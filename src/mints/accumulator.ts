/**
 * In-memory mint accumulator.
 *
 * One entry per `groupingKey`; tracks observed mint count, rolling
 * 60s/5min velocity, last-mint timestamp, and aggregate price/type.
 * Display-state gates (incubating → shown → cooled) decide which
 * collections appear in the trending list. No RPC, no DB — pure state.
 *
 * Bounded LRU: evicts entries idle for ACC_IDLE_EVICT_MS to bound memory
 * under hot-launch storms.
 */

import {
  saleEventBus,
  type MintEventWire,
  type MintProgramSource,
  type MintDisplayState,
  type MintType,
  type MintStatusWire,
  type MintSourceLabel,
} from '../events/emitter';

const WINDOW_60S            = 60_000;
const WINDOW_5M             = 5 * 60_000;
const ACC_IDLE_EVICT_MS     = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS     = 30_000;
/** Per-architecture: free/paid threshold (rent + fees usually < 0.001 SOL). */
const MIN_PAID_LAMPORTS     = 1_000_000;

/** Env-configurable thresholds. Defaults match the architecture spec
 *  exactly — change at runtime via env, no recompile needed. */
function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
/** Threshold-path promotion target. */
const THRESHOLD_MIN_MINTS = envInt('MINT_DISPLAY_THRESHOLD', 50);
/** Burst-path promotion thresholds. */
const BURST_V60           = envInt('MINT_BURST_V60', 8);
const BURST_V5M           = envInt('MINT_BURST_V5M', 25);
/** Demote burst-shown collections that go quiet for this long. */
const COOLDOWN_MS         = envInt('MINT_IDLE_COOLDOWN_MS', 30 * 60_000);

console.log(
  `[mints/config] thresholds: BURST_V60=${BURST_V60} BURST_V5M=${BURST_V5M}` +
  ` THRESHOLD=${THRESHOLD_MIN_MINTS} COOLDOWN_MS=${COOLDOWN_MS}`,
);

interface RingItem { ts: number; priceLamports: number | null; }

interface Accum {
  groupingKey:       string;
  groupingKind:      MintEventWire['groupingKind'];
  programSource:     MintProgramSource;
  collectionAddress: string | null;
  sourceLabel:       MintSourceLabel;

  observedMints: number;
  events60s:     RingItem[];
  events5m:      RingItem[];

  firstObservedAt: number;
  lastMintAt:      number;

  freeCount:    number;
  paidCount:    number;
  unknownCount: number;

  displayState: MintDisplayState;
  shownReason?: 'threshold' | 'burst';
  shownAt?:     number;

  name?:     string;
  imageUrl?: string;
}

const map = new Map<string, Accum>();

/** Sticky reject set: groupingKeys the enricher classified as non-NFT
 *  via DAS. Future `recordMint` calls for these keys are silently
 *  dropped so a fungible's continuing MintTo / metadata-update stream
 *  can't re-resurrect the row. Bounded with FIFO eviction so it can't
 *  grow without limit across long uptime. Sets preserve insertion
 *  order in JS, so iterating `.values()` yields the oldest first. */
const EVICTED_NON_NFT_MAX = 50_000;
const evictedNonNft = new Set<string>();
function rememberNonNft(key: string): void {
  if (evictedNonNft.has(key)) return;
  evictedNonNft.add(key);
  if (evictedNonNft.size <= EVICTED_NON_NFT_MAX) return;
  const overflow = evictedNonNft.size - EVICTED_NON_NFT_MAX;
  const it = evictedNonNft.values();
  for (let i = 0; i < overflow; i++) {
    const r = it.next();
    if (r.done) break;
    evictedNonNft.delete(r.value);
  }
}

function trimWindow(arr: RingItem[], cutoff: number): RingItem[] {
  let i = 0;
  while (i < arr.length && arr[i].ts < cutoff) i++;
  return i === 0 ? arr : arr.slice(i);
}

function rollupType(a: Accum): MintType | 'mixed' {
  if (a.observedMints === 0) return 'unknown';
  if (a.freeCount / a.observedMints > 0.95) return 'free';
  if (a.paidCount / a.observedMints > 0.95) return 'paid';
  if (a.freeCount > 0 && a.paidCount > 0) return 'mixed';
  return a.unknownCount > a.paidCount + a.freeCount ? 'unknown' : 'paid';
}

function classifyMintType(priceLamports: number | null): MintType {
  if (priceLamports == null) return 'unknown';
  if (priceLamports === 0)   return 'free';
  if (priceLamports >= MIN_PAID_LAMPORTS) return 'paid';
  return 'unknown';
}

function buildStatus(a: Accum, now: number): MintStatusWire {
  const v60 = a.events60s.length;
  const v5m = a.events5m.length / 5;
  const recentPrices = a.events5m
    .map(e => e.priceLamports)
    .filter((p): p is number => p != null && p > 0)
    .sort((x, y) => x - y);
  const median = recentPrices.length > 0
    ? recentPrices[Math.floor(recentPrices.length / 2)]
    : null;
  return {
    groupingKey:       a.groupingKey,
    groupingKind:      a.groupingKind,
    programSource:     a.programSource,
    collectionAddress: a.collectionAddress,
    displayState:      a.displayState,
    shownReason:       a.shownReason,
    observedMints:     a.observedMints,
    v60,
    v5m: Math.round(v5m * 10) / 10,
    lastMintAt:        a.lastMintAt,
    mintType:          rollupType(a),
    priceLamports:     median,
    sourceLabel:       a.sourceLabel,
    name:              a.name,
    imageUrl:          a.imageUrl,
  };
}

/** Public: record a detected mint and return whether it passed the
 *  tracked gate (i.e. should be persisted by the caller — though we
 *  don't persist in this MVP). Always emits `mint` + `mint_status`. */
export function recordMint(ev: MintEventWire): void {
  // Sticky non-NFT skip — once the enricher's DAS check rejected this
  // group, every subsequent mint for the same key is dropped before it
  // hits the accumulator / SSE bus. Without this, a fungible's
  // continuing MintTo activity would just re-promote the row.
  if (evictedNonNft.has(ev.groupingKey)) return;
  const now = Date.now();
  let a = map.get(ev.groupingKey);
  if (!a) {
    a = {
      groupingKey:       ev.groupingKey,
      groupingKind:      ev.groupingKind,
      programSource:     ev.programSource,
      collectionAddress: ev.collectionAddress,
      sourceLabel:       ev.sourceLabel,
      observedMints:     0,
      events60s:         [],
      events5m:          [],
      firstObservedAt:   now,
      lastMintAt:        now,
      freeCount:         0,
      paidCount:         0,
      unknownCount:      0,
      displayState:      'incubating',
    };
    map.set(ev.groupingKey, a);
  }
  if (ev.collectionAddress && !a.collectionAddress) {
    a.collectionAddress = ev.collectionAddress;
    a.groupingKind      = 'collection';
  }
  a.observedMints++;
  a.lastMintAt = now;
  const item: RingItem = { ts: now, priceLamports: ev.priceLamports };
  a.events60s.push(item);
  a.events5m.push(item);
  a.events60s = trimWindow(a.events60s, now - WINDOW_60S);
  a.events5m  = trimWindow(a.events5m,  now - WINDOW_5M);

  const cls = classifyMintType(ev.priceLamports);
  if (cls === 'free') a.freeCount++;
  else if (cls === 'paid') a.paidCount++;
  else a.unknownCount++;

  // Promote on threshold or burst (never demote here).
  const prevDisplay = a.displayState;
  if (a.displayState !== 'shown') {
    if (a.observedMints >= THRESHOLD_MIN_MINTS) {
      a.displayState = 'shown';
      a.shownReason  = 'threshold';
      a.shownAt      = now;
    } else if (a.events60s.length >= BURST_V60 || a.events5m.length >= BURST_V5M) {
      a.displayState = 'shown';
      a.shownReason  = 'burst';
      a.shownAt      = now;
    }
  }

  saleEventBus.emitMint(ev);
  saleEventBus.emitMintStatus(buildStatus(a, now));
  if (prevDisplay !== a.displayState) {
    // Transition-only debug: never spammy because it fires once per
    // collection per state change (incubating → shown is the common
    // case, demotion logged in the sweep tick below).
    console.log(
      `[mints/status] ${a.groupingKey} ${prevDisplay} -> ${a.displayState}` +
      ` reason=${a.shownReason ?? '—'} observed=${a.observedMints} v60=${a.events60s.length}`,
    );
  }
}

/** Background sweep: re-emits status frames for shown collections so the
 *  frontend's velocity readouts decay correctly when activity stops, and
 *  demotes burst-shown collections that have gone quiet. */
function sweep(): void {
  const now = Date.now();
  for (const [key, a] of map) {
    // Trim windows even if no new events arrived.
    a.events60s = trimWindow(a.events60s, now - WINDOW_60S);
    a.events5m  = trimWindow(a.events5m,  now - WINDOW_5M);

    // Demote burst-shown collections that went quiet without hitting the
    // 50-mint floor. Threshold-shown collections stay shown forever.
    let dirty = false;
    if (
      a.displayState === 'shown' &&
      a.shownReason === 'burst' &&
      a.observedMints < THRESHOLD_MIN_MINTS &&
      now - a.lastMintAt > COOLDOWN_MS
    ) {
      a.displayState = 'cooled';
      dirty = true;
      console.log(
        `[mints/status] ${a.groupingKey} shown -> cooled` +
        ` (burst expired, observed=${a.observedMints} idleMs=${now - a.lastMintAt})`,
      );
    }

    // Evict idle entries entirely.
    if (now - a.lastMintAt > ACC_IDLE_EVICT_MS) {
      map.delete(key);
      continue;
    }

    if (dirty || a.displayState === 'shown') {
      saleEventBus.emitMintStatus(buildStatus(a, now));
    }
  }
}

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

/** Periodic debug summary — once per 60 s. Operator-readable snapshot
 *  of the accumulator's state without per-event spam. Skips when the
 *  map is empty so a quiet period doesn't pollute the log. */
function logDebugSummary(): void {
  if (map.size === 0) return;
  let incubating = 0;
  let shown      = 0;
  let cooled     = 0;
  let lastMintAt = 0;
  for (const a of map.values()) {
    if      (a.displayState === 'incubating') incubating++;
    else if (a.displayState === 'shown')      shown++;
    else                                      cooled++;
    if (a.lastMintAt > lastMintAt) lastMintAt = a.lastMintAt;
  }
  const lastSeen = lastMintAt > 0
    ? `${Math.round((Date.now() - lastMintAt) / 1000)}s ago`
    : 'never';
  console.log(
    `[mints/summary] groups=${map.size} incubating=${incubating} shown=${shown}` +
    ` cooled=${cooled} lastMintSeen=${lastSeen}`,
  );
}
const summaryTimer = setInterval(logDebugSummary, 60_000);
if (typeof summaryTimer.unref === 'function') summaryTimer.unref();

/** Public: snapshot for SSE bootstrap. New clients receive this on
 *  connect so the trending table is populated immediately. Returns
 *  ALL display states — clients filter to `shown` for the main table
 *  and may render incubating/cooled rows in a debug surface. Incubating
 *  rows with zero observed mints are skipped so we don't ship empty
 *  shells. */
export function currentMintStatuses(): MintStatusWire[] {
  const now = Date.now();
  const out: MintStatusWire[] = [];
  for (const a of map.values()) {
    if (a.observedMints === 0) continue;
    out.push(buildStatus(a, now));
  }
  // Sort by velocity descending — most active first; clients re-sort.
  out.sort((x, y) => y.v60 - x.v60 || y.observedMints - x.observedMints);
  return out;
}

/** Optional metadata patch from background enrichment. */
export function patchAccumulatorMeta(
  groupingKey: string,
  patch: { name?: string; imageUrl?: string },
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  if (patch.name)     a.name     = patch.name;
  if (patch.imageUrl) a.imageUrl = patch.imageUrl;
  saleEventBus.emitMintStatus(buildStatus(a, Date.now()));
}

/** Permanently remove a group from /mints. Used by the enricher when
 *  DAS classifies the group as a non-NFT (fungible / SPL token).
 *
 *  Effect:
 *    1. Marks the entry `cooled` and emits one final `mint_status`
 *       frame so any connected client immediately stops surfacing the
 *       row (the frontend's table memo filters out cooled rows).
 *    2. Deletes the entry from the in-memory map so subsequent
 *       `currentMintStatuses()` snapshots don't replay it on connect.
 *    3. Adds the groupingKey to `evictedNonNft` so any further
 *       `recordMint` calls for the same key are dropped before they
 *       can re-promote the row. */
export function evictMintGroup(groupingKey: string): void {
  rememberNonNft(groupingKey);
  const a = map.get(groupingKey);
  if (!a) return;
  a.displayState = 'cooled';
  saleEventBus.emitMintStatus(buildStatus(a, Date.now()));
  map.delete(groupingKey);
}
