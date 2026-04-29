/**
 * Manual scanner — Retardio listings with Magic Eden personal offers.
 *
 * Endpoint:
 *   POST /api/tools/retardio-me-offer-scan
 *   body: { slug?: string, minOfferSol?: number, limit?: number }
 *
 * Flow (synchronous, single ~5-10 s scan per call):
 *   1. Fetch active listings for `slug` from ME's public v2 API.
 *   2. For each listing, fetch token-specific offers_received from the
 *      same API.
 *   3. Keep only mints with at least one personal offer.
 *   4. Sort by best-offer price descending.
 *
 * Constraints:
 *   - Manual / on-demand only. Never runs in the background.
 *   - In-memory cache TTL = 45 s so a flurry of clicks doesn't spam ME.
 *   - Sequential fetches with a small gap (REQUEST_GAP_MS) — keeps us
 *     well under ME's published rate limit (~120 req/min, public).
 *   - Default scan ceiling = 60 listings/scan (~12-15 s wall time).
 */

import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';

const ME_API_BASE      = 'https://api-mainnet.magiceden.dev/v2';
const DEFAULT_SLUG     = process.env.RETARDIO_ME_SLUG ?? 'retardio_cousins';
const REQUEST_GAP_MS   = 120;
const SCAN_LIMIT_MAX   = 100;
const SCAN_LIMIT_DFLT  = 60;
const CACHE_TTL_MS     = 45_000;
/** Largest single ME listings page; v2 endpoint accepts up to 100. */
const LISTINGS_PAGE    = 100;

interface MeListing {
  pdaAddress?:    string;
  tokenMint?:     string;
  seller?:        string;
  price?:         number;       // SOL
  tokenAddress?:  string;
  auctionHouse?:  string;
  extra?:         { img?: string };
  token?:         { name?: string; image?: string };
}

interface MeOffer {
  pdaAddress?:    string;
  tokenMint?:     string;
  buyer?:         string;       // bidder
  price?:         number;       // SOL
  auctionHouse?:  string;
  /** Unix timestamp seconds when the offer expires. ME often returns 0
   *  for offers without an explicit expiry (open-ended bids); per spec
   *  we treat missing/zero as inactive unless ME explicitly marks it.
   *  Ground truth: only offers with `expiry > now` are kept. */
  expiry?:        number;
  /** Unix timestamp seconds when the offer was placed. ME returns this
   *  on most offers_received responses; absent on a few legacy rows.
   *  Used by the UI to render an "AGE" column. */
  createdAt?:     number;
  blockTime?:     number;       // alternate name on some ME endpoints
}

/** Active = `expiry` is a number AND in the future. Returns false for
 *  missing / zero / past expiry. Conservative by design — a stale offer
 *  in our results is a worse UX than a dropped one. */
function isOfferActive(o: MeOffer, nowSec: number): boolean {
  const exp = o.expiry;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return false;
  return exp > nowSec;
}

export interface ScanRow {
  mint:             string;
  nftName:          string | null;
  imageUrl:         string | null;
  listingPrice:     number;     // SOL
  bestOfferPrice:   number;     // SOL
  spreadSol:        number;     // bestOffer - listing  (positive = offer above ask)
  /** Stable identity for the best active offer. ME returns its
   *  `pdaAddress` per offer; the frontend uses this to compare scans
   *  and mark newly-appeared offers as NEW. Falls back to a synthetic
   *  `${mint}:${buyer}:${price}` composite when ME omitted pda. */
  bestOfferId:      string;
  /** Unix timestamp seconds when the best offer was placed. Null when
   *  ME didn't provide a createdAt / blockTime. UI renders this as a
   *  human "AGE" string. */
  bestOfferCreatedAt: number | null;
  meUrl:            string;
  tensorUrl:        string;
}

export interface ScanResult {
  ok:           true;
  slug:         string;
  scanned:      number;         // listings checked
  listedTotal:  number;         // total listings from ME (may exceed `scanned`)
  /** Total raw offers seen across all listings before the active filter. */
  offersFetched: number;
  /** Count of offers that passed the active (future-expiry) filter. */
  offersActive:  number;
  withOffers:   ScanRow[];
  cachedAt:     number;         // epoch ms
  ttlMs:        number;
}

let cached: { key: string; result: ScanResult } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchListings(slug: string): Promise<MeListing[]> {
  const out: MeListing[] = [];
  let offset = 0;
  // Up to SCAN_LIMIT_MAX listings via single LISTINGS_PAGE pages.
  while (out.length < SCAN_LIMIT_MAX) {
    const url = `${ME_API_BASE}/collections/${encodeURIComponent(slug)}/listings?offset=${offset}&limit=${LISTINGS_PAGE}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) break;
    const page = await r.json() as MeListing[];
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < LISTINGS_PAGE) break;       // last page
    offset += LISTINGS_PAGE;
    await sleep(REQUEST_GAP_MS);
  }
  return out;
}

async function fetchOffersReceived(mint: string): Promise<MeOffer[]> {
  const url = `${ME_API_BASE}/tokens/${encodeURIComponent(mint)}/offers_received?limit=20`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return [];
    const data = await r.json() as MeOffer[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function runScan(slug: string, scanLimit: number, minOfferSol: number): Promise<ScanResult> {
  const listings = await fetchListings(slug);
  const sliced   = listings.slice(0, scanLimit);
  const out: ScanRow[] = [];

  const nowSec = Math.floor(Date.now() / 1000);
  let totalFetched = 0;
  let totalActive  = 0;

  for (const l of sliced) {
    const mint = l.tokenMint ?? l.tokenAddress;
    if (!mint || typeof l.price !== 'number') continue;

    const offers = await fetchOffersReceived(mint);
    await sleep(REQUEST_GAP_MS);
    if (offers.length === 0) continue;

    // Active filter: expiry must be a future-dated number. Missing /
    // zero / past expiry → drop. Sorted active offers desc by price.
    const active = offers
      .filter(o => isOfferActive(o, nowSec))
      .filter(o => typeof o.price === 'number' && (o.price as number) > 0)
      .sort((a, b) => (b.price as number) - (a.price as number));

    totalFetched += offers.length;
    totalActive  += active.length;

    if (active.length === 0) continue;

    const best = active[0];
    const bestPrice = best.price as number;
    if (bestPrice < minOfferSol) continue;

    // Pick whichever timestamp field ME populated. Both are seconds.
    const createdAt =
      typeof best.createdAt === 'number' && best.createdAt > 0 ? best.createdAt :
      typeof best.blockTime === 'number' && best.blockTime > 0 ? best.blockTime :
      null;

    const bestOfferId = best.pdaAddress
      ?? `${mint}:${best.buyer ?? '?'}:${bestPrice}`;

    out.push({
      mint,
      nftName:           l.token?.name ?? null,
      imageUrl:          l.extra?.img ?? l.token?.image ?? null,
      listingPrice:      l.price,
      bestOfferPrice:    bestPrice,
      spreadSol:         bestPrice - l.price,
      bestOfferId,
      bestOfferCreatedAt: createdAt,
      meUrl:             `https://magiceden.io/item-details/${mint}`,
      tensorUrl:         `https://www.tensor.trade/item/${mint}`,
    });
  }

  // Highest best-offer first; tie-break by spread.
  out.sort((a, b) => b.bestOfferPrice - a.bestOfferPrice || b.spreadSol - a.spreadSol);

  return {
    ok:           true,
    slug,
    scanned:      sliced.length,
    listedTotal:  listings.length,
    offersFetched: totalFetched,
    offersActive:  totalActive,
    withOffers:   out,
    cachedAt:     Date.now(),
    ttlMs:        CACHE_TTL_MS,
  };
}

export function createRetardioOffersRouter(): Router {
  const router = Router();
  // Manual tool — coarse rate limit (one full scan ~10 s, cap clicks at
  // 6/min/wallet so a stuck button doesn't drain ME credits).
  const limit = rateLimit({ limit: 6, windowMs: 60_000, label: 'tools/retardio-me-offer-scan' });

  router.post('/tools/retardio-me-offer-scan', limit, async (req: Request, res: Response) => {
    const slug        = (req.body?.slug as string)        || DEFAULT_SLUG;
    const minOfferSol = Math.max(0, Number(req.body?.minOfferSol ?? 0));
    const scanLimit   = Math.min(SCAN_LIMIT_MAX, Math.max(1, Number(req.body?.limit ?? SCAN_LIMIT_DFLT)));
    const cacheKey    = `${slug}|${minOfferSol}|${scanLimit}`;

    if (cached && cached.key === cacheKey && Date.now() - cached.result.cachedAt < CACHE_TTL_MS) {
      return res.json({ ...cached.result, fromCache: true });
    }

    const startedAt = Date.now();
    try {
      const result = await runScan(slug, scanLimit, minOfferSol);
      cached = { key: cacheKey, result };
      console.log(
        `[tools/retardio-me-offer-scan] slug=${slug} scanned=${result.scanned} ` +
        `withOffers=${result.withOffers.length} ` +
        `offersFetched=${result.offersFetched} offersActive=${result.offersActive} ` +
        `took=${Date.now() - startedAt}ms`,
      );
      return res.json({ ...result, fromCache: false });
    } catch (err) {
      console.error('[tools/retardio-me-offer-scan] error', err);
      return res.status(500).json({ ok: false, error: 'scan failed' });
    }
  });

  return router;
}
