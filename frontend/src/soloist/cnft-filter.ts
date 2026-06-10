// Shared cNFT dust-floor rule.
//
// Hide cNFT low-floor noise by collection floor, not sale price. Backend
// already discards cNFT *sales* under 0.002 SOL at parse time
// (`src/ingestion/*` — see CLAUDE.md "cNFT price filter"). This module is the
// matching frontend gate: hide any cNFT collection whose CURRENT FLOOR is at
// or below 0.005 SOL, regardless of what an individual sale printed at — a
// 0.2 SOL sale on a 0.004-floor collection is still dust by collection. Both
// Live Feed (per-event) and Dashboard (pre-aggregate) import the predicate so
// the two surfaces stay in lockstep — no second drift-prone copy.

import type { FeedEvent } from './mock-data';

export const CNFT_MIN_VISIBLE_FLOOR_SOL = 0.005;

/**
 * Returns true when an event should be hidden as cNFT dust. Predicate keys on
 * the COLLECTION FLOOR — not the event's sale price — so a high-priced sale
 * on a dust-floor collection still gets hidden, and a sub-floor sale on a
 * legitimate collection still shows.
 *
 * Fail-safe: an unknown floor never filters — we'd rather show a collection
 * briefly than suppress one whose floor hasn't loaded yet. Both callers
 * populate the floor lookup from `/api/collections/bids`, so "unknown"
 * converges to "known" within one fetch tick.
 */
export function isCnftDust(
  e: Pick<FeedEvent, 'nftType' | 'meCollectionSlug' | 'collectionAddress'>,
  floorSolByKey: (key: string) => number | null | undefined,
): boolean {
  if (e.nftType !== 'cnft') return false;
  // Floor lookup key: prefer the ME slug (existing flow, unchanged); fall back
  // to the on-chain collection address for slug-less Tensor / DRiP cNFTs, whose
  // floor is resolved via the address-keyed `/api/collections/cnft-floor`
  // endpoint. Both keys resolve into the SAME collection-floor map.
  const key = e.meCollectionSlug ?? e.collectionAddress ?? null;
  if (!key) return false;
  const floor = floorSolByKey(key);
  return floor != null && floor <= CNFT_MIN_VISIBLE_FLOOR_SOL;
}
