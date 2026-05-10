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
  e: Pick<FeedEvent, 'nftType' | 'meCollectionSlug'>,
  floorSolBySlug: (slug: string) => number | null | undefined,
): boolean {
  if (e.nftType !== 'cnft' || !e.meCollectionSlug) return false;
  const floor = floorSolBySlug(e.meCollectionSlug);
  return floor != null && floor <= CNFT_MIN_VISIBLE_FLOOR_SOL;
}
