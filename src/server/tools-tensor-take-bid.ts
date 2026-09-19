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
 *   GET  /api/tools/tensor-take-bid/resolve    ?asset=&bidder=
 *   POST /api/tools/tensor-take-bid/build     { bidState, asset, wallet, priority?, compute? }
 *   POST /api/tools/tensor-take-bid/simulate  { transactionBase64, wallet }
 *
 * /resolve looks up the live bidState PDA for a (mint, bidder) pair via
 * Tensor's `collections/nft_bids` endpoint (same one used for the forgotten-
 * bid scan this tool feeds off of), so the caller only needs the two things
 * a discovery scan actually produces — the NFT and who placed the bid — same
 * shape as /tools/me-sell's mint+buyer entry point, instead of having to
 * separately go find the bidState account address by hand.
 */

import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { buildTakeBidTx } from '../tensor-take-bid/build';
import { simulateTakeBidTx } from '../tensor-take-bid/simulate';
import { resolveLiveBidOnChain } from '../tensor-take-bid/resolve';

function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function createTensorTakeBidRouter(): Router {
  const router = Router();
  const resolveLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/tensor-take-bid/resolve' });
  const buildLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/tensor-take-bid/build' });
  const simulateLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/tensor-take-bid/simulate' });

  router.get('/tools/tensor-take-bid/resolve', resolveLimit, requireAuth, async (req: Request, res: Response) => {
    try {
      const asset = req.query.asset;
      const bidder = req.query.bidder;
      if (!isValidPubkey(asset) || !isValidPubkey(bidder)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      // On-chain search, not Tensor's `collections/nft_bids` REST endpoint —
      // that endpoint only surfaces Target::AssetId bids and returns an
      // empty array for Target::Whitelist (collection-wide) bids, which are
      // the majority of real bid volume. See resolve.ts header for the full
      // finding. TENSOR_API_KEY is still used inside (to resolve collId for
      // the whitelist-target search) but degrades to AssetId-only search
      // when unset, rather than hard-failing the route.
      const bid = await resolveLiveBidOnChain(asset, bidder);
      if (!bid) {
        return res.status(404).json({ ok: false, error: 'no_live_bid_from_this_bidder_on_this_asset' });
      }
      return res.json({ ok: true, ...bid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/tensor-take-bid] resolve error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

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
