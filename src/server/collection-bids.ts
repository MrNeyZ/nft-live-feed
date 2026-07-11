/**
 * Per-collection bid snapshot endpoint — powers the dashboard's ME BID / TNSR BID
 * columns with real data instead of placeholders.
 *
 * Sources:
 *   floor        = ME v2 `/collections/{slug}/stats`         (public)
 *   meBid        = ME v2 `/mmm/pools?collectionSymbol={slug}` top `spotPrice`
 *                  over pools with buy-side SOL and a poolType that can buy.
 *                  This is the top MMM (ME AMM) pool bid — a stable public
 *                  proxy for "best bid on ME". Individual escrowed offers are
 *                  not exposed on the public v2 API.
 *   tnsrBid      = Tensor `api.mainnet.tensordev.io` top collection bid when
 *                  `TENSOR_API_KEY` is set. Null otherwise (no public Tensor
 *                  bid endpoint exists without a key).
 *
 * Values are returned as lamports (or null). Each slug cached for BID_TTL_MS.
 * Client pings every ~60s for visible slugs — cache absorbs duplicate slugs
 * across concurrent dashboard tabs.
 */

import { Router, Request, Response } from 'express';
import { getMeStats } from '../enrichment/me-stats';
import { rateLimit, isValidSlug, isValidMint } from './rate-limit';
import { resolveTensorMeta, tensorFetch } from './listings-store';

const BID_TTL_MS = 60_000;
// Lowered 80 → 20 per H2: per-request fan-out budget is now bounded
// regardless of caller. Dashboard / Live Feed bid-cache prefetch calls
// in chunks of ≤ 20, so legitimate usage is unaffected.
const MAX_SLUGS_PER_REQUEST = 20;

interface CachedBids {
  floorLamports:    number | null;
  meBidLamports:    number | null;
  tnsrBidLamports:  number | null;
  listedCount:      number | null;
  volumeAllLamports: number | null;
  fetchedAt:        number;
}

const cache = new Map<string, CachedBids>();

interface MeStatsOut {
  floorLamports:     number | null;
  listedCount:       number | null;
  volumeAllLamports: number | null;
}
interface MmmPool {
  spotPrice?: number;
  poolType?: string;           // 'buy' | 'two_sided' | 'sell'
  buysidePaymentAmount?: number;
  poolKey?: string;
  poolOwner?: string;
}
interface MmmPoolsResponse { results?: MmmPool[] }

/** Richer result for offer-history.ts (src/analytics/offer-history.ts) —
 *  `getBidsForSlug` below only ever reads `.amountLamports` off this, so the
 *  dashboard /bids route's existing response shape is untouched. `funded`
 *  mirrors the SAME `buysidePaymentAmount > 0` check `fetchMmmTopBid`
 *  already made to decide eligibility — just no longer discarded after the
 *  fact. This is ME's own self-reported on-chain balance (from their
 *  indexer), not an independent RPC verification. */
export interface MmmTopBidResult {
  amountLamports: number;
  poolAddress:    string | null;
  owner:          string | null;
  funded:         boolean;
}

async function fetchMeStats(slug: string): Promise<MeStatsOut> {
  const json = await getMeStats(slug);
  if (!json) return { floorLamports: null, listedCount: null, volumeAllLamports: null };
  return {
    floorLamports: typeof json.floorPrice === 'number' && json.floorPrice > 0 ? json.floorPrice : null,
    listedCount:   typeof json.listedCount === 'number' && json.listedCount >= 0 ? json.listedCount : null,
    volumeAllLamports: typeof json.volumeAll === 'number' && json.volumeAll >= 0 ? json.volumeAll : null,
  };
}

/**
 * Top MMM (ME AMM) pool bid for a collection. Exported (not just used
 * internally) so src/analytics/offer-history.ts can reuse this single
 * fetcher/cache-free call site instead of re-implementing the same request —
 * see that module's own audit notes on pool-allowlist eligibility (NOT
 * checked here — this only confirms poolType + a non-zero buy-side balance,
 * never that a SPECIFIC NFT is eligible for this pool) and on `spotPrice`
 * being a gross, fee-exclusive curve quote (same semantics as
 * floor-depth.ts's MMM handling).
 */
export async function fetchMmmTopBid(slug: string): Promise<MmmTopBidResult | null> {
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/mmm/pools?collectionSymbol=${encodeURIComponent(slug)}&limit=50`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as MmmPoolsResponse;
    const pools = json.results ?? [];
    let best: MmmPool | null = null;
    for (const p of pools) {
      // A pool can take our NFT only if its poolType includes 'buy' and it has
      // SOL on hand. spotPrice is the current quoted bid in lamports.
      const canBuy = (p.poolType === 'buy' || p.poolType === 'two_sided')
        && (p.buysidePaymentAmount ?? 0) > 0;
      if (!canBuy) continue;
      if ((p.spotPrice ?? 0) > (best?.spotPrice ?? 0)) best = p;
    }
    if (!best || !best.spotPrice || best.spotPrice <= 0) return null;
    return {
      amountLamports: best.spotPrice,
      poolAddress:    best.poolKey   ?? null,
      owner:          best.poolOwner ?? null,
      funded:         (best.buysidePaymentAmount ?? 0) > 0,
    };
  } catch {
    return null;
  }
}

interface TensorCollStats {
  stats?: { priceUnit?: string; buyNowPrice?: string; sellNowPrice?: string };
}

/** Exported for offer-history.ts reuse — see fetchMmmTopBid's own doc note. */
export async function fetchTensorTopBid(slug: string): Promise<number | null> {
  if (!process.env.TENSOR_API_KEY) return null;
  try {
    // Reuse the listings-store resolver + alias cache so our ME slug maps to
    // Tensor's collId once (cached for the process), then fetch live stats by
    // collId. Both calls go through the shared `tensorFetch` gate, so dashboard
    // bids and listings share one global 1 req/sec limit (no request storm).
    const meta = await resolveTensorMeta(slug);
    if (!meta) return null;
    const res = await tensorFetch(
      `https://api.mainnet.tensordev.io/api/v1/collections/find_collection`
      + `?filter=${encodeURIComponent(meta.collId)}`,
    );
    if (!res.ok) return null;
    const json = await res.json() as TensorCollStats;
    // sellNowPrice (lamports) = what you'd get *selling now* into the top
    // collection bid — i.e. the top Tensor bid.
    const sell = json?.stats?.sellNowPrice;
    const n = sell ? Number(sell) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function getBidsForSlug(slug: string): Promise<CachedBids> {
  const hit = cache.get(slug);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < BID_TTL_MS) return hit;

  const [stats, mmmBid, tnsrBidLamports] = await Promise.all([
    fetchMeStats(slug),
    fetchMmmTopBid(slug),
    fetchTensorTopBid(slug),
  ]);
  const entry: CachedBids = {
    floorLamports:    stats.floorLamports,
    listedCount:      stats.listedCount,
    volumeAllLamports: stats.volumeAllLamports,
    // Route response is unchanged — still a bare lamports number (or null).
    // `mmmBid`'s richer poolAddress/owner/funded fields are for
    // offer-history.ts, not this dashboard endpoint.
    meBidLamports:    mmmBid?.amountLamports ?? null,
    tnsrBidLamports,
    fetchedAt: now,
  };
  cache.set(slug, entry);
  return entry;
}

// ── cNFT collection floor by on-chain collection ADDRESS ────────────────────
// Slug-less cNFT collections (DRiP / Tensor-native) never get an ME slug, so
// the slug-keyed floor above — and the frontend `isCnftDust` predicate — can't
// run, and they leak into the feed regardless of a dust floor. Resolve the
// Tensor collId straight from the collection address (`resolveTensorMeta` →
// tensordev `find_collection?filter=<address>`) and read the single cheapest
// active listing as the floor. Cached per address (hit AND miss) so a hot
// collection costs at most one Tensor round-trip per TTL; `tensorFetch` already
// serializes tensordev calls at ≥1 req/s. Returns null on any miss — the caller
// (and the frontend predicate) then FAILS SAFE and shows the collection.
const CNFT_FLOOR_TTL_MS = 120_000;
const cnftFloorCache = new Map<string, { floorLamports: number | null; fetchedAt: number }>();

async function fetchCnftFloorByAddress(address: string): Promise<number | null> {
  if (!process.env.TENSOR_API_KEY) return null;
  const meta = await resolveTensorMeta(address);
  if (!meta) return null;
  const res = await tensorFetch(
    'https://api.mainnet.tensordev.io/api/v1/mint/active_listings'
    + `?collId=${encodeURIComponent(meta.collId)}&sortBy=ListingPriceAsc&limit=1`,
  );
  if (!res.ok) return null;
  const json = await res.json() as { mints?: Array<{ listing?: { price?: string } }> };
  const raw = json.mints?.[0]?.listing?.price;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getCnftFloorForAddress(address: string): Promise<number | null> {
  const hit = cnftFloorCache.get(address);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < CNFT_FLOOR_TTL_MS) return hit.floorLamports;
  let floorLamports: number | null = null;
  try { floorLamports = await fetchCnftFloorByAddress(address); }
  catch { floorLamports = null; }
  cnftFloorCache.set(address, { floorLamports, fetchedAt: now });
  return floorLamports;
}

export function createCollectionBidsRouter(): Router {
  const router = Router();
  // 60 req/min/IP covers a steady dashboard refresh (every 30 s) per
  // tab + headroom; stops a rotating-slug attacker cold while leaving
  // normal page UX untouched.
  const bidsLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'collections/bids' });

  router.get('/bids', bidsLimit, async (req: Request, res: Response) => {
    const raw = String(req.query.slugs ?? '').trim();
    if (!raw) {
      res.json({ bids: {} });
      return;
    }
    // Validate-then-cap. Slugs that don't match the canonical shape
    // never see an upstream ME/Tensor call — slug bypass via crafted
    // strings (`/api/collections/bids?slugs=<garbage>`) used to cost
    // 3 fetches per garbage entry. Cheap regex test up front.
    const slugs = Array.from(new Set(
      raw.split(',').map(s => s.trim()).filter(isValidSlug),
    )).slice(0, MAX_SLUGS_PER_REQUEST);

    try {
      const entries = await Promise.all(slugs.map(async (slug) => {
        const b = await getBidsForSlug(slug);
        return [slug, {
          floorLamports:    b.floorLamports,
          meBidLamports:    b.meBidLamports,
          tnsrBidLamports:  b.tnsrBidLamports,
          listedCount:      b.listedCount,
          volumeAllLamports: b.volumeAllLamports,
        }] as const;
      }));
      res.json({ bids: Object.fromEntries(entries) });
    } catch (err) {
      console.error('[collection-bids] error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // cNFT collection floor by on-chain collection address — the slug-less
  // counterpart to /bids. Powers the frontend cNFT dust filter for DRiP /
  // Tensor cNFT collections that carry no ME slug. Same rate budget as /bids.
  const cnftFloorLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'collections/cnft-floor' });
  router.get('/cnft-floor', cnftFloorLimit, async (req: Request, res: Response) => {
    const raw = String(req.query.addresses ?? '').trim();
    if (!raw) {
      res.json({ floors: {} });
      return;
    }
    const addresses = Array.from(new Set(
      raw.split(',').map(s => s.trim()).filter(isValidMint),
    )).slice(0, MAX_SLUGS_PER_REQUEST);

    try {
      const entries = await Promise.all(addresses.map(async (address) => {
        const floorLamports = await getCnftFloorForAddress(address);
        return [address, { floorLamports }] as const;
      }));
      res.json({ floors: Object.fromEntries(entries) });
    } catch (err) {
      console.error('[collection-bids] cnft-floor error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
