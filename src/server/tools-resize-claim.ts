/**
 * Resize / Claim tool — personal use only, requireAuth-gated on every route.
 *
 * Recovers the Metaplex "TM Resize" excess SOL for legacy / pNFT NFTs held
 * by the connecting wallet, without depending on resize.metaplex.com's UI:
 *
 *   GET  /api/tools/resize-claim/scan   ?wallet=<addr>
 *        → { claimable[], resizable[], alreadyClaimed[], proofUnknown[] }
 *          Enumerates the wallet's legacy/pNFT NFTs, resolves merkle proofs
 *          from Metaplex's proof server-action, and checks each ClaimReceipt
 *          PDA on chain. `claimable` = in the tree + not yet claimed.
 *
 *   POST /api/tools/resize-claim/build  { wallet, claims?, resizes?, priorityMicroLamports? }
 *        → { txs: [{ kind, txBase64, mints }], blockhash, lastValidBlockHeight }
 *          Unsigned VersionedTransactions — one `DistributeToLegacyNft`
 *          per claim (the 25-node proof fills a tx), `Resize` packed 8-up.
 *          The client signs all + submits. No key ever touches this process,
 *          no backend broadcast step.
 *
 * The `claims` array passed to /build should come straight from /scan's
 * `claimable` output (mint + amountLamports + proof); the amount and proof
 * are re-validated shapewise here but the merkle proof itself is only
 * verified on chain by the program (error 17 InvalidClaimProof).
 */

import { Router, Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { rpcPost } from './tools-mmm-pools';
import { scanWallet, revalidateItems } from '../resize-claim/scan';
import { buildTransactions, type ClaimInput, type ResizeInput } from '../resize-claim/build';
import { verifyTransaction } from '../resize-claim/verify';
import { checkStatus } from '../resize-claim/status';

/** No response ever echoes a raw error back to the client — detail stays
 *  server-side in the log, the client gets a stable, generic string (same
 *  pattern already applied to GhostBid's tools-ghostbid.ts). */
export function toClientError(err: unknown, tag: string): string {
  console.error(`[resize-claim/${tag}]`, err);
  return 'internal_error';
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function parseClaims(raw: unknown): ClaimInput[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: ClaimInput[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null;
    const { mint, amountLamports, proof } = e as Record<string, unknown>;
    if (!isValidPubkey(mint)) return null;
    if (typeof amountLamports !== 'string' || !/^\d+$/.test(amountLamports)) return null;
    if (!Array.isArray(proof) || proof.length === 0 || proof.length > 32) return null;
    if (!proof.every(isValidPubkey)) return null;
    out.push({ mint, amountLamports, proof: proof as string[] });
  }
  return out;
}

export function parseResizes(raw: unknown): ResizeInput[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: ResizeInput[] = [];
  for (const e of raw) {
    const mint = typeof e === 'string' ? e : (e as Record<string, unknown>)?.mint;
    if (!isValidPubkey(mint)) return null;
    out.push({ mint });
  }
  return out;
}

export function createResizeClaimRouter(): Router {
  const router = Router();
  const scanLimit = rateLimit({ limit: 20, windowMs: 60_000, label: 'tools/resize-claim/scan' });
  const buildLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/resize-claim/build' });

  router.get(
    '/tools/resize-claim/scan',
    scanLimit,
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const wallet = req.query.wallet;
        if (!isValidPubkey(wallet)) {
          return res.status(400).json({ ok: false, error: 'missing_or_invalid_wallet' });
        }
        if (!process.env.HELIUS_API_KEY) {
          return res.status(502).json({ ok: false, error: 'helius_api_key_not_configured' });
        }
        const conn = new Connection(rpcUrl(), 'confirmed');
        const result = await scanWallet(conn, wallet);
        return res.json({ ok: true, ...result });
      } catch (err) {
        return res.status(500).json({ ok: false, error: toClientError(err, 'scan') });
      }
    },
  );

  router.post(
    '/tools/resize-claim/build',
    buildLimit,
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const wallet = body.wallet;
        if (!isValidPubkey(wallet)) {
          return res.status(400).json({ ok: false, error: 'missing_or_invalid_wallet' });
        }
        const claims = parseClaims(body.claims);
        const resizes = parseResizes(body.resizes);
        if (claims === null || resizes === null) {
          return res.status(400).json({ ok: false, error: 'invalid_claims_or_resizes' });
        }
        if (claims.length === 0 && resizes.length === 0) {
          return res.status(400).json({ ok: false, error: 'nothing_to_build' });
        }
        let priority: number | undefined;
        if (body.priorityMicroLamports !== undefined) {
          const p = Number(body.priorityMicroLamports);
          if (!Number.isFinite(p) || p < 0 || p > 5_000_000) {
            return res.status(400).json({ ok: false, error: 'invalid_priority' });
          }
          priority = Math.floor(p);
        }

        const conn = new Connection(rpcUrl(), 'confirmed');
        const out = await buildTransactions({
          conn,
          wallet,
          claims,
          resizes,
          priorityMicroLamports: priority,
        });
        return res.json({ ok: true, ...out });
      } catch (err) {
        return res.status(500).json({ ok: false, error: toClientError(err, 'build') });
      }
    },
  );

  // Read-only pre-signature verification — ALT resolution + simulation of
  // the EXACT final bytes the frontend is about to hand to Phantom. Never
  // signs, never sends. See resize-claim/verify.ts header for why this
  // exists (the frontend has no direct RPC access anywhere in this app).
  const verifyLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'tools/resize-claim/verify' });
  router.post('/tools/resize-claim/verify', verifyLimit, requireAuth, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_tx' });
    }
    try {
      const conn = new Connection(rpcUrl(), 'confirmed');
      const out = await verifyTransaction(conn, tx);
      return res.json({ ok: true, ...out });
    } catch (err) {
      return res.status(500).json({ ok: false, error: toClientError(err, 'verify') });
    }
  });

  // Exact-signature confirmation status + current blockheight. Called both
  // right after signing (freshness check, signatures: []) and repeatedly
  // while polling a submitted batch's outcomes (signatures: [...]).
  const statusLimit = rateLimit({ limit: 200, windowMs: 60_000, label: 'tools/resize-claim/status' });
  router.post('/tools/resize-claim/status', statusLimit, requireAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { signatures?: unknown };
    const sigs = body.signatures;
    if (sigs !== undefined && (!Array.isArray(sigs) || !sigs.every((s) => typeof s === 'string'))) {
      return res.status(400).json({ ok: false, error: 'invalid_signatures' });
    }
    if (Array.isArray(sigs) && sigs.length > 100) {
      return res.status(400).json({ ok: false, error: 'too_many_signatures' });
    }
    try {
      const conn = new Connection(rpcUrl(), 'confirmed');
      const out = await checkStatus(conn, (sigs as string[] | undefined) ?? []);
      return res.json({ ok: true, ...out });
    } catch (err) {
      return res.status(500).json({ ok: false, error: toClientError(err, 'status') });
    }
  });

  // Narrow per-item re-check before a retry rebuild — see scan.ts's
  // revalidateItems header for exactly what this does and does not re-read.
  router.post('/tools/resize-claim/revalidate', buildLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const wallet = body.wallet;
      if (!isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_wallet' });
      }
      const claims = parseClaims(body.claims);
      const resizes = parseResizes(body.resizes);
      if (claims === null || resizes === null) {
        return res.status(400).json({ ok: false, error: 'invalid_claims_or_resizes' });
      }
      const conn = new Connection(rpcUrl(), 'confirmed');
      const out = await revalidateItems(conn, wallet, claims, resizes);
      return res.json({ ok: true, ...out });
    } catch (err) {
      return res.status(500).json({ ok: false, error: toClientError(err, 'revalidate') });
    }
  });

  // Dedicated broadcast proxy — same shape as the generic
  // /tools/mmm-pools/send-tx, but on this tool's own limiter so a wallet
  // with many claimable NFTs (one signed tx per claim) doesn't hit the
  // shared 10/min cap partway through a batch (same reasoning as
  // tools-candy-mint.ts's dedicated send-tx).
  const sendLimit = rateLimit({ limit: 200, windowMs: 60_000, label: 'tools/resize-claim/send-tx' });
  router.post('/tools/resize-claim/send-tx', sendLimit, requireAuth, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_tx' });
    }
    try {
      const signature = await rpcPost('sendTransaction', [
        tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' },
      ]) as string;
      return res.json({ ok: true, signature });
    } catch (err) {
      console.error('[resize-claim/send-tx]', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  return router;
}
