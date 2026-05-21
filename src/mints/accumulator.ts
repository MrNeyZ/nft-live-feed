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
import { getCollectionMintedCount } from '../enrichment/helius-das';
import { cleanName } from './clean-name';
import { noteSearchAssetsCall } from './collection-confirm';
import { isCollectionBlacklisted, noteBlacklistDrop } from './blacklist';

/** Per-row refresh cadence for the MINTED column. A single row can
 *  trigger at most one DAS `searchAssets` call per this window even if
 *  it's bursting 50 mints/sec. Bumped from 30 s → 60 s as part of the
 *  Helius-credit-budget pass — at 50 mints/sec a single hot collection
 *  was still firing 2 searchAssets/min while the user-visible MINTED
 *  number changes by ~the same percentage either way. 60 s halves the
 *  searchAssets traffic for hot collections at no perceptible UX cost. */
const MINTED_REFRESH_MIN_MS = 60_000;

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

/** Temporary diagnostic gate. The per-accept logs (`[mints/INSERT]`,
 *  `[mints/REJECT]`, `[mints/emit]`, `[mints/recent]`, `[mints/live]`)
 *  were unsampled and at 50 mints/sec produced ~250 PM2-stringified
 *  log lines/sec. Enable with `MINTS_DEBUG=1` (or `=verbose`) when
 *  actively debugging the ingest pipeline; otherwise these stay quiet
 *  and the operator-facing transitions (`[mints/status]`, `[mints/summary]`,
 *  `[mints/minted-count]`, `[mints/supply]`, `[mints/link]`) still print. */
const MINTS_DEBUG = process.env.MINTS_DEBUG === '1' || process.env.MINTS_DEBUG === 'verbose';

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
  /** Representative per-NFT image — a confidently-unique per-mint
   *  URL from this drop. Sticky write-once. Patched only after
   *  `collection-confirm.ts` observes the launchpad serving
   *  variety (>=2 distinct image URLs) AND the URL being patched
   *  is unique to its own mint. Used as a 2nd-tier fallback by
   *  both the tracker table thumbnail (when the collection hero
   *  is missing/broken) and the live-feed card (when the per-mint
   *  URL turns out to be the shared placeholder). */
  representativeImageUrl?: string;
  /** Shared-placeholder image URL — set by `collection-confirm.ts`
   *  once the same URL is observed on 2+ distinct mints in this
   *  collection. Not sticky; refreshed as new placeholders surface.
   *  Live-feed card uses this to detect "ev.nftImageUrl is a
   *  shared pre-reveal asset, not per-NFT identity" and skip
   *  rendering the placeholder on the card surface (cards must
   *  represent individual mint identity). The tracker table is
   *  unaffected — a shared placeholder is still a valid
   *  collection-level image for that row. */
  sharedPlaceholderImageUrl?: string;
  /** Max planned supply (LMNFT `max_items`, MPL Core master-edition
   *  `maxSupply`). Distinct from `observedMints`. Populated lazily by
   *  `setMintMaxSupply()` once a launchpad-specific resolver decodes
   *  the relevant config account; null until then so the frontend
   *  renders "—" rather than mis-using `observedMints`. */
  maxSupply?: number | null;
  /** Total assets DAS has indexed for this collection (proxy for "how
   *  many minted so far"). Populated lazily by `refreshMintedCount` and
   *  is throttled per-row. Distinct from `observedMints` (session-only)
   *  and `maxSupply` (planned cap). Null until the first DAS lookup. */
  mintedCount?:       number | null;
  /** Last time `refreshMintedCount` was attempted for this row, used to
   *  throttle DAS calls (a single row triggers at most one refresh per
   *  `MINTED_REFRESH_MIN_MS`). */
  mintedFetchedAt?:   number;
  /** LMNFT URL fragments — `{owner}/{collectionId}`. Populated by
   *  `patchAccumulatorLmnft` once the homepage-featured lookup returns. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
  /** Authoritative total minted in the drop, decoded from the MPL Core
   *  `CollectionV1.num_minted` u32 by the core-supply refresher. Null
   *  until the refresher visits this collection. Once set, increases
   *  monotonically (the refresher never overwrites with a smaller
   *  value — protects against transient RPC results). */
  supplyMintedOnChain?: number | null;
  /** Running session-local count of accepted mints into this group.
   *  Incremented in `recordMint` on every accepted event regardless of
   *  programSource. Used as the optimistic fallback when no on-chain
   *  authority has been resolved yet. */
  supplyMintedLocal:    number;
  /** Wall-clock ms of the last successful on-chain decode for this
   *  group. Used by the refresher to throttle per-collection refresh
   *  frequency. Undefined until the first successful decode. */
  supplyVerifiedAt?:    number;
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
/** Wall-clock ms of the most recent accepted mint, across all groups.
 *  Returns 0 when nothing has been observed since boot. Used by
 *  `/api/mints/runtime` so operators can see at a glance how long it
 *  has been since the tracker last saw a mint event — the primary
 *  health signal when sales mode is OFF and the trade endpoints are
 *  silent. Cheap O(N) over the in-memory accumulator (bounded). */
/** Snapshot of `(groupingKey, collectionAddress, lastVerifiedAt)` for
 *  every MPL Core group with a real collection address. Used by the
 *  core-supply refresher to pick its next batch (filter by TTL +
 *  recency). Bounded — only one entry per group, even very long
 *  uptime stays O(active rows). Non-Core / cNFT / placeholder
 *  collections are excluded; the refresher's batch is Core-specific. */
export function coreCollectionSupplyTargets(): Array<{
  groupingKey:       string;
  collectionAddress: string;
  lastVerifiedAt:    number | undefined;
  lastMintAt:        number;
}> {
  const out: Array<{ groupingKey: string; collectionAddress: string; lastVerifiedAt: number | undefined; lastMintAt: number }> = [];
  for (const a of map.values()) {
    if (a.programSource !== 'mpl_core') continue;
    const coll = a.collectionAddress;
    if (!coll) continue;
    // Skip placeholder/synthetic grouping addresses (the targeted
    // detector occasionally emits `authority:` / `pool:` style keys
    // for borderline rows). A real Core CollectionV1 always has a
    // base58 32-byte pubkey, so the colon-prefix shape is a safe
    // negative gate.
    if (/^(authority|program|owner|pool):/.test(coll)) continue;
    out.push({
      groupingKey:       a.groupingKey,
      collectionAddress: coll,
      lastVerifiedAt:    a.supplyVerifiedAt,
      lastMintAt:        a.lastMintAt,
    });
  }
  return out;
}

export function lastObservedMintAt(): number {
  let last = 0;
  for (const a of map.values()) {
    if (a.lastMintAt > last) last = a.lastMintAt;
  }
  return last;
}
/** Public: snapshot of the most-recent mints for SSE bootstrap. Newest
 *  last (chronological order — the frontend's reducer dedups + reverses
 *  to its newest-first display ordering). */
export function currentRecentMints(): MintEventWire[] {
  return recentMints.slice();
}

/** Boot-time hydration: refill the recent-mints ring from the DB-backed
 *  store (src/mints/event-store.ts) so the SSE replay survives restarts and
 *  is identical for every client. Pass events in chronological order (oldest
 *  first) — same order the ring keeps and the SSE replay expects. */
export function hydrateRecentMints(events: MintEventWire[]): void {
  for (const ev of events) rememberRecentMint(ev);
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

/** Throttled fire-and-forget refresher for the MINTED column. Reads the
 *  collection-wide DAS index size and patches it onto the row, then
 *  re-emits a `mint_status` frame so connected clients see the new
 *  count in real time. Skips silently when:
 *    - `collectionAddress` is unknown (e.g. groupingKind=`creator`)
 *    - the last attempt was less than `MINTED_REFRESH_MIN_MS` ago
 *  Does not block the caller — even on RPC timeout the per-mint event
 *  has already gone out. */
function scheduleMintedCountRefresh(a: Accum, now: number): void {
  if (!a.collectionAddress) return;
  // MPL Core short-circuit. The core-supply refresher
  // (`core-supply-refresher.ts`) decodes `CollectionV1.num_minted`
  // directly from the on-chain account every 30 s, which is strictly
  // more authoritative than DAS `searchAssets` (and one
  // `getMultipleAccounts` per ≤100 collections is much cheaper than
  // N independent `searchAssets` calls). When the refresher has
  // already populated `supplyMintedOnChain` for a Core row, mirror
  // that into `mintedCount` and skip the DAS call entirely. Legacy /
  // pNFT / cNFT / unknown rows fall through to the DAS path unchanged.
  if (a.programSource === 'mpl_core'
      && typeof a.supplyMintedOnChain === 'number'
      && a.supplyMintedOnChain >= 0) {
    const next = Math.max(a.supplyMintedOnChain, a.observedMints);
    if (a.mintedCount !== next) {
      a.mintedCount     = next;
      a.mintedFetchedAt = now;
      saleEventBus.emitMintStatus(buildStatus(a, now));
    } else {
      // Value unchanged — still bump the throttle clock so the next
      // check fires on the same per-row cadence the DAS path uses.
      a.mintedFetchedAt = now;
    }
    return;
  }
  if (a.mintedFetchedAt && now - a.mintedFetchedAt < MINTED_REFRESH_MIN_MS) return;
  a.mintedFetchedAt = now;
  const collection = a.collectionAddress;
  void (async () => {
    noteSearchAssetsCall();
    const dasCount = await getCollectionMintedCount(collection);
    if (dasCount == null) return;
    // The accumulator entry may have been re-keyed or evicted in the
    // meantime; re-resolve via the live map so we never patch a stale
    // local reference.
    const live = map.get(a.groupingKey);
    if (!live) return;
    // Floor invariant: total minted on chain must be >= what we've
    // observed in this session. Helius DAS occasionally returns a
    // stale low count (e.g. 1) for a collection that our session has
    // already seen multiple mints for — likely a grouping-index lag
    // for fresh launches. Surfacing the smaller number breaks user
    // trust in the MINTED column. Prefer max(das, observed) so the
    // column never shows a value lower than what's already in the
    // user's eyes from MINTS column.
    // Three potential sources of truth for the MINTED column. Take the
    // max so we always show the most progressed launch state:
    //   1. DAS searchAssets total — best for steady-state, Helius
    //      indexes most collections eventually.
    //   2. LMNFT on-chain state account u32 at offset 230 — patched
    //      in via `patchAccumulatorLmnft` from the LMNFT decoder; the
    //      most authoritative for LMNFT-managed collections (DAS
    //      grouping can lag a fast launch by minutes/hours, e.g.
    //      Micros at 6669/10000 minted but DAS returns 0–1).
    //   3. observedMints — session-only floor; never let MINTED show
    //      less than what the user has already seen via MINTS column.
    const lmnftMinted = typeof live.mintedCount === 'number' ? live.mintedCount : 0;
    const count = Math.max(dasCount, live.observedMints, lmnftMinted);
    if (count !== dasCount) {
      console.log(
        `[mints/minted-count] collection=${collection} ` +
        `dasTotal=${dasCount} observed=${live.observedMints} ` +
        `lmnft=${lmnftMinted || 'null'} corrected=${count} reason=das_lower_than_authoritative`,
      );
    }
    if (live.mintedCount === count) return;
    live.mintedCount = count;
    saleEventBus.emitMintStatus(buildStatus(live, Date.now()));
  })();
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
    representativeImageUrl:    a.representativeImageUrl,
    sharedPlaceholderImageUrl: a.sharedPlaceholderImageUrl,
    maxSupply:         a.maxSupply ?? null,
    mintedCount:       a.mintedCount ?? null,
    lmntfOwner:        a.lmntfOwner ?? null,
    lmntfCollectionId: a.lmntfCollectionId ?? null,
    // Authoritative on-chain count when the core-supply refresher has
    // visited; otherwise the session-local running count so the
    // frontend's SUPPLY column has something to show for Core/VVV/GRAVE
    // rows where `maxSupply` (planned cap) is unknown. The two paths
    // are distinguishable via `supplyVerified` below — UI mutes
    // unverified values per spec.
    supplyMinted:
      typeof a.supplyMintedOnChain === 'number' && a.supplyMintedOnChain >= 0
        ? Math.max(a.supplyMintedOnChain, a.supplyMintedLocal)
        : (a.supplyMintedLocal > 0 ? a.supplyMintedLocal : null),
    supplyVerified: typeof a.supplyMintedOnChain === 'number' && a.supplyMintedOnChain >= 0,
  };
}

/** Identity gate for displayState='shown'. A row is allowed into
 *  ACTIVE only when it has at least one usable identity field —
 *  a non-empty trimmed `name` OR an `imageUrl`. Without this gate,
 *  cNFT/Core LMNFT bursts that arrive before DAS metadata patches
 *  produced loud "ACTIVE with no name and no image" rows on the
 *  tracker (audit captured one Bubblegum row that emitted 8
 *  `displayState='shown'` frames with name=null/image=null over
 *  ~3 minutes). The row is NOT evicted while waiting — velocity
 *  windows + burst thresholds keep accumulating, so the moment
 *  `patchAccumulatorMeta` / `patchAccumulatorLmnft` resolves
 *  identity, `tryPromote` re-runs and the row upgrades cleanly. */
function hasUsableIdentity(a: Accum): boolean {
  const trimmedName = (a.name ?? '').trim();
  return trimmedName.length > 0 || !!a.imageUrl;
}

/** Single source of truth for incubating → shown promotion. Mirrors
 *  the previous inline block in `recordMint`, plus the identity
 *  gate above. Called from:
 *    1. `recordMint` on every mint, after stats are updated.
 *    2. `patchAccumulatorMeta` / `patchAccumulatorLmnft` after a
 *       metadata patch lands — so a row that hit a burst earlier
 *       but was held back by missing identity upgrades the moment
 *       the name or image arrives.
 *  Never demotes. Demotion (shown → cooled) lives only in `sweep`. */
function tryPromote(a: Accum, now: number): void {
  if (a.displayState === 'shown')        return;
  if (!hasUsableIdentity(a))             return;
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

/** Public: record a detected mint and return whether it passed the
 *  tracked gate (i.e. should be persisted by the caller — though we
 *  don't persist in this MVP). Always emits `mint` + `mint_status`. */
export function recordMint(ev: MintEventWire): void {
  // Hard collection blacklist — drops the event BEFORE any state
  // mutation. Suppresses /mints table, recentMints ring, `mint` and
  // `mint_status` SSE frames in one place. `mint_meta` patches are
  // dropped at their own out-of-band emit site
  // (`collection-confirm.ts`). Detector branch agnostic — works
  // uniformly for LMNFT / VVV / GRAVE / v2-core fallback / legacy
  // classifier and any future detector that calls recordMint. Log
  // gated to once per unique address per process lifetime so a hot
  // launch in the muted collection can't flood the log.
  if (isCollectionBlacklisted(ev.collectionAddress)) {
    noteBlacklistDrop(ev.collectionAddress as string);
    return;
  }
  // Sticky non-NFT skip — once the enricher's DAS check rejected this
  // group, every subsequent mint for the same key is dropped before it
  // hits the accumulator / SSE bus. Without this, a fungible's
  // continuing MintTo activity would just re-promote the row.
  if (evictedNonNft.has(ev.groupingKey)) {
    if (MINTS_DEBUG) {
      console.log(
        `[mints/REJECT] reason=evicted_group_replay groupingKey=${ev.groupingKey} ` +
        `mint=${ev.mintAddress ?? '—'} sig=${ev.signature.slice(0, 20)}…`,
      );
    }
    return;
  }
  const isFirst = !map.has(ev.groupingKey);
  if (MINTS_DEBUG) {
    console.log(
      `[mints/INSERT] groupingKey=${ev.groupingKey} mint=${ev.mintAddress ?? '—'} ` +
      `name=${'name' in ev ? '—' : '—'} source=${ev.sourceLabel} ` +
      `programSource=${ev.programSource} groupingKind=${ev.groupingKind} ` +
      `priceLamports=${ev.priceLamports ?? '—'} mintType=${ev.mintType} ` +
      `collectionAddress=${ev.collectionAddress ?? '—'} ` +
      `path=${isFirst ? 'first_insert' : 'subsequent'} sig=${ev.signature.slice(0, 20)}…`,
    );
  }
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
      supplyMintedLocal: 0,
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
  a.supplyMintedLocal++;
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

  // Promote on threshold or burst (never demote here). Promotion is
  // additionally gated by `hasUsableIdentity` — see tryPromote below.
  const prevDisplay = a.displayState;
  tryPromote(a, now);

  // EMIT FIRST — never gated on metadata, never debounced. The
  // per-mint event must be on the wire before any DAS retry queue
  // touches the row. Metadata comes back later via mint_meta patches.
  auditAcceptedCount++;
  saleEventBus.emitMint(ev);
  rememberRecentMint(ev);
  auditEmittedCount++;
  saleEventBus.emitMintStatus(buildStatus(a, now));

  // Fire-and-forget DAS refresh of the collection-wide minted count.
  // Throttled per row so a 50-mint burst still issues one refresh, not
  // 50. The status frame above already went out with the previous
  // (possibly stale or null) `mintedCount`; when the refresh resolves
  // we patch + re-emit, so connected clients see the MINTED column
  // climb over time without us paying a DAS call per mint.
  scheduleMintedCountRefresh(a, now);
  if (MINTS_DEBUG) {
    console.log(
      `[mints/emit] sig=${ev.signature.slice(0, 12)}… ` +
      `mint=${ev.mintAddress ?? '—'} collection=${ev.collectionAddress ?? '—'}`,
    );
    console.log(`[mints/recent] size=${recentMints.length}`);
    console.log(
      `[mints/live] inserted sig=${ev.signature.slice(0, 12)}… ` +
      `mint=${ev.mintAddress ?? '—'} collection=${ev.collectionAddress ?? '—'}`,
    );
  }
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

/** True iff `s` is a non-empty `http(s)` URL string. Caller-side
 *  validation — rejects empty / whitespace-only / non-URL values and
 *  the rare `data:`/`blob:` sentinel that can slip through DAS for
 *  off-chain placeholders. Cheap regex; no allocations on the happy
 *  path (regex compiles once at module load). */
const HTTP_URL_RE = /^https?:\/\/\S+$/i;
function isUsableImageUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  const t = u.trim();
  if (t.length === 0) return false;
  return HTTP_URL_RE.test(t);
}

/** Optional metadata patch from background enrichment.
 *
 *  imageUrl contract — collection-level, write-once-sticky:
 *    1. The accumulator's `imageUrl` field is the collection's hero
 *       art (the row thumbnail on /mints + the fallback for live-
 *       feed cards). It is NEVER a per-NFT image.
 *    2. Only `enrichLaunchpadCollectionMeta` (CG / LMNFT-Core paths)
 *       is allowed to populate it today, via this function. The
 *       per-NFT enricher and the collection-confirm retry chain
 *       both explicitly drop imageUrl from their patches.
 *    3. Once set, it stays. A later patch with a different URL is
 *       ignored — a row that already resolved a real collection
 *       image must never be downgraded by:
 *         - an empty / null URL,
 *         - a temporary DAS unresolved blank,
 *         - a per-NFT image leaking through a future bug,
 *         - a re-resolve to a different launchpad host that may
 *           later break.
 *  Sticky also defends against the bug-of-the-day where some new
 *  code path starts calling patchAccumulatorMeta with a per-NFT
 *  image: the first good collection write wins for the row's
 *  lifetime in this process.
 *
 *  Name has the same trim/reject-empty rule but is not sticky:
 *  upgrading a short-address fallback to a real collection name on
 *  a later patch is intentional behaviour and lives in
 *  `collection-confirm.ts`'s weak/strong gate, not here. */
export function patchAccumulatorMeta(
  groupingKey: string,
  patch: { name?: string; imageUrl?: string },
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  // Trim before storing — on-chain / scraped collection names are
  // sometimes whitespace-padded ("                                "),
  // which renders as blank rows. cleanName returns null for empty /
  // whitespace-only inputs; we then skip the write so an existing good
  // name on the row isn't clobbered with null.
  const cleaned = cleanName(patch.name);
  if (cleaned) a.name = cleaned;
  // Sticky-merge + URL validity. Three gates, in order:
  //   1. patch.imageUrl must be a usable http(s) URL (rejects
  //      empty / whitespace / data:/blob: / malformed).
  //   2. accumulator must not already have an imageUrl (write-once).
  //   3. patch must differ from a known-bad sentinel — currently the
  //      gate is just `isUsableImageUrl`; extend here if we see a
  //      collection start advertising e.g. a fixed placeholder URL.
  if (isUsableImageUrl(patch.imageUrl) && !a.imageUrl) {
    a.imageUrl = patch.imageUrl;
  }
  // Re-evaluate promotion AFTER the patch fields are written. A row
  // held back by the identity gate (no name AND no image) at the
  // last burst tick can now satisfy `hasUsableIdentity` and flip to
  // 'shown' on the same status frame this patch emits — no extra
  // round-trip needed.
  tryPromote(a, Date.now());
  saleEventBus.emitMintStatus(buildStatus(a, Date.now()));
}

/** Sticky write of the first valid per-NFT image observed for this
 *  collection. Called by `collection-confirm.ts` whenever a DAS
 *  resolve of a specific mintAddress returns a usable image. Once
 *  set the value never changes — same rationale as the sticky
 *  `imageUrl` write in `patchAccumulatorMeta`: a later patch with a
 *  broken / null / placeholder URL must never downgrade a row that
 *  already has working art on it.
 *
 *  Distinct from `imageUrl` (collection hero, set by
 *  `enrichLaunchpadCollectionMeta`): the tracker table thumbnail
 *  uses `imageUrl` first, this as 2nd-tier fallback, and initials
 *  only when both are missing or broken. The live-feed card path
 *  uses neither — per-mint images flow on the `mint_meta` channel.
 *
 *  Re-emits one `mint_status` frame so connected clients pick up
 *  the new fallback in real time. */
export function patchAccumulatorRepresentativeImage(
  groupingKey: string,
  imageUrl: string | null | undefined,
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  if (a.representativeImageUrl) return;             // sticky — write-once
  if (!isUsableImageUrl(imageUrl)) return;          // empty / non-http(s) / data: — reject
  a.representativeImageUrl = imageUrl;
  // Re-evaluate promotion: the identity gate already passes on
  // collection name + collection image, but a row that has neither
  // (rare: launchpad with no scraper, DAS hasn't indexed collection
  // asset yet) can now satisfy `hasUsableIdentity` on this URL alone
  // and promote. `hasUsableIdentity` reads collection-level fields
  // only today, so this is a no-op unless we widen the gate — kept
  // here for symmetry with patchAccumulatorMeta.
  tryPromote(a, Date.now());
  saleEventBus.emitMintStatus(buildStatus(a, Date.now()));
}

/** Mark a URL as the collection's shared-placeholder image. Called
 *  by `collection-confirm.ts` once the same image URL has been
 *  observed on >=2 distinct mints in this drop — strong evidence
 *  the launchpad is serving one pre-reveal asset across many
 *  mintings.
 *
 *  NOT sticky: a drop can in theory rotate its placeholder, and
 *  the field should reflect the most recently-detected shared URL.
 *  In practice we expect one placeholder per drop until reveal,
 *  then unique-per-NFT URLs (none of which will be detected as
 *  shared, so the field stays pointing at the now-defunct
 *  placeholder — harmless: the frontend compares against
 *  `ev.nftImageUrl`, which for post-reveal mints won't match).
 *
 *  Re-emits one `mint_status` frame so connected clients can
 *  update their card-image decisions in real time. Idempotent
 *  when the value is unchanged. */
export function patchAccumulatorSharedPlaceholderImage(
  groupingKey: string,
  imageUrl: string | null | undefined,
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  if (!isUsableImageUrl(imageUrl)) return;
  if (a.sharedPlaceholderImageUrl === imageUrl) return;
  a.sharedPlaceholderImageUrl = imageUrl;
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
  patch: {
    owner?:        string | null;
    collectionId?: string | null;
    maxSupply?:    number | null;
    name?:         string | null;
    mintedCount?:  number | null;
  },
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  // Each field is optional and only overwrites when the new value is
  // truthy — lets independent sources contribute partial updates:
  //   - on-chain decoder supplies {owner, maxSupply, mintedCount}.
  //   - LMNFT homepage scraper supplies {owner, collectionId, maxSupply, name}.
  // Whichever lands first populates its share; the other fills in
  // when it runs. Sticky-merge means a later partial patch never
  // clobbers a previously-resolved value with null.
  const nextOwner  = patch.owner       || a.lmntfOwner       || null;
  const nextId     = patch.collectionId || a.lmntfCollectionId || null;
  const nextSupply = (typeof patch.maxSupply === 'number' && patch.maxSupply > 0)
    ? patch.maxSupply
    : (a.maxSupply ?? null);
  // Trim LMNFT-supplied collection names — homepage scraper occasionally
  // returns the on-chain right-padded buffer (32 spaces). cleanName
  // returns null for whitespace-only; in that case we keep `a.name`
  // (sticky-merge — never replace a previously resolved good name with
  // an empty patch).
  const nextName   = cleanName(patch.name) ?? a.name;
  // For mintedCount we WANT to overwrite with new on-chain values
  // (count grows over time), but never replace a known number with
  // null. Patch wins iff it's a finite non-negative number.
  const nextMinted =
    typeof patch.mintedCount === 'number' && Number.isFinite(patch.mintedCount) && patch.mintedCount >= 0
      ? patch.mintedCount
      : (a.mintedCount ?? null);
  if (
    a.lmntfOwner === nextOwner &&
    a.lmntfCollectionId === nextId &&
    a.maxSupply === nextSupply &&
    a.name === nextName &&
    a.mintedCount === nextMinted
  ) return;
  a.lmntfOwner        = nextOwner;
  a.lmntfCollectionId = nextId;
  a.maxSupply         = nextSupply;
  a.mintedCount       = nextMinted;
  if (nextName) a.name = nextName;
  // Same rationale as in `patchAccumulatorMeta`: if this LMNFT patch
  // resolved a name (the only identity dimension this path can
  // populate; imageUrl is patched via the meta path), a row that was
  // bursting but identity-gated can now upgrade to 'shown' on this
  // same status frame.
  tryPromote(a, Date.now());
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

/** Patch a group's authoritative on-chain minted count. Called by the
 *  core-supply refresher once a CollectionV1 account has been decoded.
 *  Monotonic: never overwrites a higher previous value with a smaller
 *  one (guards against transient RPC results returning a stale account
 *  snapshot — possible across validator forks during a heavy burst).
 *  Re-emits one mint_status frame so connected clients see the SUPPLY
 *  column flip from optimistic to verified without waiting for the
 *  next mint. */
export function patchAccumulatorCoreSupply(
  groupingKey: string,
  numMinted:   number,
): void {
  const a = map.get(groupingKey);
  if (!a) return;
  if (!Number.isFinite(numMinted) || numMinted < 0) return;
  const prev = typeof a.supplyMintedOnChain === 'number' ? a.supplyMintedOnChain : -1;
  const next = numMinted < prev ? prev : numMinted;
  const verifiedAtChanged = !a.supplyVerifiedAt;
  if (prev === next && !verifiedAtChanged) {
    // Value unchanged AND we already had a verifiedAt — still bump
    // the timestamp so the refresher's throttle uses the latest poll
    // time, but no need to re-emit downstream.
    a.supplyVerifiedAt = Date.now();
    return;
  }
  a.supplyMintedOnChain = next;
  a.supplyVerifiedAt    = Date.now();
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

/** Rehydrate the accumulator from a previously-saved snapshot of
 *  `MintStatusWire` rows (see `src/mints/snapshot.ts`). Only fields
 *  that the snapshot carries are restored — the volatile state used
 *  by promotion / sweep (event ring buffers, free/paid/unknown
 *  tallies, idle-eviction timers, mintedFetchedAt throttle clock) is
 *  reconstructed empty.
 *
 *  The intent is UI continuity, not full state restoration:
 *    - `displayState` / `shownReason` / `name` / `imageUrl` / supply
 *      fields survive so the same row paints in the tracker
 *      immediately after restart.
 *    - velocity windows reset to empty; sweep's COOLDOWN_MS demotion
 *      still runs on burst-shown rows that go quiet, so a stale row
 *      naturally `shown` → `cooled` after ~30 min of no fresh mints.
 *    - threshold-shown rows stay `shown` permanently (matches the
 *      pre-snapshot behaviour for the same row pre-restart).
 *    - skips rows whose `groupingKey` is already present — a snapshot
 *      restore racing against an early `recordMint` should never
 *      overwrite live state with a frozen rebuild.
 *
 *  Idempotent: calling twice is a no-op the second time. Returns the
 *  number of rows actually written into the map. */
export function hydrateAccumulatorFromSnapshot(rows: MintStatusWire[]): number {
  let written = 0;
  for (const r of rows) {
    if (map.has(r.groupingKey)) continue;
    // Reconstruct an Accum from the wire shape. Fields not in the
    // snapshot (events60s, events5m, free/paid/unknown counts,
    // firstObservedAt, mintedFetchedAt, supplyMintedLocal,
    // supplyVerifiedAt) are reset to safe defaults; live activity
    // will repopulate them. We seed `supplyMintedLocal` from the
    // snapshot's `supplyMinted` (verified case takes
    // `supplyMintedOnChain` instead) so the SUPPLY column doesn't
    // briefly flicker to null between restore and the next mint.
    const verified = r.supplyVerified === true
      && typeof r.supplyMinted === 'number'
      && r.supplyMinted >= 0;
    const a: Accum = {
      groupingKey:       r.groupingKey,
      groupingKind:      r.groupingKind,
      programSource:     r.programSource,
      collectionAddress: r.collectionAddress,
      lastMintAddress:   r.lastMintAddress ?? null,
      sourceLabel:       r.sourceLabel,
      observedMints:     r.observedMints,
      events60s:         [],
      events5m:          [],
      firstObservedAt:   r.lastMintAt,
      lastMintAt:        r.lastMintAt,
      freeCount:         0,
      paidCount:         0,
      unknownCount:      0,
      displayState:      r.displayState,
      shownReason:       r.shownReason,
      shownAt:           r.displayState === 'shown' ? r.lastMintAt : undefined,
      name:              r.name,
      imageUrl:          r.imageUrl,
      representativeImageUrl:    r.representativeImageUrl,
      sharedPlaceholderImageUrl: r.sharedPlaceholderImageUrl,
      maxSupply:         r.maxSupply ?? null,
      mintedCount:       r.mintedCount ?? null,
      lmntfOwner:        r.lmntfOwner ?? null,
      lmntfCollectionId: r.lmntfCollectionId ?? null,
      supplyMintedOnChain:
        verified ? (r.supplyMinted as number) : null,
      supplyMintedLocal:
        !verified && typeof r.supplyMinted === 'number' && r.supplyMinted >= 0
          ? r.supplyMinted
          : 0,
      supplyVerifiedAt:  verified ? r.lastMintAt : undefined,
    };
    map.set(r.groupingKey, a);
    written++;
  }
  return written;
}
