/**
 * Per-collection bid snapshot endpoint — powers the dashboard's ME BID / TNSR BID
 * columns with real data instead of placeholders.
 *
 * Sources:
 *   floor        = ME v2 `/collections/{slug}/stats`         (public)
 *   meBid        = ME v2 `/mmm/pools?collectionSymbol={slug}` top `spotPrice`
 *                  over pools with a poolType that can buy AND whose escrow
 *                  (`buysidePaymentAmount`) actually covers that spotPrice
 *                  (Stage 4.5 fix — see classifyFunding doc; previously any
 *                  pool with SOL > 0 qualified, which surfaced unfillable
 *                  quotes like mad_lads' 57.67 SOL / okay_bears' 6 SOL bids).
 *                  This is the top EXECUTABLE MMM (ME AMM) pool bid — a
 *                  stable public proxy for "best fillable bid on ME".
 *                  Individual escrowed offers are not exposed on the public
 *                  v2 API.
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
import { meAuthHeaders } from '../me-api-cooldown';

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

/**
 * Stage 4.5 fix: a pool is only genuinely fillable at its own quoted price
 * when its escrowed `buysidePaymentAmount` (bpa) covers that price, not
 * merely when bpa > 0. Confirmed live (Jul 2026 audit): mad_lads' top-quoted
 * pool showed spotPrice 57.67 SOL against bpa 2.30 SOL, okay_bears 6.00 SOL
 * against 0.067 SOL — both pass the old `> 0` check and both are actually
 * unfillable at the quoted price.
 *   - bpa >= spotPrice           → 'verified'      (can pay its own quote)
 *   - 0 <= bpa < spotPrice        → 'insufficient'  (real data, real shortfall)
 *   - bpa/spotPrice missing/NaN  → 'unknown'        (no usable data either way)
 */
export type MmmFundingState = 'verified' | 'insufficient' | 'unknown';

/** Exported for direct regression testing (collection-bids.test.ts) and for
 *  normalized-collection-bid.ts, should it ever need to reclassify a raw
 *  bpa/spot pair outside the candidate-fetch path. */
export function classifyFunding(bpa: unknown, spot: unknown): MmmFundingState {
  const bpaNum  = typeof bpa  === 'number' && Number.isFinite(bpa)  ? bpa  : null;
  const spotNum = typeof spot === 'number' && Number.isFinite(spot) && spot > 0 ? spot : null;
  if (bpaNum == null || spotNum == null) return 'unknown';
  return bpaNum >= spotNum ? 'verified' : 'insufficient';
}

/** One MMM buy/two_sided pool candidate, funding-classified. Exported for
 *  src/analytics/normalized-collection-bid.ts, which additionally needs the
 *  on-chain allowlist (eligibility) — a check this REST-only shape can't
 *  answer, hence the separate cached RPC lookup there instead of here. */
export interface MmmBidCandidate {
  spotPriceLamports:            number;
  buysidePaymentAmountLamports: number;
  poolAddress:                  string;
  owner:                        string | null;
  funding:                      MmmFundingState;
}

/** Richer result for offer-history.ts (src/analytics/offer-history.ts) —
 *  `getBidsForSlug` below only ever reads `.amountLamports` off this, so the
 *  dashboard /bids route's existing response shape is untouched. `funded`
 *  is now `true` iff `funding === 'verified'` (see classifyFunding) — a
 *  real, escrow-covers-quote fact, not merely "some SOL is on hand". */
export interface MmmTopBidResult {
  amountLamports: number;
  poolAddress:    string | null;
  owner:          string | null;
  funded:         boolean;
  funding:        MmmFundingState;
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

// Candidate list is fetched at most once per slug per TTL window — both
// fetchMmmTopBid (below) and the Stage 4.5 normalized-bid module need it,
// and without this cache each observation would double the REST calls.
const CANDIDATES_TTL_MS = 60_000;
const candidatesCache = new Map<string, { value: MmmBidCandidate[]; fetchedAt: number }>();

// ── MMM pools concurrency gate ──────────────────────────────────────────────
// Unlike Tensor (tensorFetch — a shared 1 req/sec serial gate), this ME
// endpoint had no ceiling at all: every caller (dashboard's /bids batch,
// offer-history.ts, normalized-collection-bid.ts) fires one `mmm/pools`
// fetch per uncached slug, all concurrently within a batch. A single
// /bids request already fanned out to up to 20 at once; once the dashboard
// started chunking past 20 visible slugs (instead of silently truncating),
// a cold cache (e.g. right after a restart) could burst to ~100 concurrent
// hits. Bounded here — global to the process, so it protects every caller,
// not just the dashboard — rather than left to each call site to pace
// itself. 5 concurrent is generous headroom over Tensor's serial 1/sec
// while still capping the worst-case burst by 20x.
const MMM_MAX_CONCURRENT = 5;
let mmmActive = 0;
const mmmQueue: Array<() => void> = [];

function acquireMmmSlot(): Promise<void> {
  if (mmmActive < MMM_MAX_CONCURRENT) { mmmActive++; return Promise.resolve(); }
  return new Promise<void>((resolve) => { mmmQueue.push(() => { mmmActive++; resolve(); }); });
}
function releaseMmmSlot(): void {
  mmmActive--;
  const next = mmmQueue.shift();
  if (next) next();
}

async function fetchMmmPoolCandidates(slug: string): Promise<MmmBidCandidate[]> {
  const hit = candidatesCache.get(slug);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < CANDIDATES_TTL_MS) return hit.value;

  let out: MmmBidCandidate[] = [];
  await acquireMmmSlot();
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/mmm/pools?collectionSymbol=${encodeURIComponent(slug)}&limit=50`,
      { headers: meAuthHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const json = await res.json() as MmmPoolsResponse;
      const pools = json.results ?? [];
      for (const p of pools) {
        // A pool can only ever take our NFT if its poolType includes 'buy'
        // and it quotes a positive spotPrice. Funding is classified, never
        // filtered out here — an insufficient/unknown pool is still a real
        // candidate for market-context purposes (see classifyFunding doc).
        if (p.poolType !== 'buy' && p.poolType !== 'two_sided') continue;
        if (!p.poolKey || !(typeof p.spotPrice === 'number' && p.spotPrice > 0)) continue;
        out.push({
          spotPriceLamports:            p.spotPrice,
          buysidePaymentAmountLamports: p.buysidePaymentAmount ?? 0,
          poolAddress:                  p.poolKey,
          owner:                        p.poolOwner ?? null,
          funding:                      classifyFunding(p.buysidePaymentAmount, p.spotPrice),
        });
      }
    }
  } catch { /* fail soft — empty candidate list */ }
  finally { releaseMmmSlot(); }

  candidatesCache.set(slug, { value: out, fetchedAt: now });
  return out;
}

export interface MmmBidSnapshot {
  /** Top pool among VERIFIED-funded candidates only — the only one safe to
   *  call "executable". Null when no pool can actually pay its own quote. */
  best:       MmmBidCandidate | null;
  /** Top pool by spotPrice regardless of funding state — for market-context
   *  display only. May equal `best`, may be underfunded, may be the only
   *  candidate that exists. Never treat as executable on its own. */
  topOverall: MmmBidCandidate | null;
}

/** Exported for src/analytics/normalized-collection-bid.ts — the single
 *  shared candidate fetch + classification, so the normalized model and
 *  fetchMmmTopBid's back-compat contract stay consistent with each other. */
export async function fetchMmmBidSnapshot(slug: string): Promise<MmmBidSnapshot> {
  const candidates = await fetchMmmPoolCandidates(slug);
  if (!candidates.length) return { best: null, topOverall: null };
  const sorted = [...candidates].sort((a, b) => b.spotPriceLamports - a.spotPriceLamports);
  const topOverall = sorted[0];
  const best = sorted.find(c => c.funding === 'verified') ?? null;
  return { best, topOverall };
}

/**
 * Top EXECUTABLE MMM (ME AMM) pool bid for a collection — Stage 4.5: only
 * ever returns a pool whose escrow can actually cover its own quoted price
 * (`funding === 'verified'`). Underfunded pools (the mad_lads/okay_bears
 * bug — see classifyFunding doc) never surface here; use
 * `fetchMmmBidSnapshot`'s `topOverall` for market-context display of an
 * underfunded quote. Pool ALLOWLIST eligibility (collection-wide vs
 * exact-mint-restricted) is still NOT checked here — see
 * src/analytics/normalized-collection-bid.ts for that on-chain check.
 * `spotPrice` is a gross, fee-exclusive curve quote (same semantics as
 * floor-depth.ts's MMM handling).
 */
export async function fetchMmmTopBid(slug: string): Promise<MmmTopBidResult | null> {
  const { best } = await fetchMmmBidSnapshot(slug);
  if (!best) return null;
  return {
    amountLamports: best.spotPriceLamports,
    poolAddress:    best.poolAddress,
    owner:          best.owner,
    funded:         true,
    funding:        'verified',
  };
}

interface TensorCollStats {
  stats?: {
    priceUnit?:          string;
    buyNowPrice?:        string;
    sellNowPrice?:       string;
    /** Net-of-fees counterpart to sellNowPrice — confirmed live (Jul 2026
     *  audit): mad_lads returned sellNowPrice 8.0010 SOL (gross) alongside
     *  sellNowPriceNetFees 7.5049 SOL (net), a ~6.2% gap matching
     *  sellRoyaltyFeeBPS + Tensor's own cut. `sellNowPrice` is GROSS. */
    sellNowPriceNetFees?: string;
  };
}

export interface TensorTopBidDetail {
  grossLamports: number;
  netLamports:   number | null;
}

/** Exported for src/analytics/normalized-collection-bid.ts — exposes BOTH
 *  the gross quote and (when present) the net-of-fees figure, so callers can
 *  choose the correct basis instead of assuming `sellNowPrice` is net (the
 *  old comment on fetchTensorTopBid implied "what you'd get", which reads as
 *  net but is actually gross — see TensorCollStats doc). */
export async function fetchTensorTopBidDetailed(slug: string): Promise<TensorTopBidDetail | null> {
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
    const grossRaw = json?.stats?.sellNowPrice;
    const gross = grossRaw ? Number(grossRaw) : NaN;
    if (!Number.isFinite(gross) || gross <= 0) return null;
    const netRaw = json?.stats?.sellNowPriceNetFees;
    const net = netRaw ? Number(netRaw) : NaN;
    return { grossLamports: gross, netLamports: Number.isFinite(net) && net > 0 ? net : null };
  } catch {
    return null;
  }
}

/** Back-compat: gross lamports only. Exported for offer-history.ts reuse —
 *  see fetchMmmTopBid's own doc note. Prefer fetchTensorTopBidDetailed for
 *  any new caller that needs the net-of-fees figure. */
export async function fetchTensorTopBid(slug: string): Promise<number | null> {
  const detail = await fetchTensorTopBidDetailed(slug);
  return detail?.grossLamports ?? null;
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
