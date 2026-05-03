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
  /** Most-recent accepted mintAddress. Updated on every recordMint;
   *  surfaced in MintStatusWire so the frontend has a safe Solscan
   *  link target that points at an actual NFT (never the collection
   *  / authority / merkle-tree pubkey used as the groupingKey). */
  lastMintAddress:   string | null;
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
  /** Max planned supply (LMNFT `max_items`, MPL Core master-edition
   *  `maxSupply`). Distinct from `observedMints`. Populated lazily by
   *  `setMintMaxSupply()` once a launchpad-specific resolver decodes
   *  the relevant config account; null until then so the frontend
   *  renders "—" rather than mis-using `observedMints`. */
  maxSupply?: number | null;
  /** LMNFT URL fragments — `{owner}/{collectionId}`. Populated by
   *  `patchAccumulatorLmnft` once the homepage-featured lookup returns. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
}

const map = new Map<string, Accum>();

/** Ring buffer of recent accepted mint events, replayed to every fresh
 *  SSE client on connect so /mints' Live Mint Feed isn't always empty
 *  when a user opens the page mid-launch (per-mint events were
 *  previously broadcast-once, so anyone connecting after a mint never
 *  saw it). FIFO bounded — newest pushes at the end, oldest is
 *  trimmed off the front. Capacity matches the frontend `LIVE_FEED_MAX`. */
const RECENT_MINTS_MAX = 150;
const recentMints: MintEventWire[] = [];
function rememberRecentMint(ev: MintEventWire): void {
  recentMints.push(ev);
  if (recentMints.length > RECENT_MINTS_MAX) {
    recentMints.splice(0, recentMints.length - RECENT_MINTS_MAX);
  }
}

// Audit counters — total since process start. Pair with the
// downstream counter in src/server/sse.ts (sseSent) to spot drops
// between accept → emit → SSE broadcast. Logged every 60 s.
let auditAcceptedCount = 0;
let auditEmittedCount  = 0;
export function getMintAuditCounts(): { accepted: number; emitted: number } {
  return { accepted: auditAcceptedCount, emitted: auditEmittedCount };
}
/** Public: snapshot of the most-recent mints for SSE bootstrap. Newest
 *  last (chronological order — the frontend's reducer dedups + reverses
 *  to its newest-first display ordering). */
export function currentRecentMints(): MintEventWire[] {
  return recentMints.slice();
}

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
    lastMintAddress:   a.lastMintAddress,
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
    maxSupply:         a.maxSupply ?? null,
    lmntfOwner:        a.lmntfOwner ?? null,
    lmntfCollectionId: a.lmntfCollectionId ?? null,
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
  if (evictedNonNft.has(ev.groupingKey)) {
    // TEMPORARY hard diagnostic: every blocked-by-prior-eviction call
    // is logged so the operator can see whether sticky rejection is
    // actually firing for the live-leaking groups.
    console.log(
      `[mints/REJECT] reason=evicted_group_replay groupingKey=${ev.groupingKey} ` +
      `mint=${ev.mintAddress ?? '—'} sig=${ev.signature.slice(0, 20)}…`,
    );
    return;
  }
  // TEMPORARY hard diagnostic: every accepted row hitting the accumulator
  // is logged unsampled. Lets the operator pair `[mints/INSERT]` lines
  // (every accept) against `[mints/REJECT]` lines (every drop in
  // ingestMintRaw + this function) and locate the bypass that put the
  // visible Pump.fun / Meteora authority rows in /mints.
  // Remove this log once the leak source is confirmed.
  const isFirst = !map.has(ev.groupingKey);
  console.log(
    `[mints/INSERT] groupingKey=${ev.groupingKey} mint=${ev.mintAddress ?? '—'} ` +
    `name=${'name' in ev ? '—' : '—'} source=${ev.sourceLabel} ` +
    `programSource=${ev.programSource} groupingKind=${ev.groupingKind} ` +
    `priceLamports=${ev.priceLamports ?? '—'} mintType=${ev.mintType} ` +
    `collectionAddress=${ev.collectionAddress ?? '—'} ` +
    `path=${isFirst ? 'first_insert' : 'subsequent'} sig=${ev.signature.slice(0, 20)}…`,
  );
  const now = Date.now();
  let a = map.get(ev.groupingKey);
  if (!a) {
    a = {
      groupingKey:       ev.groupingKey,
      groupingKind:      ev.groupingKind,
      programSource:     ev.programSource,
      collectionAddress: ev.collectionAddress,
      lastMintAddress:   ev.mintAddress,
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
  // Track the most-recent valid mintAddress so the frontend has
  // something safe to link to (collectionAddress / groupingKey can
  // be a non-NFT pubkey).
  if (ev.mintAddress) a.lastMintAddress = ev.mintAddress;
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

  // EMIT FIRST — never gated on metadata, never debounced. The
  // per-mint event must be on the wire before any DAS retry queue
  // touches the row. Metadata comes back later via mint_meta patches.
  auditAcceptedCount++;
  saleEventBus.emitMint(ev);
  rememberRecentMint(ev);
  auditEmittedCount++;
  saleEventBus.emitMintStatus(buildStatus(a, now));
  console.log(
    `[mints/emit] sig=${ev.signature.slice(0, 12)}… ` +
    `mint=${ev.mintAddress ?? '—'} collection=${ev.collectionAddress ?? '—'}`,
  );
  console.log(
    `[mints/recent] size=${recentMints.length}`,
  );
  console.log(
    `[mints/live] inserted sig=${ev.signature.slice(0, 12)}… ` +
    `mint=${ev.mintAddress ?? '—'} collection=${ev.collectionAddress ?? '—'}`,
  );
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

/** Read-only name probe — lets callers gate weaker-source name
 *  fallbacks on whether we already have a stronger name. Returns
 *  the current row's `name`, or null/undefined when unset. */
export function getAccumulatorName(groupingKey: string): string | null | undefined {
  return map.get(groupingKey)?.name;
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

/** Patch a group's max planned supply once a launchpad-specific
 *  resolver decodes it. Re-emits one mint_status frame so connected
 *  clients see the SUPPLY column populate without waiting for the
 *  next mint. Treats null/undefined/non-positive as "unknown" — never
 *  overwrites a known supply with null. */
/** Patch LMNFT-specific deep-link fields + max supply on a group.
 *  Called by the LMNFT lookup once a featured collection match comes
 *  back. Re-emits one mint_status frame so connected clients see the
 *  source pill become clickable + the supply column populate without
 *  waiting for the next mint. Idempotent — no-op when the values
 *  are unchanged. */
export function patchAccumulatorLmnft(
  groupingKey: string,
  patch: { owner?: string | null; collectionId?: string | null; maxSupply?: number | null; name?: string | null },
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  // Each field is optional and only overwrites when the new value is
  // truthy — lets independent sources contribute partial updates:
  //   - on-chain decoder supplies {owner, maxSupply} (no collectionId).
  //   - LMNFT homepage scraper supplies {owner, collectionId, maxSupply, name}.
  // Whichever lands first populates its share; the other fills in
  // when it runs. Sticky-merge means a later partial patch never
  // clobbers a previously-resolved value with null.
  const nextOwner  = patch.owner       || a.lmntfOwner       || null;
  const nextId     = patch.collectionId || a.lmntfCollectionId || null;
  const nextSupply = (typeof patch.maxSupply === 'number' && patch.maxSupply > 0)
    ? patch.maxSupply
    : (a.maxSupply ?? null);
  const nextName   = (patch.name && patch.name.length > 0) ? patch.name : a.name;
  if (
    a.lmntfOwner === nextOwner &&
    a.lmntfCollectionId === nextId &&
    a.maxSupply === nextSupply &&
    a.name === nextName
  ) return;
  a.lmntfOwner        = nextOwner;
  a.lmntfCollectionId = nextId;
  a.maxSupply         = nextSupply;
  if (nextName) a.name = nextName;
  const href = (nextOwner && nextId)
    ? `https://www.launchmynft.io/collections/${nextOwner}/${nextId}`
    : null;
  console.log(
    `[mints/link] source=LaunchMyNFT owner=${nextOwner ?? 'null'} ` +
    `collectionId=${nextId ?? 'null'} href=${href ?? 'null'} ` +
    `maxSupply=${nextSupply ?? 'null'}`,
  );
  saleEventBus.emitMintStatus(buildStatus(a, Date.now()));
}

export function setMintMaxSupply(groupingKey: string, maxSupply: number | null): void {
  const a = map.get(groupingKey);
  if (!a) return;
  if (maxSupply == null || !Number.isFinite(maxSupply) || maxSupply <= 0) {
    console.log(
      `[mints/supply-miss] reason=${maxSupply == null ? 'null' : 'invalid'} ` +
      `source=${a.sourceLabel} groupingKey=${groupingKey}`,
    );
    return;
  }
  if (a.maxSupply === maxSupply) return;
  a.maxSupply = maxSupply;
  console.log(
    `[mints/supply] source=${a.sourceLabel} ` +
    `collection=${a.collectionAddress ?? '—'} ` +
    `groupingKey=${groupingKey} maxSupply=${maxSupply}`,
  );
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
