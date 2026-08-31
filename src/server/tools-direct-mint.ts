/**
 * CreateV2 tool — personal use only, not a public feature.
 *
 * Companion to Candy Mint (tools-candy-mint.ts): builds a bare Token
 * Metadata `createV1`+`mintV1` mint (no Candy Machine/Guard involved) for
 * the connecting wallet to sign directly — the shape a self-authored 1-of-1
 * mint actually is on-chain (see ../direct-mint/build.ts's header comment).
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — not meant to be reachable by anyone outside the operator's own
 * allowed wallet.
 *
 *   GET  /api/tools/direct-mint/inspect?sig=<signature>
 *   POST /api/tools/direct-mint/build-tx    { wallet, name, symbol, uri, royaltyBp, standard, collection? }
 *   POST /api/tools/direct-mint/simulate-tx { transactionBase64, wallet }
 *
 *   GET  /api/tools/direct-mint/core-collection?collection=<pubkey>
 *   POST /api/tools/direct-mint/core-delegate/build-tx { wallet, collection, delegate }
 *   (built delegate txs share simulate-tx above — same generic shape)
 *
 *   GET  /api/tools/direct-mint/duplicate-metadata?exampleUri=<uri>&n=<int>
 *   (resolved metadata feeds straight into build-tx above — no separate
 *   duplicate-mint builder; see ../direct-mint/duplicate.ts's header)
 */

import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { buildDirectMintTx, type TokenStandardChoice } from '../direct-mint/build';
import { decodeDirectMintSignature } from '../direct-mint/decode';
import { simulateCandyMintTx } from '../candy-mint/simulate';
import { fetchCollectionDelegateInfo, buildAddCollectionDelegateTx } from '../direct-mint/delegate';
import { resolveDuplicateMetadata } from '../direct-mint/duplicate';

function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function createDirectMintRouter(): Router {
  const router = Router();
  const inspectLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/direct-mint/inspect' });
  const buildLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/direct-mint/build-tx' });
  const simulateLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/direct-mint/simulate-tx' });

  router.get('/tools/direct-mint/inspect', inspectLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const sig = req.query.sig as string | undefined;
      if (!sig) return res.status(400).json({ ok: false, error: 'missing_sig' });
      const result = await decodeDirectMintSignature(sig);
      if (!result.ok) return res.status(422).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] inspect error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/direct-mint/build-tx', buildLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const {
        wallet, name, symbol, uri, royaltyBp, standard, collection,
      } = req.body as {
        wallet?: string; name?: string; symbol?: string; uri?: string;
        royaltyBp?: number; standard?: string; collection?: string | null;
      };
      if (!isValidPubkey(wallet)) return res.status(400).json({ ok: false, error: 'invalid_wallet' });
      if (standard !== 'nft' && standard !== 'pnft' && standard !== 'core') {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_standard' });
      }
      if (typeof name !== 'string' || typeof uri !== 'string' || typeof royaltyBp !== 'number') {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      if (collection != null && !isValidPubkey(collection)) {
        return res.status(400).json({ ok: false, error: 'invalid_collection' });
      }
      const result = await buildDirectMintTx({
        wallet,
        name,
        symbol: typeof symbol === 'string' ? symbol : '',
        uri,
        royaltyBp,
        standard: standard as TokenStandardChoice,
        collection: collection ?? null,
      });
      if (!result.ok) return res.status(409).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] build-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/direct-mint/simulate-tx', simulateLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { transactionBase64, wallet } = req.body as { transactionBase64?: string; wallet?: string };
      if (typeof transactionBase64 !== 'string' || !transactionBase64 || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      const result = await simulateCandyMintTx(transactionBase64, wallet);
      if (!result.ok) return res.status(502).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] simulate-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/direct-mint/core-collection', inspectLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const collection = req.query.collection as string | undefined;
      if (!isValidPubkey(collection)) return res.status(400).json({ ok: false, error: 'invalid_collection' });
      const result = await fetchCollectionDelegateInfo(collection);
      if (!result.ok) return res.status(422).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] core-collection error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/direct-mint/core-delegate/build-tx', buildLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { wallet, collection, delegate } = req.body as { wallet?: string; collection?: string; delegate?: string };
      if (!isValidPubkey(wallet)) return res.status(400).json({ ok: false, error: 'invalid_wallet' });
      if (!isValidPubkey(collection)) return res.status(400).json({ ok: false, error: 'invalid_collection' });
      if (!isValidPubkey(delegate)) return res.status(400).json({ ok: false, error: 'invalid_delegate' });
      const result = await buildAddCollectionDelegateTx({ wallet, collection, delegate });
      if (!result.ok) return res.status(409).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] core-delegate/build-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/direct-mint/duplicate-metadata', inspectLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const exampleUri = req.query.exampleUri as string | undefined;
      const n = Number(req.query.n);
      if (typeof exampleUri !== 'string' || !exampleUri) {
        return res.status(400).json({ ok: false, error: 'missing_example_uri' });
      }
      if (!Number.isFinite(n)) return res.status(400).json({ ok: false, error: 'invalid_number' });
      const result = await resolveDuplicateMetadata(exampleUri, n);
      if (!result.ok) return res.status(422).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/direct-mint] duplicate-metadata error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
