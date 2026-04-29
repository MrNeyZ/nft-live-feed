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
  expiry?:        number;
  // ME has shipped these timestamp fields under several different names
  // across endpoints / endpoint versions; we accept any of them and use
  // the first one that contains a positive number. extractCreatedAt()
  // below handles selection + ms-vs-seconds normalisation. The
  // `[key: string]: unknown` index lets us look up snake-case variants
  // without TypeScript narrowing rejecting them.
  createdAt?:     number;
  created_at?:    number;
  createdTime?:   number;
  created_time?:  number;
  blockTime?:     number;
  block_time?:    number;
  timestamp?:     number;
  [key: string]:  unknown;
}

const CREATED_AT_KEYS = [
  'createdAt', 'created_at', 'createdTime', 'created_time',
  'blockTime', 'block_time', 'timestamp',
] as const;

/** Pick the first populated timestamp field. ME returns most timestamps
 *  in seconds, but a handful of endpoints return ms — we detect by
 *  magnitude (anything ≥ 1e12 is unambiguously ms after 2001) and
 *  normalise to seconds. Returns `null` when none of the known field
 *  names carry a positive number. */
function extractCreatedAt(o: MeOffer): number | null {
  for (const k of CREATED_AT_KEYS) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    return v >= 1e12 ? Math.floor(v / 1000) : v;
  }
  return null;
}

/** One-shot diagnostic: dump the keys ME actually populated on the
 *  first offer we see. Helps pin down which timestamp field name ME
 *  is using on the current endpoint without digging through their
 *  docs. Logs at most once per process. */
let _loggedSampleKeys = false;
function maybeLogSampleKeys(offer: MeOffer): void {
  if (_loggedSampleKeys) return;
  _loggedSampleKeys = true;
  console.log(
    `[tools/retardio-me-offer-scan/sample] ME offer keys = ` +
    JSON.stringify(Object.keys(offer).sort()),
  );
}

/** Per-offer status — every offer ME returns is kept; this label tells
 *  the UI how to dim/sort it.
 *    AVAILABLE  — `expiry` is a future-dated number (offer is fillable).
 *    EXPIRED    — `expiry` is a past-dated number (offer has lapsed).
 *    EXPECTED   — `expiry` missing / zero / non-finite (open-ended bid
 *                 or a payload variant ME doesn't expose expiry on;
 *                 worth surfacing because the offer is still in ME's
 *                 active set, just not validatable from our side). */
export type OfferStatus = 'AVAILABLE' | 'EXPIRED' | 'EXPECTED';

function classifyOfferStatus(o: MeOffer, nowSec: number): OfferStatus {
  const exp = o.expiry;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return 'EXPECTED';
  return exp > nowSec ? 'AVAILABLE' : 'EXPIRED';
}

/** Lower rank = better. Drives both best-offer selection per listing
 *  and the default sort on the frontend. */
function statusRank(s: OfferStatus): number {
  return s === 'AVAILABLE' ? 0 : s === 'EXPECTED' ? 1 : 2;
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
  /** Status of the best offer for this listing — see OfferStatus. */
  bestOfferStatus:  OfferStatus;
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
  /** Total raw offers seen across all listings (all statuses). */
  offersFetched: number;
  /** Count of offers classified AVAILABLE (future-dated expiry). */
  offersAvailable: number;
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
  let totalFetched   = 0;
  let totalAvailable = 0;

  for (const l of sliced) {
    const mint = l.tokenMint ?? l.tokenAddress;
    if (!mint || typeof l.price !== 'number') continue;

    const offers = await fetchOffersReceived(mint);
    await sleep(REQUEST_GAP_MS);
    if (offers.length === 0) continue;
    if (offers[0]) maybeLogSampleKeys(offers[0]);

    // Keep ALL priced offers; classify status per spec. Best-of-listing
    // is picked by (status rank, price desc) so an AVAILABLE offer
    // always beats EXPECTED, which always beats EXPIRED — within a
    // status tier we still prefer the highest price.
    const priced = offers
      .filter(o => typeof o.price === 'number' && (o.price as number) > 0)
      .map(o => ({ offer: o, status: classifyOfferStatus(o, nowSec) }))
      .sort((a, b) => {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        if (ra !== rb) return ra - rb;
        return (b.offer.price as number) - (a.offer.price as number);
      });

    totalFetched   += offers.length;
    totalAvailable += priced.filter(p => p.status === 'AVAILABLE').length;

    if (priced.length === 0) continue;

    const best       = priced[0].offer;
    const bestStatus = priced[0].status;
    const bestPrice  = best.price as number;
    if (bestPrice < minOfferSol) continue;

    // Pick whichever timestamp field ME actually populated — see
    // extractCreatedAt for the full alias list and ms→s normalisation.
    const createdAt = extractCreatedAt(best);

    const bestOfferId = best.pdaAddress
      ?? `${mint}:${best.buyer ?? '?'}:${bestPrice}`;

    out.push({
      mint,
      nftName:            l.token?.name ?? null,
      imageUrl:           l.extra?.img ?? l.token?.image ?? null,
      listingPrice:       l.price,
      bestOfferPrice:     bestPrice,
      spreadSol:          bestPrice - l.price,
      bestOfferId,
      bestOfferStatus:    bestStatus,
      bestOfferCreatedAt: createdAt,
      meUrl:              `https://magiceden.io/item-details/${mint}`,
      tensorUrl:          `https://www.tensor.trade/item/${mint}`,
    });
  }

  // Default order: status priority first (AVAILABLE > EXPECTED > EXPIRED),
  // then highest best-offer price, then spread. Frontend can re-sort by
  // any column on click.
  out.sort((a, b) => {
    const ra = statusRank(a.bestOfferStatus);
    const rb = statusRank(b.bestOfferStatus);
    if (ra !== rb) return ra - rb;
    return b.bestOfferPrice - a.bestOfferPrice || b.spreadSol - a.spreadSol;
  });

  return {
    ok:              true,
    slug,
    scanned:         sliced.length,
    listedTotal:     listings.length,
    offersFetched:   totalFetched,
    offersAvailable: totalAvailable,
    withOffers:      out,
    cachedAt:        Date.now(),
    ttlMs:           CACHE_TTL_MS,
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
        `offersFetched=${result.offersFetched} offersAvailable=${result.offersAvailable} ` +
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
