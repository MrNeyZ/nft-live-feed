// VictoryLabs — Mints: shared filter predicates.
//
// Single source of truth for the Mint Tracker filter logic so the LEFT
// collections table and the RIGHT live mint feed can NEVER diverge. Both
// panels import these helpers; there is no panel-specific copy of the matching
// rules.
//
// Axes (multi-select Sets; empty Set === "Any" === no filter):
//   TYPE     — NFT standard bucket (cnft / core / candy). Works for both a
//              MintStatus row and a MintEvent (both carry programSource +
//              sourceLabel).
//   SOURCE   — launchpad origin (sourceLabel). Unified key set across both
//              panels (previously the feed lacked CORE).
//   STATUS   — collection-level lifecycle (active / watch / sold), derived from
//              the row. For a feed EVENT we map event → collection row via
//              groupingKey (see matchesStatusEvent).
//   TIMEFRAME— a numeric cutoff applied to row.lastMintAt / event.receivedAt.
//
// Groups combine as AND; keys within a group combine as OR.

import type { MintStatus } from './types';

export type FeedTypeKey = 'cnft' | 'core' | 'candy';
/** Unified launchpad-source keys — shared by table + feed (feed previously
 *  omitted CORE; now both honour it). */
export type SourceKey   = 'LMNFT' | 'VVV' | 'GRAVE' | 'CANDY' | 'CORE';
export type StatusKey   = 'active' | 'watch' | 'sold';

export const TYPE_KEYS:   ReadonlyArray<FeedTypeKey> = ['cnft', 'core', 'candy'];
export const SOURCE_KEYS: ReadonlyArray<SourceKey>   = ['LMNFT', 'VVV', 'GRAVE', 'CANDY', 'CORE'];
export const STATUS_KEYS: ReadonlyArray<StatusKey>   = ['active', 'watch', 'sold'];

/** TYPE axis — identical for rows and events (both expose programSource +
 *  sourceLabel). Empty set = Any. CANDY is matched by sourceLabel (the
 *  user-facing launchpad identity) rather than programSource, since Candy
 *  Machine drops ship token_metadata under the hood. */
export function matchesType(
  sel: ReadonlySet<FeedTypeKey>,
  programSource: string,
  sourceLabel: string,
): boolean {
  if (sel.size === 0) return true;
  return (
    (sel.has('cnft')  && programSource === 'bubblegum') ||
    (sel.has('core')  && programSource === 'mpl_core')  ||
    // CANDY type covers all Candy-Guard-routed mints — generic Candy
    // Machine + nfts.gay (CG behind the scenes, just relabelled for
    // the launchpad badge).
    (sel.has('candy') && (sourceLabel === 'Metaplex Candy Machine'
                       || sourceLabel === 'nfts.gay'))
  );
}

/** SOURCE axis — exact sourceLabel match. Empty set = Any. */
export function matchesSource(sel: ReadonlySet<SourceKey>, sourceLabel: string): boolean {
  if (sel.size === 0) return true;
  return (
    (sel.has('LMNFT') && sourceLabel === 'LaunchMyNFT')            ||
    (sel.has('VVV')   && sourceLabel === 'VVV')                    ||
    (sel.has('GRAVE') && sourceLabel === 'GRAVE')                  ||
    (sel.has('CANDY') && sourceLabel === 'Metaplex Candy Machine') ||
    (sel.has('CORE')  && sourceLabel === 'Metaplex Core')
  );
}

/** Collection lifecycle state — SAME rule the row badge uses (MintsTableRow):
 *  SOLD when the planned cap is fully minted, else ACTIVE when promoted
 *  (displayState 'shown'), else WATCH (incubating). */
export function deriveRowState(r: MintStatus): StatusKey {
  const soldOut = typeof r.maxSupply === 'number' && r.maxSupply > 0 && r.observedMints >= r.maxSupply;
  return soldOut ? 'sold' : (r.displayState === 'shown' ? 'active' : 'watch');
}

/** STATUS axis for a ROW. Empty set = Any. */
export function matchesStatusRow(sel: ReadonlySet<StatusKey>, r: MintStatus): boolean {
  if (sel.size === 0) return true;
  return sel.has(deriveRowState(r));
}

/** STATUS axis for a feed EVENT, resolved via its collection row by
 *  groupingKey (`statusByKey`, precomputed from the rows map).
 *
 *  Unknown-status policy (no row exists yet for the event's groupingKey):
 *    - STATUS = Any (empty set) → SHOW the event (no filter active).
 *    - a specific status selected → HIDE the event. We can't prove it matches
 *      the requested status, and showing it would reintroduce exactly the
 *      table/feed mismatch this change removes (table would hide the unknown
 *      collection, feed would still show its mints). Safe = hide. */
export function matchesStatusEvent(
  sel: ReadonlySet<StatusKey>,
  statusByKey: ReadonlyMap<string, StatusKey>,
  groupingKey: string,
): boolean {
  if (sel.size === 0) return true;
  const st = statusByKey.get(groupingKey);
  if (st === undefined) return false;
  return sel.has(st);
}

/** TIMEFRAME axis — shared cutoff comparison. `ts` is row.lastMintAt for the
 *  table or event.receivedAt for the feed. */
export function matchesTimeframe(ts: number, cutoff: number): boolean {
  return ts >= cutoff;
}
