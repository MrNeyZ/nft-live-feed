/**
 * Per-collection active-listings endpoint — thin adapter over
 * `listings-store.ts`. Every source (ME direct, MMM sell-side pools,
 * optional Tensor) is normalized into `Listing` once and held in the
 * process-wide store; this route reads from it and shapes the response.
 *
 * No recompute per request: `ensureFresh(slug)` only triggers a scoped
 * snapshot fetch when the slug's TTL has expired. Within TTL we return
 * directly from the store. Sale events remove matching mints from the
 * store between snapshots (see listings-store.ts).
 *
 * Response shape preserved — callers (frontend collection page) see the
 * same `{ listings: ListingOut[] }` they saw before.
 */

import { Router, Request, Response } from 'express';
import { ensureFresh, getByCollection, Listing } from './listings-store';

const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 40;

// ─── Cheapest-portion output filter ──────────────────────────────────────────
//
// Applied at the final serialization stage — upstream fetchers, the store,
// and the dedupe/sort step are all unchanged. The filter cuts the long tail
// of joke-priced listings so the Collection Terminal's LISTINGS panel shows
// only the floor-side actionable market.
//
//   1. Sort ascending by priceSol (already done).
//   2. Keep the cheapest `ceil(count * FRACTION)`.
//   3. Floor the cut at FLOOR_MIN so mid-size collections still show a
//      useful set; cap at FLOOR_MAX so very large collections don't flood
//      the UI.
//   4. If `count < FLOOR_MIN`, return what exists — never fabricate rows.
//   5. Then respect the caller's explicit `?limit=` as a further cap.
//
// "Total count" (ME `listedCount`) shown in the header is untouched — it
// still reflects the full market; only the displayed rows are trimmed.
const FLOOR_MIN = 30;
const FLOOR_MAX = 120;
const FLOOR_FRACTION = 0.30;

function cheapestCutoff(total: number): number {
  if (total <= 0) return 0;
  if (total < FLOOR_MIN) return total;
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.ceil(total * FLOOR_FRACTION)));
}

export interface ListingOut {
  /** Source-aware unique id (mirrors the backend store). Lets clients
   *  target a specific row for id-based `listing_remove` deltas instead of
   *  mint-wide removal. */
  id:           string;
  mint:         string;
  seller:       string;
  auctionHouse: string;     // empty string for non-AH sources
  priceSol:     number;
  tokenAta:     string;     // empty string when resolved at buy time
  rank:         number | null;
  marketplace:  'me' | 'tensor';
  /** Epoch ms when the listing was created on-chain. Null when unavailable. */
  listedAt:     number | null;
  /** NFT item name (from ME `token.name`). Null when the source doesn't
   *  expose it (MMM pool rows, Tensor until wired). */
  nftName:      string | null;
  /** NFT thumbnail URL. Null when unavailable; frontend falls back to the
   *  abbr/color placeholder. */
  imageUrl:     string | null;
}

// ME direct + MMM pool → `marketplace: 'me'` (both are ME-economy).
// Tensor → `marketplace: 'tensor'`. Frontend buy-button gating is unchanged.
function toListingOut(l: Listing): ListingOut {
  return {
    id:           l.id,
    mint:         l.mint,
    seller:       l.seller,
    auctionHouse: l.auctionHouse,
    priceSol:     l.priceSol,
    tokenAta:     l.tokenAta,
    rank:         l.rank,
    marketplace:  l.source === 'TENSOR' ? 'tensor' : 'me',
    listedAt:     l.listedAt,
    nftName:      l.nftName,
    imageUrl:     l.imageUrl,
  };
}

/** Preference when the same mint appears in multiple sources:
 *  ME escrow (buyable now) > MMM pool > Tensor. Defensive — a mint usually
 *  lives in exactly one source at a time. */
function sourceRank(s: Listing['source']): number {
  return s === 'ME' ? 0 : s === 'MMM' ? 1 : 2;
}

export function createCollectionListingsRouter(): Router {
  const router = Router();

  router.get('/listings', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) {
      res.status(400).json({ error: 'missing slug' });
      return;
    }

    const rawLimit = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    try {
      await ensureFresh(slug);

      // De-dup per mint across sources; then sort ascending by priceSol.
      const chosenByMint = new Map<string, Listing>();
      for (const l of getByCollection(slug)) {
        const cur = chosenByMint.get(l.mint);
        if (!cur || sourceRank(l.source) < sourceRank(cur.source)) {
          chosenByMint.set(l.mint, l);
        }
      }
      const sorted = Array.from(chosenByMint.values())
        .sort((a, b) => a.priceSol - b.priceSol);
      // Trim to cheapest-half (with FLOOR_MIN / FLOOR_MAX bounds) BEFORE the
      // caller's limit so `?limit=500` can't bypass the floor-side policy.
      const cutoff = Math.min(cheapestCutoff(sorted.length), limit);
      const listings = sorted.slice(0, cutoff).map(toListingOut);

      res.json({ listings });
    } catch (err) {
      console.error('[collections/listings] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
