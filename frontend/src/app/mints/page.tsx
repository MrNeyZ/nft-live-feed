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
  const strongNftEvidence = hasImage || hasRealName || hasNonPrefixedCollection;

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
/** Hard expiry for stored individual mint events. Bumped to 6 hours
 *  per spec so the persistent feed survives longer absences ("came
 *  back from lunch") while still aging out genuinely stale rows. */
const FEED_TTL_MS         = 6 * 60 * 60_000;       // 6 hours
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
    const cutoff = Date.now() - FEED_TTL_MS;
    const out: MintEvent[] = [];
    const seen = new Set<string>();
    let staleSkipped = 0;
    for (const v of parsed) {
      if (!v || typeof v !== 'object')                     continue;
      const ev = v as MintEvent;
      if (typeof ev.signature !== 'string')                continue;
      if (typeof ev.receivedAt !== 'number')               continue;
      if (ev.receivedAt < cutoff)                          { staleSkipped++; continue; }
      if (seen.has(ev.signature))                          continue;
      seen.add(ev.signature);
      out.push(ev);
      if (out.length >= LIVE_FEED_MAX) break;
    }
    if (process.env.NODE_ENV !== 'production') {
      // Diagnostic for the "feed disappears after refresh" report.
      // `parsedLen` shows what was on disk; `count` is what survived
      // shape + TTL filtering; `staleSkipped` distinguishes a wiped
      // store (parsedLen=0) from a 6h-aged-out store (staleSkipped>0).
      console.debug('[mints/cache] restored feed', out.length, {
        parsedLen: parsed.length, staleSkipped,
      });
    }
    return out;
  } catch {
    try { window.localStorage.removeItem(FEED_STORAGE_KEY); } catch { /* fail silent */ }
    return [];
  }
}

function savePersistedFeed(events: MintEvent[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Defensive: trim again on write so a spec drift in the in-memory
    // cap can't blow up the stored payload.
    const cutoff = Date.now() - FEED_TTL_MS;
    const slice  = events.filter(e => e.receivedAt >= cutoff).slice(0, LIVE_FEED_MAX);
    window.localStorage.setItem(FEED_STORAGE_KEY, JSON.stringify(slice));
  } catch { /* quota / private mode — fail silent */ }
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

/** Outbound link target for launchpad source badges. Returns null for
 *  sources where we can't safely build a per-collection deep link —
 *  the badge then renders as a plain pill (no anchor). LMNFT requires
 *  per-row owner + collectionId from the wire; vvv.so currently has
 *  no per-collection URL pattern, so it points at the platform root. */
function sourceHref(row: MintStatus): string | null {
  switch (row.sourceLabel) {
    case 'LaunchMyNFT':
      // Build the per-collection mint page when we have the LMNFT
      // owner + collectionId fields. Falls through to null (plain
      // pill, no link) when either is missing — never the homepage,
      // per the targeted-mode spec.
      return buildLaunchMyNftUrl(row);
    case 'VVV':
      return 'https://vvv.so/';
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

type SortKey = 'velocity' | 'mints';
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
   *  Stored payload is filtered by FEED_TTL_MS + deduped by signature
   *  inside loadPersistedFeed(). */
  const [events, setEvents]   = useState<MintEvent[]>(() => loadPersistedFeed());
  // Mirror of `events` for synchronous reads from event listeners
  // (mint_meta needs to find the groupingKey by signature without
  // racing setEvents's async batched update).
  const eventsRef = useRef<MintEvent[]>(events);
  useEffect(() => { eventsRef.current = events; }, [events]);
  const [sortKey, setSortKey] = useState<SortKey>('velocity');
  const [, force]             = useState(0);

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
  // never drops anything from localStorage. cNFTs land with
  // programSource='bubblegum'; everything else is shown unconditionally.
  const visibleEvents = useMemo(
    () => showCnft ? events : events.filter(ev => ev.programSource !== 'bubblegum'),
    [events, showCnft],
  );

  // Self-tick so velocity / lastMint columns refresh smoothly between
  // backend status frames (every 5s here vs. 30s sweep on backend).
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 5_000);
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
    savePersistedFeed(events);
  }, [events]);

  // Periodic TTL eviction for the persisted live feed. Without this,
  // an idle tab whose user comes back after >45 min would still show
  // events from before the absence — load() filters them on mount but
  // an already-mounted page wouldn't rotate them out otherwise. 60 s
  // cadence is fine: events go quiet visually via the row's "Xs ago"
  // tier well before the eviction; this just clears the buffer.
  useEffect(() => {
    const id = setInterval(() => {
      setEvents(prev => {
        if (prev.length === 0) return prev;
        const cutoff = Date.now() - FEED_TTL_MS;
        // Cheap path: tail is freshest? skip filter. (events are stored
        // newest-first, so the LAST element is the oldest.)
        if (prev[prev.length - 1].receivedAt >= cutoff) return prev;
        const next = prev.filter(e => e.receivedAt >= cutoff);
        if (next.length === prev.length) return prev;
        return next;
        // Persistence handled by the events-watcher effect above.
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

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
    const connect = () => {
      if (cancelled) return;
      sseStatusRef.current = 'connecting';
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('open', () => {
        sseStatusRef.current = 'open';
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
            savePersistedCollections(next);
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
            const next = [ev, ...prev];
            // Hard cap at LIVE_FEED_MAX. When the buffer would
            // overflow, drop EVERYTHING except the just-arrived
            // event — the operator gets a clean slate at the cap
            // instead of an opaque sliding-window trim that quietly
            // hides older rows. The on-screen counter resets to 1,
            // making the wipe visible. Below the cap we just prepend
            // newest-first.
            // Wipe at-or-above the cap so the buffer never displays a
            // permanent "150 recent · max 150" shelf. Previously gated
            // by `>`, which meant the wipe only fired on the 151st
            // insert — if traffic stalled at exactly 150 events, the
            // counter sat there indefinitely. `>=` fires on the
            // insert that WOULD bring the buffer to the cap, dropping
            // the prior 149 + the new event collapses to just `[ev]`.
            const trimmed = next.length >= LIVE_FEED_MAX ? [ev] : next;
            if (next.length >= LIVE_FEED_MAX) {
              console.log(`[mints/live] cap reached (${LIVE_FEED_MAX}) — feed cleared`);
            }
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
            savePersistedCollections(next);
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
              savePersistedCollections(next);
              return next;
            });
          }
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        sseStatusRef.current = 'error';
        console.warn('[sse/mints] connection error — retrying in 2s');
        es?.close();
        if (!cancelled) setTimeout(connect, 2_000);
      });
    };
    connect();
    return () => { cancelled = true; es?.close(); };
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
  const sorted = useMemo(() => {
    const now    = Date.now();
    const tfMs   = MINT_TF_MS[mintTf];
    const cutoff = now - tfMs;
    let arr = Array.from(rows.values())
      .filter(r => r.displayState !== 'cooled')
      // Final-render safety net — a row that slipped past load /
      // SSE filters (e.g. mutated mid-session by patchAccumulatorMeta)
      // still gets dropped here before it paints.
      .filter(r => isRenderableMintStatus(r));

    if (mintTab === 'recent') {
      // RECENT view — flatten the shown/watch tiering and only show
      // collections whose most recent mint falls inside the chosen
      // timeframe window. Sort strictly by recency.
      arr = arr.filter(r => r.lastMintAt >= cutoff);
      arr.sort((a, b) => b.lastMintAt - a.lastMintAt || b.v60 - a.v60);
      return arr;
    }

    // ACTIVE — preserve the existing two-tier sort (shown first, then
    // watch), but still respect the timeframe filter so an idle 25h-old
    // row doesn't sit on top when the user picked 5M.
    arr = arr.filter(r => r.lastMintAt >= cutoff);
    arr.sort((a, b) => {
      const aShown = a.displayState === 'shown' ? 0 : 1;
      const bShown = b.displayState === 'shown' ? 0 : 1;
      if (aShown !== bShown) return aShown - bShown;
      // Same tier:
      if (a.displayState === 'shown') {
        if (sortKey === 'velocity') {
          return b.v60 - a.v60 || b.observedMints - a.observedMints;
        }
        return b.observedMints - a.observedMints || b.v60 - a.v60;
      }
      // WATCH tier — newest mint first, then v60.
      return b.lastMintAt - a.lastMintAt || b.v60 - a.v60;
    });
    return arr;
  }, [rows, sortKey, mintTab, mintTf]);

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
        <div style={{ padding: '16px 4px 8px', flexShrink: 0, width: '100%', maxWidth: 1400, margin: '0 auto', boxSizing: 'border-box' }}>
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
        maxWidth: embedded ? 'none' : 1400,
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
                  style={{ border: mintTf === t ? '1px solid rgba(168,144,232,0.55)' : '1px solid transparent',
                           background: mintTf === t ? 'rgba(168,144,232,0.22)' : 'transparent' }}
                />
              ))}
            </div>
          </div>
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

        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
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
              <col style={{ width: 110 }} /> {/* MINTED   */}
              <col style={{ width: 100 }} /> {/* SUPPLY   */}
              <col style={{ width: 110 }} /> {/* LAST     */}
              <col style={{ width: 90 }}  /> {/* MINT/MIN */}
              <col style={{ width: 120 }} /> {/* SOURCE   */}
            </colgroup>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,50,0.95)' }}>
                {/* COLLECTION header pads left by 13 px = 10 px (data
                    cell padding) + 3 px (data cell accent border that
                    pushes its content right by 3 px and isn't on the
                    th). Without this comp the COLLECTION label sat 3 px
                    to the left of the row content beneath it. */}
                <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 13 }} onClick={() => setSortKey('mints')}>
                  COLLECTION
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('mints')}>
                  MINTS {sortKey === 'mints' && <span style={{ color: '#8068d8' }}>↓</span>}
                </th>
                {/* MINTED — total minted on-chain so far (DAS-indexed
                    asset count for the collection). Distinct from
                    MINTS (session-only observation count) and from
                    SUPPLY (planned cap). Renders MINTED / SUPPLY when
                    both are known so progress is readable at a
                    glance. */}
                <th style={thStyle}>MINTED</th>
                <th style={thStyle}>SUPPLY</th>
                <th style={thStyle}>LAST MINT</th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('velocity')}>
                  MINT/MIN {sortKey === 'velocity' && <span style={{ color: '#8068d8' }}>↓</span>}
                </th>
                {/* SOURCE data cell uses paddingRight: 12 (vs the
                    default 8 in thStyle). Match it so the SOURCE label
                    sits directly above the LMNFT pill. */}
                <th style={{ ...thStyle, paddingRight: 12 }}>SOURCE</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: '#55556e', padding: '48px 0 12px', fontSize: 13 }}>
                    Waiting for active mints…
                  </td>
                </tr>
              )}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: '#3a3a52', padding: '0 24px 48px', fontSize: 11.5, lineHeight: 1.5 }}>
                    Collections appear here as soon as a mint is detected
                    (WATCH); they upgrade to ACTIVE on burst (≥ 8 mints / 60 s)
                    or 50 cumulative mints.
                  </td>
                </tr>
              )}
              {sorted.map((r, i) => {
                const displayName = r.name ?? shortKey(r.groupingKey);
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
                    className={isFreshMint ? 'row-flash-up' : undefined}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      transition: 'background 0.12s',
                      // SOLD rows render at full opacity — definitive
                      // state, not a "less interesting" one to dim.
                      opacity: isSoldOut ? 1 : (isActive ? 1 : 0.78),
                    }}
                  >
                    {/* COLLECTION cell — matches Dashboard rows:
                        12px vertical padding (up from /mints' previous
                        compact 8px to align with /dashboard rhythm),
                        38 px ItemThumb, 15 px name. Left accent stripe
                        (3 px, deterministic per collectionAddress) so
                        rows from the same collection are visually
                        grouped at a glance. */}
                    <td style={{ padding: '12px 6px 12px 10px', verticalAlign: 'middle', borderLeft: `3px solid ${accentColor}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{i + 1}</span>
                        <ItemThumb
                          imageUrl={thumb64(r.imageUrl ?? null)}
                          color={colorForCollection(r.collectionAddress ?? r.groupingKey)}
                          abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()}
                          size={38}
                        />
                        <span style={{ fontSize: 15, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
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
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {r.observedMints.toLocaleString()}
                    </td>
                    {/* MINTED cell — backend-resolved total minted on
                        chain (DAS-indexed). When known and supply is
                        also known we paint a percent fill behind the
                        number (red 95–100%, amber 60–95%, neutral
                        below) so progress to sold-out is readable at a
                        glance. Falls back to "—" when DAS hasn't
                        resolved yet. */}
                    {(() => {
                      const minted   = typeof r.mintedCount === 'number' ? r.mintedCount : null;
                      const supply   = typeof r.maxSupply   === 'number' && r.maxSupply > 0 ? r.maxSupply : null;
                      const pct      = (minted != null && supply != null) ? Math.min(100, (minted / supply) * 100) : null;
                      const cellColor = pct == null
                        ? '#aaaabf'
                        : pct >= 80 ? '#ef7878'
                        : pct >= 60 ? '#c7b479'
                        : '#aaaabf';
                      const tooltip = minted == null
                        ? 'On-chain minted count not yet resolved — DAS lookup pending'
                        : supply != null
                          ? `${minted.toLocaleString()} of ${supply.toLocaleString()} minted (${pct!.toFixed(0)}%)`
                          : `${minted.toLocaleString()} minted on chain so far`;
                      return (
                        <td
                          title={tooltip}
                          style={{
                            position: 'relative',
                            padding: '12px 8px', textAlign: 'right', verticalAlign: 'middle',
                            fontSize: 13, color: cellColor, fontWeight: 700,
                            fontFamily: "'SF Mono','Fira Code',monospace",
                            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                          }}
                        >
                          {/* Background fill — left-aligned, height
                              matches text band, fades from the cell's
                              tier color so the bar reads as a "fill"
                              not a "highlight". */}
                          {pct != null && (
                            <span
                              aria-hidden
                              style={{
                                position: 'absolute', left: 0, top: 6, bottom: 6,
                                width: `${pct}%`,
                                background: pct >= 80
                                  ? 'rgba(239,120,120,0.10)'
                                  : pct >= 60
                                    ? 'rgba(199,180,121,0.10)'
                                    : 'rgba(168,144,232,0.06)',
                                borderRadius: 2,
                                pointerEvents: 'none',
                              }}
                            />
                          )}
                          <span style={{ position: 'relative' }}>
                            {minted == null ? '—' : minted.toLocaleString()}
                          </span>
                        </td>
                      );
                    })()}
                    <td
                      title={
                        typeof r.maxSupply === 'number' && r.maxSupply > 0
                          ? `Max supply for this collection`
                          : `Max supply unavailable — observed ${r.observedMints.toLocaleString()} mint(s)`
                      }
                      style={{ padding: '12px 8px', textAlign: 'right', verticalAlign: 'middle', fontSize: 12.5, color: '#aaaabf', fontWeight: 600, fontFamily: "'SF Mono','Fira Code',monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                    >
                      {typeof r.maxSupply === 'number' && r.maxSupply > 0
                        ? r.maxSupply.toLocaleString()
                        : '—'}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', verticalAlign: 'middle', fontSize: 11.5, color: '#5e5e78', fontWeight: 500, whiteSpace: 'nowrap' }}>
                      {fmtAge(r.lastMintAt)}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 700, color: '#5ce0a0', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {r.v60.toFixed(0)}
                    </td>
                    <td style={{ padding: '12px 12px 12px 8px', textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                      {(() => {
                        const sb = sourceBadge(r.sourceLabel);
                        const href = sourceHref(r);
                        const pillStyle: React.CSSProperties = {
                          display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                          background: sb.bg, color: sb.fg, letterSpacing: '0.3px',
                          textDecoration: 'none', cursor: href ? 'pointer' : 'default',
                        };
                        // Tooltip explains why the pill isn't clickable for
                        // LMNFT today (no per-collection URL we can build
                        // from the wire fields). Avoids the "looks dead"
                        // perception. Other unlinked sources just show
                        // their label as the tooltip.
                        const plainTitle = r.sourceLabel === 'LaunchMyNFT'
                          ? 'LaunchMyNFT mint page unavailable'
                          : r.sourceLabel;
                        return href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" title={r.sourceLabel} style={pillStyle}>{sb.label}</a>
                        ) : (
                          <span title={plainTitle} style={pillStyle}>{sb.label}</span>
                        );
                      })()}
                    </td>
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
                  ? 'Hiding cNFT mints — click to show'
                  : 'Showing cNFT mints — click to hide'}
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
              return (
                <div
                  key={ev.signature}
                  // `mints-feed-row-fresh` adds a one-shot slide-in +
                  // green flash on the first paint of a freshly-arrived
                  // SSE mint event. Predicate is evaluated once per
                  // render: cache-restored events have an old
                  // `receivedAt` (set when the SSE first delivered them
                  // in a prior session), so they fail the 2.5 s window
                  // and never animate. New SSE arrivals stamp
                  // `receivedAt = Date.now()` in the `mint` listener,
                  // so they pass the window exactly once.
                  className={
                    'mints-feed-row' +
                    (Date.now() - ev.receivedAt < 2500 ? ' mints-feed-row-fresh' : '')
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
                        fontSize: 11, color: '#7a7a94', fontWeight: 500,
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
                    {/* Minter wallet — same compact styling as the
                        seller/buyer rows in /feed (mono, 10.5 px,
                        muted). Hidden when the field isn't on the
                        wire (some replays / cNFT paths). */}
                    {ev.minter && (
                      <div style={{ fontSize: 10.5, color: '#55556e', fontFamily: "'SF Mono','Fira Code',monospace", marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span>minter:</span>
                        <span>{shortMint(ev.minter)}</span>
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

const thStyle: React.CSSProperties = {
  padding: '10px 8px',
  fontSize: 9.5,
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
