/**
 * Magic Eden pre-aggregated "trending collections" stats — fetch + adapter.
 *
 *   Source: https://stats-mainnet.magiceden.io/collection_stats/search/solana
 *           ?window=<w>&sort=<s>&direction=<d>&limit=<n>&offset=<o>
 *
 * This module owns the upstream contract with ME and NEVER lets ME's raw
 * shape escape: every caller receives our normalized `TrendingCollection`
 * DTO. A single short-TTL cache + per-key in-flight dedup (mirror of
 * `me-stats.ts`) keeps concurrent callers from fanning out into duplicate
 * upstream requests for the same query.
 *
 * Failures are surfaced as typed errors so the route layer can map them to
 * the right HTTP status:
 *   - MeTrendingUpstreamError → ME unreachable / non-2xx / timeout → 502
 *   - MeTrendingSchemaError   → response wasn't the expected array → 502
 */

import { meAuthHeaders } from '../me-api-cooldown';

const ME_TRENDING_BASE = 'https://stats-mainnet.magiceden.io/collection_stats/search';
const ME_TRENDING_TTL_MS     = 45_000;
const ME_TRENDING_TIMEOUT_MS = 8_000;

/** Browser-like UA — ME's stats host 403s some non-browser agents. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Time windows ME accepts on this endpoint. Mirrors the spec; ME rejects
 *  anything else with a 4xx. */
export const TRENDING_RANGES = ['10m', '1h', '6h', '1d', '7d', '30d'] as const;
export type TrendingRange = (typeof TRENDING_RANGES)[number];

/** Window length (ms) for each range — single source of truth shared by the
 *  hover-sales-preview query, the internal (sale_events) aggregator, and the
 *  frontend's live-overlay windowing, so a range string maps to one window
 *  everywhere instead of several ad-hoc copies. */
export const RANGE_WINDOW_MS: Record<TrendingRange, number> = {
  '10m': 10 * 60_000,
  '1h':  60 * 60_000,
  '6h':  6 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
  '7d':  7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/** Exact `sort` enum ME exposed (captured from its own invalid-enum error
 *  payload). Whitelisting these means we forward only values ME will accept,
 *  so a bad `sort` is a local 400 — never an upstream round-trip. */
export const TRENDING_SORTS = [
  'volume',
  'volumePercentageChange',
  'totalVolume',
  'sales',
  'salesPercentageChange',
  'totalSales',
  'floorPrice',
  'floorPricePercentageChange',
  'topOffer',
  'listedOverSupply',
  'ownerPercentage',
  'pending',
  'marketCap',
  'ownerCount',
  'listedCount',
  'minted',
  'mintedVolume',
] as const;
export type TrendingSort = (typeof TRENDING_SORTS)[number];

export type TrendingDirection = 'asc' | 'desc';

/** Chains we currently allow. Solana only for now — the upstream path is
 *  `/search/<chain>`, so widening this later is a one-line change once a
 *  second chain is validated end-to-end. */
export const TRENDING_CHAINS = ['solana'] as const;
export type TrendingChain = (typeof TRENDING_CHAINS)[number];

/** Subset of ME's raw item we actually read. ME ships more fields; the index
 *  signature keeps the rest reachable without TS narrowing complaints but we
 *  never pass the raw object onward. */
interface MeTrendingRaw {
  name?: string;
  collectionSymbol?: string;
  collectionId?: string;
  image?: string;
  fp?: number;                 // floor price, SOL
  fpPctChg?: number;
  highestGlobalOffer?: number; // top offer, SOL
  vol?: number;                // window volume, SOL
  volPctChg?: number;
  txns?: number;               // window sales count
  txnsPctChg?: number;
  listedCount?: number;
  totalSupply?: number;
  ownerCount?: number;
  uniqueOwnerRatio?: number;
  isCompressed?: boolean;
  isVerified?: boolean;
  marketCap?: number;          // SOL
  marketCapUsd?: number;
  [k: string]: unknown;
}

/** Our normalized DTO — the ONLY trending shape that leaves the backend.
 *  `source: 'internal'` rows are our own sale_events aggregation, appended
 *  by the router to cover collections ME's own stats endpoint misses
 *  (notably Tensor-only activity — ME's collection_stats only counts
 *  ME-native volume). Internal rows carry `null` for every ME-only field
 *  (topOfferSol, all three *PctChange, listedCount/totalSupply/listedPct,
 *  ownerCount, uniqueOwnerRatio, isCompressed, isVerified, marketCapSol/Usd,
 *  image) — every consumer already renders `null` as `—`/placeholder. */
export interface TrendingCollection {
  slug: string;
  name: string | null;
  image: string | null;
  floorSol: number | null;
  topOfferSol: number | null;
  volumeSol: number | null;
  salesCount: number | null;
  floorPctChange: number | null;
  volumePctChange: number | null;
  salesPctChange: number | null;
  listedCount: number | null;
  totalSupply: number | null;
  listedPct: number | null;
  ownerCount: number | null;
  uniqueOwnerRatio: number | null;
  isCompressed: boolean | null;
  isVerified: boolean | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  /** Tensor's collection slug when known — may differ from `slug` (the ME
   *  slug). Used to build a correct Tensor external link instead of
   *  assuming the two slug systems always match. */
  tensorSlug: string | null;
  source: 'magic_eden' | 'internal';
  range: TrendingRange;
}

export interface TrendingQuery {
  chain: TrendingChain;
  range: TrendingRange;
  sort: TrendingSort;
  direction: TrendingDirection;
  limit: number;
  offset: number;
}

/** ME unreachable, timed out, or returned a non-2xx status. → 502. */
export class MeTrendingUpstreamError extends Error {
  readonly upstreamStatus: number;
  constructor(status: number, detail: string) {
    super(`ME trending upstream error: ${status} ${detail}`.trim());
    this.name = 'MeTrendingUpstreamError';
    this.upstreamStatus = status;
  }
}

/** ME responded 2xx but the body wasn't the array of objects we expect. → 502
 *  with a safe generic message (never echo the raw body to the client). */
export class MeTrendingSchemaError extends Error {
  constructor(detail: string) {
    super(`ME trending schema mismatch: ${detail}`);
    this.name = 'MeTrendingSchemaError';
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Adapt one raw ME item → our DTO. `listedPct` is derived (ME has no single
 *  field for it); everything else is a typed read with a null fallback so a
 *  missing/odd ME field degrades to null instead of leaking `undefined`. */
function adaptItem(raw: MeTrendingRaw, range: TrendingRange): TrendingCollection | null {
  const slug = str(raw.collectionSymbol) ?? str(raw.collectionId);
  // No slug = unidentifiable row; drop it rather than emit a keyless DTO.
  if (!slug) return null;

  const listedCount = num(raw.listedCount);
  const totalSupply = num(raw.totalSupply);
  const listedPct =
    listedCount != null && totalSupply != null && totalSupply > 0
      ? listedCount / totalSupply
      : null;

  return {
    slug,
    name: str(raw.name),
    image: str(raw.image),
    floorSol: num(raw.fp),
    topOfferSol: num(raw.highestGlobalOffer),
    volumeSol: num(raw.vol),
    salesCount: num(raw.txns),
    floorPctChange: num(raw.fpPctChg),
    volumePctChange: num(raw.volPctChg),
    salesPctChange: num(raw.txnsPctChg),
    listedCount,
    totalSupply,
    listedPct,
    ownerCount: num(raw.ownerCount),
    uniqueOwnerRatio: num(raw.uniqueOwnerRatio),
    isCompressed: bool(raw.isCompressed),
    isVerified: bool(raw.isVerified),
    marketCapSol: num(raw.marketCap),
    marketCapUsd: num(raw.marketCapUsd),
    tensorSlug: null,
    source: 'magic_eden',
    range,
  };
}

interface CacheEntry { data: TrendingCollection[]; fetchedAt: number }

const cache    = new Map<string, CacheEntry>();
const inFlight  = new Map<string, Promise<TrendingCollection[]>>();

function cacheKey(q: TrendingQuery): string {
  return `${q.chain}|${q.range}|${q.sort}|${q.direction}|${q.limit}|${q.offset}`;
}

/** Fetch + normalize ME trending collections for a fully-validated query.
 *  Throws MeTrendingUpstreamError / MeTrendingSchemaError on failure (so the
 *  route can map to 502); resolves to the normalized DTO array otherwise. */
export async function getTrendingCollections(q: TrendingQuery): Promise<TrendingCollection[]> {
  const key = cacheKey(q);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < ME_TRENDING_TTL_MS) return hit.data;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<TrendingCollection[]> => {
    const url =
      `${ME_TRENDING_BASE}/${encodeURIComponent(q.chain)}` +
      `?window=${encodeURIComponent(q.range)}` +
      `&sort=${encodeURIComponent(q.sort)}` +
      `&direction=${encodeURIComponent(q.direction)}` +
      `&limit=${q.limit}&offset=${q.offset}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...meAuthHeaders() },
        signal: AbortSignal.timeout(ME_TRENDING_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure / timeout — status 0 marks "never got a response".
      throw new MeTrendingUpstreamError(0, (err as Error)?.message?.slice(0, 100) ?? 'network');
    }

    if (!res.ok) {
      throw new MeTrendingUpstreamError(res.status, res.statusText || '');
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new MeTrendingSchemaError(`json parse failed: ${(err as Error)?.message?.slice(0, 80)}`);
    }

    if (!Array.isArray(body)) {
      throw new MeTrendingSchemaError('expected top-level array');
    }

    const data = body
      .map(item =>
        item && typeof item === 'object'
          ? adaptItem(item as MeTrendingRaw, q.range)
          : null,
      )
      .filter((x): x is TrendingCollection => x !== null);

    cache.set(key, { data, fetchedAt: Date.now() });
    return data;
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
