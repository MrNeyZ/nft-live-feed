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

import * as fs from 'fs';
import * as path from 'path';

// ── Deployer blacklist ────────────────────────────────────────────────────────
// Blocks all mints whose fee payer (accountKeys[0]) is in this set.
// Populated from data/blocked-deployers.txt at startup; auto-updated at
// runtime by trackDeployerMint() when a single wallet mints across
// more than BULK_COLLECTION_THRESHOLD distinct collections within
// BULK_WINDOW_MS. Persisted back to the file so restarts retain it.

const DEPLOYERS_FILE = path.join(process.cwd(), 'data', 'blocked-deployers.txt');
const BULK_WINDOW_MS              = 10 * 60_000; // 10 minutes
const BULK_COLLECTION_THRESHOLD   = 3;           // >3 distinct collections → bulk

function loadBlockedDeployers(): Set<string> {
  try {
    const raw = fs.readFileSync(DEPLOYERS_FILE, 'utf8');
    const addrs = raw.split('\n')
      .map(l => l.replace(/#.*$/, '').trim())
      .filter(l => l.length > 0);
    if (addrs.length > 0) {
      console.log(`[mints/blacklist] loaded ${addrs.length} blocked deployer(s)`);
    }
    return new Set(addrs);
  } catch {
    return new Set();
  }
}

export interface BlockedDeployerEntry {
  address:        string;
  source:         'manual' | 'auto';
  blockedAt?:     number;   // ms epoch, only for auto-blocked
  collectionCount?: number; // distinct collections at time of block
}

// Mutable at runtime — new auto-detected deployers are added here.
const _blockedDeployers: Set<string> = loadBlockedDeployers();

// In-memory log of auto-blocked entries (metadata for the UI).
const _autoLog: BlockedDeployerEntry[] = [];

export function getBlockedDeployersList(): BlockedDeployerEntry[] {
  return [..._blockedDeployers].map(address => {
    const auto = _autoLog.find(e => e.address === address);
    return auto ?? { address, source: 'manual' };
  });
}

export function isDeployerBlacklisted(deployer: string | null | undefined): boolean {
  if (!deployer) return false;
  return _blockedDeployers.has(deployer);
}

function persistDeployer(deployer: string): void {
  try {
    fs.appendFileSync(DEPLOYERS_FILE, `${deployer}\n`);
  } catch (err) {
    console.warn(`[mints/blacklist] failed to persist deployer ${deployer}: ${(err as Error).message}`);
  }
}

// ── Sliding-window bulk-deployer detector ────────────────────────────────────
// Per deployer: ring of (collectionKey, timestamp) pairs pruned to BULK_WINDOW_MS.

interface CollectionStamp { key: string; ts: number }
const _deployerWindow = new Map<string, CollectionStamp[]>();

/** Called from recordMint for every accepted (non-blacklisted) mint.
 *  Returns true if the deployer was newly auto-blocked. */
export function trackDeployerMint(
  deployer: string | null | undefined,
  collectionKey: string | null | undefined,
): boolean {
  if (!deployer || !collectionKey || _blockedDeployers.has(deployer)) return false;

  const now = Date.now();
  let stamps = _deployerWindow.get(deployer);
  if (!stamps) { stamps = []; _deployerWindow.set(deployer, stamps); }

  // Prune expired entries.
  const cutoff = now - BULK_WINDOW_MS;
  let i = 0;
  while (i < stamps.length && stamps[i].ts < cutoff) i++;
  if (i > 0) stamps.splice(0, i);

  // Add current collection if not already present in the window.
  if (!stamps.some(s => s.key === collectionKey)) {
    stamps.push({ key: collectionKey, ts: now });
  }

  if (stamps.length > BULK_COLLECTION_THRESHOLD) {
    _blockedDeployers.add(deployer);
    _deployerWindow.delete(deployer);
    const entry: BlockedDeployerEntry = {
      address: deployer, source: 'auto',
      blockedAt: Date.now(), collectionCount: stamps.length,
    };
    _autoLog.push(entry);
    console.log(
      `[mints/blacklist] auto-blocked deployer=${deployer} ` +
      `reason=bulk collections=${stamps.length} window=${BULK_WINDOW_MS / 60_000}min`,
    );
    persistDeployer(deployer);
    return true;
  }
  return false;
}

// ── Collection blacklist ──────────────────────────────────────────────────────

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
