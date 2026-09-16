/**
 * Candy Mint tool — personal use only, not a public feature.
 *
 * Reconstructs a Candy Guard mint transaction from a real, already-landed
 * mint signature (or directly from candyMachine/candyGuard addresses) and
 * returns an unsigned tx for the connecting wallet to sign. Exists because
 * candy machines get closed (rent reclaimed) the moment they sell out —
 * sometimes minutes after a still-open-looking frontend shows the mint as
 * live — so "paste a recent mint's signature" is the fastest way to check
 * whether minting is still actually possible on-chain and, if so, do it
 * directly.
 *
 * Two families (see ../candy-mint/decode.ts's header comment for the
 * account-order verification behind both): 'core' (MPL Core Candy Guard)
 * and 'legacy' (Token Metadata Candy Guard). Resolved from the reference
 * signature automatically, or auto-detected from the candyGuard account's
 * on-chain owner when entering via raw addresses.
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — this endpoint is not meant to be reachable by anyone outside the
 * operator's own allowed wallet.
 *
 *   GET  /api/tools/candy-mint/inspect?sig=<signature>[&wallet=]
 *   GET  /api/tools/candy-mint/inspect?candyMachine=&candyGuard=[&wallet=]
 *      (wallet is optional — when supplied, each group's mintLimit guard
 *      also gets `used`/`remaining` filled in against that specific wallet)
 *   POST /api/tools/candy-mint/build-tx   { family, candyMachine, candyGuard, collection, collectionUpdateAuthority?, group, wallet }
 *   POST /api/tools/candy-mint/simulate-tx { transactionBase64, wallet }
 *   GET  /api/tools/candy-mint/block-height  -> { blockHeight }
 *      Batch-mint post-sign blockhash-headroom guard only (see page.tsx
 *      handleMintBatch) — one call per batch, not per item.
 *
 * Broadcast reuses the existing generic `/api/tools/mmm-pools/send-tx` proxy
 * (same pattern as tools-dotland.ts / tools-me-bids.ts).
 */

import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { rpcPost } from './tools-mmm-pools';
import { decodeCandyMintSignature, detectFamilyFromGuardAddress, type CandyMintFamily } from '../candy-mint/decode';
import { inspectCandyMachine } from '../candy-mint/guard-config';
import { buildCandyMintTx } from '../candy-mint/build';
import { simulateCandyMintTx } from '../candy-mint/simulate';
import { getTokenDecimalsMany } from '../candy-mint/token-decimals';
import { getCurrentBlockHeight } from '../candy-mint/block-height';
import { verifyMintAsset } from '../candy-mint/verify-asset';
import { getAsset } from '../enrichment/helius-das';
import { resolveEarliestSignatureForAsset } from '../candy-mint/resolve-asset-signature';
import { findSiblingCandyMachines } from '../candy-mint/siblings';

// The largest batch quantity the frontend stepper allows when no per-wallet
// mintLimit narrows it (page.tsx `quantityCap`). The batch flow broadcasts
// one send per item, sequentially, right after a single signAllTransactions —
// so the send limiter has to clear one full max-size batch in a window, plus
// headroom for a couple of "Retry unresolved" re-sends within the same
// minute. The generic /tools/mmm-pools/send-tx limiter (10/min, shared with
// every MMM read endpoint) deterministically 429s a batch past item ~10;
// this dedicated limiter is the fix (M1).
export const MAX_CANDY_MINT_BATCH = 25;

function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function createCandyMintRouter(): Router {
  const router = Router();
  // One shared limiter across inspect/build-tx/simulate-tx meant a single
  // batch mint (each item = 1 build-tx + 1 simulate-tx call) blew through a
  // 20/min budget by itself — the wallet-switch effect's background
  // /inspect refresh alone could eat into it. A quantity-10 batch got 429'd
  // partway through, which build-tx/simulate-tx surfaced as a plain "error"
  // (no on-chain trace, since the tx was never even built) — looked like a
  // silent random failure. Separate limiters, sized for this tool's actual
  // usage — quantity up to 25 now means 25 build-tx (pre-check) + 25
  // simulate-tx (pre-check) + up to 25 more build-tx (rebuild-before-sign,
  // see page.tsx handleMintBatch) = up to 75 calls across the batch.
  const inspectLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/candy-mint/inspect' });
  const buildLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'tools/candy-mint/build-tx' });
  const simulateLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'tools/candy-mint/simulate-tx' });
  const blockHeightLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/candy-mint/block-height' });
  // One max-size batch = 25 sends back-to-back, + headroom for "Retry
  // unresolved" re-sends and the single-flow. NOT the shared 10/min MMM
  // limiter (M1).
  const sendLimit = rateLimit({ limit: MAX_CANDY_MINT_BATCH * 2 + 10, windowMs: 60_000, label: 'tools/candy-mint/send-tx' });
  const verifyLimit = rateLimit({ limit: MAX_CANDY_MINT_BATCH * 4, windowMs: 60_000, label: 'tools/candy-mint/verify-asset' });

  router.get('/tools/candy-mint/inspect', inspectLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      let sig = req.query.sig as string | undefined;
      const assetQ = req.query.asset as string | undefined;
      const candyMachineQ = req.query.candyMachine as string | undefined;
      const candyGuardQ = req.query.candyGuard as string | undefined;
      const walletQ = req.query.wallet as string | undefined;
      const wallet = isValidPubkey(walletQ) ? walletQ : null;

      // `asset` (an NFT mint address, from the /mints feed's Candy Machine
      // badge — see MintStatusWire.firstMintAddress) resolves to its own
      // earliest signature here rather than being threaded through the
      // ingestion pipeline as a new field. One extra RPC, paid only when
      // the tool is actually opened.
      if (!sig && isValidPubkey(assetQ)) {
        const resolved = await resolveEarliestSignatureForAsset(assetQ);
        if (!resolved) return res.status(422).json({ ok: false, error: 'no_signature_history_for_asset' });
        sig = resolved;
      }

      let candyMachine: string; let candyGuard: string; let collection: string | null = null;
      let collectionUpdateAuthority: string | null = null; let group: string | null = null;
      let family: CandyMintFamily;

      if (sig) {
        const decoded = await decodeCandyMintSignature(sig);
        if (!decoded.ok) return res.status(422).json({ ok: false, error: decoded.error });
        family = decoded.decoded.family;
        candyMachine = decoded.decoded.candyMachine;
        candyGuard = decoded.decoded.candyGuard;
        collection = decoded.decoded.collection;
        collectionUpdateAuthority = decoded.decoded.collectionUpdateAuthority;
        group = decoded.decoded.group;
      } else if (isValidPubkey(candyMachineQ) && isValidPubkey(candyGuardQ)) {
        candyMachine = candyMachineQ;
        candyGuard = candyGuardQ;
        const detected = await detectFamilyFromGuardAddress(candyGuard);
        if (!detected) return res.status(422).json({ ok: false, error: 'unrecognized_candy_guard_program' });
        family = detected;
      } else {
        return res.status(400).json({ ok: false, error: 'provide_sig_or_candyMachine_and_candyGuard' });
      }

      const inspection = await inspectCandyMachine(family, candyMachine, candyGuard, wallet);

      // Fill in tokenPayment decimals so the UI can render a human price for
      // token-priced drops (the guard only stores the raw integer). Cheap
      // (one getTokenSupply per distinct mint, process-cached) and
      // best-effort — a miss leaves decimals null and the UI shows the raw
      // amount. Never blocks or fails the inspect.
      const tokenMints = inspection.groups
        .map((g) => g.tokenPayment?.mint)
        .filter((m): m is string => typeof m === 'string');
      if (tokenMints.length > 0) {
        try {
          const decimalsByMint = await getTokenDecimalsMany(tokenMints);
          for (const g of inspection.groups) {
            if (g.tokenPayment) {
              g.tokenPayment.decimals = decimalsByMint.get(g.tokenPayment.mint) ?? null;
            }
          }
        } catch {
          // leave decimals null — raw amount is still shown
        }
      }

      // Best-effort — the launchpad-style hero (image/name/creator) is a
      // display nicety, not a gate. A DAS miss (fresh/never-indexed
      // collection, rate limit) must never block minting itself.
      let collectionMeta: { name: string | null; image: string | null; description: string | null; creator: string | null; website: string | null } | null = null;
      const collectionAddr = inspection.collection ?? collection;
      if (collectionAddr) {
        try {
          const meta = await getAsset(collectionAddr, 'manual_tools');
          collectionMeta = {
            name: meta.nftName,
            image: meta.imageUrl,
            description: meta.description ?? null,
            creator: meta.verifiedCreators?.[0] ?? null,
            website: meta.externalUrl ?? null,
          };
        } catch {
          // leave collectionMeta null — inspection result is still fully usable
        }
      }

      // Best-effort — surfaces "phase 2" drops that reuse the same
      // collection under a DIFFERENT candy machine (see CLOIDS,
      // 2026-09-16: a second 1111-item CM sat unminted for 18 days because
      // nothing pointed at it). An RPC miss here must never block Inspect.
      let siblings: Awaited<ReturnType<typeof findSiblingCandyMachines>> = [];
      if (collectionAddr) {
        try {
          siblings = await findSiblingCandyMachines(collectionAddr, candyMachine);
        } catch {
          // leave siblings empty — inspection result is still fully usable
        }
      }

      return res.json({
        ok: true, family, referenceCollection: collection,
        referenceCollectionUpdateAuthority: collectionUpdateAuthority,
        referenceGroup: group, inspection, collectionMeta, siblings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] inspect error', msg);
      // 200, not 502/503/504 — Cloudflare replaces the body of those statuses
      // with its own generic error page, hiding this JSON from the client.
      return res.status(200).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/candy-mint/build-tx', buildLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const {
        family, candyMachine, candyGuard, collection, collectionUpdateAuthority, group, wallet,
      } = req.body as {
        family?: string; candyMachine?: string; candyGuard?: string; collection?: string;
        collectionUpdateAuthority?: string | null; group?: string | null; wallet?: string;
      };
      if (family !== 'core' && family !== 'legacy') {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_family' });
      }
      if (!isValidPubkey(candyMachine) || !isValidPubkey(candyGuard) || !isValidPubkey(collection) || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      if (family === 'legacy' && collectionUpdateAuthority != null && !isValidPubkey(collectionUpdateAuthority)) {
        return res.status(400).json({ ok: false, error: 'invalid_collectionUpdateAuthority' });
      }
      const result = await buildCandyMintTx({
        family, candyMachine, candyGuard, collection, wallet,
        collectionUpdateAuthority: collectionUpdateAuthority ?? null,
        group: typeof group === 'string' && group.length > 0 ? group : null,
      });
      if (!result.ok) return res.status(409).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] build-tx error', msg);
      return res.status(200).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/candy-mint/simulate-tx', simulateLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { transactionBase64, wallet } = req.body as { transactionBase64?: string; wallet?: string };
      if (typeof transactionBase64 !== 'string' || !transactionBase64 || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      const result = await simulateCandyMintTx(transactionBase64, wallet);
      if (!result.ok) return res.status(200).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] simulate-tx error', msg);
      return res.status(200).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/candy-mint/block-height', blockHeightLimit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const blockHeight = await getCurrentBlockHeight();
      return res.json({ ok: true, blockHeight });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] block-height error', msg);
      return res.status(200).json({ ok: false, error: msg });
    }
  });

  // Dedicated broadcast proxy (M1) — same behavior as the generic
  // /tools/mmm-pools/send-tx (sendTransaction, skipPreflight, base64) but on
  // this tool's own limiter, sized so one full 25-item batch clears in a
  // window. Callers already run their own post-sign blockhash-headroom guard
  // BEFORE hitting this; skipPreflight stays true to match that contract.
  router.post('/tools/candy-mint/send-tx', sendLimit, requireAuth, async (req: Request, res: Response) => {
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] send-tx error', msg);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: msg });
    }
  });

  // Post-confirmation mint verification (H1) — after tx-status reports
  // landed+err==null, the caller asks whether the FINAL asset/nftMint pubkey
  // was actually minted. A landed Candy Guard bot-tax transaction has err==null
  // but mints nothing, so "confirmed" alone is not "minted"; and a clean
  // account-null is NOT proof of "no mint" (RPC lag / load-balanced nodes) —
  // see verify-asset.ts header.
  //   { verdict: 'minted' }        -> asset account exists, right owner
  //   { verdict: 'tax_no_mint' }   -> asset absent AND the confirmed tx's logs
  //                                   carry the bot-tax marker (strong evidence)
  //   { verdict: 'not_observed' }  -> asset absent, logs clean / not fetchable
  //                                   -> caller keeps the signature, re-checks,
  //                                      never claims minted or bot-tax
  router.get('/tools/candy-mint/verify-asset', verifyLimit, requireAuth, async (req: Request, res: Response) => {
    const asset = req.query.asset as string | undefined;
    const family = req.query.family as string | undefined;
    const sig = req.query.sig as string | undefined;
    if (!isValidPubkey(asset) || (family !== 'core' && family !== 'legacy') || typeof sig !== 'string' || !sig) {
      return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
    }
    try {
      const result = await verifyMintAsset(family, asset, sig);
      return res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] verify-asset error', msg);
      return res.status(200).json({ ok: false, error: msg });
    }
  });

  return router;
}
