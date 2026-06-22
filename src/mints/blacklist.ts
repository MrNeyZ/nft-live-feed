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

/** Deployer wallets (fee payer, accountKeys[0]) whose mints are suppressed
 *  entirely — same chokepoints as BLACKLISTED_COLLECTIONS. Loaded from
 *  `data/blocked-deployers.txt` at process start (one base58 address per
 *  line; # comments and blank lines ignored). Add a new wallet by appending
 *  its address to that file and restarting the backend. */
import * as fs from 'fs';
import * as path from 'path';

function loadBlockedDeployers(): Set<string> {
  const filePath = path.join(process.cwd(), 'data', 'blocked-deployers.txt');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const addrs = raw.split('\n')
      .map(l => l.replace(/#.*$/, '').trim())
      .filter(l => l.length > 0);
    if (addrs.length > 0) {
      console.log(`[mints/blacklist] loaded ${addrs.length} blocked deployer(s) from ${filePath}`);
    }
    return new Set(addrs);
  } catch {
    return new Set();
  }
}

export const BLACKLISTED_DEPLOYERS: ReadonlySet<string> = loadBlockedDeployers();

export function isDeployerBlacklisted(deployer: string | null | undefined): boolean {
  if (!deployer) return false;
  return BLACKLISTED_DEPLOYERS.has(deployer);
}

/** Collections whose mints are dropped before they reach SSE. */
export const BLACKLISTED_COLLECTIONS: ReadonlySet<string> = new Set([
  // phygitals___ (Magic Eden slug) — operator request.
  'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC',
  // collectiblescom (Magic Eden slug) — operator request.
  'EuZxduirhpWBYk4vKsrwzsrZk311FsTiKmQ57UFhGHh9',
  // Collector Crypt (MPL Core collection) — operator request. Resolved from
  // mint tx 4kahMtP1SNHXZRxbzXBwWBKr911K3NDwKLQkpZ4aEqfXdZaXQ7aJQ1iYbnWQPnk6VPj5hFMqd3pagk2gYLG8KYWy.
  'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac',
  // Dripshop Live (MPL Core collection) — operator request. Resolved from
  // mint tx 3kCVssihxpS8h5ggqkj9qUU23DgFV3GNx6nkqmXcWPfVkkEn7YrGcmi6u2TbRh3dMuPrkxvbt8ZCGWgqpA5PKRAk.
  'HeAu1tatE1jVcyW3mGyZRru2y6NjcD4cPKtqNy1tFWW6',
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
