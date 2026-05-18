/**
 * Hard collection blacklist for the mint tracker.
 *
 * Single source of truth for "this collection must never reach any
 * mint surface". Imported by both `accumulator.ts:recordMint` (blocks
 * the `mint` / `mint_status` SSE channels + the accumulator row + the
 * `recentMints` ring) and `collection-confirm.ts` (blocks the
 * out-of-band `mint_meta` patch). Together those two chokepoints
 * suppress every mint surface — /mints table, live feed, recentMints
 * replay on SSE connect, late metadata patches — without touching the
 * detectors themselves, so the blacklist applies uniformly across
 * existing LMNFT / VVV / GRAVE branches AND any future labels we add.
 *
 * Matching is exact base58 address compare. No slug / name / partial
 * match — the only knob that could ever mute an unrelated collection
 * is appending its address to the set below.
 *
 * Adding entries: hard-code into BLACKLISTED_COLLECTIONS with a
 * one-line comment explaining the reason. Do NOT load from .env / DB
 * / config files — this list must survive process restarts without
 * any external dependency.
 */

/** Collections whose mints are dropped before they reach SSE. */
export const BLACKLISTED_COLLECTIONS: ReadonlySet<string> = new Set([
  // phygitals___ (Magic Eden slug) — operator request.
  'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC',
  // collectiblescom (Magic Eden slug) — operator request.
  'EuZxduirhpWBYk4vKsrwzsrZk311FsTiKmQ57UFhGHh9',
]);

/** Lifetime-bounded log gate: each blacklisted collection logs once
 *  the first time it's dropped, never again. Bounded by
 *  BLACKLISTED_COLLECTIONS.size, so no memory concern. */
const loggedDrops = new Set<string>();

/** True iff `addr` is in the blacklist. Null/empty/undefined are
 *  short-circuited to false so a parser-missing collection address
 *  doesn't accidentally match. */
export function isCollectionBlacklisted(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return BLACKLISTED_COLLECTIONS.has(addr);
}

/** Called from every chokepoint that drops an event due to this
 *  blacklist. Logs `[mints/blacklist] drop collection=<addr>` exactly
 *  once per unique address per process lifetime so a hot launch in
 *  the muted collection can't flood the log. */
export function noteBlacklistDrop(addr: string): void {
  if (loggedDrops.has(addr)) return;
  loggedDrops.add(addr);
  console.log(`[mints/blacklist] drop collection=${addr}`);
}
