/**
 * ME-vs-Tensor arbitrage lookup — read-only, one collection per request.
 *
 * Reuses the existing `listings-store.ts` snapshot engine (ME direct + MMM
 * sell-side pools + Tensor active_listings, already normalized into one
 * `Listing` schema) instead of fetching anything new: `ensureFresh(slug)`
 * only re-hits upstream when that slug's TTL has expired, so repeat lookups
 * on a hot collection are cache-fast, not a fresh scan every time.
 *
 * Answers exactly one question: which ME/MMM-side listings are currently
 * priced below Tensor's own cheapest active listing for the same
 * collection. Tensor floor is computed from the FULL fetched Tensor set,
 * not the cheapest-portion-trimmed view `collection-listings.ts` serves the
 * Collection page — that trim is a UI concern for this route.
 */

import { Router, Request, Response } from 'express';
import { ensureFresh, getByCollection } from './listings-store';
import { rateLimit, isValidSlug } from './rate-limit';

export interface ArbListing {
  mint:      string;
  priceSol:  number;
  seller:    string;
  source:    'ME' | 'MMM';
  rank:      number | null;
  listedAt:  number | null;
  nftName:   string | null;
  imageUrl:  string | null;
  /** tensorFloorSol / priceSol — how many times cheaper than Tensor. */
  multiple:  number;
}

export function createMeTensorArbRouter(): Router {
  const router = Router();
  const arbLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-tensor-arb' });

  router.get('/tools/me-tensor-arb', arbLimit, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid_slug' });
      return;
    }
    if (!process.env.TENSOR_API_KEY) {
      res.status(503).json({ error: 'tensor_api_key_missing' });
      return;
    }

    try {
      await ensureFresh(slug);
      const rows = getByCollection(slug);

      const tensorPrices = rows.filter(r => r.source === 'TENSOR').map(r => r.priceSol);
      if (tensorPrices.length === 0) {
        res.json({ ok: true, tensorFloorSol: null, tensorListedCount: 0, listings: [] });
        return;
      }
      const tensorFloorSol = Math.min(...tensorPrices);

      const listings: ArbListing[] = rows
        .filter(r => r.source !== 'TENSOR' && r.priceSol < tensorFloorSol)
        .sort((a, b) => a.priceSol - b.priceSol)
        .map(r => ({
          mint:     r.mint,
          priceSol: r.priceSol,
          seller:   r.seller,
          source:   r.source as 'ME' | 'MMM',
          rank:     r.rank,
          listedAt: r.listedAt,
          nftName:  r.nftName,
          imageUrl: r.imageUrl,
          multiple: tensorFloorSol / r.priceSol,
        }));

      res.json({ ok: true, tensorFloorSol, tensorListedCount: tensorPrices.length, listings });
    } catch (err) {
      console.error('[tools/me-tensor-arb] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
