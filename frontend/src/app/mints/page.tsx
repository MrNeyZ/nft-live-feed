'use client';

// ASSET_REV: 2026-06-12a — bump to force a fresh content hash on the mints page
// chunk (app/mints/page-*.js). A Cloudflare edge had cached an HTML 404
// (text/html) under the old stable chunk URL during a past live `.next` wipe,
// blocking the script (nosniff) and black-screening /mints even after a hard
// refresh. A new URL is fetched fresh (un-poisoned). See shared.tsx ASSET_REV.

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
import { LiveDot, ItemThumb, Pill, SETTINGS_PILL_INACTIVE, settingsPillActive, SettingsToggle } from '@/soloist/shared';
import { useBlacklist, MINTS_BLACKLIST_KEY, readBlacklist } from '@/soloist/blacklist-store';
import { isMintEventBlacklisted, isMintStatusBlacklisted } from '@/soloist/blacklist-filter';
import { formatSol } from '@/soloist/mock-data';
import {
  MINT_TIMEFRAMES, MINT_TF_MS, MINT_TF_DESC,
} from './lib/types';
import type {
  MintRollupType, MintStatus, MintEvent, MintTimeframe, PaymentTokenInfo,
} from './lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

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
  // LMNFT cNFT carve-out — backend already promoted this row with
  // `shownReason='launchpad'` because the LMNFT outer + Bubblegum CPI
  // fingerprint is unspoofable. DAS can transiently fail for compressed
  // assets (-32000), leaving `name`/`imageUrl` null for one or more
  // status frames. Per product rule "LMNFT cNFT MUST be tracked" +
  // "Missing image/name should not drop the LMNFT cNFT event": skip
  // the identity-strict rejects below. Row renders with shortKey
  // fallback for the name and initials for the thumbnail until the
  // next mint's DAS retry patches identity in.
  const isLmnftCnft = row.programSource === 'bubblegum'
    && row.sourceLabel === 'LaunchMyNFT';
  if (isLmnftCnft) return true;
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
  // Aligned with backend `hasUsableIdentity` (src/mints/accumulator.ts):
  // a row is tracker-worthy if EITHER a real name OR an image has
  // resolved. Pre-fix this was `!realName` alone, which hid backend-
  // confirmed rows whose DAS image had landed but name hadn't yet.
  if (!realName && !hasImage)                 return false;
  // Generic literal "NFT" is junk ONLY when the row has no other
  // collection evidence. MPL Core / LaunchMyNFT collections can resolve
  // their on-chain name to the literal "NFT" while still being a real,
  // heavily-minted collection (real collection address + image). Keep
  // dropping bare "NFT" noise, but spare rows with strong identity.
  const hasCollectionIdentity =
    hasImage &&
    !!row.collectionAddress &&
    !/^(authority|program|owner|pool):/.test(row.collectionAddress) &&
    (row.groupingKind === 'collection' ||
      (typeof row.groupingKey === 'string' && row.groupingKey.startsWith('collection:')));
  if (realName.toLowerCase() === 'nft' && !hasCollectionIdentity) return false;
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

/** Trim + treat empty-string as undefined. Older reducer revs wrote
 *  literal `""` into `imageUrl` / `representativeImageUrl` /
 *  `sharedPlaceholderImageUrl` / `nftImageUrl`; on hydrate those
 *  values short-circuit `??` chains in render code and pin the row to
 *  a blank URL. Normalize at read-time so rendering can stay simple.
 *  In-place mutation is safe here — we own this fresh-parsed object. */
function normalizeImageFieldsOnRow(r: MintStatus): void {
  for (const k of ['imageUrl', 'representativeImageUrl', 'sharedPlaceholderImageUrl'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v.trim().length === 0) r[k] = undefined;
  }
}
function normalizeImageFieldsOnEvent(ev: MintEvent): void {
  if (typeof ev.nftImageUrl === 'string' && ev.nftImageUrl.trim().length === 0) {
    ev.nftImageUrl = null;
  }
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
    // Read the user's persisted blacklist directly (this runs in useState
    // init, before the useBlacklist hook) so blacklisted rows are dropped
    // BEFORE they enter restored state — no flash on reload.
    const userBl = new Set(readBlacklist(MINTS_BLACKLIST_KEY));
    const out = new Map<string, MintStatus>();
    for (const r of parsed.rows) {
      if (!r || typeof r.groupingKey !== 'string') continue;
      // Defensive UI-side junk filter — drops authority/pool/program
      // aggregates and evidence-free Metaplex rows resurrected from
      // pre-fix localStorage state. See `isRenderableMintStatus`.
      if (!isRenderableMintStatus(r)) continue;
      if (isMintStatusBlacklisted(r, userBl)) continue;
      normalizeImageFieldsOnRow(r);
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
    // User blacklist read directly (runs in useState init, before the
    // useBlacklist hook) so blacklisted cards never enter restored state.
    const userBl = new Set(readBlacklist(MINTS_BLACKLIST_KEY));
    const out: MintEvent[] = [];
    const seen = new Set<string>();
    for (const v of parsed) {
      if (!v || typeof v !== 'object')        continue;
      const ev = v as MintEvent;
      if (typeof ev.signature !== 'string')   continue;
      if (typeof ev.receivedAt !== 'number')  continue;
      if (seen.has(ev.signature))             continue;
      if (isMintEventBlacklisted(ev, userBl)) continue;
      seen.add(ev.signature);
      normalizeImageFieldsOnEvent(ev);
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
 *  the user picks 4H / 24H timeframe — the row simply doesn't exist.
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
    // Collection-CREATE is a deploy, not a mint — never count it toward a
    // collection's MINTS / velocity here. The authoritative row (with its
    // CREATED timestamp) arrives via the backend `mint_status` frame on
    // reconnect; counting it would fake a +1 supply on the table row.
    if (ev.collectionCreate === true) continue;
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
        coreLaunchpad:     ev.coreLaunchpad,
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
import { thumb64, shortKey } from './lib/format';

import { MintsTableRow } from './components/MintsTableRow';
import { LiveMintFeedCard } from './components/LiveMintFeedCard';
import {
  matchesType, matchesSource, matchesStatusRow, matchesStatusEvent, deriveRowState,
  TYPE_KEYS, SOURCE_KEYS, STATUS_KEYS,
  type FeedTypeKey, type SourceKey, type StatusKey,
} from './lib/filters';

/** UI-only subset of SOURCE_KEYS — CORE is a mint *standard*, not a
 *  launchpad/source, so it was duplicating the TYPE filter meaning.
 *  matchesSource() still recognises CORE; this just hides it from the
 *  filter pill rows and sanitises any prior stored value via
 *  loadFeedSet(..., SOURCE_KEYS_UI). */
const SOURCE_KEYS_UI: ReadonlyArray<SourceKey> = SOURCE_KEYS.filter(k => k !== 'CORE');

type SortKey = 'collection' | 'mints' | 'supply' | 'last' | 'price' | 'created';
type SortDir = 'asc' | 'desc';
type MintTab = 'active' | 'recent';

function typeBadge(t: MintRollupType): { label: string; bg: string; fg: string } {
  switch (t) {
    case 'free':    return { label: 'FREE',    bg: alpha(VL.greenGlow,0.15),  fg: rgb(VL.green) };
    case 'paid':    return { label: 'PAID',    bg: alpha(VL.purpleTint,0.15), fg: rgb(VL.purpleMuted) };
    case 'mixed':   return { label: 'MIXED',   bg: 'rgba(232,193,74,0.15)',  fg: rgb(VL.gold) };
    default:        return { label: 'UNKNOWN', bg: 'rgba(255,255,255,0.05)', fg: VLText.muted };
  }
}

import { colorForCollection, isSolPubkey } from './lib/palette';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

// Filter keys + predicates are shared with the table via ./lib/filters
// (FeedTypeKey / SourceKey / StatusKey, matchesType / matchesSource / …) so the
// LEFT table and RIGHT feed can never apply divergent rules. An empty Set ===
// "Any" === no filter for that group.

/** Two-axis filter control for the LIVE MINT FEED panel. Renders as a
 *  compact pill-button; click opens a small terminal-violet popover
 *  anchored below-right with two rows of Pills (Type, Source). Closes
 *  on outside click / Escape. The popover never participates in the
 *  table's filter — caller wires only the right-pane state in. */
// Settings controls (SETTINGS_PILL_INACTIVE / settingsPillActive / SettingsToggle)
// come from the shared VictoryLabs settings system in @/soloist/shared so this
// surface and the Live Feed read as one product. Imported at top of file.

function FeedFiltersPopover({
  selectedTypes, selectedSources, toggleType, toggleSource, activeCount,
  showCnftMints, setShowCnftMints,
  showBulkMints, setShowBulkMints, hasBulkDeployers,
}: {
  selectedTypes:   ReadonlySet<FeedTypeKey>;
  selectedSources: ReadonlySet<SourceKey>;
  // null clears the group ("Any"); a specific key toggles it on/off.
  toggleType:      (k: FeedTypeKey | null) => void;
  toggleSource:    (k: SourceKey   | null) => void;
  activeCount:     number;
  // "Show cNFT Mints" — Live Mint Feed only, default ON.
  showCnftMints:    boolean;
  setShowCnftMints: (v: boolean) => void;
  // "Show Mass Mints" — hides bulk-deployer floods, default OFF.
  showBulkMints:    boolean;
  setShowBulkMints: (v: boolean) => void;
  hasBulkDeployers: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Close on outside-click + Escape. The mousedown listener fires before
  // a re-render triggered by an inside click, so we always re-check
  // containment via the ref — never closes the popover on a click that
  // landed inside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {/* Canonical shared Settings toggle. Styled as a PASSIVE utility control
          (not an active nav tab): muted dark fill, low-contrast border, dim
          text + gear, no glow — in BOTH states. Open is indicated only by a
          hair-brighter fill (no brighter border, no thicker border, no glow),
          so attention stays on the cards / mint activity / MINT OK status.
          `count` still renders the "Settings · N" active-filter badge. */}
      <SettingsToggle
        active={open || activeCount > 0}
        onClick={() => setOpen(v => !v)}

        count={activeCount}
        style={{
          background: open ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.028)',
          border: '1px solid rgba(255,255,255,0.06)',
          color: '#7c7c92',
          boxShadow: 'none',
        }}
      />
      {open && (
        <div
          // Same settings surface as the LEFT Mint Collections panel
          // (.feed-filters-panel material + .feed-set-group sections), adapted
          // to float: opaque matte base so feed cards behind never bleed
          // through, all-around border + radius (the embedded strip has none),
          // stronger drop shadow. Pills / rows / section title / typography are
          // the shared VictoryLabs settings system — identical to the left.
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6,
            // EXACT reuse of the left Mint Collections panel recipe so the two
            // settings surfaces read as one system — no approximated colors:
            //   • card gradient identity  (#1a1530 → #1a1530, line ~2212)
            //   • .feed-filters-panel overlay (rgba(0,0,0,0.26), globals ~920)
            //     stacked on top → exact effective tone of the left strip,
            //     opaque so feed cards behind never bleed through.
            //   • card border (rgba(168,144,232,0.32)) + card box-shadow.
            background:
              'linear-gradient(rgba(0,0,0,0.26), rgba(0,0,0,0.26)), linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
            border: `1px solid ${alpha(VL.purpleTint,0.32)}`,
            borderRadius: 12,
            boxShadow:
              `inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep,0.10)}`,
            padding: '8px 14px 9px', zIndex: 100,
            // ~one feed-card width so the Type / Source rows fit on a single
            // line at the left panel's 72px label spacing. Capped to viewport.
            width: 344, maxWidth: 'calc(100vw - 16px)',
            display: 'flex', flexDirection: 'column',
          }}
        >
          {/* CONTENT — same semantic group + section header + aligned .feed-srow
              rows as the left Mint Collections panel. Default 72px label column
              (no inline override) so row spacing matches the left exactly. */}
          <div className="feed-set-group feed-set-group--content">
            <div className="feed-set-group-hd">Content</div>
            <div className="feed-srow">
              <span className="feed-srow-lbl">Type</span>
              <div className="feed-srow-ctl feed-seg" style={{ flexWrap: 'nowrap' }}>
                <Pill active={selectedTypes.has('cnft')} onClick={() => toggleType('cnft')} label="cNFT" size="sm" style={selectedTypes.has('cnft') ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                <Pill active={selectedTypes.has('core')} onClick={() => toggleType('core')} label="CORE" size="sm" style={selectedTypes.has('core') ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                {/* "NFT" maps to the 'candy' key (Candy Machine / Candy Guard).
                    UI-only label; key, persistence, and predicate unchanged. */}
                <Pill active={selectedTypes.has('candy')} onClick={() => toggleType('candy')} label="NFT" size="sm" style={selectedTypes.has('candy') ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
              </div>
            </div>
            <div className="feed-srow">
              <span className="feed-srow-lbl">Source</span>
              <div className="feed-srow-ctl feed-seg" style={{ flexWrap: 'nowrap' }}>
                {SOURCE_KEYS_UI.map(s => (
                  <Pill key={s} active={selectedSources.has(s)} onClick={() => toggleSource(s)} label={s} size="sm" style={selectedSources.has(s) ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                ))}
              </div>
            </div>
            {/* Show cNFT Mints — Live Mint Feed only. Default ON; Hide drops
                compressed mints from the right pane (table/counters unaffected). */}
            <div className="feed-srow">
              <span className="feed-srow-lbl">cNFT</span>
              <div className="feed-srow-ctl feed-seg" style={{ flexWrap: 'nowrap' }}>
                <Pill active={showCnftMints}  onClick={() => setShowCnftMints(true)}  label="Show" size="sm" style={showCnftMints  ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                <Pill active={!showCnftMints} onClick={() => setShowCnftMints(false)} label="Hide" size="sm" style={!showCnftMints ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
              </div>
            </div>
            {/* Mass Mints — bulk deployer flooding the feed across many
                collections. Default OFF (hidden). Red dot badge when active. */}
            <div className="feed-srow">
              <span className="feed-srow-lbl" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                Mass
                {hasBulkDeployers && !showBulkMints && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#e05c5c', display: 'inline-block', flexShrink: 0 }} />
                )}
              </span>
              <div className="feed-srow-ctl feed-seg" style={{ flexWrap: 'nowrap' }}>
                <Pill active={showBulkMints}  onClick={() => setShowBulkMints(true)}  label="Show" size="sm" style={showBulkMints  ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                <Pill active={!showBulkMints} onClick={() => setShowBulkMints(false)} label="Hide" size="sm" style={!showBulkMints ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-row external links cluster: Solscan + Magic Eden.
 *  Solscan path branches on programSource — MPL Core assets/collections
 *  are first-class accounts (`/account/`), Token Metadata mints are SPL
 *  token mints (`/token/`). Magic Eden's `/item-details/<addr>` resolves
 *  both Core asset addresses and TM mint addresses, so a single URL form
 *  covers both. Renders a muted dash when no on-chain anchor is known
 *  yet (groupingKind is `authority` / `programSource`). */
/** Subtle PAUSED status chip — muted amber, lower contrast than the
 *  prior loud version. Rendered in both the LEFT Mint Tracker header and
 *  the RIGHT Live Mint Feed header while hover-pause is active. Shared
 *  component (single source of truth for the style) so the two surfaces
 *  can never drift. */
function PausedChip() {
  return (
    <span
      aria-live="polite"
      
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '1px 5px', borderRadius: 3,
        fontSize: 9, fontWeight: 600, letterSpacing: '0.5px',
        // Muted lavender — same family as the pinned/hover chips so the
        // chip reads as a status indicator in the existing palette, not
        // a warning. Lower contrast than the pinned variant on purpose.
        color: 'rgba(201,189,240,0.78)',
        background: alpha(VL.purpleTint,0.06),
        border: `1px solid ${alpha(VL.purpleTint,0.22)}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{
        width: 4, height: 4, borderRadius: '50%',
        background: alpha(VL.purpleTint,0.65),
      }} />
      PAUSED
    </span>
  );
}

export default function MintsPage() {
  // Embed mode (`?embed=1`) suppresses TopNav so multi-tab can iframe
  // the real /mints page without a duplicated chrome row, mirroring
  // the existing /dashboard and /feed embed plumbing.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'Mint Tracker | VictoryLabs'; }, []);
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

  // Custom-token mint payments → symbol/logo cache. Populated from the
  // SSE `payment_token_meta` channel (one entry per unique paymentMint;
  // backend replays the snapshot on connect). Keyed by mint address.
  const [paymentTokens, setPaymentTokens] = useState<Map<string, PaymentTokenInfo>>(() => new Map());

  // Hover-pause for the LIVE MINT FEED panel — mirrors the
  // /feed page's hoverPaused pattern. While the cursor is over the
  // feed scroll container, incoming `mint` SSE events are buffered
  // (not prepended) so cards stay clickable. Drains on mouseleave
  // through the same setEvents path so dedupe/sort/cap are consistent
  // with live arrivals. The LEFT collections table keeps updating
  // (matches /feed UX — only the live list freezes).
  const [hoverPaused, setHoverPaused] = useState(false);
  const pausedFeedRef = useRef(false);
  const pausedFeedBuffer = useRef<MintEvent[]>([]);
  const PAUSE_BUFFER_MAX = 500;
  useEffect(() => { pausedFeedRef.current = hoverPaused; }, [hoverPaused]);

  // Master switch for hover-pause behavior — mirrors /feed's HOVER toggle.
  // Default true; persisted in vl.mints.hoverPauseEnabled. When OFF,
  // enter/leavePauseZone become no-ops, any in-effect pause is cleared,
  // and the buffer drains immediately via the existing drain effect
  // (hoverPaused → false).
  const [hoverPauseEnabled, setHoverPauseEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const v = window.localStorage.getItem('vl.mints.hoverPauseEnabled');
      return v === null ? true : v === '1';
    } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.hoverPauseEnabled', hoverPauseEnabled ? '1' : '0'); } catch { /* quota */ }
    // Turning the master switch OFF clears any in-effect pause + the zone
    // counter, so the LEFT snapshot drops and the RIGHT buffer drains via
    // the existing useEffect([hoverPaused]).
    if (!hoverPauseEnabled) {
      hoverZoneCountRef.current = 0;
      setHoverPaused(false);
    }
  }, [hoverPauseEnabled]);

  // Hover-zone counter — pause activates while the cursor is over EITHER
  // the LEFT Mint Tracker table or the RIGHT Live Mint Feed panel. Single
  // state (`hoverPaused`) feeds both surfaces' PAUSED chips and the SSE
  // buffer. Counter (not boolean) so moving the cursor from one zone
  // directly into the other never produces a brief unpause flicker —
  // the second enter increments before the first leave decrements.
  const hoverZoneCountRef = useRef(0);
  const enterPauseZone = () => {
    if (!hoverPauseEnabled) return;
    hoverZoneCountRef.current += 1;
    if (hoverZoneCountRef.current === 1) setHoverPaused(true);
  };
  const leavePauseZone = () => {
    if (!hoverPauseEnabled) { hoverZoneCountRef.current = 0; return; }
    hoverZoneCountRef.current = Math.max(0, hoverZoneCountRef.current - 1);
    if (hoverZoneCountRef.current === 0) setHoverPaused(false);
  };

  // Frontend-only collection blacklist — render-layer filter applied to
  // both LEFT tracker and RIGHT feed. Independent, versioned, persisted
  // store (vl.mints.blacklist.v1) — survives reload, separate from /feed.
  // Matches against groupingKey, collectionAddress, mintAddress, and
  // lowercased name — so a user can paste any of those identifiers from
  // the row title.
  const { slugs: blacklistSlugs, add: addBlacklistToken, remove: removeBlacklist } = useBlacklist(MINTS_BLACKLIST_KEY);
  const [blInput, setBlInput] = useState('');
  const addBlacklist = (raw: string) => {
    addBlacklistToken(raw);
    setBlInput('');
  };
  /** O(1) match for the render-layer blacklist. Checks groupingKey,
   *  collectionAddress, mintAddress, and lowercased name. */
  const blacklistSet = useMemo(() => new Set(blacklistSlugs), [blacklistSlugs]);
  // Live mirror so the SSE handlers (registered once) and the REST snapshot
  // drop blacklisted mints/rows at the boundary using the CURRENT set —
  // including tokens added mid-session — instead of relying on render-time
  // filtering (which paints the row for a frame first).
  const blacklistSetRef = useRef(blacklistSet);
  useEffect(() => { blacklistSetRef.current = blacklistSet; }, [blacklistSet]);
  // Render-time matchers delegate to the shared pure helper so the boundary
  // and render backstop can never diverge. Fields unchanged.
  const isBlacklistedRow   = (r: MintStatus): boolean => isMintStatusBlacklisted(r, blacklistSet);
  const isBlacklistedEvent = (e: MintEvent): boolean => isMintEventBlacklisted(e, blacklistSet);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  // Direction is per-key; toggling the same header flips it, picking a
  // new header resets to 'desc' (the natural default for numeric/recency
  // columns — collection/source still default to 'desc' so a single click
  // produces a Z→A read, second click flips to A→Z).
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Has the user manually clicked a column header in the current tab?
  // While false, each tab uses its own default (ACTIVE → CREATED desc,
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
      : (mintTab === 'recent' ? 'last' : 'created');
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
  // Backend-truthed per-collection mint counts for the active timeframe.
  // The live SSE buffer is capped at LIVE_FEED_MAX (150) so for older
  // windows (1H / 4H / 24H) the local count silently undercounts. The
  // /api/mints/tf-stats endpoint groups mint_events by grouping_key over
  // the requested windowMs — bounded indexed query, 5 s server cache.
  // tfStatsByKey below seeds counts from this map and only adds local
  // events newer than `asOf` (so live mints surface without waiting for
  // the next backend refresh). Null = endpoint hasn't returned yet;
  // local-buffer fallback covers it.
  const [tfStatsBackend, setTfStatsBackend] = useState<{
    stats:    Map<string, number>;
    inFeed:   Map<string, number>;
    asOf:     number;
    windowMs: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchTfStats = async () => {
      // Skip the network round-trip on a hidden tab; the next tick
      // after the tab returns to visible refreshes counts.
      if (typeof document !== 'undefined' && document.hidden) return;
      const windowMs = MINT_TF_MS[mintTf];
      try {
        const res = await fetch(`${API_BASE}/api/mints/tf-stats?windowMs=${windowMs}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { stats?: Record<string, number>; inFeed?: Record<string, number>; asOf?: number; windowMs?: number };
        if (cancelled) return;
        if (!body.stats || typeof body.asOf !== 'number' || typeof body.windowMs !== 'number') return;
        setTfStatsBackend({
          stats:    new Map(Object.entries(body.stats)),
          inFeed:   new Map(Object.entries(body.inFeed ?? {})),
          asOf:     body.asOf,
          windowMs: body.windowMs,
        });
      } catch {
        // silent — local buffer keeps the column populated
      }
    };
    fetchTfStats();
    // 5 s refresh keeps counts fresh; server cache (2 s) absorbs bursts.
    const id = setInterval(fetchTfStats, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [mintTf]);
  // Collapsible embedded filter section (Source/Status). Closed by default so
  // the table starts high; the header "Settings" pill toggles it. Not a
  // floating popover — it expands/collapses inline.
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.tab', mintTab); } catch { /* noop */ }
    // Tab switch clears manual-sort state so each tab opens with its
    // own default ordering (ACTIVE → CREATED desc, RECENT → LAST MINT
    // desc). Manual click in the new tab re-enables the user's choice.
    setHasManualSort(false);
  }, [mintTab]);
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.tf', mintTf); } catch { /* noop */ }
  }, [mintTf]);

  // Legacy global "show cNFT everywhere" gate. The UI control that used
  // to toggle this lived in the LIVE MINT FEED header and was replaced
  // by the per-feed Filters popover below — the right pane now has its
  // own `feedType` ('cnft' | 'core' | 'candy' | 'all') instead. We KEEP
  // the state pinned to `true` (no UI) so the left collection table's
  // filter line (`r => showCnft || !isCnftLike(r)`) is preserved bit-
  // identical per "do not alter table filters" — cNFT rows in the table
  // continue to be visible by default, which matches the prior default.
  const showCnft = true;

  // Live Mint Feed filters — independent from the LEFT tracker table.
  // Two orthogonal axes that combine with AND:
  //   feedType   — NFT standard / Candy Machine bucket
  //   feedSource — launchpad origin (sourceLabel)
  // Both default to 'all' (no filter). Persisted in localStorage so the
  // preference survives reloads. Affects ONLY the right-pane events
  // memo; left-table memo never reads these.
  // Multi-select TYPE / SOURCE filters as Sets of specific keys. An EMPTY set
  // means "Any" (no filtering for that group). Persisted as CSV; back-compat
  // with the old single-value keys ('all' / 'core' / 'LMNFT' / …).
  const FEED_TYPE_KEYS: ReadonlyArray<FeedTypeKey> = TYPE_KEYS;
  function loadFeedSet<K extends string>(lsKey: string, valid: ReadonlyArray<K>): Set<K> {
    const out = new Set<K>();
    if (typeof window === 'undefined') return out;
    try {
      const raw = window.localStorage.getItem(lsKey) ?? '';
      for (const part of raw.split(',')) {
        const v = part.trim();
        if (v && v !== 'all' && (valid as readonly string[]).includes(v)) out.add(v as K);
      }
    } catch { /* ignore */ }
    return out;
  }
  const [selectedTypes, setSelectedTypes] = useState<Set<FeedTypeKey>>(
    () => loadFeedSet('vl.mints.feed.type', FEED_TYPE_KEYS),
  );
  // Unified launchpad-SOURCE filter — single source of truth driving BOTH
  // panels and BOTH filter UIs (feed popover + table settings). On first load
  // we union the legacy table-source pref ('vl.mints.sourceFilter.multi') so
  // existing selections survive the merge; persists going forward under
  // 'vl.mints.feed.source'.
  const [selectedSources, setSelectedSources] = useState<Set<SourceKey>>(() => {
    const merged = loadFeedSet('vl.mints.feed.source', SOURCE_KEYS_UI);
    for (const k of loadFeedSet('vl.mints.sourceFilter.multi', SOURCE_KEYS_UI)) merged.add(k);
    return merged;
  });
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.feed.type', [...selectedTypes].join(',')); } catch { /* quota */ }
  }, [selectedTypes]);
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.feed.source', [...selectedSources].join(',')); } catch { /* quota */ }
  }, [selectedSources]);
  // "Show cNFT Mints" — Live Mint Feed only. Default ON. When OFF, compressed
  // (Bubblegum) mints are hidden from the RIGHT pane via `isCnftLike` in the
  // `visibleEvents` render filter. Does NOT touch the LEFT collections table,
  // backend APIs, SSE, or any counter/stat — pure presentation. Persisted in
  // localStorage ('0' = hidden); absent/anything-else = shown (default ON).
  const [showCnftMints, setShowCnftMints] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try { return window.localStorage.getItem('vl.mints.feed.showCnft') !== '0'; }
    catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.feed.showCnft', showCnftMints ? '1' : '0'); } catch { /* quota */ }
  }, [showCnftMints]);

  // "Show Mass Mints" — hides feed events from a deployer wallet that has
  // flooded the feed with many mints across multiple different collections.
  // Threshold: >5 events from the same deployer in the current time window.
  // Default OFF (hidden) so a flood doesn't fill the feed on first load.
  const [showBulkMints, setShowBulkMints] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('vl.mints.feed.showBulkMints') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.feed.showBulkMints', showBulkMints ? '1' : '0'); } catch { /* quota */ }
  }, [showBulkMints]);

  // Compute which deployer wallets are "bulk" in the current event window.
  const bulkDeployers = useMemo<Set<string>>(() => {
    const counts = new Map<string, number>();
    for (const ev of events) {
      if (!ev.deployer) continue;
      counts.set(ev.deployer, (counts.get(ev.deployer) ?? 0) + 1);
    }
    const bulk = new Set<string>();
    for (const [deployer, count] of counts) {
      if (count > 5) bulk.add(deployer);
    }
    return bulk;
  }, [events]);
  // Toggle a specific key; passing null = "Any" clears the whole group. ANY
  // and specific keys are mutually exclusive (ANY = empty set), and disabling
  // the last specific key leaves the set empty → ANY automatically.
  const toggleType = (k: FeedTypeKey | null) => setSelectedTypes(prev => {
    if (k === null) return new Set();
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleSource = (k: SourceKey | null) => setSelectedSources(prev => {
    if (k === null) return new Set();
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // ── Hover-linked feed scoping (frontend-only, temporary) ──────────────────
  // Hovering a LEFT-table row emphasises that collection in the RIGHT feed
  // (matching mints cluster to the top at full opacity, the rest fade — see
  // feedView). Pure UI state, never persisted, cleared on mouse leave.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // Pinned (locked) collections — persists the live-feed scope after the
  // mouse leaves. Multiple pins are additive: clicking SHOW on another
  // row adds it to the set rather than replacing the prior pin. Pure UI
  // state, not persisted across reloads.
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(() => new Set());
  // Effective scope drives the live feed: every pin + the transient
  // hovered key. Hover preview still works while pins exist.
  const scopeKeys = useMemo(() => {
    const s = new Set<string>(pinnedKeys);
    if (hoveredKey) s.add(hoveredKey);
    return s;
  }, [pinnedKeys, hoveredKey]);
  // Map any pinned/hovered groupingKey to its collectionAddress so feed
  // events that only carry the address still match.
  const scopeAddrs = useMemo(() => {
    const out = new Set<string>();
    for (const k of scopeKeys) {
      const a = rows.get(k)?.collectionAddress;
      if (a) out.add(a);
    }
    return out;
  }, [scopeKeys, rows]);
  // Toggle pin membership. Click SHOW on an unpinned row → add. Click
  // SHOW on a pinned row → remove. Duplicates impossible (Set semantics).
  const togglePin = (key: string) => {
    setPinnedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const removePin = (key: string) => {
    setPinnedKeys(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Multi-select STATUS filter (collection lifecycle). SOURCE is the unified
  // `selectedSources` above (shared with the feed); STATUS applies to both
  // panels too (feed events map to collection status via groupingKey).
  const [selectedStatuses, setSelectedStatuses] = useState<Set<StatusKey>>(
    () => loadFeedSet('vl.mints.statusFilter.multi', STATUS_KEYS),
  );
  useEffect(() => {
    try { window.localStorage.setItem('vl.mints.statusFilter.multi', [...selectedStatuses].join(',')); } catch { /* quota */ }
  }, [selectedStatuses]);
  // ANY (null) clears the group; specific keys toggle; emptying the set → ANY.
  const toggleStatus = (k: StatusKey | null) => setSelectedStatuses(prev => {
    if (k === null) return new Set();
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Render-time view of `events` for the LIVE MINT FEED panel. Pure
  // filter — never mutates the persisted store, so toggling filters
  // doesn't drop anything from localStorage. Two-axis AND:
  //   feedType:   programSource / sourceLabel bucket
  //   feedSource: launchpad sourceLabel exact match
  // CANDY is intentionally matched by `sourceLabel === 'Metaplex Candy
  // Machine'` rather than `programSource === 'mpl_token_metadata'`:
  // Candy Machine drops happen to ship token_metadata under the hood,
  // but the user-facing identity is the launchpad, not the standard.
  // Matching by sourceLabel keeps CANDY narrow (only real CG rows, not
  // every generic Metaplex mint).
  // groupingKey → collection lifecycle state, derived from the rows map. Lets
  // the STATUS filter scope the feed: an event inherits its collection's
  // status. Rebuilt only when `rows` changes; cheap (one pass, bounded rows).
  const statusByKey = useMemo(() => {
    const m = new Map<string, StatusKey>();
    for (const r of rows.values()) m.set(r.groupingKey, deriveRowState(r));
    return m;
  }, [rows]);

  const visibleEvents = useMemo(() => {
    // Timeframe gate — same cutoff the LEFT collection table uses
    // (MINT_TF_MS[mintTf]), so changing the timeframe pills updates BOTH
    // panels consistently. `receivedAt` is anchored to on-chain blockTime
    // (see the SSE handler), so a 5M view shows only mints from the last
    // 5 min in the feed too, matching the table's recent-mint window.
    // Re-evaluated on `tick` (5s) so events age out without a UI nudge.
    //
    // ALL four axes use the shared predicates (./lib/filters) so the feed and
    // the LEFT table can never diverge. Groups AND together; keys OR within a
    // group. STATUS maps event → collection via statusByKey (unknown status is
    // hidden only when a specific status is selected — see matchesStatusEvent).
    const feedCutoff = Date.now() - MINT_TF_MS[mintTf];
    return events.filter(ev =>
      ev.receivedAt >= feedCutoff
      && !isBlacklistedEvent(ev)
      // "Show cNFT Mints" OFF → drop compressed mints from the feed only.
      && (showCnftMints || !isCnftLike(ev))
      // "Show Mass Mints" OFF → drop events from bulk-deployer wallets.
      && (showBulkMints || !ev.deployer || !bulkDeployers.has(ev.deployer))
      && matchesType(selectedTypes, ev.programSource, ev.sourceLabel)
      && matchesSource(selectedSources, ev.sourceLabel)
      && matchesStatusEvent(selectedStatuses, statusByKey, ev.groupingKey),
    );
    // isBlacklistedEvent closes over blacklistSet — listing it in deps
    // is enough to refilter on add/remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, showCnftMints, showBulkMints, bulkDeployers, selectedTypes, selectedSources, selectedStatuses, statusByKey, mintTf, tick, blacklistSet]);

  // Hover-scoped feed VIEW. Hover no longer hides non-matching mints — instead
  // matching mints cluster to the top at full opacity and the rest fade to
  // ~0.15 (dimmed), so the operator sees the hovered collection's cadence in
  // context without losing the surrounding stream. Newest-first ordering is
  // preserved WITHIN each group (matching block + dimmed block are each just a
  // stable partition of the already-newest-first visibleEvents). When nothing
  // is hovered, the list is identity (no reorder, no dim). groupingKey is the
  // stable join; collectionAddress is the fallback for the rare mismatch.
  const feedView = useMemo(() => {
    if (scopeKeys.size === 0) return visibleEvents.map(ev => ({ ev, dimmed: false }));
    const match: MintEvent[] = [];
    const rest:  MintEvent[] = [];
    for (const ev of visibleEvents) {
      const isMatch =
        scopeKeys.has(ev.groupingKey)
        || (ev.collectionAddress != null && scopeAddrs.has(ev.collectionAddress));
      (isMatch ? match : rest).push(ev);
    }
    return [
      ...match.map(ev => ({ ev, dimmed: false })),
      ...rest.map(ev  => ({ ev, dimmed: true  })),
    ];
  }, [visibleEvents, scopeKeys, scopeAddrs]);

  // Total number of active specific filters across both groups — drives the
  // "Settings · N" badge so the active state shows without opening the popup.
  // 0 (both groups = Any) hides the badge.
  const activeFeedFilterCount = selectedTypes.size + selectedSources.size + (showCnftMints ? 0 : 1) + (!showBulkMints && bulkDeployers.size > 0 ? 1 : 0);

  // Self-tick so velocity / lastMint columns refresh smoothly between
  // backend status frames (every 5s here vs. 30s sweep on backend).
  useEffect(() => {
    // Skip the tick on a hidden tab — downstream memos (tfStatsByKey,
    // sortedRows) don't need to recompute against an audience nobody
    // is watching. Next tick after the tab returns to visible covers
    // the catch-up.
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick(n => n + 1);
    }, 5_000);
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
    // expands the timeframe to 4H / 24H, collections that exist only
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

  // Drain hover-pause buffer when the cursor leaves the feed. Routes
  // every buffered event through the same merge+dedupe+sort+cap path
  // as live arrivals so the resumed list is identical to "had the
  // events landed without a pause".
  useEffect(() => {
    if (hoverPaused) return;
    const buf = pausedFeedBuffer.current;
    if (buf.length === 0) return;
    pausedFeedBuffer.current = [];
    setEvents(prev => {
      const seen = new Set<string>();
      for (const p of prev) seen.add(`${p.signature}:${p.mintAddress ?? ''}`);
      const merged = [...prev];
      for (const ev of buf) {
        const k = `${ev.signature}:${ev.mintAddress ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(ev);
      }
      merged.sort((a, b) => b.receivedAt - a.receivedAt);
      return merged.slice(0, LIVE_FEED_MAX);
    });
  }, [hoverPaused]);

  // Backend is the source of truth for the recent live feed. localStorage
  // (loadPersistedFeed) hydrated `events` synchronously for instant paint, but
  // that's device-local fallback only. On mount, fetch the server snapshot
  // (DB-backed, identical for every device) and merge it in — this converges
  // Mac/PC to the same recent feed and the persist-on-change effect above
  // rewrites localStorage from the backend-normalized set. Runs once; live
  // updates continue via SSE. Dedupe key is signature:mintAddress everywhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/mints/recent?limit=${LIVE_FEED_MAX}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { events?: Array<Omit<MintEvent, 'receivedAt'>> };
        if (cancelled || !Array.isArray(body.events)) return;
        const server: MintEvent[] = body.events
          .map(m => {
            const bt = m.blockTime ? Date.parse(m.blockTime) : NaN;
            return { ...m, receivedAt: Number.isFinite(bt) ? bt : Date.now() } as MintEvent;
          })
          // Boundary filter — keep blacklisted mints out of the hydration
          // snapshot so they never enter state on refresh (no flash).
          .filter(ev => !isMintEventBlacklisted(ev, blacklistSetRef.current));
        const k = (e: { signature: string; mintAddress: string | null }) => `${e.signature}:${e.mintAddress ?? ''}`;
        setEvents(prev => {
          // Server set is authoritative; keep only live events NOT in it (i.e.
          // arrived during the fetch). Device-local stale events drop out.
          const seen = new Set(server.map(k));
          const liveExtra = prev.filter(e => !seen.has(k(e)));
          const merged = [...server, ...liveExtra];
          merged.sort((a, b) => b.receivedAt - a.receivedAt);
          return merged.slice(0, LIVE_FEED_MAX);
        });
      } catch { /* offline / backend down → keep localStorage fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
          // User-blacklist boundary — keep blacklisted collection rows out
          // of table state entirely so they never flash before the render
          // filter runs. Counting is backend-side and unaffected.
          if (isMintStatusBlacklisted(s, blacklistSetRef.current)) return;
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
          // User-blacklist boundary — drop the card AND its LEFT-table mirror
          // below before either enters state, so a blacklisted mint never
          // paints. Backend still counts it (mint_status carries the rollup).
          if (isMintEventBlacklisted(m, blacklistSetRef.current)) return;
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
          // Wall-clock arrival gates the fresh-mint flash. `receivedAt` is
          // anchored to blockTime (already older than the 2.5 s flash window
          // by paint time), so the flash must key off this instead.
          const ev: MintEvent = { ...m, receivedAt, clientArrivedAt: Date.now() };
          if (pausedFeedRef.current) {
            // Hover-pause: defer feed-list mutation. Buffer is bounded
            // — drop oldest when capped so a long hover can't blow up
            // memory. Drains via the useEffect when hover clears.
            const buf = pausedFeedBuffer.current;
            if (buf.length >= PAUSE_BUFFER_MAX) buf.shift();
            buf.push(ev);
          } else {
            setEvents(prev => {
              // Dedupe by signature:mintAddress (consistent with the backend
              // unique key + the /api/mints/recent snapshot). A single tx that
              // mints multiple assets yields distinct rows; a replay/reconnect of
              // the same (sig,mint) is dropped.
              if (prev.some(p => p.signature === ev.signature && (p.mintAddress ?? '') === (ev.mintAddress ?? ''))) {
                console.log(`[mints/live-miss] reason=dedupe sig=${ev.signature.slice(0,12)}… mint=${ev.mintAddress ?? '—'}`);
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
          }
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
          //
          // Collection-CREATE events are deploys, not mints: skip the
          // table mirror entirely so they never fake a +1 on the MINTS
          // column. The card still renders from the feed `events` list,
          // and the backend `mint_status` frame (fired in the same SSE
          // batch) seeds/refreshes the row with the real CREATED time.
          if (!ev.collectionCreate) setRows(prev => {
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
              // Sticky-true once a Core Candy v3 mint is seen (pink CORE badge).
              coreLaunchpad:     ev.coreLaunchpad || cur.coreLaunchpad,
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
              coreLaunchpad:     ev.coreLaunchpad,
              // Per-NFT identity intentionally NOT seeded on the
              // synthesized collection row. `ev.nftName` /
              // `ev.nftImageUrl` are per-MINT fields that arrive via
              // the `mint_meta` SSE channel — for a Candy Machine drop
              // they look like "Unknown Flork 5857" / a single child's
              // art, never the collection's "Flork" / hero image.
              // Leaving them undefined lets the next `mint_status`
              // frame (carrying the backend's collection-asset DAS
              // patch) fill in the real collection name + image. The
              // `mint_meta` handler below also respects this: a strong
              // collection-level name is no longer clobbered by the
              // per-NFT title.
              name:              undefined,
              imageUrl:          undefined,
              maxSupply:         null,
              mintedCount:       null,
              lmntfOwner:        null,
              lmntfCollectionId: null,
              // Left null/false on the synthetic placeholder — the next
              // mint_status frame (fires in the same SSE batch) carries
              // the real session-local optimistic count and, after the
              // refresher's first tick, the on-chain verified count.
              supplyMinted:      null,
              supplyVerified:    false,
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
              // Strip per-asset suffixes BEFORE deciding whether to use
              // this as a collection-row name. Three shapes matter for
              // launchpad drops where every NFT has a unique title:
              //   1. "Foo #42"            (Metaplex/Core convention)
              //   2. "Foo - 42" / "Foo 1/1" (LMNFT / 1-of-1 / edition)
              //   3. "Foo 5857"           (Candy Machine: "Unknown Flork 5857")
              // Shape #3 was the gap: the previous regex (`\s*#\s*\d+`)
              // only caught `#`-style. Per-NFT names like "Unknown Flork
              // 5857" passed through unstripped and were then written
              // into the row title, replacing the real "Flork".
              const stripped = p.nftName
                ? p.nftName
                    .replace(/\s*#\s*\d+\s*$/, '')   // " #42"
                    .replace(/\s+-\s+\d+\s*$/, '')   // " - 42"
                    .replace(/\s+\d+\s*\/\s*\d+\s*$/, '') // " 1/1"
                    .replace(/\s+\d{3,}\s*$/, '')    // " 5857" (3+ digits — avoids "Vol 2")
                    .trim()
                : null;
              // Sticky-merge: a per-mint name should NEVER overwrite a
              // collection-level name that already resolved to something
              // real. Treat the current row name as weak only if it's
              // empty/missing or shaped like a short-key fallback
              // (`Abcdef…ghij`). Once a real "Flork" lands via
              // `mint_status` (from the backend's collection-asset DAS
              // patch), no per-mint nftName can replace it.
              const curName = (cur.name ?? '').trim();
              const curIsWeak =
                curName.length === 0 ||
                /^[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{4,8}$/.test(curName);
              const nextName  = (curIsWeak && stripped && stripped.length > 0)
                ? stripped
                : cur.name;
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
      // Payment-token metadata — one entry per unique custom-token mint
      // resolved by the backend's lazy DAS lookup. Snapshot replayed on
      // connect; live updates fan out as new payment tokens are seen.
      es.addEventListener('payment_token_meta', (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as PaymentTokenInfo;
          if (!p || typeof p.mint !== 'string' || p.mint.length === 0) return;
          setPaymentTokens(prev => {
            const cur = prev.get(p.mint);
            // Idempotent: skip if every field matches what we already have.
            if (cur && cur.symbol === p.symbol && cur.name === p.name
              && cur.image === p.image && cur.decimals === p.decimals) {
              return prev;
            }
            const next = new Map(prev);
            next.set(p.mint, p);
            return next;
          });
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
  // Drives the MINTS column (count) and the RATE column (mintPerMin) so
  // the table metrics react to 5M / … / 24H pills instead of showing
  // the cumulative session-lifetime number. Counted from the live events
  // buffer, which is bounded at LIVE_FEED_MAX (150 newest); for very hot
  // collections + long timeframes the count can be understated when older
  // events have rolled off the buffer — same trade-off as the existing
  // `recent`-tab filter.
  //
  // RATE = HEAT composite (Option C): throughput × supplyMult × recencyMult.
  // Option A (the previous fix, `count / tfMinutes`) corrected the
  // active-span inversion but reduced RATE to a near-clone of the MINTS
  // column — both are linear in count once divided by a row-invariant
  // constant. HEAT adds the two trader-relevant dimensions Option A is
  // blind to: how big a fraction of the planned drop got minted in the
  // window, and how recently in the window the activity happened.
  //
  //   throughput   = count / tfMinutes                          (≈ Option A)
  //   supplyFrac   = clamp(count / max(maxSupply, 50), 0, 1)    (% of cap consumed)
  //   supplyMult   = 1 + supplyFrac × 4                          (1× … 5×)
  //   recencyFrac  = mintsInLastQuarter / count                  (% of activity at tail)
  //   recencyMult  = 0.5 + recencyFrac                           (0.5× … 1.5×)
  //   HEAT         = throughput × supplyMult × recencyMult
  //
  // Sanity choices:
  //   • Supply floor of 50 keeps 1/1 art pieces & 5–20-supply
  //     collections from dominating: supplyFrac stays ≤ count / 50.
  //   • supplyMult caps at 5×: a sold-out drop boosts strongly but
  //     doesn't run away.
  //   • recencyMult range 0.5–1.5: stale activity is halved, tail-
  //     loaded activity is 1.5×'d. Never zero (so a steady mid-window
  //     stream isn't punished into invisibility).
  //   • maxSupply unknown ⇒ supplyMult = 1 (neutral; the row is
  //     ranked purely on throughput × recency).
  //
  // Audit fixture (1H window):
  //   COLORS NFTs v2  count=2  supply=3884  uniform
  //     throughput 0.033 × supplyMult 1.00 × recencyMult 0.50 = 0.017
  //   poliworld       count=24 supply=104   uniform
  //     throughput 0.400 × supplyMult 1.92 × recencyMult 0.75 = 0.576
  //   → poliworld outranks COLORS by ~34× (vs. ~12× under Option A).
  //
  // firstTs/lastTs stay on Stats because computeCoef still reads them
  // to derive cluster compactness independently of RATE.
  const tfStatsByKey = useMemo(() => {
    const now            = Date.now();
    const tfMs           = MINT_TF_MS[mintTf];
    const cutoff         = now - tfMs;
    const tfQuarterStart = now - (tfMs / 4);
    const tfMin          = tfMs / 60_000;
    type Stats           = {
      count:    number;
      inFeed:   number;   // sampled feed cards in TF (from mint_events, may undercount bursts)
      firstTs:  number;
      lastTs:   number;
      recentQ:  number;   // mints in the last 25 % of the timeframe
      mintPerMin: number; // HEAT composite (name kept for cross-module compat)
    };
    const m = new Map<string, Stats>();
    // Seed counts from the backend tf-stats endpoint when it covers the
    // active timeframe — that's the DB source of truth, untouched by
    // the local LIVE_FEED_MAX cap. Local events newer than backend.asOf
    // are then added below WITHOUT double-counting (older local events
    // are already represented in the backend count).
    const hasBackend = tfStatsBackend !== null && tfStatsBackend.windowMs === tfMs;
    const backendCutoff = hasBackend ? tfStatsBackend!.asOf + 3_000 : 0; // 3 s clock-skew grace
    if (hasBackend) {
      for (const [key, count] of tfStatsBackend!.stats) {
        const inFeed = tfStatsBackend!.inFeed.get(key) ?? 0;
        m.set(key, {
          count, inFeed, firstTs: 0, lastTs: 0,
          recentQ: 0, mintPerMin: 0,
        });
      }
    }
    for (const ev of events) {
      if (ev.receivedAt < cutoff) continue;
      const isRecent = ev.receivedAt >= tfQuarterStart ? 1 : 0;
      const inBackend = hasBackend && ev.receivedAt <= backendCutoff;
      const cur = m.get(ev.groupingKey);
      if (!cur) {
        m.set(ev.groupingKey, {
          count: inBackend ? 0 : 1, inFeed: inBackend ? 0 : 1,
          firstTs: ev.receivedAt, lastTs: ev.receivedAt,
          recentQ: isRecent, mintPerMin: 0,
        });
      } else {
        if (!inBackend) { cur.count += 1; cur.inFeed += 1; }
        cur.recentQ += isRecent;
        if (cur.firstTs === 0 || ev.receivedAt < cur.firstTs) cur.firstTs = ev.receivedAt;
        if (ev.receivedAt > cur.lastTs)  cur.lastTs  = ev.receivedAt;
      }
    }
    // Compute HEAT once we know the group counts. Reads maxSupply
    // from the rollup row when present; defaults supplyMult = 1
    // (neutral) when supply is unknown so cNFT / pre-resolved rows
    // aren't penalized.
    for (const [key, s] of m) {
      const throughput  = s.count / tfMin;
      const row         = rows.get(key);
      const supply      = (typeof row?.maxSupply === 'number' && row.maxSupply > 0)
        ? row.maxSupply
        : null;
      const supplyFrac  = supply !== null
        ? Math.min(1, s.count / Math.max(supply, 50))
        : 0;
      const supplyMult  = 1 + supplyFrac * 4;
      const recencyMult = s.count > 0 ? 0.5 + s.recentQ / s.count : 0.5;
      s.mintPerMin      = throughput * supplyMult * recencyMult;
    }
    return m;
  // `tick` re-evaluates the cutoff every 5 s so events that age past
  // the selected window drop out without waiting for new SSE traffic.
  // `rows` joined so supplyMult sees the latest maxSupply once
  // launchpad / on-chain resolvers populate it. Recompute cost is
  // O(events) ≤ 150 — trivially cheap.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, mintTf, tick, rows, tfStatsBackend]);

  // Latest observed mint price per groupingKey. Walk events newest-
  // first (the live-feed buffer is maintained newest-at-index-0) and
  // take the first entry per group. Drives the PRICE column.
  //
  // Important: NOT an average. Launchpads run phased pricing (OG /
  // WL / Public) so the price changes mid-drop; an average would
  // mix stages and read incorrectly. The price the PRICE column
  // shows is "the most recent observed mint price for this row",
  // which naturally updates the moment a new event with a different
  // price arrives. priceLamports semantics:
  //    null  → unknown (free or paid?); cell renders "—"
  //    0     → confirmed free mint;     cell renders "FREE"
  //    >0    → paid mint, lamports;     cell renders fmtSol(value)
  //
  // No tfMs/timeframe dep — the latest price persists across tf
  // changes and only updates on a new event for the group.
  const lastPriceByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const ev of events) {
      if (m.has(ev.groupingKey)) continue;
      m.set(ev.groupingKey, ev.priceLamports);
    }
    return m;
  }, [events]);

  // Latest custom-token payment per groupingKey. Same newest-first scan as
  // lastPriceByKey; surfaces { mint, amount, decimals } from the most
  // recent event for the group. Null when the most recent event was
  // SOL-priced. Symbol/logo come from `paymentTokens` keyed by mint.
  const lastPaymentByKey = useMemo(() => {
    const m = new Map<string, { mint: string; amount: string; decimals: number } | null>();
    for (const ev of events) {
      if (m.has(ev.groupingKey)) continue;
      if (ev.paymentMint && ev.paymentAmount != null && ev.paymentDecimals != null) {
        m.set(ev.groupingKey, { mint: ev.paymentMint, amount: ev.paymentAmount, decimals: ev.paymentDecimals });
      } else {
        m.set(ev.groupingKey, null);
      }
    }
    return m;
  }, [events]);

  // (COEF column removed; its slot in the table now hosts PRICE.
  //  `lastPriceByKey` above feeds the new column; `computeCoef` was
  //  only used by the old COEF cell + sort comparator, both of which
  //  are gone, so the function and its derived `coefBy` map were
  //  dropped to keep this surface lean. If a future audit asks for
  //  cluster-compactness back, the formula is `tfMinutes / activeMin`
  //  using `tfStatsByKey.get(key).{firstTs,lastTs}`.)

  // Effective sort = manual override when set, else per-tab default.
  // ACTIVE defaults to CREATED desc; RECENT defaults to LAST MINT desc so
  // the table reads as recent activity until the user opts into a
  // different ordering by clicking a header.
  const effectiveSortKey: SortKey = hasManualSort
    ? sortKey
    : (mintTab === 'recent' ? 'last' : 'created');
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
      // User blacklist (render-only). Same Set drives the RIGHT feed
      // filter below so a slug toggled here vanishes from both surfaces.
      .filter(r => !isBlacklistedRow(r))
      // TYPE / SOURCE / STATUS filters — SAME shared predicates the RIGHT feed
      // uses (./lib/filters), so a selection can never hide a collection here
      // while its mints still show in the feed (or vice-versa). Empty set =
      // Any. Groups AND; keys OR within a group. TYPE was previously feed-only;
      // it now scopes the table too.
      .filter(r => matchesType(selectedTypes, r.programSource, r.sourceLabel))
      .filter(r => matchesSource(selectedSources, r.sourceLabel))
      .filter(r => matchesStatusRow(selectedStatuses, r))
      // Timeframe gate — applies to BOTH tabs. A row whose lastMintAt
      // is older than the selected window is hidden, so 30M never
      // shows a "56m ago" row regardless of tab.
      .filter(r => r.lastMintAt >= cutoff);

    // Per-key comparator (always returns "ascending" — direction is
    // applied below). Numeric keys compare on the actual underlying
    // value, not the formatted string, so e.g. SUPPLY sorts 8 < 88 <
    // 888, not lexically 8 < 88 < 888 (happens to match here, but the
    // pattern matters for floats / negatives elsewhere).
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
        case 'price': {
          // Rows with no observed price (null) sink to the bottom of
          // the ascending order so an asc-click clusters paid rows
          // first; a desc-click puts the highest mint price on top
          // and pushes unknowns to the bottom. FREE (0 lamports) is
          // a real observed value and sorts as 0 — appears at the
          // top of an asc-click as "cheapest = free".
          const ap = lastPriceByKey.get(a.groupingKey);
          const bp = lastPriceByKey.get(b.groupingKey);
          const av = (typeof ap === 'number') ? ap : Number.POSITIVE_INFINITY;
          const bv = (typeof bp === 'number') ? bp : Number.POSITIVE_INFINITY;
          return av - bv;
        }
        case 'created': {
          // Prefer on-chain collectionCreatedAt; fall back to firstSeenAt.
          // Missing-on-both rows sink to bottom of an asc-click; desc
          // puts newest-created collections first.
          const av = a.collectionCreatedAt ?? a.firstSeenAt ?? 0;
          const bv = b.collectionCreatedAt ?? b.firstSeenAt ?? 0;
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
  }, [rows, effectiveSortKey, effectiveSortDir, mintTab, mintTf, showCnft, selectedTypes, selectedSources, selectedStatuses, tfStatsByKey, lastPriceByKey, tick, blacklistSet]);

  // Aggregate Mint Stats — collection counts for the active timeframe.
  // Observed = any collection whose lastMintAt is within the TF window

  // ── LEFT-table pause snapshot ─────────────────────────────────────
  // Mirrors the RIGHT feed's hover-pause: while hoverPaused is true,
  // the visible table reads from a frozen snapshot of `sorted` +
  // its per-row data maps so new mints don't shuffle rows under the
  // cursor. Backend / SSE / internal state keep ticking — only the
  // RENDER is frozen. User-driven sort/filter/tab/tf changes recapture
  // the snapshot immediately (filterSortKey diff), so the freeze never
  // hides a UX action. Cleared the moment pause ends.
  const filterSortKey =
    `${effectiveSortKey}|${effectiveSortDir}|${mintTab}|${mintTf}|${showCnft}|` +
    `${[...selectedTypes].sort().join(',')}|${[...selectedSources].sort().join(',')}|${[...selectedStatuses].sort().join(',')}|` +
    `${[...blacklistSet].sort().join(',')}`;
  interface MintsDisplaySnap {
    key:              string;
    sorted:           typeof sorted;
    tfStatsByKey:     typeof tfStatsByKey;
    lastPriceByKey:   typeof lastPriceByKey;
    lastPaymentByKey: typeof lastPaymentByKey;
  }
  const displaySnapshotRef = useRef<MintsDisplaySnap | null>(null);
  const displaySorted = useMemo(() => {
    if (!hoverPaused) { displaySnapshotRef.current = null; return sorted; }
    const cur = displaySnapshotRef.current;
    if (!cur || cur.key !== filterSortKey) {
      const fresh: MintsDisplaySnap = {
        key:              filterSortKey,
        sorted, tfStatsByKey, lastPriceByKey, lastPaymentByKey,
      };
      displaySnapshotRef.current = fresh;
      return fresh.sorted;
    }
    return cur.sorted;
  }, [hoverPaused, sorted, filterSortKey, tfStatsByKey, lastPriceByKey, lastPaymentByKey]);
  const frozenSnap = hoverPaused ? displaySnapshotRef.current : null;
  const displayTfStatsByKey     = frozenSnap?.tfStatsByKey     ?? tfStatsByKey;
  const displayLastPriceByKey   = frozenSnap?.lastPriceByKey   ?? lastPriceByKey;
  const displayLastPaymentByKey = frozenSnap?.lastPaymentByKey ?? lastPaymentByKey;

  /** Live mint feed — events array drives the bottom panel directly,
   *  newest first (already maintained by the SSE handler). The group
   *  imageUrl/name is looked up from `rows` at render time so freshly
   *  enriched groups update their feed thumbnails on the next React
   *  re-render without re-fetching anything. */

  return (
    <div className="feed-root page-transition" data-page="mints" data-embedded={embedded ? '1' : undefined}>
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      {/* Header — hidden in embed mode so the multi-tab pane chrome
          owns the title context. Compact vertical padding (16/8 instead
          of 20/14) to tighten the gap between the title and the table
          grid below — matches /tools' denser feel. */}
      {!embedded && (
        <div style={{ padding: '16px 4px 8px', flexShrink: 0, width: '100%', maxWidth: 'var(--mints-max, 1400px)', margin: '0 auto', alignSelf: 'center', transform: embedded ? undefined : 'translateX(10px)', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.5px' }}>
                Live mint tracker
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <LiveDot />
                <span style={{ fontSize: 11, color: rgb(VL.green) }}>
                  {(() => {
                    if (displaySorted.length === 0) return 'No active mints';
                    const active = displaySorted.filter(r => r.displayState === 'shown').length;
                    const watch  = displaySorted.length - active;
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
        // Left-column cap is a token (`--mints-table-max`, default 942px) so the
        // PC tier alone can widen the collections table; the right Live Mint
        // Feed track is the `fr` column, so it auto-shrinks by exactly the
        // amount the left cap grows (no separate right-width change needed).
        // Laptop/tablet/phone never set the token → fall back to 942px.
        gridTemplateColumns: embedded ? '1fr' : 'minmax(0, var(--mints-table-max, 942px)) minmax(420px, 0.95fr)',
        gap: 10,
        width: '100%',
        maxWidth: embedded ? 'none' : 'var(--mints-max, 1400px)',
        margin: '0 auto',
        alignSelf: embedded ? 'stretch' : 'center',
        transform: embedded ? undefined : 'translateX(10px)',
        paddingBottom: embedded ? 0 : 8,
        boxSizing: 'border-box',
      }}>
      {/* ── LEFT: Mint Collections table ─ hidden in embed mode so a
          /multi column shows ONLY the Live Mint Feed cards (right pane).
          Non-embed /mints is unchanged. ──────────────────────────────── */}
      {!embedded && (
      <div style={{
        display: 'flex', flexDirection: 'column', minHeight: 0,
        // Restore the VictoryLabs dark-purple panel identity (the v2
        // strong-pass de-saturated this to cold #15121f/#0f0c19 which
        // detached the page from the rest of the app). Original was
        // #1a1530 → #1a1530 with a loud 0.65 purple border and a 0.15
        // outer purple aura — kept the hue, trimmed the excess. New:
        // same purple gradient, border alpha 0.65 → 0.32 (half),
        // inner sheen 0.08 → 0.06, outer aura 0.15 → 0.10. Reads as
        // the same purple terminal panel /feed and /dashboard ship,
        // just with less neon ring around it.
        background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
        border: `1px solid ${alpha(VL.purpleTint,0.32)}`,
        borderRadius: 12,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep,0.10)}`,
        overflow: 'hidden',
      }}>
        {/* Header line — dense operator strip: ACTIVE/RECENT tabs + collection
            count + live dot (left), Timeframe segmented control (right). No
            "VIEW" label; tabs/count/timeframe integrated on one line so the
            filter section below stays short and the table starts high. */}
        <div style={{
          padding: '6px 12px',
          // Restore purple-tinted control strip identity (v2 ivory
          // wash detached this from the rest of the palette). Hue
          // back to purple but quieter than original (bg 0.04 → 0.025,
          // border 0.12 → 0.08) so the panel surface still reads
          // matte rather than glassy.
          borderBottom: `1px solid ${alpha(VL.purpleTint,0.08)}`,
          flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: alpha(VL.purpleTint,0.025), flexWrap: 'wrap', gap: '6px 8px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {(['active', 'recent'] as const).map(t => (
              <Pill
                key={t}
                active={mintTab === t}
                onClick={() => setMintTab(t)}
                label={t}
                style={{ padding: '3px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
                         textTransform: 'uppercase',
                         border: mintTab === t ? `1px solid ${alpha(VL.purpleTint,0.44)}` : '1px solid transparent',
                         background: mintTab === t ? alpha(VL.purpleTint,0.20) : 'transparent',
                         color: mintTab === t ? VLText.primary : VLText.muted, boxShadow: 'none' }}
              />
            ))}
            <span style={{ marginLeft: 6 }}><LiveDot /></span>
            {/* Shared PAUSED chip — same hoverPaused state as the Live
                Mint Feed header; appears here so the tracker table also
                reflects the freeze. */}
            {hoverPaused && <span style={{ marginLeft: 6 }}><PausedChip /></span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Canonical shared Settings toggle — same control as Live Feed and
                the Live Mint Feed popover. Toggles the embedded filter section
                inline (collapsed by default; not a floating popover). */}
            <SettingsToggle
              active={settingsOpen}
              onClick={() => setSettingsOpen(o => !o)}
              
            />
            {/* Old dense segmented styling (tight pills in a dark shell). */}
            <div style={{ display: 'flex', gap: 2, background: 'rgba(10,7,20,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 2 }}>
              {MINT_TIMEFRAMES.map(t => (
                <Pill
                  key={t}
                  active={mintTf === t}
                  onClick={() => setMintTf(t)}
                  label={t}
                  size="sm"
                  
                  style={{ border: mintTf === t ? `1px solid ${alpha(VL.purpleTint,0.55)}` : '1px solid transparent',
                           background: mintTf === t ? alpha(VL.purpleTint,0.22) : 'transparent' }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Embedded filter section — canonical VictoryLabs settings surface
            (.feed-filters-panel) + a semantic group (.feed-set-group + header)
            so it reads as one system with the Live Feed panel. Single column:
            the Source row carries 6 pills and needs full width to stay on one
            line — a two-column split would wrap and grow taller, so the two-
            column/divider variant of the system isn't used here. Collapsible
            inline via the header Settings toggle. State/persistence unchanged. */}
        {settingsOpen && (
          <div className="feed-filters-panel feed-filters-panel-open"
            style={{ borderTop: 'none', borderRadius: 0, padding: '7px 12px 8px' }}>
            {/* Two-column settings — mirrors /feed exactly:
                  LEFT col 1 = CONTENT (Source, Status)
                  LEFT col 2 = LISTS   (Blacklist)
                  RIGHT col  = DISPLAY (Hover toggle, spans both rows)
                Grid + divider are owned by .feed-settings /
                .feed-set-group--{content,lists,display} in globals.css —
                no new CSS introduced. */}
            <div className="feed-settings">
              {/* GROUP — CONTENT (Source + Status) */}
              <div className="feed-set-group feed-set-group--content">
                <div className="feed-set-group-hd">Content</div>
                <div className="feed-srow">
                  <span className="feed-srow-lbl">Source</span>
                  <div className="feed-srow-ctl feed-seg">
                    {SOURCE_KEYS_UI.map(s => (
                      <Pill key={s} active={selectedSources.has(s)} onClick={() => toggleSource(s)}
                        label={s} size="sm"
                        style={selectedSources.has(s) ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                    ))}
                  </div>
                </div>
                <div className="feed-srow">
                  <span className="feed-srow-lbl">Status</span>
                  <div className="feed-srow-ctl feed-seg">
                    {([['active','Active'],['watch','Watch'],['sold','Sold']] as const).map(([k,lbl]) => (
                      <Pill key={k} active={selectedStatuses.has(k)} onClick={() => toggleStatus(k)}
                        label={lbl} size="sm"
                        style={selectedStatuses.has(k) ? settingsPillActive() : SETTINGS_PILL_INACTIVE} />
                    ))}
                  </div>
                </div>
              </div>
              {/* GROUP — LISTS (Blacklist). Single blacklistSet filters
                  BOTH the LEFT tracker rows AND the RIGHT Live Mint Feed. */}
              <div className="feed-set-group feed-set-group--lists">
                <div className="feed-set-group-hd">Lists</div>
                <div className="feed-srow">
                  <span className="feed-srow-lbl">Blacklist</span>
                  <div className="feed-srow-ctl">
                    <input
                      className="feed-coll-input"
                      value={blInput}
                      onChange={(e) => setBlInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addBlacklist(blInput); }}
                      placeholder="slug, address, or name…"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Pill
                      active
                      color="#d96867"
                      onClick={() => addBlacklist(blInput)}
                      label="+"
                      
                      size="sm"
                      style={settingsPillActive('#d96867')}
                    />
                    {blacklistSlugs.map((slug) => (
                      <span key={slug} className="feed-chip feed-chip-bl">
                        <span className="feed-chip-txt">{slug}</span>
                        <button
                          type="button"
                          onClick={() => removeBlacklist(slug)}
                          
                          className="feed-chip-x"
                        >✕</button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {/* GROUP — DISPLAY (Hover toggle; spans both rows on the
                  right, divider painted by --display border-left). */}
              <div className="feed-set-group feed-set-group--display">
                <div className="feed-set-group-hd">Display</div>
                <div className="feed-srow" role="group" aria-label="Hover pause">
                  <span className="feed-srow-lbl">Hover</span>
                  <div className="feed-srow-ctl">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={hoverPauseEnabled}
                      
                      onClick={() => setHoverPauseEnabled(v => !v)}
                      className={`vl-switch${hoverPauseEnabled ? ' vl-switch-on' : ''}`}
                    >
                      <span className="vl-switch-thumb" />
                    </button>
                    <span className="feed-srow-hint">{hoverPauseEnabled ? 'On' : 'Off'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Collapsed summary — a single subtle line, shown only when the
            Settings filter section is closed AND a filter is off-default, so
            the operator sees active Source/Status without expanding. Hidden
            entirely when everything is default (no extra height in the common
            case). Subtle text only — no pill/glow. */}
        {!settingsOpen && (selectedSources.size > 0 || selectedStatuses.size > 0) && (
          <div style={{
            padding: '6px 18px', fontSize: 10, color: VLText.muted,
            letterSpacing: '0.3px', flexShrink: 0,
            borderBottom: `1px solid ${alpha(VL.purpleTint,0.08)}`,
          }}>
            Source: {selectedSources.size === 0 ? 'Any' : [...selectedSources].join(', ')}
            {' · '}Status: {selectedStatuses.size === 0 ? 'Any' : [...selectedStatuses].map(s => s === 'active' ? 'Active' : s === 'watch' ? 'Watch' : 'Sold').join(', ')}
            {' · '}Time: {mintTf}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area mints-tracker-scroll collection-table-scroll">
          <table className="collections-table" style={{
            // Table cap (COLLECTION 300 + SHOW ~216 + metrics 426 = 942):
            // aggressive first pass — raised from 834 so the flexible SHOW
            // column ~doubles (108 -> 216) and the empty band before the Live
            // Mint Feed shrinks by ~108px, bringing the table closer to its
            // pre-cap width. COLLECTION (300) and metric columns (426) unchanged;
            // surplus beyond 942 still sits to the table's right. width:100%
            // kept so narrower panes fill without extra overflow.
            // maxWidth tracks the same `--mints-table-max` token as the grid's
            // left-column cap so the table actually fills the reclaimed space on
            // PC (COLLECTION is the auto/remainder column, so it absorbs the
            // extra width — metric cols + row height/fonts unchanged). Default
            // 942px keeps laptop/tablet/phone identical.
            width: '100%', maxWidth: 'var(--mints-table-max, 942px)', borderCollapse: 'collapse', tableLayout: 'fixed',
            // Inner table-frame hairline at the row-content right edge.
            // `.scroll-area` reserves the scrollbar via `scrollbar-gutter:
            // stable`, so the table's right edge already lands just left
            // of the scrollbar lane — drawing a 1 px purple-tinted border
            // here visually clips every row inside an intentional frame
            // and explains that the gutter is OUTSIDE the table content.
            // Border absorbed by collapse + tableLayout:fixed; no row
            // width / column width / CREATED gutter regression.
            borderRight: `1px solid ${alpha(VL.purpleTint,0.08)}`,
          }}>
            {/* Explicit column widths so the COLLECTION cell stays
                wide and the right-hand metrics columns stay tight —
                without these, `tableLayout: fixed` was distributing
                the surplus width evenly and producing the spread-out
                layout. COLLECTION is auto (no width = takes the
                remainder); the others are pinned. */}
            <colgroup>
              {/* COLLECTION — fixed to its identity-content width (rank 22 +
                  img 46 + status 22 + name 100 + icons/source ~1fr + gaps +
                  padding). Sized to content, NOT the remainder, so the empty
                  area between the source badges and the metrics belongs to the
                  flexible SHOW column instead of sitting unused inside this
                  cell. Name truncation is unaffected (the name is a fixed 100px
                  grid track with ellipsis, independent of this width).
                  Width is 330 (not 300): the trailing 1fr track holds the
                  icons+source group (up to 3×13 icons + gaps + the 66 px source
                  chip ≈ 117 px). At 300 the 1fr track was only ~69 px, so the
                  chip overflowed the cell's right edge by ~48 px and collided
                  with the SHOW band. The SHOW band is right-anchored and (for a
                  sub-196 px SHOW cell) always starts ~32 px in from the cell's
                  left edge, so the chip can overflow by up to ~32 px and still
                  clear it. 330 gives a ~99 px 1fr track → ~18 px chip overflow
                  → a consistent ~14 px gap to the band at every table width,
                  while leaving SHOW ~20 px wider than 350 did (350 over-narrowed
                  SHOW). SHOW is the flexible remainder col, so this trade is
                  width-for-width — the overall table width (maxWidth 942) is
                  unchanged. */}
              <col style={{ width: 330 }} /> {/* COLLECTION (content width) */}
              {/* SHOW — flexible spacer / action zone. This is now the auto
                  (remainder) column, so it stretches to consume ALL space
                  between the COLLECTION content and the MINTS metric, giving
                  the ME-style [identity][flexible action gap][metrics] rhythm. */}
              <col /> {/* SHOW (flexible / remainder) */}
              {/* Even-spacing pass: the metric widths (78/84/84/92/88) had a
                  14 px spread that made the inter-column gaps read unevenly
                  (SUPPLY→LAST wide, LAST→PRICE narrow, PRICE→CREATED wide).
                  Flattened to a near-uniform set so the column pitch — and
                  thus the visual gaps — is consistent across MINTS…CREATED.
                  PRICE keeps +3 for its price+icon content and CREATED +3 for
                  its 18 px terminal gutter. The metric SUM is unchanged (426)
                  so the flexible SHOW column and the overall table width stay
                  exactly as before; only the internal split changed. No
                  alignment/font/padding/data changes. */}
              <col style={{ width: 84 }} /> {/* MINTS    */}
              <col style={{ width: 84 }} /> {/* SUPPLY   */}
              <col style={{ width: 84 }} /> {/* LAST     */}
              <col style={{ width: 87 }} /> {/* PRICE    */}
              <col style={{ width: 87 }} /> {/* CREATED  */}
              {/* SOURCE column removed — source badge is now rendered
                  inline inside the COLLECTION cell. The freed width
                  goes to COLLECTION (auto / remainder col). */}
            </colgroup>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,48,0.96)' }}>
                {/* COLLECTION header pads left by 13 px = 10 px (data
                    cell padding) + 3 px (data cell accent border that
                    pushes its content right by 3 px and isn't on the
                    th). Without this comp the COLLECTION label sat 3 px
                    to the left of the row content beneath it. */}
                <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 9, cursor: 'pointer', borderLeft: `1px solid ${alpha(VL.purpleTint,0.08)}` }} onClick={() => handleSortClick('collection')}>
                  COLLECTION {sortArrow(effectiveSortKey, effectiveSortDir, 'collection')}
                </th>
                {/* SHOW — empty header (action column, no label). aria-label
                    keeps the column semantic for assistive tech. */}
                <th style={thStyle} aria-label="Show in live feed" />
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('mints')}>
                  MINTS {sortArrow(effectiveSortKey, effectiveSortDir, 'mints')}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('supply')}>
                  SUPPLY {sortArrow(effectiveSortKey, effectiveSortDir, 'supply')}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSortClick('last')}>
                  LAST {sortArrow(effectiveSortKey, effectiveSortDir, 'last')}
                </th>
                {/* PRICE — latest observed mint price for the
                    collection (the most recent event's priceLamports
                    for this groupingKey). NOT an average — launchpads
                    run phased pricing (OG / WL / Public) and an
                    average would mix stages. Updates the moment a
                    new mint event with a different price arrives.
                    Sortable but not a default sort.  */}
                <th
                  
                  style={{ ...thStyle, cursor: 'pointer' }}
                  onClick={() => handleSortClick('price')}
                >
                  PRICE {sortArrow(effectiveSortKey, effectiveSortDir, 'price')}
                </th>
                {/* CREATED — backend's first-observed timestamp for this
                    collection (see MintStatus.firstSeenAt). Last column
                    on the right, so it keeps the same wider "terminal"
                    gutter the previous RATE column used; the matching td
                    in MintsTableRow uses `padding: '14px 18px 14px 10px'`
                    to honour it. Sortable. */}
                <th
                  // Centered like the other metric columns (thStyle default)
                  // so inter-column gaps read evenly; paddingRight 18 keeps the
                  // terminal gutter and matches the CREATED cell's right pad so
                  // header + value stay vertically aligned.
                  style={{ ...thStyle, paddingRight: 18, cursor: 'pointer', borderRight: `1px solid ${alpha(VL.purpleTint,0.08)}` }}
                  onClick={() => handleSortClick('created')}
                >
                  CREATED {sortArrow(effectiveSortKey, effectiveSortDir, 'created')}
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
              {displaySorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="mints-empty-primary">
                    No collections in this timeframe
                  </td>
                </tr>
              )}
              {displaySorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="mints-empty-helper">
                    Try a longer window
                  </td>
                </tr>
              )}
              {(() => { const now = Date.now(); return displaySorted.map((r, i) => (
                <MintsTableRow
                  key={`${r.groupingKey}:${r.lastMintAt}`}
                  row={r}
                  index={i}
                  now={now}
                  mintTf={mintTf}
                  tfStatsByKey={displayTfStatsByKey}
                  lastPriceByKey={displayLastPriceByKey}
                  lastPaymentByKey={displayLastPaymentByKey}
                  paymentTokens={paymentTokens}
                  // Transient hover only takes effect when nothing is pinned —
                  // a pin holds the scope regardless of mouse movement.
                  onHoverEnter={() => setHoveredKey(r.groupingKey)}
                  onHoverLeave={() => setHoveredKey(prev => prev === r.groupingKey ? null : prev)}
                  onPauseEnter={enterPauseZone}
                  onPauseLeave={leavePauseZone}
                  isPinned={pinnedKeys.has(r.groupingKey)}
                  onTogglePin={() => togglePin(r.groupingKey)}
                />
              )); })()}
            </tbody>
          </table>
        </div>
      </div>
      )}

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
          client. Shown in BOTH normal and embed mode — in a /multi
          column it is the only pane (the LEFT collections table is
          hidden in embed). */}
      {(
        <div style={{
          background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
          border: `1px solid ${alpha(VL.purpleTint,0.65)}`, borderRadius: 12,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep,0.15)}`,
          // Pane fills its grid cell vertically — minHeight: 0 lets the
          // inner scroll-area shrink to fit; overflow: hidden + the
          // inner overflowY: 'auto' keep all scrolling internal so the
          // page itself never grows with feed content.
          overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${alpha(VL.purpleTint,0.12)}`, background: alpha(VL.purpleTint,0.04), display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 4, minWidth: 0, flex: 1 }}>
              {/* Header rebuilt to share the Live Feed Sales header pattern
                  (title · live dot · count · status pill) so the LEFT and
                  RIGHT /multi columns read as one component family. Only
                  the naming is mint-specific. */}
              <h1 style={{ fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.2px', margin: 0 }}>Live Mint Feed</h1>
              <LiveDot />
              <span style={{ fontSize: 11, fontWeight: 500, color: VLText.muted, marginLeft: 4 }}>
                ({visibleEvents.length.toLocaleString()})
              </span>
              {/* PAUSED chip — shared with the LEFT Mint Tracker header
                  (single PausedChip component, single hoverPaused state).
                  Same chip shape/height as the pinned chips so the header
                  doesn't reflow when toggled. */}
              {hoverPaused && <PausedChip />}
              {/* Pinned chips — one per pinned collection. SHOW click on a
                  table row adds to this set; the × on a chip removes that
                  one without affecting the others. Wrap onto a second line
                  if many pins to keep the header compact. */}
              {[...pinnedKeys].map(k => {
                const c = rows.get(k);
                const nm = c ? (c.name?.trim() || shortKey(k)) : shortKey(k);
                return (
                  <span
                    key={`pin-${k}`}
                    onClick={() => removePin(k)}
                    
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
                      maxWidth: 160, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.3px',
                      color: '#e6def8', background: alpha(VL.purpleDeep,0.34),
                      border: `1px solid ${alpha(VL.purpleTint,0.75)}`, whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ color: rgb(VL.purpleMuted), textTransform: 'uppercase', fontSize: 9 }}>pinned</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</span>
                    <span style={{ color: rgb(VL.purpleMuted), fontWeight: 800 }}>×</span>
                  </span>
                );
              })}
              {/* Transient hover chip — only when the hovered row isn't
                  already pinned (avoid stacking a hover chip on top of an
                  identical pinned chip). */}
              {hoveredKey && !pinnedKeys.has(hoveredKey) && (() => {
                const c = rows.get(hoveredKey);
                const nm = c ? (c.name?.trim() || shortKey(hoveredKey)) : shortKey(hoveredKey);
                return (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
                    maxWidth: 160, padding: '2px 8px', borderRadius: 4,
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.3px',
                    color: VLText.muted, background: alpha(VL.purpleDeep,0.16),
                    border: `1px solid ${alpha(VL.purpleTint,0.4)}`, whiteSpace: 'nowrap',
                  }}>
                    <span style={{ color: VLText.muted, textTransform: 'uppercase', fontSize: 9 }}>hover</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</span>
                  </span>
                );
              })()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Feed Filters popover — replaces the prior cNFT ON/OFF
                  pill. Two orthogonal axes (type + source) that the
                  user toggles independently; both default to Any. The
                  popover anchors to the button via the relative wrapper
                  and closes on outside click. Active-axis count surfaces
                  on the button as "Filters · N" so the user sees the
                  filtered state without opening the popover. */}
              <FeedFiltersPopover
                selectedTypes={selectedTypes}
                selectedSources={selectedSources}
                toggleType={toggleType}
                toggleSource={toggleSource}
                activeCount={activeFeedFilterCount}
                showCnftMints={showCnftMints}
                setShowCnftMints={setShowCnftMints}
                showBulkMints={showBulkMints}
                setShowBulkMints={setShowBulkMints}
                hasBulkDeployers={bulkDeployers.size > 0}
              />
            </div>
          </div>
          <div className="scroll-area"
            /* Hover-pause is per-card now — see onPauseEnter/Leave on
               LiveMintFeedCard below. Hovering empty panel padding no
               longer triggers a pause. */
            style={{
            flex: 1, overflowY: 'auto',
            // Card-stack rhythm (mirrors /feed): inner column with a 6 px
            // gap between rows + 8 px padding so the first/last cards
            // breathe inside the panel chrome. Each row is itself a
            // bordered card via the .feed-card-style rules below.
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: '8px 8px',
            // Override the global `.scroll-area` single-edge `stable` gutter
            // (right-only → cards read tight-left / extra-right, worse once
            // the scrollbar shows). `both-edges` reserves an EQUAL gutter on
            // both inline edges so the card column stays horizontally
            // symmetric with and without a scrollbar, and never shifts when
            // it appears. Scoped inline to THIS Live Mint Feed container only
            // — the global rule (dashboard, left table, sales feed) is
            // untouched.
            scrollbarGutter: 'stable both-edges',
          }}>
            {visibleEvents.length === 0 && (
              <div style={{ textAlign: 'center', color: '#241f3b', padding: '36px 16px', fontSize: 12 }}>
                {events.length === 0
                  ? 'Waiting for individual mint events…'
                  : activeFeedFilterCount > 0
                    ? 'No mints match the current filters — open Filters to widen.'
                    : 'Waiting for individual mint events…'}
              </div>
            )}
            {/* Hover view: matching mints cluster to the top at full opacity,
                non-matching fade to ~0.15. Keyed by signature so React reorders
                (not remounts) cards when the hover partition changes — cards
                keep their size, only position + opacity shift (no layout jump). */}
            {/* In /multi embed mode the rendered card count is capped at 60
                (from LIVE_FEED_MAX 150) to cut paint cost when three feeds
                run side-by-side. State is untouched; non-embed /mints renders
                the full feedView. */}
            {(() => { const now = Date.now(); return (embedded ? feedView.slice(0, 60) : feedView).map(({ ev, dimmed }) => (
              <LiveMintFeedCard
                key={ev.signature}
                event={ev}
                group={rows.get(ev.groupingKey)}
                now={now}
                dimmed={dimmed}
                embedded={embedded}
                onPauseEnter={enterPauseZone}
                onPauseLeave={leavePauseZone}
              />
            )); })()}
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
  return <span style={{ color: rgb(VL.purpleMuted) }}>{dir === 'asc' ? '↑' : '↓'}</span>;
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
  color: VLText.muted,
  letterSpacing: '0.6px',
  // Numeric columns are centered over their fixed-width cells (COLLECTION
  // overrides back to left below). Centered header + centered value keeps
  // the label directly above the number with no oversized empty gutter.
  textAlign: 'center',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
  // Header bg moved to the sticky <tr> + a CSS rule on the thead so
  // the strip reads as one continuous rectangle across the full table
  // width (per-th bg here was making the COLLECTION cell visually
  // stop at its column boundary). Separator stays as a th-level
  // hairline so the header → body boundary is consistent.
  background: 'transparent',
  borderBottom: `1px solid ${alpha(VL.purpleTint,0.08)}`,
  textTransform: 'uppercase',
  userSelect: 'none',
};

