/**
 * Bot API v1 collection snapshot builder.
 *
 * Pure orchestration — every number in the response comes from an
 * existing, already-tested analytics function or an existing indexed DB
 * query. This file adds NO new formulas:
 *   floorDepth  → computeFloorDepth()        (src/analytics/floor-depth.ts)
 *   crossMarket → computeCrossMarketGap()    (src/analytics/cross-market.ts)
 *   bids        → getBestCollectionBids()    (src/analytics/normalized-collection-bid.ts)
 *   recentSales → getEventsByCollection()    (src/db/queries.ts — same indexed
 *                 query GET /collections/trade-history already uses as its
 *                 DB-fallback path)
 * Listings themselves come from listings-store.ts's existing cache +
 * in-flight dedup (`ensureFresh` / `getByCollection`) — no direct fetch()
 * to ME/Tensor/Helius happens in this file or anywhere under bot-api/.
 *
 * Fail-soft: any one source failing does not fail the whole snapshot. It
 * sets `stale: true`, appends a warning, and the response still ships
 * whatever the other sources produced (mirrors collection-floor-depth.ts's
 * existing fail-soft convention for ensureFresh failures).
 */

import { ensureFresh as ensureFreshDefault, getByCollection as getByCollectionDefault, type Listing } from '../listings-store';
import { computeFloorDepth, type FloorDepthResult } from '../../analytics/floor-depth';
import { computeCrossMarketGap, type CrossMarketResult } from '../../analytics/cross-market';
import { getBestCollectionBids as getBestCollectionBidsDefault, type CollectionBidPair } from '../../analytics/normalized-collection-bid';
import { getEventsByCollection as getEventsByCollectionDefault, type SaleEventRow } from '../../db/queries';
import type { BotApiCollectionSnapshot, BotApiSaleSummary, BotApiWarning } from '../../domain/bot-api-types';

const RECENT_SALES_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const RECENT_SALES_LIMIT     = 10;                  // "keep the response minimal"

export interface SnapshotDeps {
  ensureFresh:          (slug: string) => Promise<void>;
  getByCollection:      (slug: string) => Listing[];
  getBestCollectionBids: (slug: string) => Promise<CollectionBidPair>;
  getEventsByCollection: (slug: string, since: Date, limit: number) => Promise<SaleEventRow[]>;
}

export const defaultSnapshotDeps: SnapshotDeps = {
  ensureFresh:           ensureFreshDefault,
  getByCollection:       getByCollectionDefault,
  getBestCollectionBids: getBestCollectionBidsDefault,
  getEventsByCollection: getEventsByCollectionDefault,
};

function toSaleSummary(row: SaleEventRow): BotApiSaleSummary | null {
  if (!row.signature || !row.mint_address) return null;
  return {
    signature:   row.signature,
    blockTime:   row.block_time,
    marketplace: row.marketplace,
    saleType:    row.sale_type,
    priceSol:    row.price_sol,
    mint:        row.mint_address,
  };
}

export interface SnapshotResult {
  collection: BotApiCollectionSnapshot;
  warnings:   BotApiWarning[];
  stale:      boolean;
}

/**
 * Assembles one collection's Bot API snapshot. Never throws — every
 * upstream call is individually try/caught so a single failing source
 * degrades to a documented warning instead of a 500. `slug` is assumed
 * already validated by the caller (route layer) — this function does no
 * shape validation of its own.
 */
export async function buildCollectionSnapshot(
  slug: string,
  deps: SnapshotDeps = defaultSnapshotDeps,
): Promise<SnapshotResult> {
  const warnings: BotApiWarning[] = [];
  let stale = false;

  try {
    await deps.ensureFresh(slug);
  } catch (err) {
    stale = true;
    warnings.push({
      code:    'listings_refresh_failed',
      message: `listings snapshot refresh failed for ${slug}; serving last-known-cached data: ${(err as Error).message}`,
    });
  }

  // getByCollection never throws (see listings-store.ts) — an unknown or
  // never-refreshed slug simply yields [].
  const listings: Listing[] = deps.getByCollection(slug);

  // Pure, synchronous, no I/O — same input snapshot for both, so the two
  // results are guaranteed internally consistent with each other.
  const floorDepth: FloorDepthResult   = computeFloorDepth(listings);
  const crossMarket: CrossMarketResult = computeCrossMarketGap(listings);
  for (const w of floorDepth.warnings)  warnings.push({ code: 'floor_depth',  message: w });
  for (const w of crossMarket.warnings) warnings.push({ code: 'cross_market', message: w });

  let bids: CollectionBidPair | null = null;
  try {
    bids = await deps.getBestCollectionBids(slug);
  } catch (err) {
    stale = true;
    warnings.push({
      code:    'bids_lookup_failed',
      message: `collection bid lookup failed for ${slug}: ${(err as Error).message}`,
    });
  }

  let recentSales: BotApiSaleSummary[] = [];
  try {
    const since = new Date(Date.now() - RECENT_SALES_WINDOW_MS);
    const rows  = await deps.getEventsByCollection(slug, since, RECENT_SALES_LIMIT);
    recentSales = rows.map(toSaleSummary).filter((s): s is BotApiSaleSummary => s !== null);
  } catch (err) {
    warnings.push({
      code:    'recent_sales_failed',
      message: `recent sales lookup failed for ${slug}: ${(err as Error).message}`,
    });
  }

  return {
    collection: { slug, floorDepth, crossMarket, bids, recentSales },
    warnings,
    stale,
  };
}
