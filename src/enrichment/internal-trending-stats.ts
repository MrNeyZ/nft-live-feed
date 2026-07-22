/**
 * Internal (sale_events) trending supplement.
 *
 * ME's own `collection_stats` endpoint (see me-trending-stats.ts) only counts
 * ME-native volume (ME marketplace + ME AMM/MMM pools) — Tensor sales never
 * appear in it, even for collections ME otherwise recognizes. This module
 * aggregates our own ingestion (`sale_events` — ME v2/AMM + Tensor TComp/TAMM
 * via src/ingestion/listener.ts) over the same range windows, in the same
 * `TrendingCollection` DTO shape, so the router can append rows for whatever
 * ME's response is missing without any special-casing downstream.
 *
 * Every ME-only field (topOfferSol, the three *PctChange fields, listed/
 * supply/owner/marketCap, image, isVerified/isCompressed) is `null` here —
 * intentional: we have no ME-side historical baseline or collection
 * metadata for these rows. Every consumer of TrendingCollection already
 * renders `null` as a placeholder, so this needs no downstream changes.
 */

import { getPool } from '../db/client';
import { RANGE_WINDOW_MS, type TrendingCollection, type TrendingRange } from './me-trending-stats';

const CACHE_TTL_MS = 30_000;

interface CacheEntry { data: TrendingCollection[]; fetchedAt: number }
const cache    = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TrendingCollection[]>>();

interface InternalRow {
  me_collection_slug: string;
  name: string | null;
  tensor_slug: string | null;
  sales_count: string;   // bigint → text via pg
  volume_sol: string | null;
  floor_sol: string | null;
}

const INTERNAL_TRENDING_SQL = `
  SELECT
    me_collection_slug,
    mode() WITHIN GROUP (ORDER BY collection_name)     AS name,
    mode() WITHIN GROUP (ORDER BY tensor_collection_slug)
      FILTER (WHERE tensor_collection_slug IS NOT NULL) AS tensor_slug,
    count(*)                                            AS sales_count,
    sum(price_sol)                                       AS volume_sol,
    min(price_sol)                                       AS floor_sol
  FROM sale_events
  WHERE me_collection_slug IS NOT NULL
    AND block_time >= $1
  GROUP BY me_collection_slug
`;

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Aggregate sale_events into TrendingCollection rows for one range. Cached
 *  + in-flight-deduped the same way me-trending-stats.ts caches ME's own
 *  response, so concurrent requests for the same range share one query. */
export async function getInternalTrendingStats(range: TrendingRange): Promise<TrendingCollection[]> {
  const now = Date.now();
  const hit = cache.get(range);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.data;

  const pending = inFlight.get(range);
  if (pending) return pending;

  const task = (async (): Promise<TrendingCollection[]> => {
    const since = new Date(now - RANGE_WINDOW_MS[range]);
    const pool = getPool();
    const { rows } = await pool.query<InternalRow>(INTERNAL_TRENDING_SQL, [since]);

    const data: TrendingCollection[] = rows.map(r => ({
      slug: r.me_collection_slug,
      name: r.name,
      image: null,
      floorSol: num(r.floor_sol),
      topOfferSol: null,
      volumeSol: num(r.volume_sol),
      salesCount: num(r.sales_count),
      floorPctChange: null,
      volumePctChange: null,
      salesPctChange: null,
      listedCount: null,
      totalSupply: null,
      listedPct: null,
      ownerCount: null,
      uniqueOwnerRatio: null,
      isCompressed: null,
      isVerified: null,
      marketCapSol: null,
      marketCapUsd: null,
      tensorSlug: r.tensor_slug,
      source: 'internal',
      range,
    }));

    cache.set(range, { data, fetchedAt: Date.now() });
    return data;
  })();

  inFlight.set(range, task);
  try {
    return await task;
  } finally {
    inFlight.delete(range);
  }
}
