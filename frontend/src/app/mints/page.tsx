'use client';

// VictoryLabs — Mints.
// Real-time NFT mint tracker. Subscribes to the existing SSE stream's
// `mint_status` channel; one in-process accumulator on the backend
// emits a status frame per collection on every detected mint and on a
// 30s sweep. No per-client polling. No new RPC.
//
// Layout mirrors /dashboard so the table style is consistent — same
// `.collections-table` className for phone CSS reuse, same flex shell,
// same scroll containment.

import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, TopNav, ItemThumb, Pill } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type ProgramSource = 'mpl_token_metadata' | 'mpl_core' | 'bubblegum';
type MintRollupType = 'free' | 'paid' | 'unknown' | 'mixed';
type SourceLabel =
  | 'LaunchMyNFT' | 'VVV' | 'ME'
  | 'Metaplex Candy Machine' | 'Metaplex Core' | 'Metaplex'
  | 'Bubblegum' | 'Unknown';

interface MintStatus {
  groupingKey:       string;
  groupingKind:      string;
  programSource:     ProgramSource;
  collectionAddress: string | null;
  /** Latest mintAddress seen for this group — the only safe Solscan
   *  link target. May be null until the first event arrives or for
   *  cNFT groups whose first sample didn't carry a leaf address. */
  lastMintAddress?:  string | null;
  /** Max planned supply for the collection (e.g. LMNFT `max_items`,
   *  MPL Core master-edition `maxSupply`). Distinct from
   *  `observedMints` — this is "how big the drop will be", not "how
   *  many we've seen". Optional — backend may not populate it until a
   *  launchpad-specific resolver decodes the relevant config account.
   *  UI falls back to "—" when null/undefined per spec. */
  maxSupply?:        number | null;
  /** Total assets DAS has indexed for this collection — backend's
   *  proxy for "how many minted so far". Refreshed on a 30 s per-row
   *  cadence. UI shows it as the MINTED column; falls back to
   *  `observedMints` when null so the cell isn't ever empty. */
  mintedCount?:      number | null;
  /** LaunchMyNFT URL fragments. Backend populates them via the LMNFT
   *  homepage scraper (`src/enrichment/lmnft.ts`). Both required to
   *  build the deep-link; either null falls back to a plain pill. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
  displayState:      'incubating' | 'shown' | 'cooled';
  shownReason?:      'threshold' | 'burst';
  observedMints:     number;
  v60:               number;
  v5m:               number;
  lastMintAt:        number;
  mintType:          MintRollupType;
  priceLamports:     number | null;
  sourceLabel:       SourceLabel;
  name?:             string;
  imageUrl?:         string;
}

/** Individual mint event — one fired per detected mint, before
 *  aggregation. Backend broadcasts these on the existing `event: mint`
 *  SSE channel (see src/events/emitter.ts MintEventWire); we mirror
 *  the shape here. Per-mint `nftName` / `imageUrl` are intentionally
 *  not on the wire — those are resolved per-`groupingKey` by the
 *  backend enricher and arrive via `mint_status`. The live feed
 *  uses the group-level imageUrl (looked up from `rows`) as the
 *  row thumbnail, with a placeholder when not yet resolved. */
interface MintEvent {
  signature:         string;
  blockTime:         string;          // ISO 8601
  programSource:     ProgramSource;
  mintAddress:       string | null;
  collectionAddress: string | null;
  groupingKey:       string;
  groupingKind:      string;
  mintType:          'free' | 'paid' | 'unknown';
  priceLamports:     number | null;
  minter:            string | null;
  sourceLabel:       SourceLabel;
  /** Wall-clock receive time (ms). Drives the "Xs ago" column without
   *  re-parsing blockTime on every tick. */
  receivedAt:        number;
  /** Per-mint metadata, lazily filled by the SSE `mint_meta` patch
   *  once DAS surfaces them. Live Mint Feed cards swap a
   *  shortMint(mintAddress) placeholder for the real NFT name + image
   *  the moment these arrive. */
  nftName?:          string | null;
  nftImageUrl?:      string | null;
}

/** Defensive client-side guard for the COLLECTIONS table — refuses to
 *  render rows that look like junk (authority / pool / program-bucket
 *  aggregates, evidence-free Metaplex noise, anything with explicit
 *  fungible signals). Applied in three places:
 *    1. localStorage hydration — filter rows on read
 *    2. SSE `mint_status` handler — filter rows before insert into state
 *    3. final render path — last-mile safety net
 *  Strong NFT evidence (image / real name / non-prefixed collection
 *  address) overrides the soft-reject prefix rule, so legitimate
 *  authority-grouped NFTs (rare but real for pre-MCC drops) still
 *  render once metadata resolves.
 *
 *  Per spec: a missing price alone is NOT enough to drop a row — some
 *  legitimate free-mint NFTs lack price until the first paid event. */
function isRenderableMintStatus(row: MintStatus | null | undefined): boolean {
  if (!row) return false;
  if (typeof row.groupingKey !== 'string') return false;

  // Defensive: explicit fungible signals on extra wire fields (none today,
  // but future-proof against backend additions).
  const r = row as unknown as Record<string, unknown>;
  if (typeof r.decimals === 'number' && r.decimals > 0) return false;
  if (typeof r.supply === 'number' && r.supply > 1) return false;
  const tokenStandard = typeof r.tokenStandard === 'string' ? r.tokenStandard.toLowerCase() : '';
  if (tokenStandard === 'fungible' || tokenStandard === 'fungibleasset' || tokenStandard === 'fungible_asset') return false;
  const iface = typeof r.interface === 'string' ? r.interface.toLowerCase() : '';
  if (iface === 'fungibletoken' || iface === 'fungibleasset') return false;

  // Strong NFT evidence — overrides the soft-reject prefix rule below.
  const hasImage = !!row.imageUrl && row.imageUrl.length > 0;
  // Short-address fallback name pattern: e.g. "Fhvo3m…SmFkM". When the
  // backend can't resolve real metadata it falls back to a shortened
  // pubkey rendering — that's NOT evidence of a real NFT.
  const isShortKeyName = !!row.name &&
    /^[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{4,8}$/.test(row.name);
  const hasRealName = !!row.name && !isShortKeyName;
  const hasNonPrefixedCollection = !!row.collectionAddress &&
    !/^(authority|program|owner|pool):/.test(row.collectionAddress);
  // Bubblegum (cNFT) program is NEVER used for fungibles by design;
  // a row carrying programSource='bubblegum' is by definition a real
  // cNFT mint and survives the soft-reject prefix rule below even
  // when the backend grouping fell back to 'program:bubblegum' (no
  // verified collection AND no merkle tree on the wire).
  const isCnftEvidence = row.programSource === 'bubblegum';
  const strongNftEvidence = hasImage || hasRealName || hasNonPrefixedCollection || isCnftEvidence;

  // Soft reject: groupingKey prefix indicates a non-collection bucket
  // (launchpad / DEX / system grouping). Keep only when strong evidence
  // proves a real NFT lives behind this aggregate.
  const gk = row.groupingKey;
  if (gk.startsWith('authority:') || gk.startsWith('program:') ||
      gk.startsWith('owner:') || gk.startsWith('pool:')) {
    if (!strongNftEvidence) {
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[mints/ui-drop-junk] grouping-prefix-no-evidence', gk);
      }
      return false;
    }
  }

  // Soft reject: bare 'Metaplex' source label with no image AND no real
  // name. Generic Token Metadata noise — when both metadata signals are
  // absent and the launchpad allowlist didn't recognise the source,
  // there's no NFT-ness left to display. Per spec, missing price alone
  // does NOT trigger this rule.
  if (row.sourceLabel === 'Metaplex' && !hasImage && !hasRealName) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[mints/ui-drop-junk] metaplex-no-evidence', gk);
    }
    return false;
  }

  return true;
}

/** Stricter display filter applied ONLY to the left Live mint tracker
 *  table. `isRenderableMintStatus` is the global safety net (drops
 *  fungibles / aggregates / evidence-free Metaplex noise); this helper
 *  goes one step further and refuses rows whose visible identity isn't
 *  useful for a tracker:
 *    1. no real `name` (missing / null / empty after trim).
 *    2. literal "NFT" — generic per-asset metadata fallback.
 *    3. name equals what `shortKey(groupingKey)` would have rendered
 *       (the backend never resolved a name and is echoing the truncated
 *       address back at us).
 *    4. name looks like a pubkey-ish fallback — contains "…" / "...",
 *       or is a long base58-only blob (≥ 24 chars, no whitespace).
 *    5. one-of-one drop without collection identity — `maxSupply ≤ 1`
 *       AND no non-prefixed collection address / collection grouping.
 *       Per spec example "DASC 1/1": even if the per-asset name string
 *       is technically real, a single-mint NFT with no collection MCC
 *       isn't a tracker-worthy "collection". A 1-of-1 with a real
 *       collection address (groupingKind=collection, non-prefixed
 *       collectionAddress) is kept — see rule 5 of the parent spec.
 *
 *  Pure render filter — never touches state or localStorage. The right-
 *  side Live Mint Feed cards do NOT use this; per-mint cards keep their
 *  own per-asset names/fallbacks. */
function isUsefulTrackerCollection(row: MintStatus): boolean {
  const realName = (row.name ?? '').trim();
  // Explicit zero-identity-singleton gate (audit task 8 finding):
  // when a row has none of the four identity dimensions —
  // trimmed name, imageUrl, lastMintAddress — and is still in
  // single-test-mint territory (observedMints ≤ 2), reject. A real
  // collection that later resolves any of these flips back to
  // visible on the next mint_status frame; this only suppresses
  // 1-of-2 mint test deploys / unindexed cNFT trees that have no
  // signal yet. Strict subset of the `!realName` reject below
  // (kept as documentation + defense-in-depth in case the bare
  // name reject is ever relaxed).
  const hasImage           = !!row.imageUrl && row.imageUrl.length > 0;
  const hasLastMint        = !!row.lastMintAddress && row.lastMintAddress.length > 0;
  const observed           = typeof row.observedMints === 'number' ? row.observedMints : 0;
  if (!realName && !hasImage && !hasLastMint && observed <= 2) return false;
  if (!realName)                              return false;
  if (realName.toLowerCase() === 'nft')       return false;
  if (realName === shortKey(row.groupingKey)) return false;
  // Pubkey-ish fallback: the codebase's shortKey emits `{6}…{4}` with
  // U+2026; some backends fall back to ASCII "...". Either way, hide.
  if (realName.includes('…') || realName.includes('...')) return false;
  // Bare base58 blob with no spaces — Solana pubkeys are 32–44 chars,
  // floor at 24 to also catch truncated variants the backend may emit.
  if (realName.length >= 24 && !/\s/.test(realName) &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(realName)) {
    return false;
  }
  // 1-of-1 drops: require evidence of a real collection grouping.
  // Without a non-prefixed collection address AND a `collection:` /
  // `groupingKind === 'collection'` key, the row is a single asset
  // wearing a per-asset name (e.g. "DASC 1/1") rather than a real
  // collection — hide it.
  const ms = typeof row.maxSupply === 'number' ? row.maxSupply : null;
  if (ms !== null && ms > 0 && ms <= 1) {
    const hasCollectionAddr = !!row.collectionAddress &&
      !/^(authority|program|owner|pool):/.test(row.collectionAddress);
    const isCollectionGrouping = row.groupingKind === 'collection' ||
      (typeof row.groupingKey === 'string' && row.groupingKey.startsWith('collection:'));
    if (!hasCollectionAddr || !isCollectionGrouping) return false;
  }
  return true;
}

/** Unified cNFT (Bubblegum) detector — shared by the LIVE MINT FEED
 *  filter and the COLLECTIONS table filter so the single CNFT ON/OFF
 *  toggle in the header controls both surfaces consistently.
 *
 *  Accepts either a MintEvent or a MintStatus row (overlapping field
 *  set covers both). Returns true when ANY of these hold:
 *    1. `programSource === 'bubblegum'` — authoritative signal from
 *       the backend detector / accumulator. Bubblegum is the cNFT
 *       program by design, never used for fungibles.
 *    2. `mintType === 'cnft'` — defensive; not currently on the wire
 *       (mintType is `free`/`paid`/`unknown`/`mixed`) but accepted in
 *       case a future backend revision starts emitting it.
 *    3. `standard === 'cnft'` — defensive; same forward-compat rationale.
 *    4. LMNFT-without-mint-address heuristic: `mintAddress`/`lastMintAddress`
 *       missing AND `sourceLabel === 'LaunchMyNFT'` AND we have a real
 *       group key. LMNFT cNFT drops surface as feed events with null
 *       mintAddress because the leaf doesn't have a stable mint
 *       address in the same sense as a legacy NFT; this catches them
 *       even when the backend hasn't tagged programSource yet. */
function isCnftLike(x: {
  programSource?:    string;
  mintType?:         string;
  sourceLabel?:      string;
  groupingKey?:      string;
  collectionAddress?: string | null;
  mintAddress?:      string | null;
  lastMintAddress?:  string | null;
} | MintEvent | MintStatus): boolean {
  const r = x as Record<string, unknown>;
  if (r.programSource === 'bubblegum') return true;
  if (r.mintType      === 'cnft')      return true;
  if (r.standard      === 'cnft')      return true;
  const mintAddr      = (r.mintAddress      ?? null) as string | null;
  const lastMintAddr  = (r.lastMintAddress  ?? null) as string | null;
  const sourceLabel   = typeof r.sourceLabel === 'string' ? r.sourceLabel : '';
  const groupingKey   = typeof r.groupingKey === 'string' ? r.groupingKey : '';
  const collection    = (r.collectionAddress ?? null) as string | null;
  if (
    mintAddr === null && lastMintAddr === null &&
    sourceLabel === 'LaunchMyNFT' &&
    (groupingKey.length > 0 || (typeof collection === 'string' && collection.length > 0))
  ) {
    return true;
  }
  return false;
}

/** Defensive client-side guard against fungible / SPL / program-account
 *  events leaking into the live feed. The backend already filters these
 *  via NFT-shape checks + a program-account blacklist — this safety net
 *  only triggers when the wire frame carries an *explicit* fungible
 *  signal, so a frame without these fields is still passed through
 *  (the function returns false). Mirrors the /mints product rule:
 *  show only Core / pNFT / legacy NFTs. */
function isClearlyNonNftMintEvent(ev: unknown): boolean {
  if (!ev || typeof ev !== 'object') return false;
  const r = ev as Record<string, unknown>;
  if (typeof r.decimals === 'number' && r.decimals > 0) return true;
  if (typeof r.supply === 'number' && r.supply > 1) return true;
  if (typeof r.supply === 'string') {
    const n = Number(r.supply);
    if (Number.isFinite(n) && n > 1) return true;
  }
  const ts = typeof r.tokenStandard === 'string' ? r.tokenStandard.toLowerCase() : '';
  if (ts === 'fungible' || ts === 'fungibleasset' || ts === 'fungible_asset') return true;
  const iface = typeof r.interface === 'string' ? r.interface.toLowerCase() : '';
  if (iface === 'fungibletoken' || iface === 'fungibleasset') return true;
  const at = typeof r.assetType === 'string' ? r.assetType.toLowerCase() : '';
  if (at === 'fungible' || at === 'fungibletoken' || at === 'fungible_token'
   || at === 'token' || at === 'program' || at === 'programaccount' || at === 'program_account') return true;
  return false;
}

/** Live-feed retention. Older events are dropped from the head when
 *  this is exceeded. Persisted in localStorage so a page reload /
 *  tab-switch doesn't wipe the recent stream. */
const LIVE_FEED_MAX     = 150;
/** Defensive ceiling on rows loaded from the persisted collections
 *  store. `savePersistedCollections` already trims writes to 200, so
 *  a value above that bounds damage from out-of-band corruption (e.g.
 *  a manual DevTools edit) while still tolerating legitimate writes. */
const COLLECTIONS_LOAD_MAX = 500;

/** Cache version for /mints localStorage entries. Bump this constant
 *  whenever the backend filter rules change so already-cached rows
 *  that no longer pass the filter (e.g. fungible tokens) get evicted
 *  on the next page load. The version is checked in
 *  `migratePersistedCachesIfNeeded()` below — mismatch → wipe both
 *  the live-feed and collections stores, then write the new version. */
const MINTS_CACHE_VERSION_KEY = 'vl.mints.cacheVersion';
const MINTS_CACHE_VERSION     = 'launchpad.v5-minted';

function migratePersistedCachesIfNeeded(): void {
  if (typeof window === 'undefined') return;
  try {
    const have = window.localStorage.getItem(MINTS_CACHE_VERSION_KEY);
    if (have === MINTS_CACHE_VERSION) return;
    // Mismatch (or first run) → drop the persisted /mints stores so
    // any rows produced by an older filter regime disappear. Other
    // localStorage entries (auth, layout-mode, price-mode, /tools
    // scan caches) are intentionally untouched.
    window.localStorage.removeItem('vl.mints.liveFeed');
    window.localStorage.removeItem('vl.mints.collections');
    window.localStorage.setItem(MINTS_CACHE_VERSION_KEY, MINTS_CACHE_VERSION);
  } catch { /* quota / private mode — fail silent */ }
}

/** Idempotent guard — invoked at the top of every persisted-store
 *  loader so the version migration runs exactly once, on the first
 *  loader call (which lands inside React's first useState lazy
 *  initializer). This keeps migration off module-import while
 *  guaranteeing the first localStorage read sees a clean store
 *  on a version bump. */
let didRunCacheMigration = false;
function ensureCacheMigration(): void {
  if (didRunCacheMigration) return;
  didRunCacheMigration = true;
  migratePersistedCachesIfNeeded();
}
/** localStorage key for the live-feed buffer. Per-user, single key
 *  (no multi-account variants for now). */
const FEED_STORAGE_KEY  = 'vl.mints.liveFeed';
/** Per-collection rollup cache. Persists the active-collections
 *  table across reloads so the operator doesn't see an empty table
 *  while waiting for the next mint_status frame. Longer TTL (24 h)
 *  because incubating/active groups can be silent for a while
 *  between traffic spikes. */
const COLLECTIONS_STORAGE_KEY = 'vl.mints.collections';
const COLLECTIONS_TTL_MS      = 24 * 60 * 60_000;  // 24 hours

interface PersistedCollections {
  savedAt: number;
  rows:    MintStatus[];
}

function loadPersistedCollections(): Map<string, MintStatus> {
  if (typeof window === 'undefined') return new Map();
  ensureCacheMigration();
  try {
    const raw = window.localStorage.getItem(COLLECTIONS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as PersistedCollections | null;
    // Corrupt root / missing fields / non-array rows → drop the key so
    // the next legitimate save lands cleanly instead of layering on
    // top of garbage.
    if (!parsed || typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.rows)) {
      try { window.localStorage.removeItem(COLLECTIONS_STORAGE_KEY); } catch { /* fail silent */ }
      return new Map();
    }
    if (Date.now() - parsed.savedAt > COLLECTIONS_TTL_MS) return new Map();
    const out = new Map<string, MintStatus>();
    for (const r of parsed.rows) {
      if (!r || typeof r.groupingKey !== 'string') continue;
      // Defensive UI-side junk filter — drops authority/pool/program
      // aggregates and evidence-free Metaplex rows resurrected from
      // pre-fix localStorage state. See `isRenderableMintStatus`.
      if (!isRenderableMintStatus(r)) continue;
      out.set(r.groupingKey, r);
      if (out.size >= COLLECTIONS_LOAD_MAX) break;
    }
    return out;
  } catch {
    try { window.localStorage.removeItem(COLLECTIONS_STORAGE_KEY); } catch { /* fail silent */ }
    return new Map();
  }
}

function savePersistedCollections(rows: Map<string, MintStatus>): void {
  if (typeof window === 'undefined') return;
  try {
    // Cap to 200 most-recently-touched so a long-running session can't
    // bloat the stored payload past the localStorage quota.
    const arr = Array.from(rows.values())
      .sort((a, b) => b.lastMintAt - a.lastMintAt)
      .slice(0, 200);
    const payload: PersistedCollections = { savedAt: Date.now(), rows: arr };
    window.localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(payload));
  } catch { /* quota / private mode — fail silent */ }
}

function loadPersistedFeed(): MintEvent[] {
  if (typeof window === 'undefined') return [];
  ensureCacheMigration();
  try {
    const raw = window.localStorage.getItem(FEED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      try { window.localStorage.removeItem(FEED_STORAGE_KEY); } catch { /* fail silent */ }
      return [];
    }
    // Restore-as-is: dedupe by signature, validate shape only. No age-based
    // filter — fresh events must survive remount unconditionally; stale
    // entries are bounded by LIVE_FEED_MAX (sliding-window) instead of TTL.
    const out: MintEvent[] = [];
    const seen = new Set<string>();
    for (const v of parsed) {
      if (!v || typeof v !== 'object')        continue;
      const ev = v as MintEvent;
      if (typeof ev.signature !== 'string')   continue;
      if (typeof ev.receivedAt !== 'number')  continue;
      if (seen.has(ev.signature))             continue;
      seen.add(ev.signature);
      out.push(ev);
    }
    // Sort newest-first by receivedAt (which is anchored to blockTime when
    // available) so the restored display order is independent of the order
    // events were appended to localStorage during the previous session.
    out.sort((a, b) => b.receivedAt - a.receivedAt);
    const capped = out.slice(0, LIVE_FEED_MAX);
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[mints/cache] restored feed', capped.length, {
        parsedLen: parsed.length,
      });
    }
    return capped;
  } catch {
    try { window.localStorage.removeItem(FEED_STORAGE_KEY); } catch { /* fail silent */ }
    return [];
  }
}

function savePersistedFeed(events: MintEvent[]): void {
  if (typeof window === 'undefined') return;
  try {
    // No TTL filter on write — fresh events must persist across remount.
    // Cap by count only so a long-running session can't blow the quota.
    const slice = events.slice(0, LIVE_FEED_MAX);
    window.localStorage.setItem(FEED_STORAGE_KEY, JSON.stringify(slice));
  } catch { /* quota / private mode — fail silent */ }
}

/** Rebuild minimal MintStatus rows from restored MintEvent buffer.
 *  Used on mount when:
 *    - the live-feed restore brought back events for a group whose
 *      `mint_status` snapshot is no longer in the persisted collections
 *      store (or was never there — restored from a prior session that
 *      saved the feed but evicted the collection row at the 24 h
 *      collections-cache TTL or the 200-row write cap), AND
 *    - the backend's `mint_status` snapshot replay (sent on SSE connect)
 *      hasn't yet arrived for that group.
 *  Without this, the LIVE MINT FEED panel shows old events but the
 *  COLLECTIONS table on the left is empty for those groups even when
 *  the user picks 4H / 1D timeframe — the row simply doesn't exist.
 *
 *  Synthesized rows are always `displayState: 'incubating'` so they
 *  appear in both ACTIVE (WATCH tier) and RECENT tabs once a real
 *  `mint_status` from the backend arrives, the SSE handler's
 *  sticky-merge overwrites these scaffolds with authoritative numbers
 *  (observedMints / v60 / v5m / displayState / mintType / etc.) while
 *  preserving any name / image that resolved later. */
/** Compute the most specific grouping key available on a MintEvent.
 *  Priority:
 *    1. `ev.groupingKey` — backend-authoritative (already prefixed with
 *       `collection:` / `tree:` / `program:` / `authority:`).
 *    2. `collection:<collectionAddress>` — synthesised when groupingKey
 *       is empty but a collection address is on the wire.
 *    3. `mint:<mintAddress>` — last-resort, single-asset key. Only
 *       used when nothing else is present (rare; mostly applicable to
 *       legacy / pNFT events without grouping info).
 *  Returns null when the event carries none of the above (event is
 *  un-groupable and the row would be a duplicate-prone singleton). */
function rebuildEventGroupingKey(ev: MintEvent): string | null {
  if (typeof ev.groupingKey === 'string' && ev.groupingKey.length > 0) {
    return ev.groupingKey;
  }
  if (ev.collectionAddress) return `collection:${ev.collectionAddress}`;
  if (ev.mintAddress)       return `mint:${ev.mintAddress}`;
  return null;
}

interface RebuildResult { rows: Map<string, MintStatus>; cnftCount: number }

function rebuildCollectionsFromEvents(events: MintEvent[]): RebuildResult {
  const now = Date.now();
  const out = new Map<string, MintStatus>();
  const freeCount: Record<string, number> = {};
  const paidCount: Record<string, number> = {};
  for (const ev of events) {
    const key = rebuildEventGroupingKey(ev);
    if (!key) {
      console.log(
        `[mints/cache] rebuildSkip reason=missing_group sig=${ev.signature?.slice(0, 12) ?? '—'}…`,
      );
      continue;
    }
    let row = out.get(key);
    if (!row) {
      row = {
        groupingKey:       key,
        groupingKind:      ev.groupingKind,
        // Preserve programSource ('mpl_token_metadata' / 'mpl_core' /
        // 'bubblegum'). Critical for cNFT rows: without this, the
        // table row would mis-classify the source and the LIVE FEED
        // CNFT toggle's render filter would still leave the row in
        // the table (correct) but with the wrong sourceLabel pill.
        programSource:     ev.programSource,
        collectionAddress: ev.collectionAddress,
        lastMintAddress:   ev.mintAddress,
        // Preserve sourceLabel ('Bubblegum' / 'LaunchMyNFT' / 'Metaplex'
        // / 'CandyMachine' / etc.) so the SOURCE pill renders the
        // right launchpad even before the first real `mint_status`
        // arrives.
        sourceLabel:       ev.sourceLabel,
        displayState:      'incubating',
        observedMints:     0,
        v60:               0,
        v5m:               0,
        lastMintAt:        0,
        mintType:          'unknown',
        priceLamports:     null,
        // name / imageUrl / maxSupply / mintedCount / lmntfOwner /
        // lmntfCollectionId left undefined — no per-NFT image leaks
        // into the collection row. The first authoritative
        // `mint_status` frame after SSE reconnect fills these in.
      };
      out.set(key, row);
      freeCount[key] = 0;
      paidCount[key] = 0;
    }
    row.observedMints++;
    if (ev.receivedAt > row.lastMintAt) row.lastMintAt = ev.receivedAt;
    if (ev.mintAddress) row.lastMintAddress = ev.mintAddress;
    if (now - ev.receivedAt < 60_000)  row.v60++;
    if (now - ev.receivedAt < 300_000) row.v5m++;
    if (ev.mintType === 'free')      freeCount[key]++;
    else if (ev.mintType === 'paid') paidCount[key]++;
  }
  // Roll up mintType the same way the backend does (`rollupType` in
  // src/mints/accumulator.ts): mostly-free / mostly-paid / mixed /
  // unknown. Cheap pass over the per-group counters.
  let cnftCount = 0;
  for (const [k, row] of out) {
    const obs = row.observedMints;
    const f   = freeCount[k] ?? 0;
    const p   = paidCount[k] ?? 0;
    if (obs === 0)            row.mintType = 'unknown';
    else if (f / obs > 0.95)  row.mintType = 'free';
    else if (p / obs > 0.95)  row.mintType = 'paid';
    else if (f > 0 && p > 0)  row.mintType = 'mixed';
    else                      row.mintType = 'unknown';
    if (row.programSource === 'bubblegum') cnftCount++;
  }
  return { rows: out, cnftCount };
}

/** Lighter-weight render check used ONLY by the synth-row merge path.
 *  Events that survived to localStorage already passed
 *  `isClearlyNonNftMintEvent` at save time, so they're definitionally
 *  real NFT mints. The strict `isRenderableMintStatus` rules below
 *  exist for backend `mint_status` frames whose `groupingKey` may be
 *  a launchpad/program bucket without strong NFT evidence — here that
 *  filter wrongly drops cNFT rows whose backend grouping fell back to
 *  `program:bubblegum` (when neither verified collection nor merkle
 *  tree was on the wire). For synth rows we trust the upstream
 *  feed-side filter and only require a non-empty groupingKey. */
function isRebuildableSynthRow(row: MintStatus): boolean {
  return typeof row.groupingKey === 'string' && row.groupingKey.length > 0;
}

/** Debounce shell for the two persist functions above. The raw
 *  `savePersistedCollections` / `savePersistedFeed` calls were being
 *  invoked from inside the SSE setRows / setEvents updaters on every
 *  mint_status / mint_meta / mint frame. During a hot launch (sweep
 *  re-emits N rows every 30 s plus per-mint frames) this serialized
 *  the entire rows Map / events array on the main thread many times
 *  per second. Coalescing on a 1.5 s timer cuts the per-frame cost
 *  while keeping the persisted store eventually-consistent.
 *
 *  A `pagehide` / `beforeunload` flush guarantees the latest snapshot
 *  survives a tab close — important on /mints where the user often
 *  alt-tabs between collections during a launch. */
const PERSIST_DEBOUNCE_MS = 1500;

let collectionsFlushTimer:   ReturnType<typeof setTimeout> | null = null;
let collectionsPendingRows:  Map<string, MintStatus> | null = null;
let feedFlushTimer:          ReturnType<typeof setTimeout> | null = null;
let feedPendingEvents:       MintEvent[] | null = null;

function flushPersistedCollectionsNow(): void {
  if (collectionsFlushTimer != null) {
    clearTimeout(collectionsFlushTimer);
    collectionsFlushTimer = null;
  }
  if (collectionsPendingRows) {
    savePersistedCollections(collectionsPendingRows);
    collectionsPendingRows = null;
  }
}
function flushPersistedFeedNow(): void {
  if (feedFlushTimer != null) {
    clearTimeout(feedFlushTimer);
    feedFlushTimer = null;
  }
  if (feedPendingEvents) {
    savePersistedFeed(feedPendingEvents);
    feedPendingEvents = null;
  }
}

function schedulePersistedCollections(rows: Map<string, MintStatus>): void {
  if (typeof window === 'undefined') return;
  collectionsPendingRows = rows;
  if (collectionsFlushTimer != null) return;
  collectionsFlushTimer = setTimeout(flushPersistedCollectionsNow, PERSIST_DEBOUNCE_MS);
}
function schedulePersistedFeed(events: MintEvent[]): void {
  if (typeof window === 'undefined') return;
  feedPendingEvents = events;
  if (feedFlushTimer != null) return;
  feedFlushTimer = setTimeout(flushPersistedFeedNow, PERSIST_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') {
  const flushAllNow = (): void => {
    flushPersistedCollectionsNow();
    flushPersistedFeedNow();
  };
  window.addEventListener('pagehide',     flushAllNow);
  window.addEventListener('beforeunload', flushAllNow);
}
/** Proxy size for live-feed thumbnails — 64×64, matches the spec's
 *  /thumb URL form. compressImage() defaults to 200×200; the live
 *  feed uses this smaller size to halve bandwidth on rolling rows. */
function thumb64(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=64&h=64&fit=cover&output=png`;
}
/** Proxy size for the live-mint card thumbnails — 200×200 source. The
 *  card display size stays around the existing 56–64 px footprint, so
 *  the larger source is purely for crisp rendering on hi-DPI displays
 *  (and matches the spec's "200×200 source if available"). */
function thumb200(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=200&h=200&fit=cover&output=png`;
}
function shortMint(addr: string | null): string {
  if (!addr) return '—';
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

// LMNFT URL pattern:
//   https://www.launchmynft.io/collections/{lmntfOwner}/{lmntfCollectionId}
// Both fields must be present and look like a safe path segment for
// the link to render — defends against XSS / open-redirect via wire-
// injected paths even if the backend scraper ever misbehaves.
const SAFE_URL_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
function buildLaunchMyNftUrl(row: MintStatus): string | null {
  const owner = row.lmntfOwner;
  const id    = row.lmntfCollectionId;
  // Direct per-collection mint page — preferred when both fragments
  // resolved (LMNFT featured-set scrape or on-chain state decode).
  if (owner && id && SAFE_URL_SEGMENT_RE.test(owner) && SAFE_URL_SEGMENT_RE.test(id)) {
    return `https://www.launchmynft.io/collections/${owner}/${id}`;
  }
  // Fallback: LMNFT `/explore` Algolia-search by deployer wallet.
  // We deliberately do NOT fall back to `collectionAddress` as the
  // search query — Algolia returns the wrong/empty result for the
  // on-chain collection address (it indexes by deployer + collection
  // name, not by token address). Instead the backend resolves the
  // owner from three sources, in order:
  //   1. LMNFT featured-set scraper (`getLmnftInfoByMint`)
  //   2. on-chain LMNFT state-account decoder (`getLmnftStateForCollection`)
  //   3. DAS collection-asset owner (`getCollectionOwner`)
  // (3) is the safety net — for MPL Core collections it reads
  // `getAsset(collectionAddress).ownership.owner` which IS the
  // deployer wallet. By the time the user clicks the pill `lmntfOwner`
  // is virtually always populated.
  if (owner && SOL_PUBKEY_RE.test(owner)) {
    return `https://www.launchmynft.io/explore?` +
      `query=${encodeURIComponent(owner)}` +
      `&toggle%5BtwitterVerified%5D=false` +
      `&toggle%5BsoldOut%5D=false` +
      `&page=1` +
      `&sortBy=collections%2Fsort%2FlastMintedAt%3Adesc` +
      `&refinementList%5Btype%5D%5B0%5D=Solana`;
  }
  return null;
}

/** Slug rule used to deep-link a VVV mint into vvv.so. Lowercase,
 *  unicode-folded, non-alphanumerics collapsed to a single hyphen.
 *  Returns '' when the input has no usable characters (caller treats
 *  that as "no link, plain pill"). Examples:
 *    "CSTRIKE v2"        → "cstrike-v2"
 *    "Neo Keith : Angel" → "neo-keith-angel"
 *    "Pepok Collection"  → "pepok-collection"
 *    "Café Latte"        → "cafe-latte"
 *    "###"               → "" (no link) */
function vvvSlugify(input: string): string {
  let s = input.trim().toLowerCase();
  // NFKD splits accented chars (é → e + combining acute), then we drop
  // the combining marks. Wrapped in try/catch because some legacy
  // browsers don't ship `normalize` for every form.
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { /* noop */ }
  s = s.replace(/[^a-z0-9]+/g, '-');  // anything not [a-z0-9] → '-'
  s = s.replace(/-+/g, '-');          // collapse runs
  s = s.replace(/^-+|-+$/g, '');      // trim edges
  return s;
}

/** Build the per-collection vvv.so URL from the row's collection name.
 *  Returns null when the name is missing or slugifies to empty. */
function buildVvvCollectionUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = vvvSlugify(name);
  return slug ? `https://www.vvv.so/${slug}` : null;
}

/** Outbound link target for launchpad source badges. Returns null for
 *  sources where we can't safely build a per-collection deep link —
 *  the badge then renders as a plain pill (no anchor). LMNFT requires
 *  per-row owner + collectionId from the wire; VVV uses the collection
 *  name slugified into the vvv.so per-collection URL shape. */
function sourceHref(row: MintStatus): string | null {
  switch (row.sourceLabel) {
    case 'LaunchMyNFT':
      // Build the per-collection mint page when we have the LMNFT
      // owner + collectionId fields. Falls through to null (plain
      // pill, no link) when either is missing — never the homepage,
      // per the targeted-mode spec.
      return buildLaunchMyNftUrl(row);
    case 'VVV':
      // Per-collection vvv.so URL derived from the collection name.
      // Plain pill when no name yet (mirrors the LMNFT "wait for the
      // wire to populate" pattern — no point linking to a homepage).
      return buildVvvCollectionUrl(row.name);
    default:
      return null;
  }
}

function sourceBadge(s: SourceLabel): { label: string; bg: string; fg: string } {
  switch (s) {
    case 'LaunchMyNFT':            return { label: 'LMNFT',    bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' };
    case 'VVV':                    return { label: 'VVV',      bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' };
    case 'ME':                     return { label: 'ME',       bg: 'rgba(232,122,176,0.15)', fg: '#e87ab0' };
    case 'Metaplex Candy Machine': return { label: 'CANDY',    bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Metaplex Core':          return { label: 'CORE',     bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Metaplex':               return { label: 'METAPLEX', bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Bubblegum':              return { label: 'cNFT',     bg: 'rgba(92,224,160,0.15)',  fg: '#5ce0a0' };
    default:                       return { label: 'UNKNOWN',  bg: 'rgba(255,255,255,0.05)', fg: '#7a7a94' };
  }
}

type SortKey = 'collection' | 'mints' | 'supply' | 'last' | 'coef' | 'velocity';
type SortDir = 'asc' | 'desc';
type MintTab = 'active' | 'recent';

/** Mirror of the dashboard's TIMEFRAMES — same labels, same windows.
 *  Used by the Live Mint Tracker's RECENT tab to filter rows by
 *  `lastMintAt` falling inside the chosen window. */
const MINT_TIMEFRAMES = ['5M', '10M', '15M', '30M', '1H', '4H', '1D'] as const;
type MintTimeframe = typeof MINT_TIMEFRAMES[number];
const MINT_TF_MS: Record<MintTimeframe, number> = {
  '5M':   5 * 60_000,
  '10M': 10 * 60_000,
  '15M': 15 * 60_000,
  '30M': 30 * 60_000,
  '1H':  60 * 60_000,
  '4H':  4  * 60 * 60_000,
  '1D':  24 * 60 * 60_000,
};
/** Per-timeframe tooltips for the pills in the tracker header. Same
 *  phrasing across pills so users learn the rule once and don't
 *  have to interpret each label — the window scopes WHICH rows
 *  appear and the active-window math behind RATE / COEF. */
const MINT_TF_DESC: Record<MintTimeframe, string> = {
  '5M':  'Show collections active in the last 5 minutes',
  '10M': 'Show collections active in the last 10 minutes',
  '15M': 'Show collections active in the last 15 minutes',
  '30M': 'Show collections active in the last 30 minutes',
  '1H':  'Show collections active in the last hour',
  '4H':  'Show collections active in the last 4 hours',
  '1D':  'Show collections active in the last 24 hours',
};

function fmtSol(lamports: number | null): string {
  if (lamports == null) return '—';
  if (lamports === 0)   return 'FREE';
  // Shared formatter: ≥0.1 → 2 decimals, <0.1 → 3 decimals.
  return formatSol(lamports / 1e9);
}

function fmtAge(ts: number): string {
  // Defensive: invalid timestamp → em-dash; future / negative ages
  // collapse into the "just now" branch via the `< 5_000` check
  // below so a clock skew between client and server can't render
  // absurd labels like "-3s ago".
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function typeBadge(t: MintRollupType): { label: string; bg: string; fg: string } {
  switch (t) {
    case 'free':    return { label: 'FREE',    bg: 'rgba(92,224,160,0.15)',  fg: '#5ce0a0' };
    case 'paid':    return { label: 'PAID',    bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'mixed':   return { label: 'MIXED',   bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' };
    default:        return { label: 'UNKNOWN', bg: 'rgba(255,255,255,0.05)', fg: '#7a7a94' };
  }
}

function shortKey(k: string): string {
  // Display-friendly truncation when no name is available.
  const clean = k.replace(/^[a-z]+:/, '');
  return clean.length > 14 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean;
}

/** Deterministic accent color per collection. Same address → same
 *  color across reloads, across collection-row + live-feed-card
 *  surfaces. Palette stays in the dark VictoryLabs purple-leaning
 *  family so accents read as "tag", not "alert". FNV-1a over the
 *  address gives a stable index without per-render allocation. */
const COLLECTION_PALETTE: readonly string[] = [
  '#8068d8',  // VL purple (default fallback)
  '#a890e8',  // light purple
  '#5fa8e6',  // teal-blue
  '#36b868',  // green
  '#e8c14a',  // amber (muted)
  '#e87ab0',  // pink
  '#5ce0a0',  // mint
  '#c084fc',  // lavender
  '#7a63c4',  // dim purple
  '#4e8cd4',  // blue
  '#28a878',  // dark green
];
function colorForCollection(addr: string | null | undefined): string {
  if (!addr) return COLLECTION_PALETTE[0];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return COLLECTION_PALETTE[h % COLLECTION_PALETTE.length];
}

/** Strict Solana pubkey check (base58, 32–44 chars). Used as a final
 *  guard before linking to Solscan so we never emit a URL pointing at
 *  a prefix-tagged groupingKey ('authority:…', 'pool:…') or any other
 *  non-pubkey value the wire might carry. */
const SOL_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isSolPubkey(s: string | null | undefined): s is string {
  return typeof s === 'string' && SOL_PUBKEY_RE.test(s);
}

/** Per-row external links cluster: Solscan + Magic Eden.
 *  Solscan path branches on programSource — MPL Core assets/collections
 *  are first-class accounts (`/account/`), Token Metadata mints are SPL
 *  token mints (`/token/`). Magic Eden's `/item-details/<addr>` resolves
 *  both Core asset addresses and TM mint addresses, so a single URL form
 *  covers both. Renders a muted dash when no on-chain anchor is known
 *  yet (groupingKind is `authority` / `programSource`). */
function RowLinks({
  collectionAddress,
  programSource,
}: {
  collectionAddress: string | null;
  programSource: ProgramSource;
}) {
  if (!collectionAddress) {
    return <span style={{ color: '#3a3a52', fontSize: 11 }}>—</span>;
  }
  const solscanPath = programSource === 'mpl_core' ? 'account' : 'token';
  const solscanUrl  = `https://solscan.io/${solscanPath}/${collectionAddress}`;
  const meUrl       = `https://magiceden.io/item-details/${collectionAddress}`;
  return (
    <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
      <a
        href={solscanUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Solscan · ${collectionAddress}`}
        style={solscanChipStyle}
      >SOL</a>
      <a
        href={meUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Magic Eden · ${collectionAddress}`}
        style={logoChipStyle}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/me.png" alt="Magic Eden" width={20} height={20} draggable={false} style={logoImgStyle} />
      </a>
    </div>
  );
}

/** Square chrome shared with /tools — 22×22 logo button. */
const logoChipStyle: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          22,
  height:         22,
  borderRadius:   4,
  overflow:       'hidden',
  border:         '1px solid rgba(255,255,255,0.08)',
  cursor:         'pointer',
  textDecoration: 'none',
  flexShrink:     0,
  lineHeight:     0,
};
const logoImgStyle: React.CSSProperties = {
  display:      'block',
  width:        '100%',
  height:       '100%',
  objectFit:    'cover',
  pointerEvents: 'none',
};
/** Text-only chip used for Solscan since we don't ship a brand asset
 *  for it. Same 22×22 footprint as the logo chips so the LINKS column
 *  stays a uniform width regardless of which links are present. */
const solscanChipStyle: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          22,
  height:         22,
  fontSize:       9,
  fontWeight:     800,
  letterSpacing:  '0.3px',
  borderRadius:   4,
  border:         '1px solid rgba(168,144,232,0.45)',
  background:     'rgba(168,144,232,0.12)',
  color:          '#a890e8',
  textDecoration: 'none',
  cursor:         'pointer',
  flexShrink:     0,
};

export default function MintsPage() {
  // Embed mode (`?embed=1`) suppresses TopNav so multi-tab can iframe
  // the real /mints page without a duplicated chrome row, mirroring
  // the existing /dashboard and /feed embed plumbing.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'VictoryLabs — Mints'; }, []);
  const [rows, setRows]       = useState<Map<string, MintStatus>>(() => loadPersistedCollections());
  /** Rolling buffer of individual mint events for the bottom Live Feed.
   *  Newest at index 0; capped at LIVE_FEED_MAX. Hydrated synchronously
   *  from localStorage on first render via the lazy initializer so a
   *  page reload doesn't flash an empty feed before the SSE reconnects.
   *  Stored payload is deduped by signature + sorted newest-first
   *  inside loadPersistedFeed(); no age-based eviction. */
  const [events, setEvents]   = useState<MintEvent[]>(() => loadPersistedFeed());
  // Mirror of `events` for synchronous reads from event listeners
  // (mint_meta needs to find the groupingKey by signature without
  // racing setEvents's async batched update).
  const eventsRef = useRef<MintEvent[]>(events);
  useEffect(() => { eventsRef.current = events; }, [events]);
  const [sortKey, setSortKey] = useState<SortKey>('velocity');
  // Direction is per-key; toggling the same header flips it, picking a
  // new header resets to 'desc' (the natural default for numeric/recency
  // columns — collection/source still default to 'desc' so a single click
  // produces a Z→A read, second click flips to A→Z).
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Has the user manually clicked a column header in the current tab?
  // While false, each tab uses its own default (ACTIVE → RATE desc,
  // RECENT → LAST MINT desc) so the table reads as "active activity"
  // / "recent activity" without surprising the user with an unrelated
  // metric ordering. Resets on tab switch so going to RECENT always
  // starts newest-first regardless of what was clicked under ACTIVE.
  const [hasManualSort, setHasManualSort] = useState<boolean>(false);
  const handleSortClick = (k: SortKey) => {
    setHasManualSort(true);
    // When entering manual mode, the displayed sort key may differ
    // from the underlying `sortKey` state (effective default kicks in).
    // Compare against the *effective* key so a click on the currently-
    // visible column flips direction, while a click on a different
    // column resets to desc.
    const currentEffective = hasManualSort
      ? sortKey
      : (mintTab === 'recent' ? 'last' : 'velocity');
    if (k === currentEffective) {
      const currentDir = hasManualSort ? sortDir : 'desc';
      setSortKey(k);
      setSortDir(currentDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(k);
      setSortDir('desc');
    }
  };
  // Self-tick — exposed (not just discarded via `[, force]`) so the
  // tfStatsByKey / sorted memos can include it in their deps and re-
  // evaluate the timeframe cutoff every 5 s. Without that dep, a row
  // whose lastMintAt rolled past the selected window stayed visible
  // until something else (new event, tab change, tf change) forced
  // the memo to recompute — which is what produced the "30M selected
  // but rows show 56m ago" bug.
  const [tick, setTick]       = useState(0);

  // ACTIVE / RECENT tab — mirrors the dashboard pattern. ACTIVE keeps
  // the existing two-tier sort (shown rows first, watch rows after);
  // RECENT flattens to "any row with a mint inside the selected
  // timeframe window, sorted by most-recent mint", ignoring the
  // shown/watch promotion gate so freshly-mintted but not-yet-promoted
  // collections surface immediately. Tab + timeframe + filters-open
  // are persisted in localStorage with the same key prefix as the rest
  // of /mints state.
  const [mintTab, setMintTab] = useState<MintTab>(() => {
    if (typeof window === 'undefined') return 'active';
    try {
      const v = window.localStorage.getItem('vl.mints.tab');
      return v === 'recent' ? 'recent' : 'active';
    } catch { return 'active'; }
  });
  const [mintTf, setMintTf] = useState<MintTimeframe>(() => {
    if (typeof window === 'undefined') return '1H';
    try {
      const v = window.localStorage.getItem('vl.mints.tf');
      return (MINT_TIMEFRAMES as readonly string[]).includes(v ?? '')
        ? (v as MintTimeframe)
        : '1H';
    } catch { return '1H'; }
  });
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.tab', mintTab); } catch { /* noop */ }
    // Tab switch clears manual-sort state so each tab opens with its
    // own default ordering (ACTIVE → RATE desc, RECENT → LAST MINT
    // desc). Manual click in the new tab re-enables the user's choice.
    setHasManualSort(false);
  }, [mintTab]);
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.tf', mintTf); } catch { /* noop */ }
  }, [mintTf]);

  // cNFT visibility toggle for the LIVE MINT FEED panel. cNFT (Bubblegum)
  // mints arrive in massive bursts (free airdrop drops can saturate the
  // feed for minutes). The toggle hides them from the right-pane stream
  // without affecting the LEFT collections table or backend ingest —
  // it's a pure render filter. Persisted in localStorage so the
  // preference survives reloads. Default ON (show everything).
  const [showCnft, setShowCnft] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const v = window.localStorage.getItem('vl.mints.feed.showCnft');
      return v === null ? true : v === '1';
    } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.feed.showCnft', showCnft ? '1' : '0'); } catch { /* quota — fail silent */ }
  }, [showCnft]);

  // Render-time view of `events` for the LIVE MINT FEED panel. Pure
  // filter — does not touch the persisted store, so flipping the toggle
  // never drops anything from localStorage. Uses the shared `isCnftLike`
  // detector so the same rule applies to the COLLECTIONS table memo
  // below — a single CNFT ON/OFF toggle in the header consistently
  // hides/shows cNFTs in both surfaces.
  const visibleEvents = useMemo(
    () => showCnft ? events : events.filter(ev => !isCnftLike(ev)),
    [events, showCnft],
  );

  // Self-tick so velocity / lastMint columns refresh smoothly between
  // backend status frames (every 5s here vs. 30s sweep on backend).
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // One-shot mount log — surfaces what hydrated from localStorage
  // (collection rows + live mint events). Helps confirm the persisted-
  // feed survives reloads in production. Only fires on first mount.
  const cacheLoggedRef = useRef(false);
  useEffect(() => {
    if (cacheLoggedRef.current) return;
    cacheLoggedRef.current = true;
    console.log(`[mints/cache] restored collections=${rows.size} events=${events.length}`);
    // Rebuild missing collection rows from the restored live-feed
    // events. Runs ONCE on mount, before any SSE traffic can arrive
    // (the SSE useEffect opens the connection in the same tick but
    // the network round-trip lands later). Result: when the user
    // expands the timeframe to 4H / 1D, collections that exist only
    // in the persisted feed (no surviving collection cache row, no
    // backend snapshot replay yet) still appear in the table. The
    // SSE handler's sticky-merge later overwrites these scaffolds
    // with authoritative `mint_status` data while preserving any
    // synthesized lastMintAt / observedMints in the meantime.
    if (events.length > 0) {
      setRows(prev => {
        const { rows: synth, cnftCount } = rebuildCollectionsFromEvents(events);
        let added = 0;
        const next = new Map(prev);
        for (const [k, synthRow] of synth) {
          if (next.has(k)) continue;                       // mint_status authoritative
          if (!isRebuildableSynthRow(synthRow)) continue;  // light filter — events
                                                           // already passed feed-side
                                                           // non-NFT guard at save
          next.set(k, synthRow);
          added++;
        }
        if (added === 0) return prev;
        console.log(`[mints/cache] rebuiltCollectionsFromFeed=${added} cnft=${cnftCount}`);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the live feed whenever `events` changes. This was previously
  // called inside the setState updater for the SSE handler and the
  // eviction interval, but updaters must be pure — React 18 may invoke
  // them multiple times during concurrent rendering and strict-mode
  // checks, so a side-effecting `savePersistedFeed(...)` inside the
  // updater could write intermediate values that don't match the
  // committed state. A `useEffect` keyed on `events` always runs after
  // commit with the actual state, fixing the asymmetry where mint
  // collections persisted (their save path is similar but saves often
  // enough that any stray bad write gets corrected on the next frame)
  // but the live-feed buffer didn't.
  useEffect(() => {
    schedulePersistedFeed(events);
  }, [events]);

  // No periodic age-based eviction — the live feed is bounded purely
  // by LIVE_FEED_MAX (sliding-window trim in the SSE handler). Removing
  // the TTL pass keeps fresh events visible across tab switches and
  // long absences; the count cap protects memory.

  // Sampled console logger for `mint_status` frames. First N frames
  // emit verbatim (to confirm the wiring); after that every 25th to
  // avoid devtools spam under a hot launch. Intentionally noisy at
  // boot — we want the operator to see the SSE lifecycle in console
  // when debugging an "empty page" report.
  const dbgCountRef = (typeof window !== 'undefined')
    ? ((window as unknown as { __mintsDbg?: { n: number } }).__mintsDbg ??=
        { n: 0 })
    : { n: 0 };
  // SSE socket status — surfaced via console only; the /mints page has
  // no header status slot for connection state. Held in a ref so
  // transitions don't trigger re-renders nobody reads.
  const sseStatusRef = useRef<'connecting' | 'open' | 'error'>('connecting');
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Exponential backoff with jitter on reconnect — same pattern used
    // in /dashboard and /feed. The previous fixed 2 s retry caused a
    // herd-thunder pattern when the backend restarted: every connected
    // /mints tab hammered the just-rebooted backend on a 2 s grid.
    // Backoff is 1 s × 2^attempt, capped at 30 s, plus up to 1 s of
    // jitter; the counter resets on a successful `open` so the next
    // disconnect starts from 1 s again instead of inheriting the cap.
    let attempt = 0;
    const scheduleReconnect = (): void => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const base   = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connect, base + jitter);
      attempt++;
    };
    const connect = (): void => {
      if (cancelled) return;
      sseStatusRef.current = 'connecting';
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('open', () => {
        sseStatusRef.current = 'open';
        attempt = 0;
        console.debug('[sse/mints] connected');
      });
      es.addEventListener('mint_status', (e: MessageEvent) => {
        try {
          const s = JSON.parse(e.data) as MintStatus;
          dbgCountRef.n++;
          if (dbgCountRef.n <= 5 || dbgCountRef.n % 25 === 0) {
            // eslint-disable-next-line no-console
            console.log(
              `[mints/sse] n=${dbgCountRef.n} state=${s.displayState} ` +
              `key=${s.groupingKey.slice(0, 32)} observed=${s.observedMints} ` +
              `v60=${s.v60} v5m=${s.v5m} type=${s.mintType}`,
            );
          }
          // UI-side junk filter — refuses to admit obvious non-NFT rows
          // even when the backend's accumulator is replaying stale
          // entries via the SSE snapshot or sweep loop. Keeps the
          // table clean during the post-deploy cache-flush window.
          if (!isRenderableMintStatus(s)) return;
          setRows(prev => {
            const next = new Map(prev);
            // Sticky-merge: preserve a row's imageUrl + name once
            // they've been resolved. The backend re-emits mint_status
            // on every accepted mint (and on the periodic sweep) and
            // many of those frames lack imageUrl/name because the
            // per-collection enrichment hasn't completed yet. Without
            // this guard the row's thumbnail flickers in (resolved)
            // and out (resolved → undefined) every time a new mint
            // for the same collection lands. Treat the first non-empty
            // image / name we see as authoritative for the lifetime
            // of the page session.
            const cur = prev.get(s.groupingKey);
            const stickyImage = (s.imageUrl && s.imageUrl.length > 0)
              ? s.imageUrl
              : (cur?.imageUrl ?? undefined);
            const stickyName  = (s.name && s.name.length > 0)
              ? s.name
              : (cur?.name ?? undefined);
            const merged: MintStatus = { ...s, imageUrl: stickyImage, name: stickyName };
            next.set(s.groupingKey, merged);
            // Mirror to localStorage so the active-collections table
            // survives page reload / tab switch (24 h TTL gated inside
            // savePersistedCollections / loadPersistedCollections).
            schedulePersistedCollections(next);
            return next;
          });
        } catch { /* malformed frame — skip */ }
      });
      // Per-mint live feed channel. Already broadcast by the backend
      // (sse.ts → buildMintFrame). We keep the latest LIVE_FEED_MAX
      // events in memory AND mirror them into localStorage so a tab
      // refresh / browser restart doesn't wipe the recent stream.
      // Dedupe by `signature` so an SSE reconnect that replays a sig
      // we already have doesn't duplicate the row.
      es.addEventListener('mint', (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data) as Omit<MintEvent, 'receivedAt'>;
          if (isClearlyNonNftMintEvent(m)) {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('[mints/sse] dropped non-nft event', m.signature);
            }
            return;
          }
          if (!m.signature) {
            console.log('[mints/live-miss] reason=missing_signature');
            return;
          }
          // Anchor `receivedAt` to the on-chain `blockTime` whenever
          // available. Backend replays `currentRecentMints()` to every
          // freshly-connected SSE client (so a re-open of the page
          // surfaces the last 150 mints), and stamping `Date.now()` on
          // arrival was making every replay row read as "just now"
          // even when the underlying mint happened minutes ago. Using
          // blockTime keeps the timestamp truthful across reconnects;
          // we fall back to wall-clock only when blockTime is missing
          // or unparseable.
          const blockTimeMs = m.blockTime ? Date.parse(m.blockTime) : NaN;
          const receivedAt  = Number.isFinite(blockTimeMs) ? blockTimeMs : Date.now();
          const ev: MintEvent = { ...m, receivedAt };
          setEvents(prev => {
            if (prev.some(p => p.signature === ev.signature)) {
              console.log(`[mints/live-miss] reason=dedupe_signature sig=${ev.signature.slice(0,12)}…`);
              return prev;
            }
            // Insert + maintain newest-first order by receivedAt. Sorting
            // here (instead of trusting prepend order) is what lets a
            // backend replay — which arrives oldest-first — interleave
            // correctly with already-restored localStorage events that
            // may be newer than the head of the replay batch.
            const merged = [ev, ...prev];
            merged.sort((a, b) => b.receivedAt - a.receivedAt);
            // Sliding-window trim — drop the oldest tail, never wipe.
            // Wiping the buffer at the cap (previous behavior) destroyed
            // restored fresh events whenever a 150-event SSE replay
            // pushed the buffer over the limit on remount.
            const trimmed = merged.slice(0, LIVE_FEED_MAX);
            console.log(
              `[mints/live] inserted sig=${ev.signature.slice(0,12)}… ` +
              `mint=${ev.mintAddress ?? '—'} name=${ev.nftName ?? '—'}`,
            );
            return trimmed;
          });
          // Mirror every accepted mint event into the LEFT collections
          // table. Without this the table only ever fills from the
          // backend's separate `mint_status` channel, which the UI
          // junk-filter (`isRenderableMintStatus`) sometimes drops on
          // the first frame (no name/image yet) — leaving the user
          // looking at a populated feed and an empty table for the
          // same collection. Logic: upsert by `groupingKey`,
          // increment observedMints on every NEW signature, refresh
          // lastMintAt to the event's wall-clock. The next
          // `mint_status` frame from the backend will overwrite the
          // synthesized row with authoritative v60/v5m/state values.
          setRows(prev => {
            const next = new Map(prev);
            const cur  = next.get(ev.groupingKey);
            // Use the same blockTime anchor the feed uses, so the
            // table's LAST MINT column matches the feed's "Xm ago"
            // exactly on replayed events (otherwise after a reconnect
            // the table would show "just now" for a 5-min-old mint).
            const nowMs = ev.receivedAt;
            const merged: MintStatus = cur ? {
              ...cur,
              observedMints:     cur.observedMints + 1,
              // Never move the timestamp backwards — a replay of an
              // older mint after a fresh one would otherwise reset
              // the row to look stale.
              lastMintAt:        Math.max(cur.lastMintAt, nowMs),
              lastMintAddress:   ev.mintAddress ?? cur.lastMintAddress,
              programSource:     ev.programSource,
              collectionAddress: ev.collectionAddress ?? cur.collectionAddress,
              priceLamports:     ev.priceLamports ?? cur.priceLamports,
              sourceLabel:       ev.sourceLabel,
            } : {
              groupingKey:       ev.groupingKey,
              groupingKind:      (ev.groupingKind as MintStatus['groupingKind']) ?? 'collection',
              programSource:     ev.programSource,
              collectionAddress: ev.collectionAddress,
              lastMintAddress:   ev.mintAddress,
              displayState:      'incubating',
              observedMints:     1,
              v60:               1,
              v5m:               0.2,
              lastMintAt:        nowMs,
              mintType:          ev.mintType,
              priceLamports:     ev.priceLamports,
              sourceLabel:       ev.sourceLabel,
              name:              ev.nftName ?? undefined,
              imageUrl:          ev.nftImageUrl ?? undefined,
              maxSupply:         null,
              mintedCount:       null,
              lmntfOwner:        null,
              lmntfCollectionId: null,
            };
            next.set(ev.groupingKey, merged);
            schedulePersistedCollections(next);
            return next;
          });
        } catch { /* malformed frame — skip */ }
      });
      // Per-mint metadata patch — backend's collection-confirm DAS
      // retry surfaces the NFT-level name + image after the mint
      // event has already landed. Match by signature first
      // (authoritative); fall back to mintAddress so cNFTs / replays
      // missing the signature still update.
      es.addEventListener('mint_meta', (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as { signature?: string; mintAddress?: string | null; nftName?: string | null; imageUrl?: string | null };
          if (!p.signature && !p.mintAddress) return;
          setEvents(prev => {
            let changed = false;
            const next = prev.map(ev => {
              const match = (p.signature && ev.signature === p.signature)
                         || (!!p.mintAddress && ev.mintAddress === p.mintAddress);
              if (!match) return ev;
              const nextName  = (p.nftName  && p.nftName.length > 0)  ? p.nftName  : (ev.nftName     ?? null);
              const nextImage = (p.imageUrl && p.imageUrl.length > 0) ? p.imageUrl : (ev.nftImageUrl ?? null);
              if (ev.nftName === nextName && ev.nftImageUrl === nextImage) return ev;
              changed = true;
              return { ...ev, nftName: nextName, nftImageUrl: nextImage };
            });
            return changed ? next : prev;
          });
          // Cross-pollinate the table: every per-mint metadata patch
          // also strengthens the synthesized table row. Strip the
          // trailing "#42" off the per-NFT name so the collection
          // line in the table reads as "PIXEL APE OF THE HILL", not
          // "PIXEL APE OF THE HILL #42". Find the row by the matched
          // mint event's groupingKey (mint events and table rows
          // share that key on the wire).
          if (p.signature || p.mintAddress) {
            setRows(prev => {
              // Resolve groupingKey from the in-memory feed events —
              // we don't carry it on the `mint_meta` wire, so look it
              // up by signature/mintAddress against the live buffer.
              let groupingKey: string | null = null;
              for (const ev of eventsRef.current) {
                const match = (p.signature && ev.signature === p.signature)
                           || (!!p.mintAddress && ev.mintAddress === p.mintAddress);
                if (match) { groupingKey = ev.groupingKey; break; }
              }
              if (!groupingKey) return prev;
              const cur = prev.get(groupingKey);
              if (!cur) return prev;
              const stripped = p.nftName ? p.nftName.replace(/\s*#\s*\d+\s*$/, '').trim() : null;
              const nextName  = (stripped && stripped.length > 0) ? stripped : cur.name;
              const nextImage = cur.imageUrl;   // per-NFT images don't belong on the collection row
              if (cur.name === nextName && cur.imageUrl === nextImage) return prev;
              const next = new Map(prev);
              next.set(groupingKey, { ...cur, name: nextName, imageUrl: nextImage });
              schedulePersistedCollections(next);
              return next;
            });
          }
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        sseStatusRef.current = 'error';
        es?.close();
        scheduleReconnect();
      });
    };
    connect();
    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  // dbgCountRef is a stable mutable ref — exclude from deps to avoid the
  // effect re-running on every render and re-opening the SSE stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Main table — `shown` (ACTIVE) rows plus `incubating` (WATCH) rows
   *  so collections being minted show up here even before they reach
   *  the burst/threshold gate. `cooled` is excluded — those are
   *  dormant. Sort key:
   *    1. ACTIVE before WATCH (`shown` first)
   *    2. Within each tier:
   *         WATCH  → newest mint first (lastMintAt desc), then v60
   *         ACTIVE → user's chosen sort (velocity / mints) so the
   *                  existing UX is preserved for promoted rows
   *  This keeps the previous active-only behaviour as a strict subset
   *  while surfacing pre-burst activity at the bottom of the table. */
  // Per-collection stats inside the currently selected timeframe window.
  // Drives the MINTS column (count) and MINT/MIN column (mintPerMin) so
  // the table metrics react to 5M / 10M / … / 1D pills instead of showing
  // the cumulative session-lifetime number. Counted from the live events
  // buffer, which is bounded at LIVE_FEED_MAX (150 newest); for very hot
  // collections + long timeframes the count can be understated when older
  // events have rolled off the buffer — same trade-off as the existing
  // `recent`-tab filter.
  //
  // MINT/MIN is intentionally NOT (count / fullTimeframeMinutes). That
  // math is misleading: a single mint 4 minutes ago in a 15M window would
  // render as 0.07/min even though the collection wasn't minting for 14
  // of those 15 minutes. Instead we compute the rate over the *active*
  // span — distance between the earliest and latest mint timestamps in
  // the window, floored at 1 minute. With <2 mints we can't infer a span,
  // so we surface the raw count (0 or 1) directly.
  const tfStatsByKey = useMemo(() => {
    const cutoff = Date.now() - MINT_TF_MS[mintTf];
    type Stats = { count: number; firstTs: number; lastTs: number; mintPerMin: number };
    const m = new Map<string, Stats>();
    for (const ev of events) {
      if (ev.receivedAt < cutoff) continue;
      const cur = m.get(ev.groupingKey);
      if (!cur) {
        m.set(ev.groupingKey, { count: 1, firstTs: ev.receivedAt, lastTs: ev.receivedAt, mintPerMin: 0 });
      } else {
        cur.count += 1;
        if (ev.receivedAt < cur.firstTs) cur.firstTs = ev.receivedAt;
        if (ev.receivedAt > cur.lastTs)  cur.lastTs  = ev.receivedAt;
      }
    }
    for (const s of m.values()) {
      if (s.count >= 2) {
        const activeMin = Math.max(1, (s.lastTs - s.firstTs) / 60_000);
        s.mintPerMin = s.count / activeMin;
      } else {
        // count===1 → show 1 (no two-point span yet); count===0 unreachable here.
        s.mintPerMin = s.count;
      }
    }
    return m;
  // `tick` re-evaluates the cutoff every 5 s so events that age past
  // the selected window drop out without waiting for new SSE traffic.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, mintTf, tick]);

  // COEF — burstiness coefficient: ratio of the active-window RATE
  // (count / activeMinutes) to the baseline rate spread across the
  // FULL selected timeframe (count / timeframeMinutes). The baseline
  // is floored at 0.01 so very-sparse-but-bursty cases still surface
  // a meaningful value instead of saturating at 1.
  // Examples (verified):
  //   • 1 mint in 30M  → count<2, returns 0 (cell renders "—")
  //   • 3 mints in 2 active min inside 30M:
  //       activeRate = 3 / 2  = 1.5
  //       baseline   = 3 / 30 = 0.1
  //       coef       = 1.5 / max(0.01, 0.1) = 15
  //   • 4 mints in 4 active min inside 4H:
  //       activeRate = 4 / 4    = 1
  //       baseline   = 4 / 240  ≈ 0.0167
  //       coef       = 1 / max(0.01, 0.0167) ≈ 60
  const computeCoef = (r: MintStatus): number => {
    const stats = tfStatsByKey.get(r.groupingKey);
    if (!stats || stats.count < 2) return 0;
    const tfMinutes    = MINT_TF_MS[mintTf] / 60_000;
    const baselineRate = stats.count / tfMinutes;
    const activeRate   = stats.mintPerMin;
    return activeRate / Math.max(0.01, baselineRate);
  };

  // Effective sort = manual override when set, else per-tab default.
  // ACTIVE defaults to RATE desc; RECENT defaults to LAST MINT desc so
  // the table reads as recent activity until the user opts into a
  // different ordering by clicking a header.
  const effectiveSortKey: SortKey = hasManualSort
    ? sortKey
    : (mintTab === 'recent' ? 'last' : 'velocity');
  const effectiveSortDir: SortDir = hasManualSort ? sortDir : 'desc';

  const sorted = useMemo(() => {
    const now    = Date.now();
    const tfMs   = MINT_TF_MS[mintTf];
    const cutoff = now - tfMs;
    let arr = Array.from(rows.values())
      .filter(r => r.displayState !== 'cooled')
      // CNFT toggle — shared with the LIVE MINT FEED memo above so a
      // single header control hides cNFTs everywhere. Applied BEFORE
      // the timeframe filter so the ACTIVE/RECENT count chip matches
      // the visible row count exactly. Pure filter — never touches
      // `rows` state or localStorage.
      .filter(r => showCnft || !isCnftLike(r))
      // Final-render safety net — a row that slipped past load /
      // SSE filters (e.g. mutated mid-session by patchAccumulatorMeta)
      // still gets dropped here before it paints.
      .filter(r => isRenderableMintStatus(r))
      // Tracker-only stricter display filter — rejects rows whose
      // visible identity is junk ("NFT", pubkey-ish fallback, name
      // missing) or 1-of-1 drops without collection identity. Kept
      // separate from `isRenderableMintStatus` so the right-side Live
      // Mint Feed (which doesn't apply this filter) keeps showing
      // every detected mint.
      .filter(r => isUsefulTrackerCollection(r))
      // Timeframe gate — applies to BOTH tabs. A row whose lastMintAt
      // is older than the selected window is hidden, so 30M never
      // shows a "56m ago" row regardless of tab.
      .filter(r => r.lastMintAt >= cutoff);

    // Per-key comparator (always returns "ascending" — direction is
    // applied below). Numeric keys compare on the actual underlying
    // value, not the formatted string, so e.g. SUPPLY sorts 8 < 88 <
    // 888, not lexically 8 < 88 < 888 (happens to match here, but the
    // pattern matters for floats / negatives elsewhere).
    const coefBy = new Map<string, number>();
    for (const r of arr) coefBy.set(r.groupingKey, computeCoef(r));

    const cmpAsc = (a: MintStatus, b: MintStatus): number => {
      switch (effectiveSortKey) {
        case 'collection': {
          const an = (a.name?.trim() || a.groupingKey).toLowerCase();
          const bn = (b.name?.trim() || b.groupingKey).toLowerCase();
          return an.localeCompare(bn);
        }
        case 'mints': {
          const av = tfStatsByKey.get(a.groupingKey)?.count ?? 0;
          const bv = tfStatsByKey.get(b.groupingKey)?.count ?? 0;
          return av - bv;
        }
        case 'supply': {
          // Missing supply (null / 0 / non-number) is treated as 0 so
          // it clusters with the smallest values — predictable in both
          // directions without per-direction sentinel handling.
          const av = (typeof a.maxSupply === 'number' && a.maxSupply > 0) ? a.maxSupply : 0;
          const bv = (typeof b.maxSupply === 'number' && b.maxSupply > 0) ? b.maxSupply : 0;
          return av - bv;
        }
        case 'last': {
          return a.lastMintAt - b.lastMintAt;
        }
        case 'coef': {
          return (coefBy.get(a.groupingKey) ?? 0) - (coefBy.get(b.groupingKey) ?? 0);
        }
        case 'velocity': {
          const av = tfStatsByKey.get(a.groupingKey)?.mintPerMin ?? 0;
          const bv = tfStatsByKey.get(b.groupingKey)?.mintPerMin ?? 0;
          return av - bv;
        }
      }
    };
    const dir = effectiveSortDir === 'asc' ? 1 : -1;
    const tiebreak = (a: MintStatus, b: MintStatus): number =>
      (b.lastMintAt - a.lastMintAt) || (b.v60 - a.v60);

    if (mintTab === 'recent') {
      // RECENT view — flatten the shown/watch tiering. Apply the
      // effective sort + direction, falling back to recency when equal.
      arr.sort((a, b) => cmpAsc(a, b) * dir || tiebreak(a, b));
      return arr;
    }

    // ACTIVE — preserve the two-tier sort (shown first, then watch),
    // but apply the effective sort + direction within each tier so
    // every column header is honoured.
    arr.sort((a, b) => {
      const aShown = a.displayState === 'shown' ? 0 : 1;
      const bShown = b.displayState === 'shown' ? 0 : 1;
      if (aShown !== bShown) return aShown - bShown;
      return cmpAsc(a, b) * dir || tiebreak(a, b);
    });
    return arr;
  // computeCoef closes over `mintTf` and `tfStatsByKey`, both already
  // listed below. `tick` re-evaluates the timeframe cutoff every 5 s
  // so rows that age past the window drop out promptly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, effectiveSortKey, effectiveSortDir, mintTab, mintTf, showCnft, tfStatsByKey, tick]);

  /** Live mint feed — events array drives the bottom panel directly,
   *  newest first (already maintained by the SSE handler). The group
   *  imageUrl/name is looked up from `rows` at render time so freshly
   *  enriched groups update their feed thumbnails on the next React
   *  re-render without re-fetching anything. */

  return (
    <div className="feed-root page-transition" data-page="mints" data-embedded={embedded ? '1' : undefined}>
      {!embedded && <TopNav active="mints" />}

      {/* Header — hidden in embed mode so the multi-tab pane chrome
          owns the title context. Compact vertical padding (16/8 instead
          of 20/14) to tighten the gap between the title and the table
          grid below — matches /tools' denser feel. */}
      {!embedded && (
        <div style={{ padding: '16px 4px 8px', flexShrink: 0, width: '100%', maxWidth: 'var(--mints-max, 1400px)', margin: '0 auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
                Live mint tracker
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <LiveDot />
                <span style={{ fontSize: 11, color: '#4fb67d' }}>
                  {(() => {
                    if (sorted.length === 0) return 'No active mints';
                    const active = sorted.filter(r => r.displayState === 'shown').length;
                    const watch  = sorted.length - active;
                    if (watch === 0) return `${active} active`;
                    if (active === 0) return `${watch} watch`;
                    return `${active} active · ${watch} watch`;
                  })()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2-column grid: LEFT (large) Mint Collections + RIGHT (narrow)
          Live Mint Feed.
            • PC / Laptop: ~68 / 32 split via
              `minmax(0, 2fr) minmax(320px, 0.9fr)`.
            • Phone (globals.css rule): single column.
            • Embed mode (multi-tab): single column.
          `flex: 1` + `minHeight: 0` lets the grid fill all the height
          left over by `.feed-root`'s flex column (TopNav + header are
          its other children; the persistent BottomStatusBar reserves
          its own 36 px via `body[data-bottombar="1"]`'s padding-bottom
          rule on .feed-root). Both panels stretch to that full
          height; internal scroll inside each handles overflow so the
          page itself never grows. */}
      <div className="mints-grid" style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: embedded ? '1fr' : 'minmax(0, 2fr) minmax(320px, 0.9fr)',
        gap: 16,
        width: '100%',
        maxWidth: embedded ? 'none' : 'var(--mints-max, 1400px)',
        margin: '0 auto',
        paddingBottom: embedded ? 0 : 8,
        boxSizing: 'border-box',
      }}>
      {/* ── LEFT: Mint Collections table ─────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)',
        borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden',
      }}>
        {/* Card header — mirrors /dashboard's "Trending collections"
            chrome: ACTIVE / RECENT tab pills on the left, count + live
            dot, then Filters pill + timeframe pills on the right. The
            timeframe pills filter `sorted` by `lastMintAt` window;
            tab=RECENT additionally drops the shown/watch tiering and
            sorts strictly by recency. */}
        <div style={{
          padding: '7px 12px', borderBottom: '1px solid rgba(168,144,232,0.12)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(168,144,232,0.04)',
          flexWrap: 'wrap', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {(['active', 'recent'] as const).map(t => (
              <Pill
                key={t}
                active={mintTab === t}
                onClick={() => setMintTab(t)}
                label={t}
                style={{ padding: '4px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
                         textTransform: 'uppercase',
                         border: mintTab === t ? '1px solid rgba(168,144,232,0.5)' : '1px solid transparent',
                         background: mintTab === t ? 'rgba(168,144,232,0.18)' : 'transparent' }}
              />
            ))}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 8px' }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', letterSpacing: '0.5px' }}>
              {sorted.length.toLocaleString()} <span style={{ color: '#3a3a52', fontWeight: 500 }}>collections</span>
            </span>
            <span style={{ marginLeft: 8 }}><LiveDot /></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Pill
              active={filtersOpen}
              onClick={() => setFiltersOpen(o => !o)}
              title="Filters"
              icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
              label="Filters"
              size="sm"
            />
            <span style={{ fontSize: 10, color: '#3a3a52' }}>Timeframe:</span>
            <div style={{ display: 'flex', gap: 2, background: 'rgba(10,7,20,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 2 }}>
              {MINT_TIMEFRAMES.map(t => (
                <Pill
                  key={t}
                  active={mintTf === t}
                  onClick={() => setMintTf(t)}
                  label={t}
                  size="sm"
                  title={MINT_TF_DESC[t]}
                  style={{ border: mintTf === t ? '1px solid rgba(168,144,232,0.55)' : '1px solid transparent',
                           background: mintTf === t ? 'rgba(168,144,232,0.22)' : 'transparent' }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Tracker microcopy — explains in one short line that the
            timeframe pills above don't just filter rows but also drive
            RATE/COEF math. Without this, users were misreading why
            collections appear/disappear when toggling 15M ↔ 1H, and
            mistaking RATE/COEF for cumulative session metrics. Tiny
            italic text in the same muted lilac as the secondary
            metadata elsewhere — visible always (no tooltip-only
            solution) but quiet enough that it doesn't compete with
            the tab/timeframe row above. flexShrink: 0 keeps the band
            present even when the scroll-area squeezes vertically. */}
        <div
          style={{
            padding: '5px 12px',
            fontSize: 10,
            color: '#56566e',
            letterSpacing: '0.3px',
            fontStyle: 'italic',
            background: 'rgba(168,144,232,0.018)',
            borderBottom: '1px solid rgba(255,255,255,0.035)',
            flexShrink: 0,
          }}
        >
          Window controls table rows, RATE and COEF
        </div>

        {/* Collapsible filters — currently a placeholder slot for future
            mint-side filters (source, supply band, etc). Mirrors the
            dashboard collapsible row visually so users get a familiar
            affordance the moment the FILTERS pill is toggled on. */}
        {filtersOpen && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, background: 'rgba(255,255,255,0.015)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: '#56566e' }}>Source:</span>
            <Pill active label="LMNFT" size="sm" />
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 6px' }} />
            <span style={{ fontSize: 10, color: '#56566e' }}>Status:</span>
            <Pill active label="Any" size="sm" />
            <Pill label="Active only" size="sm" />
            <Pill label="Sold out" size="sm" />
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#3a3a52', fontStyle: 'italic' }}>
              More filters coming soon
            </span>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area mints-tracker-scroll collection-table-scroll">
          <table className="collections-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            {/* Explicit column widths so the COLLECTION cell stays
                wide and the right-hand metrics columns stay tight —
                without these, `tableLayout: fixed` was distributing
                the surplus width evenly and producing the spread-out
                layout. COLLECTION is auto (no width = takes the
                remainder); the others are pinned. */}
            <colgroup>
              <col />                        {/* COLLECTION (auto) */}
              <col style={{ width: 90 }}  /> {/* MINTS    */}
              <col style={{ width: 100 }} /> {/* SUPPLY   */}
              <col style={{ width: 110 }} /> {/* LAST     */}
              <col style={{ width: 80 }}  /> {/* COEF     */}
              <col style={{ width: 110 }} /> {/* RATE     */}
              {/* SOURCE column removed — source badge is now rendered
                  inline inside the COLLECTION cell. The freed width
                  goes to COLLECTION (auto / remainder col). */}
            </colgroup>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,50,0.95)' }}>
                {/* COLLECTION header pads left by 13 px = 10 px (data
                    cell padding) + 3 px (data cell accent border that
                    pushes its content right by 3 px and isn't on the
                    th). Without this comp the COLLECTION label sat 3 px
                    to the left of the row content beneath it. */}
                <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 13, cursor: 'pointer' }} onClick={() => handleSortClick('collection')}>
                  COLLECTION {sortArrow(effectiveSortKey, effectiveSortDir, 'collection')}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('mints')}>
                  MINTS {sortArrow(effectiveSortKey, effectiveSortDir, 'mints')}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('supply')}>
                  SUPPLY {sortArrow(effectiveSortKey, effectiveSortDir, 'supply')}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('last')}>
                  LAST MINT {sortArrow(effectiveSortKey, effectiveSortDir, 'last')}
                </th>
                {/* COEF — burstiness coefficient: active-window RATE
                    divided by the baseline rate (count over the full
                    selected timeframe). High = burst; ~1 = steady. See
                    `computeCoef` near the sorted memo. Secondary metric
                    visually — RATE is the primary activity number. */}
                <th
                  title="COEF — burstiness: active-window RATE divided by the selected timeframe's average rate. High = burst, ~1 = steady."
                  style={{ ...thStyle, cursor: 'pointer' }}
                  onClick={() => handleSortClick('coef')}
                >
                  COEF {sortArrow(effectiveSortKey, effectiveSortDir, 'coef')}
                </th>
                {/* RATE — formerly MINT/MIN, primary activity number.
                    Last column on the right, so it needs a wider
                    "terminal" gutter than the interior columns or the
                    value reads as hugging the card edge. We bump the
                    col width (110 vs the 80–100 of interior numeric
                    columns) AND set paddingRight: 18 on BOTH this th
                    and the matching td below. Both must move together
                    — moving only one re-introduces the header/value
                    drift the previous attempt fixed. The td uses the
                    explicit 4-tuple `padding: '14px 18px 14px 10px'`
                    to keep the same vertical padding (14) and same
                    left-side padding (10) as MINTS / SUPPLY / LAST /
                    COEF, only widening on the right. */}
                <th
                  title="RATE — mints per minute over the active window inside the selected timeframe (count ÷ active-minutes)."
                  style={{ ...thStyle, paddingRight: 18, cursor: 'pointer' }}
                  onClick={() => handleSortClick('velocity')}
                >
                  RATE {sortArrow(effectiveSortKey, effectiveSortDir, 'velocity')}
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Zero-row empty state — two compact rows tucked into
                  the table area, styled via .mints-empty-{primary,
                  helper} (globals.css). Premium-feeling and
                  intentional: an uppercased "no data" header plus a
                  small italic suggestion to widen the timeframe.
                  No illustration / no card — the tracker chrome
                  carries the visual weight. Hidden the moment a
                  single row arrives. */}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="mints-empty-primary">
                    No collections in this timeframe
                  </td>
                </tr>
              )}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="mints-empty-helper">
                    Try a longer window
                  </td>
                </tr>
              )}
              {sorted.map((r, i) => {
                // Belt-and-suspenders against whitespace-only names that
                // pre-date the backend trim (still cached in localStorage)
                // or that slip through any future enrichment path. `??`
                // alone wouldn't catch "                                "
                // (32 spaces) — that's truthy, would render as blank.
                const trimmed = r.name?.trim();
                const displayName = (trimmed && trimmed.length > 0)
                  ? trimmed
                  : shortKey(r.groupingKey);
                const isBurst = r.shownReason === 'burst';
                // ACTIVE = promoted (`shown`), WATCH = pre-burst
                // (`incubating`). Drives the inline status pill below
                // and a faint row dim on WATCH so ACTIVE rows stay
                // visually dominant. Threshold/burst logic in the
                // backend accumulator is unchanged.
                const isActive = r.displayState === 'shown';
                const accentColor = colorForCollection(r.collectionAddress ?? r.groupingKey);
                // SOLD takes priority over ACTIVE / WATCH: when the
                // launchpad's planned drop has been fully minted (or
                // exceeded due to dup events), the row is a completed
                // event, not "still cooking". Clamp display via the
                // raw comparison — even observedMints > maxSupply
                // hits this branch and renders SOLD.
                const isSoldOut = typeof r.maxSupply === 'number'
                  && r.maxSupply > 0
                  && r.observedMints >= r.maxSupply;
                // Row state — drives the per-state row className
                // (`.mints-tracker-row-{active,watch,sold}`) and the
                // alpha applied to the per-collection accent border
                // on the COLLECTION cell. Same priority order as the
                // status pill below: SOLD > ACTIVE > WATCH.
                const rowState: 'active' | 'watch' | 'sold' = isSoldOut
                  ? 'sold'
                  : isActive ? 'active' : 'watch';
                // WATCH rows soften the per-collection accent to ~55%
                // alpha (`8c` hex) so an incubating row reads as
                // quieter on the left edge without losing the
                // per-collection grouping cue. ACTIVE/SOLD keep the
                // accent at full strength so the band is unambiguous.
                // Palette is 6-char hex throughout (see
                // COLLECTION_PALETTE), so an 8-char hex suffix is
                // safe.
                const accentBorderColor = rowState === 'watch'
                  ? `${accentColor}8c`
                  : accentColor;
                // Fresh-mint flash — same green pulse the dashboard
                // uses for fresh sales. Two parts:
                //   1. `key` includes `r.lastMintAt` so React remounts
                //      the row whenever a new mint lands in this
                //      collection — the CSS animation replays from
                //      frame 0 each time.
                //   2. `row-flash-up` class is applied when the most
                //      recent mint is < 3.6 s old (the animation's
                //      duration). After the window passes the class
                //      is dropped automatically on the next
                //      `force()` tick (5 s cadence) — well beyond
                //      animation end, so no visible cut-off.
                const isFreshMint = (Date.now() - r.lastMintAt) < 3600;
                return (
                  <tr
                    key={`${r.groupingKey}:${r.lastMintAt}`}
                    // Class stack:
                    //   • `mints-tracker-row` — per-row background tint
                    //     (globals.css) so each tracker row sits as a
                    //     soft band rather than a fully transparent
                    //     strip; closes the depth gap with the right-
                    //     pane Live Mint Feed cards.
                    //   • `mints-tracker-row-{active,watch,sold}` —
                    //     state-based tint shift on top of the base
                    //     row tint. ACTIVE = subtle green wash;
                    //     WATCH = quieter than default; SOLD = subtle
                    //     red wash. Combined with the per-state alpha
                    //     on the COLLECTION cell's borderLeft, this
                    //     gives WATCH/ACTIVE/SOLD a visible hierarchy
                    //     without dropping row opacity (which made
                    //     images / values look washed out).
                    //   • `tools-offer-row` — shared hover lift system
                    //     (scale 1.015, inset purple ring, soft outer
                    //     glow, z-index 1, 200 ms ease-out). `:hover`
                    //     specificity (2) beats both `.mints-tracker-row`
                    //     and the state classes, so the hover state
                    //     looks identical for ACTIVE/WATCH/SOLD.
                    //   • `row-flash-up` — additive, animates
                    //     background on fresh mints without breaking
                    //     hover.
                    className={`mints-tracker-row mints-tracker-row-${rowState} tools-offer-row${isFreshMint ? ' row-flash-up' : ''}`}
                    style={{
                      // Slightly stronger separator alpha (0.05 vs 0.04
                      // before) so the per-row tint reads as a
                      // distinct band; still a 1px hairline, never
                      // thick.
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      // Full opacity across all states — the WATCH /
                      // ACTIVE / SOLD distinction is already conveyed by
                      // the inline status pill, so dimming the row body
                      // only made images and values look washed out.
                      opacity: 1,
                    }}
                  >
                    {/* COLLECTION cell — matches Dashboard rows:
                        12px vertical padding (up from /mints' previous
                        compact 8px to align with /dashboard rhythm),
                        38 px ItemThumb, 15 px name. Left accent stripe
                        (3 px, deterministic per collectionAddress) so
                        rows from the same collection are visually
                        grouped at a glance. */}
                    <td style={{ padding: '14px 8px 14px 12px', verticalAlign: 'middle', borderLeft: `3px solid ${accentBorderColor}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{i + 1}</span>
                        <ItemThumb
                          imageUrl={thumb64(r.imageUrl ?? null)}
                          color={colorForCollection(r.collectionAddress ?? r.groupingKey)}
                          abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()}
                          size={42}
                        />
                        <span style={{ fontSize: 16, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {/* Status pill priority: SOLD > ACTIVE > WATCH.
                              SOLD (red, site-consistent) when the
                              launchpad-known maxSupply is met or
                              exceeded; ACTIVE (saturated green) for
                              backend-promoted rows; WATCH (muted amber)
                              for incubating rows. Inline before the
                              name — no extra column, no layout shift. */}
                          {isSoldOut ? (
                            <span
                              title={
                                `Sold out — ${r.observedMints.toLocaleString()} of ` +
                                `${(r.maxSupply ?? 0).toLocaleString()} minted`
                              }
                              style={STATUS_BADGE_SOLD}
                            >SOLD</span>
                          ) : isActive ? (
                            <span title={r.shownReason === 'burst' ? 'Promoted via burst (≥ 8 mints / 60 s)' : 'Promoted via 50-mint threshold'} style={STATUS_BADGE_ACTIVE}>ACTIVE</span>
                          ) : (
                            <span title="Incubating — not yet at burst / threshold" style={STATUS_BADGE_WATCH}>WATCH</span>
                          )}
                          {(() => {
                            // Title is clickable → Solscan ONLY when we
                            // have a real NFT mint address from the wire
                            // (`lastMintAddress` — set by the accumulator
                            // from the most recent accepted MintEvent).
                            // We deliberately do NOT fall back to
                            // collectionAddress / groupingKey: those can
                            // be a collection account, update authority,
                            // creator, or merkle tree — none of which
                            // open a viewable NFT page on Solscan.
                            // No mint address → plain text (no link).
                            const titleAnchor = isSolPubkey(r.lastMintAddress) ? r.lastMintAddress : null;
                            const titleHref = titleAnchor
                              ? `https://solscan.io/token/${titleAnchor}`
                              : null;
                            const titleInner = (
                              <>
                                {displayName}
                                {isBurst && (
                                  <span title="Burst-detected — recent velocity spike" style={{ marginLeft: 6, fontSize: 10, color: '#e87a5e' }}>🔥</span>
                                )}
                              </>
                            );
                            const titleStyle: React.CSSProperties = {
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                              color: '#f0eef8', textDecoration: 'none', cursor: titleHref ? 'pointer' : 'default',
                            };
                            return titleHref ? (
                              <a
                                href={titleHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Solscan · ${titleAnchor}`}
                                style={titleStyle}
                                onClick={(e) => e.stopPropagation()}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                              >{titleInner}</a>
                            ) : (
                              <span style={titleStyle}>{titleInner}</span>
                            );
                          })()}
                          {/* Tiny ME icon — replaces the removed LINKS
                              column. Only renders when we have a stable
                              on-chain anchor (collectionAddress); when
                              null (e.g. groupingKind = `authority`),
                              the icon is hidden so the row doesn't
                              show a dead link. Same visual as ME icons
                              elsewhere (/feed wallet rows, /tools). */}
                          {/* ME `/item-details/{X}` only renders a real
                              page when X is a SPECIFIC NFT mint, not a
                              collection address. We use `lastMintAddress`
                              (the most recent accepted mint for this
                              row) — that lands on a viewable NFT page
                              from which the user can navigate up to the
                              collection. Falls back to nothing when no
                              real mint address is on the wire (e.g.
                              cNFTs without a leaf address) — better
                              than a dead link to a collection page. */}
                          {isSolPubkey(r.lastMintAddress) && (
                            <a
                              href={`https://magiceden.io/item-details/${r.lastMintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Magic Eden · last mint ${r.lastMintAddress}`}
                              style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/brand/me.png" alt="ME" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
                            </a>
                          )}
                          {/* Tensor badge — pairs with the ME icon and
                              uses the same lastMintAddress anchor.
                              `/trade/{collectionAddress}` was producing
                              dead pages for unverified collections
                              (Tensor only indexes verified ones in
                              that route); `/item/{mint}` always loads
                              an item page from which the user can
                              navigate up to the collection. */}
                          {isSolPubkey(r.lastMintAddress) && (
                            <a
                              href={`https://www.tensor.trade/item/${r.lastMintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Tensor · last mint ${r.lastMintAddress}`}
                              style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/brand/tensor.png" alt="Tensor" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
                            </a>
                          )}
                          {/* Source badge — moved inline from the
                              removed right-side SOURCE column. Same
                              palette as the prior column pill (uses
                              `sourceBadge`); rendered smaller (9 px,
                              tighter padding) so it reads as secondary
                              metadata next to the title rather than
                              competing with it. Clickable when
                              `sourceHref` resolves a URL (links to the
                              launchpad's mint page); plain `<span>`
                              otherwise. flexShrink: 0 so it doesn't
                              squeeze on narrow rows. */}
                          {(() => {
                            const sb = sourceBadge(r.sourceLabel);
                            const href = sourceHref(r);
                            const pillStyle: React.CSSProperties = {
                              display: 'inline-block', padding: '1px 6px', fontSize: 9, fontWeight: 700, borderRadius: 3,
                              background: sb.bg, color: sb.fg, letterSpacing: '0.4px',
                              textDecoration: 'none', cursor: href ? 'pointer' : 'default',
                              flexShrink: 0, lineHeight: '13px', textTransform: 'uppercase',
                            };
                            const plainTitle = r.sourceLabel === 'LaunchMyNFT'
                              ? 'LaunchMyNFT mint page unavailable'
                              : r.sourceLabel;
                            // Linked-pill tooltip: VVV gets "Open on VVV"
                            // per the per-collection deep-link UX so users
                            // know clicking opens the launchpad's page.
                            // Other sources keep the raw label as the
                            // hover hint.
                            const linkTitle = r.sourceLabel === 'VVV'
                              ? 'Open on VVV'
                              : r.sourceLabel;
                            return href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={linkTitle}
                                style={pillStyle}
                                onClick={(e) => e.stopPropagation()}
                              >{sb.label}</a>
                            ) : (
                              <span title={plainTitle} style={pillStyle}>{sb.label}</span>
                            );
                          })()}
                        </span>
                      </div>
                    </td>
                    {/* MINTS — count of mints for this collection
                        seen inside the currently-selected timeframe
                        window (5M / 10M / 15M / 30M / 1H / 4H / 1D).
                        Matches the LIVE MINT FEED scope; was previously
                        the cumulative session count which made the
                        timeframe pill feel non-functional. Tooltip
                        spells out the timeframe + falls back to the
                        cumulative number for context. */}
                    {(() => {
                      const tfCount = tfStatsByKey.get(r.groupingKey)?.count ?? 0;
                      const tip = `${tfCount.toLocaleString()} mint(s) in last ${mintTf}` +
                        ` · ${r.observedMints.toLocaleString()} since session start`;
                      return (
                        <td
                          title={tip}
                          style={{ padding: '14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                        >
                          {tfCount.toLocaleString()}
                        </td>
                      );
                    })()}
                    {/* SUPPLY — planned cap (when known). Bright row
                        colour matches the MINTS column so the table
                        reads as a single tier of values rather than a
                        ladder of fade levels. */}
                    <td
                      title={
                        typeof r.maxSupply === 'number' && r.maxSupply > 0
                          ? `Max supply for this collection`
                          : `Max supply unavailable — observed ${r.observedMints.toLocaleString()} mint(s)`
                      }
                      style={{ padding: '14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 13, color: '#f0eef8', fontWeight: 700, fontFamily: "'SF Mono','Fira Code',monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                    >
                      {typeof r.maxSupply === 'number' && r.maxSupply > 0
                        ? r.maxSupply.toLocaleString()
                        : '—'}
                    </td>
                    <td style={{ padding: '14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 12.5, color: '#f0eef8', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {fmtAge(r.lastMintAt)}
                    </td>
                    {/* COEF — burstiness: RATE ÷ baseline (count over
                        full selected timeframe), floor 0.01. With <2
                        mints there's no two-point span, so we render
                        "—". Rendered MUTED (gray-lilac, weight 500) so
                        it reads as secondary to the RATE column to its
                        right — RATE is the primary activity metric. */}
                    {(() => {
                      const stats   = tfStatsByKey.get(r.groupingKey);
                      const tfCount = stats?.count ?? 0;
                      const coef    = computeCoef(r);
                      const display = tfCount < 2
                        ? '—'
                        : coef >= 10 ? coef.toFixed(0)
                        : coef.toFixed(1);
                      const tip = tfCount < 2
                        ? `Need ≥ 2 mints in last ${mintTf} to compute COEF`
                        : `RATE ÷ baseline (count / ${mintTf}) ≈ ${display}` +
                          ` · higher = bursty, ~1 = steady`;
                      return (
                        <td
                          title={tip}
                          style={{ padding: '14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 13, fontWeight: 500, color: '#8a82b0', letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                        >
                          {display}
                        </td>
                      );
                    })()}
                    {/* RATE — count ÷ active-window minutes inside the
                        selected timeframe, floored at 1 minute. Header
                        renamed from MINT/MIN to avoid implying "average
                        over the full timeframe" (which it isn't). With
                        <2 mints we surface the raw count (0 or 1).
                        Primary activity metric — green, weight 700. */}
                    {(() => {
                      const stats     = tfStatsByKey.get(r.groupingKey);
                      const tfCount   = stats?.count ?? 0;
                      const rate      = stats?.mintPerMin ?? 0;
                      const display   = tfCount < 2
                                       ? tfCount.toString()
                                       : rate >= 10 ? rate.toFixed(0)
                                       : rate >= 1  ? rate.toFixed(1)
                                       : rate.toFixed(2);
                      const activeMin = stats && stats.count >= 2
                        ? Math.max(1, (stats.lastTs - stats.firstTs) / 60_000)
                        : 0;
                      const tip = tfCount < 2
                        ? `${tfCount} mint(s) in last ${mintTf} — not enough data for a rate`
                        : `${tfCount.toLocaleString()} mints over ${activeMin.toFixed(1)} active min ≈ ${display} /min`;
                      return (
                        <td
                          title={tip}
                          style={{ padding: '14px 18px 14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 700, color: '#5ce0a0', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                        >
                          {display}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── RIGHT: Live Mint Feed ────────────────────────────────────
          Per-mint stream (one row = one detected mint), independent of
          the aggregation gate that drives the LEFT collections table.
          Now sits in the right grid cell so both panels share the same
          vertical space and the page never grows past one viewport.
          Image + name are looked up from the per-group `rows` map
          (populated by `mint_status` frames) so freshly-enriched groups
          upgrade their thumbnails in-place; new mints from un-enriched
          groups render the placeholder until the backend's enricher
          catches up. No per-NFT metadata fetching anywhere on the
          client. Hidden in embed mode (multi-tab) — the grid collapses
          to a single column there. */}
      {!embedded && (
        <div style={{
          background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
          border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
          // Pane fills its grid cell vertically — minHeight: 0 lets the
          // inner scroll-area shrink to fit; overflow: hidden + the
          // inner overflowY: 'auto' keep all scrolling internal so the
          // page itself never grows with feed content.
          overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid rgba(168,144,232,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LiveDot />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#a890e8', letterSpacing: '0.6px' }}>
                LIVE MINT FEED
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 10, color: '#55556e' }}>
                {visibleEvents.length === 0
                  ? 'waiting…'
                  : `${visibleEvents.length} recent · max ${LIVE_FEED_MAX}`}
              </span>
              {/* cNFT visibility toggle. Pill style mirrors the small
                  pills used elsewhere on the page (CORE/cNFT/NFT). When
                  ON the cNFT-hidden state lights up red-ish so it's
                  obvious the feed is filtered; OFF state is muted. */}
              <button
                type="button"
                onClick={() => setShowCnft(v => !v)}
                title={showCnft
                  ? 'Showing cNFT mints in feed and table — click to hide'
                  : 'Hiding cNFT mints from feed and table — click to show'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 7px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                  background: showCnft ? 'rgba(92,224,160,0.15)' : 'rgba(239,120,120,0.15)',
                  color: showCnft ? '#5ce0a0' : '#ef7878',
                  border: '1px solid transparent',
                  letterSpacing: '0.4px', cursor: 'pointer', userSelect: 'none',
                  textTransform: 'uppercase',
                }}
              >
                cNFT {showCnft ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          <div className="scroll-area" style={{
            flex: 1, overflowY: 'auto',
            // Card-stack rhythm (mirrors /feed): inner column with a 6 px
            // gap between rows + 8 px padding so the first/last cards
            // breathe inside the panel chrome. Each row is itself a
            // bordered card via the .feed-card-style rules below.
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: '8px 8px',
          }}>
            {visibleEvents.length === 0 && (
              <div style={{ textAlign: 'center', color: '#3a3a52', padding: '36px 16px', fontSize: 12 }}>
                {events.length === 0
                  ? 'Waiting for individual mint events…'
                  : 'No non-cNFT mints in the buffer — toggle cNFT ON to see hidden rows.'}
              </div>
            )}
            {visibleEvents.map(ev => {
              const group       = rows.get(ev.groupingKey);
              // NFT name vs. collection name. Per the targeted-mode
              // spec, these are distinct lines on the card: the NFT's
              // own name is the prominent first line; the collection
              // name (when known) sits below in a smaller muted font.
              // Backend doesn't ship per-mint nftName on the wire today,
              // so we fall back to the shortened mint address for the
              // top line and use the group's resolved name for the
              // collection subtitle.
              const collectionName = group?.name ?? null;
              // NFT name source order:
              //   1. per-mint `nftName` from the SSE `mint_meta` patch
              //      (DAS-resolved post-hoc; the live update path).
              //   2. shortMint(mintAddress) placeholder until the patch
              //      arrives — at least visually distinct per row.
              //   3. literal "NFT" as last resort (cNFTs without a
              //      mint address).
              const nftName        = (ev.nftName && ev.nftName.length > 0)
                ? ev.nftName
                : (isSolPubkey(ev.mintAddress) ? shortMint(ev.mintAddress) : 'NFT');
              // Defensive frontend strip — when backend patched
              // `group.name` with the raw per-NFT name (e.g.
              // "Kryptos #287"), strip the trailing `#N` to derive a
              // collection-style label ("Kryptos"). This catches the
              // race where the synthesized-row upsert from a `mint`
              // event lands BEFORE collection-confirm strips it on
              // the backend; without this guard the bottom line
              // mirrors the top line and reads as "missing".
              const strippedCollection = collectionName
                ? collectionName.replace(/\s*#\s*\d+\s*$/, '').trim()
                : null;
              // Final collection line. Order:
              //   1. stripped backend name when distinct from nftName
              //   2. short collection address (always renders SOMETHING
              //      pubkey-ish, never empty or '—')
              //   3. literal "—" only when NEITHER is available
              // Also guard against `strippedCollection === nftName`
              // (true when backend hasn't resolved a real collection
              // name and we'd duplicate the title line).
              const collectionLine =
                (strippedCollection && strippedCollection.length > 0 && strippedCollection !== nftName)
                  ? strippedCollection
                  : (ev.collectionAddress ? shortMint(ev.collectionAddress) : '—');
              const abbr           = (nftName[0] ?? '?').toUpperCase() + (nftName[1] ?? '').toUpperCase();
              // Per-mint image only. We deliberately do NOT fall back
              // to `group?.imageUrl` here — that produced the bug
              // where every card in a collection painted the same
              // image: `patchAccumulatorMeta` used to write the
              // FIRST resolved per-NFT image into the collection row,
              // and every other card without its own resolved image
              // inherited it via this fallback. Collection-row image
              // is unaffected (renders in the trending table only);
              // unresolved live cards now show a per-mint placeholder
              // (mintAddress-seeded color + shortMint initials) until
              // their own DAS retry lands a unique image.
              const cardImage      = ev.nftImageUrl ?? null;
              const priceText      = ev.priceLamports == null
                ? '—'
                : ev.priceLamports === 0 ? 'FREE' : formatSol(ev.priceLamports / 1e9);
              const priceColor     = ev.priceLamports == null
                ? '#55556e'
                : ev.priceLamports === 0 ? '#5ce0a0' : '#f0eef8';
              // NFT-type pill. We only know `programSource` on the wire
              // (no separate nftType today), so Core → CORE; everything
              // else collapses to the spec's "NFT" fallback.
              const nftTypeLabel: string =
                ev.programSource === 'mpl_core'   ? 'CORE'   :
                ev.programSource === 'bubblegum'  ? 'cNFT'   :
                'NFT';
              // Two-tier freshness on the right Live Mint Feed:
              //   • `mints-feed-row-fresh`  (< 2.5 s) — one-shot
              //     slide-in + green flash for brand-new SSE arrivals
              //     (cache-restored events have an old `receivedAt`
              //     and never qualify).
              //   • `mints-feed-row-recent` (2.5–15 s) — soft lilac
              //     halo that persists for the rest of the 15 s
              //     window so a card stays visually distinct after
              //     the flash decays. Mutually exclusive with -fresh
              //     so the two effects never stack.
              // Boundary precision is gated by the page-level 5 s
              // force tick (same cadence used by the age-tier color
              // below) — a 14 s card flips off within 5 s of crossing
              // the threshold.
              const ageMsCard    = Date.now() - ev.receivedAt;
              const isFreshFlash = ageMsCard < 2500;
              const isRecent     = !isFreshFlash && ageMsCard < 15000;
              return (
                <div
                  key={ev.signature}
                  className={
                    'mints-feed-row' +
                    (isFreshFlash ? ' mints-feed-row-fresh'  : '') +
                    (isRecent     ? ' mints-feed-row-recent' : '')
                  }
                  style={{
                    // Card chrome — exact mirror of /feed `.feed-card`:
                    // 10/12 padding, 12 px gap, 56 px thumb, 1 px hairline
                    // border, 7 px radius, faint background. Hover tint
                    // via the className rule in globals.css.
                    // 3 px left accent stripe in the same deterministic
                    // collection color used on the row above — visually
                    // groups all mints from the same collection in the
                    // stream. `borderLeftWidth` overrides the hairline.
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderLeft: `3px solid ${colorForCollection(ev.collectionAddress ?? ev.groupingKey)}`,
                    borderRadius: 7,
                    background: 'rgba(255,255,255,0.02)',
                    transition: 'background 0.12s, border-color 0.12s',
                  }}
                >
                  {/* 56×56 thumbnail rendered from a 200×200 /thumb
                      source so hi-DPI displays render crisply without
                      enlarging the card footprint. Falls back to the
                      shared abbr/color placeholder when no image yet. */}
                  <ItemThumb
                    imageUrl={thumb200(cardImage)}
                    /* When a real per-NFT image lands we keep the
                       collection-color tint behind it (matches the row
                       accent stripe). When it's the placeholder path
                       we seed by `mintAddress` instead so two cards in
                       the same collection paint visibly different
                       tiles — otherwise the abbr is the only varying
                       pixel and the tiles read as duplicates. */
                    color={colorForCollection(
                      cardImage
                        ? (ev.collectionAddress ?? ev.groupingKey)
                        : (ev.mintAddress ?? ev.signature)
                    )}
                    abbr={abbr}
                    size={56}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Top line: NFT name. Clickable → Solscan token
                        page when a real mint address is present. */}
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {isSolPubkey(ev.mintAddress) ? (
                        <a
                          href={`https://solscan.io/token/${ev.mintAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Solscan · ${ev.mintAddress}`}
                          style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                        >
                          {nftName}
                        </a>
                      ) : (
                        nftName
                      )}
                    </div>
                    {/* Bottom line: collection name (smaller, muted)
                        per the targeted-mode spec. Falls back to the
                        shortened collection address, then to "—".
                        Clickable when we can build a LaunchMyNFT link
                        for this row's group — same target as the
                        LMNFT pill in the trending table on the left.
                        We resolve the URL via `buildLaunchMyNftUrl`
                        which already handles the deployer-only
                        explore fallback. Cursor + underline-on-hover
                        match the title-line link styling so users
                        recognise it as interactive. */}
                    {(() => {
                      const lmnftHref = group ? buildLaunchMyNftUrl(group) : null;
                      const baseStyle: React.CSSProperties = {
                        // Secondary tier in the card's text hierarchy:
                        // NFT title above is the bright primary (#f0eef8,
                        // weight 600); collection name sits a clear step
                        // darker so the two lines don't read as equally
                        // bright (the prior #d4d4e8 was too close to the
                        // title and flattened the hierarchy). Wallet
                        // below stays at #7a7a94 — the muted-metadata
                        // bottom tier — preserving the four-tier ladder
                        // (title → collection → wallet → age/source).
                        fontSize: 11, color: '#9c9cb8', fontWeight: 500,
                        marginTop: 2, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      };
                      return lmnftHref ? (
                        <a
                          href={lmnftHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`LaunchMyNFT · ${group?.name ?? collectionLine}`}
                          style={{
                            ...baseStyle,
                            display: 'block', textDecoration: 'none', cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                        >
                          {collectionLine}
                        </a>
                      ) : (
                        <div style={baseStyle}>{collectionLine}</div>
                      );
                    })()}
                    {/* Minter wallet — compact mono styling matching
                        the seller/buyer rows in /feed. Plain shortened
                        wallet (no "minter:" prefix) and clickable to
                        the Solscan account page in a new tab. Hidden
                        when the field isn't on the wire (some replays
                        / cNFT paths). */}
                    {ev.minter && (
                      <div style={{ fontSize: 10.5, color: '#7a7a94', fontFamily: "'SF Mono','Fira Code',monospace", marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <a
                          href={`https://solscan.io/account/${ev.minter}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`Solscan · ${ev.minter}`}
                          style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                        >
                          {shortMint(ev.minter)}
                        </a>
                      </div>
                    )}
                  </div>
                  {/* Compact NFT-type pill (CORE / pNFT / cNFT / NFT). */}
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                    background: 'rgba(168,144,232,0.15)', color: '#a890e8',
                    letterSpacing: '0.3px', flexShrink: 0,
                  }}>{nftTypeLabel}</span>
                  <span style={{
                    minWidth: 64, textAlign: 'right',
                    fontSize: 13, fontWeight: 700, color: priceColor,
                    fontFamily: "'SF Mono','Fira Code',monospace",
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}>{priceText}</span>
                  {(() => {
                    // Age tier coloring — mirrors /feed's TimeAgo
                    // tiers (pink <15s, amber 15s–3m, muted >3m).
                    // Re-evaluated on the page-level 5 s force tick;
                    // boundary precision is fine for this surface
                    // (avoids a per-card 1 s timer on 150 cards).
                    const ageMs = Date.now() - ev.receivedAt;
                    const ageColor:  string = ageMs < 15000 ? '#e87ab0' : ageMs < 180000 ? '#c7b479' : '#877496';
                    const ageWeight: 500 | 600 = ageMs < 15000 ? 600 : 500;
                    return (
                      <span style={{ minWidth: 56, textAlign: 'right', fontSize: 11, color: ageColor, fontWeight: ageWeight, flexShrink: 0 }}>
                        {fmtAge(ev.receivedAt)}
                      </span>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}
      </div>

    </div>
  );
}

/** Tiny ↑/↓ chip rendered next to the active sort key in the table
 *  header. Returns null when the column isn't the active key so the
 *  unselected headers don't render an empty `<span>`. */
function sortArrow(active: SortKey, dir: SortDir, key: SortKey) {
  if (active !== key) return null;
  return <span style={{ color: '#8068d8' }}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

// Comfortable density baseline shared with /dashboard (mirrors the
// `thStyle` constant in dashboard/page.tsx). /multi inherits via
// iframe + ?embed=1, so updating this in lockstep with dashboard
// keeps the three pages aligned without a CSS-class round-trip.
// The Live Mint Feed (.mints-feed-row) on this page's right pane
// uses different sizing and stays denser by design.
const thStyle: React.CSSProperties = {
  padding: '12px 10px',
  fontSize: 11,
  fontWeight: 700,
  color: '#56566e',
  letterSpacing: '0.6px',
  textAlign: 'right',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
  background: 'rgba(28,22,50,0.95)',
  borderBottom: '1px solid rgba(168,144,232,0.12)',
  textTransform: 'uppercase',
  userSelect: 'none',
};

/** Per-row status pill in the COLLECTION cell. ACTIVE = promoted
 *  (`displayState === 'shown'`); WATCH = incubating (pre-burst,
 *  surfaced here so the table isn't empty when traffic is sparse).
 *  Compact 9 px font + flexShrink: 0 so it never wraps off the row. */
const STATUS_BADGE_BASE: React.CSSProperties = {
  display:        'inline-block',
  padding:        '1px 5px',
  fontSize:       9,
  fontWeight:     800,
  letterSpacing:  '0.5px',
  borderRadius:   3,
  textTransform:  'uppercase',
  flexShrink:     0,
  lineHeight:     '13px',
};
const STATUS_BADGE_ACTIVE: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#5ce0a0',
  background: 'rgba(92,224,160,0.14)',
  border:     '1px solid rgba(92,224,160,0.42)',
};
const STATUS_BADGE_WATCH: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#c9a820',
  background: 'rgba(201,168,32,0.10)',
  border:     '1px solid rgba(201,168,32,0.32)',
};
// Same red as the rest of the site (SELL flash / SELL feed badge —
// `rgba(239,120,120,…)`), kept consistent so a row that hits its
// max supply visually clusters with sell-side cues elsewhere.
const STATUS_BADGE_SOLD: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#ef7878',
  background: 'rgba(239,120,120,0.12)',
  border:     '1px solid rgba(239,120,120,0.45)',
};
