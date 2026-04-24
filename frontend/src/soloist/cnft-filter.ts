// Shared cNFT dust-floor rule.
//
// Backend already discards cNFT *sales* under 0.002 SOL at parse time
// (`src/ingestion/*` — see CLAUDE.md "cNFT price filter"). This module is the
// matching frontend gate: hide any cNFT collection whose CURRENT FLOOR is
// below 0.002 SOL. Both Live Feed (per-event) and Dashboard (pre-aggregate)
// import the predicate so the two surfaces stay in lockstep — no second
// drift-prone copy.

import type { FeedEvent } from './mock-data';

export const CNFT_FLOOR_MIN_SOL = 0.002;

/**
 * Returns true when an event should be hidden as cNFT dust. Fail-safe: an
 * unknown floor never filters — we'd rather show a collection briefly than
 * suppress one whose floor hasn't loaded yet. Both callers populate the floor
 * lookup from `/api/collections/bids`, so "unknown" converges to "known"
 * within one fetch tick.
 */
export function isCnftDust(
  e: Pick<FeedEvent, 'nftType' | 'meCollectionSlug'>,
  floorSolBySlug: (slug: string) => number | null | undefined,
): boolean {
  if (e.nftType !== 'cnft' || !e.meCollectionSlug) return false;
  const floor = floorSolBySlug(e.meCollectionSlug);
  return floor != null && floor < CNFT_FLOOR_MIN_SOL;
}
