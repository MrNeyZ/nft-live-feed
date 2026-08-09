/**
 * Tensor Take Bid tool — personal use only, not a public feature.
 *
 * Accepts any live Tensor collection bid (TCOMP program,
 * TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp) on any mpl-core asset, by
 * reading live on-chain bid state and building an unsigned `takeBidCore`
 * transaction for the connecting wallet to sign directly. No private key
 * ever touches this process — every route only reads public chain state
 * and returns an unsigned transaction; Phantom (client-side) signs AND
 * submits it directly, same as the reference `tensor-takebid-tool/`
 * prototype's phantom.html. There is no backend broadcast step.
 *
 * Built generically — not tied to one collection/bid/asset. See
 * `tensor-takebid-tool/HANDOFF.md` for the on-chain reverse-engineering
 * notes behind the non-obvious parts of `build.ts` (targetId is a
 * whitelist PDA, the SystemProgram cosigner sentinel, the margin default).
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — this endpoint is not meant to be reachable by anyone outside the
 * operator's own allowed wallet.
 *
 *   POST /api/tools/tensor-take-bid/build     { bidState, asset, wallet, priority?, compute? }
 *   POST /api/tools/tensor-take-bid/simulate  { transactionBase64, wallet }
 */

import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { buildTakeBidTx } from '../tensor-take-bid/build';
import { simulateTakeBidTx } from '../tensor-take-bid/simulate';

function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function createTensorTakeBidRouter(): Router {
  const router = Router();
  const buildLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/tensor-take-bid/build' });
  const simulateLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/tensor-take-bid/simulate' });

  router.post('/tools/tensor-take-bid/build', buildLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { bidState, asset, wallet, priority, compute } = req.body as {
        bidState?: string; asset?: string; wallet?: string;
        priority?: number; compute?: number;
      };
      if (!isValidPubkey(bidState) || !isValidPubkey(asset) || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      const result = await buildTakeBidTx({
        bidStateAddr: bidState,
        assetAddr: asset,
        sellerAddr: wallet,
        priorityMicroLamports: typeof priority === 'number' ? priority : undefined,
        computeUnits: typeof compute === 'number' ? compute : undefined,
      });
      if (!result.ok) return res.status(409).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/tensor-take-bid] build error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/tensor-take-bid/simulate', simulateLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { transactionBase64, wallet } = req.body as { transactionBase64?: string; wallet?: string };
      if (typeof transactionBase64 !== 'string' || !transactionBase64 || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      const result = await simulateTakeBidTx(transactionBase64, wallet);
      if (!result.ok) return res.status(502).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/tensor-take-bid] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
