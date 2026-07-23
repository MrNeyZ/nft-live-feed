'use client';

// VictoryLabs — Dashboard (BOARD) · merged Trending + Dashboard.
//
// Data model: Magic Eden's own pre-aggregated collection_stats (real
// official artwork, floor/volume/sales + %-changes, listed/owner/marketCap)
// via GET /api/tools/trending-collections?range=<r>, supplemented by our own
// sale_events aggregation for whatever ME's endpoint structurally misses —
// principally Tensor-only activity, which ME's own stats never count even
// for collections it otherwise recognizes (source: 'internal' rows).
//
// On top of that base, a live SSE overlay (/api/events/stream, our own
// ingestion) drives the "alive" decorations this page inherited from the
// old /dashboard: buy/sell flow tint, row-flash on new sale, live-rank
// pulse, momentum arrow, ACTIVE/RECENT tabs. That overlay is ONLY trusted
// for 10m/1h/6h — the client's rolling event buffer has genuinely complete
// coverage at those windows; for 1d/7d/30d it would silently under-count,
// so the overlay is suppressed there and ME's own pre-aggregated numbers
// stand alone (no flash/pulse/tab pair).
//
// /tools/trending is retired (redirects here) — see internal-trending-stats.ts
// for the backend supplement and tools-trending-collections.ts for the merge.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollectionIcon, LiveDot, Pill,
  compressImage, rowLinkHandlers, RowLinkOverlay,
} from '@/soloist/shared';
import { collectionMeta, fromBackend, fromRow } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { FeedEvent, formatSol, timeAgo } from '@/soloist/mock-data';
import { useCollectionIcons } from '@/soloist/collection-icons';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_STORED_EVENTS = 2000;
const INITIAL_FETCH_LIMIT = 500;
const NOW_TICK_MS = 30_000;
/** Same grace window as the old Dashboard: unnamed rows older than this
 *  never get a late meta-patch, so they're dropped rather than left as
 *  permanent "Unknown" noise in the rolling buffer. */
const LEGACY_NULL_NAME_CUTOFF_MS = 15 * 60_000;

// ── ME trending DTO (mirror of src/enrichment/me-trending-stats.ts) ─────────
interface TrendingCollection {
  slug: string;
  name: string | null;
  image: string | null;
  floorSol: number | null;
  volumeSol: number | null;
  salesCount: number | null;
  listedCount: number | null;
  totalSupply: number | null;
  listedPct: number | null;
  isCompressed: boolean | null;
  isVerified: boolean | null;
  tensorSlug: string | null;
  source: 'magic_eden' | 'internal';
}
interface TrendingResponse {
  ok: boolean;
  collections?: TrendingCollection[];
  error?: string;
  message?: string;
}

// '5m' isn't an ME window (ME stops at 10m) — the backend synthesizes it by
// borrowing ME's 10m metadata and overriding salesCount/volumeSol with a
// true 5-minute recompute from our own sale_events. See
// tools-trending-collections.ts's is5m branch.
type Range = '5m' | '10m' | '1h' | '6h' | '1d' | '7d' | '30d';
const RANGES: ReadonlyArray<{ key: Range; label: string }> = [
  { key: '5m',  label: '5M'  },
  { key: '10m', label: '10M' },
  { key: '1h',  label: '1H'  },
  { key: '6h',  label: '6H'  },
  { key: '1d',  label: '1D'  },
  { key: '7d',  label: '7D'  },
  { key: '30d', label: '30D' },
];
const DEFAULT_RANGE: Range = '1h';
const FETCH_LIMIT = 100;
/** ME's own collection_stats cache is a 45s-TTL upstream fetch — polling
 *  faster than that just re-reads a stale cache. */
const TRENDING_POLL_MS = 45_000;

const RANGE_STORAGE_KEY = 'vl.dashboard.range';
const VALID_RANGES = new Set<Range>(RANGES.map(r => r.key));

function loadSavedRange(): Range {
  if (typeof window === 'undefined') return DEFAULT_RANGE;
  try {
    const v = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (v && VALID_RANGES.has(v as Range)) return v as Range;
  } catch { /* private mode */ }
  return DEFAULT_RANGE;
}
function saveRange(r: Range): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(RANGE_STORAGE_KEY, r); } catch { /* ignore */ }
}

/** Window length (ms) per range, for the client-side live-overlay join —
 *  independent of the backend's own RANGE_WINDOW_MS (same values, different
 *  side of the wire). */
const RANGE_MS: Record<Range, number> = {
  '5m':        5 * 60_000,
  '10m':      10 * 60_000,
  '1h':       60 * 60_000,
  '6h':   6 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
  '7d':  7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};
/** The live SSE overlay (flash/pulse/flow-tint/momentum/ACTIVE-RECENT) only
 *  drives decoration for these — the client's rolling event buffer has
 *  genuinely complete coverage at these windows (5m is in fact the most
 *  reliable of all — the shortest window). Longer ranges show ME's own
 *  pre-aggregated numbers undecorated rather than a silently-partial live
 *  signal. */
const LIVE_OVERLAY_RANGES = new Set<Range>(['5m', '10m', '1h', '6h']);

const MOMENTUM_THRESHOLD = 1.005;
const FRESH_SALE_WINDOW_MS = 6_000;
const SPIKE_RATIO = 1.5;
const SPIKE_MIN_NEWER = 3;
const LIVE_PULSE_MS = 45_000;
const FLOW_TINT_BUY_LEAN  = 0.75;
const FLOW_TINT_SELL_LEAN = 0.25;
const BIDS_REFRESH_MS = 60_000;
/** source==='internal' rows have no ME editorial judgment behind them — a
 *  cNFT-dust collection dumping near-zero sales on Tensor would otherwise
 *  show up as a legitimate-looking row. Same threshold Dashboard already
 *  used (CNFT_MIN_VISIBLE_FLOOR_SOL). ME-sourced rows are never gated —
 *  that's ME's own editorial call, not ours to second-guess. */
const INTERNAL_DUST_FLOOR_SOL = 0.005;

const DASHBOARD_NAME_BLACKLIST = new Set<string>(['collector crypt']);
const DASHBOARD_SLUG_BLACKLIST = new Set<string>(['staratlascrew']);

const SALES_TINT_BUY     = '#5EF0B0';
const SALES_TINT_SELL    = '#FF6B7A';
const SALES_TINT_NEUTRAL = VLText.primary;
function salesTint(buy: number, sell: number): string {
  const total = buy + sell;
  if (total === 0) return SALES_TINT_NEUTRAL;
  const buyRatio = buy / total;
  if (buyRatio >= FLOW_TINT_BUY_LEAN)  return SALES_TINT_BUY;
  if (buyRatio <= FLOW_TINT_SELL_LEAN) return SALES_TINT_SELL;
  return SALES_TINT_NEUTRAL;
}
const MONO = "'SF Mono','Fira Code',monospace";

/** Fixed-width collection-name truncation, mirroring shortCollectionName in
 *  MintsTableRow.tsx (12-char pass-through / 11-char slice), scaled ~15%
 *  longer for this page's wider name column. Full name always kept in the
 *  cell's `title` attribute. Pairs with a fixed 140px slot so the verified/
 *  ME/Tensor badges sit at a constant x-position regardless of name length. */
function shortDashboardName(name: string): string {
  const clean = name.trim();
  if (clean.length <= 14) return clean;
  return clean.slice(0, 13).trimEnd() + '…';
}

function fmtSol(n: number | null): string { return n == null ? '—' : formatSol(n); }
function fmtInt(n: number | null): string { return n == null ? '—' : Math.round(n).toLocaleString(); }
function fmtBid(sol: number | null): string { return sol == null ? '—' : formatSol(sol); }
function fmtAgo(ms: number): string { return timeAgo(ms); }

// ── Live overlay (event-sourced decoration, short ranges only) ─────────────
interface LiveOverlay {
  buyCount: number;
  sellCount: number;
  spike: boolean;
  isLive: boolean;
  flash: 'up' | null;
  flashKey: number;
  latestTs: number;
  newerFloor: number;
  prevFloor: number;
}

function aggregateLive(events: FeedEvent[], range: Range, now: number): Map<string, LiveOverlay> {
  const out = new Map<string, LiveOverlay>();
  if (!LIVE_OVERLAY_RANGES.has(range)) return out;

  const windowMs = RANGE_MS[range];
  const cutoff = now - windowMs;
  const halfCutoff = now - windowMs / 2;

  const groups = new Map<string, FeedEvent[]>();
  for (const e of events) {
    const slug = e.meCollectionSlug;
    if (!slug) continue;
    if (e.ts < cutoff) continue;
    const arr = groups.get(slug);
    if (arr) arr.push(e); else groups.set(slug, [e]);
  }

  for (const [slug, evs] of groups) {
    let latestTs = 0, buyCount = 0, sellCount = 0;
    let overallMin = Infinity, newerMin = Infinity, olderMin = Infinity;
    let newerCount = 0, olderCount = 0;
    for (const e of evs) {
      if (e.ts > latestTs) latestTs = e.ts;
      if (e.price < overallMin) overallMin = e.price;
      if (e.ts >= halfCutoff) { newerCount++; if (e.price < newerMin) newerMin = e.price; }
      else { olderCount++; if (e.price < olderMin) olderMin = e.price; }
      if (e.side === 'sell') sellCount++; else buyCount++;
    }
    const newerFloor = newerCount > 0 ? newerMin : overallMin;
    const prevFloor  = olderCount > 0 ? olderMin : newerFloor;
    const spike = newerCount >= SPIKE_MIN_NEWER && newerCount > olderCount * SPIKE_RATIO;
    const isFresh = (now - latestTs) < FRESH_SALE_WINDOW_MS;
    out.set(slug, {
      buyCount, sellCount, spike,
      isLive: (now - latestTs) < LIVE_PULSE_MS,
      flash: isFresh ? 'up' : null,
      flashKey: latestTs,
      latestTs, newerFloor, prevFloor,
    });
  }
  return out;
}

/** Per-slug bid snapshot from /api/collections/bids. */
interface BidSnap {
  floorSol: number | null;
  meBidSol: number | null;
  tnsrBidSol: number | null;
  /** Tensor's numListed/numMints — ME's own /collections/{slug}/stats has
   *  no supply denominator at all, so Tensor is the only source with a
   *  genuine listed/supply pair. Falls back to the ME-trending-sourced
   *  listedCount/totalSupply on the base row only when Tensor has none. */
  listedCount: number | null;
  totalSupply: number | null;
}


// ── Merged row (ME/internal DTO + live overlay + resolved artwork/bid) ─────
interface MergedRow extends TrendingCollection {
  live: LiveOverlay | null;
  bid: BidSnap | null;
  avatarUrl: string | null;
}

type SortKey = 'collection' | 'floor' | 'volume' | 'sales' | 'listedPct' | 'me_bid' | 'tnsr_bid' | 'last';
type SortDir = 'asc' | 'desc';

function sortValueFor(r: MergedRow, key: SortKey): number | string {
  switch (key) {
    case 'collection': return (r.name ?? r.slug).toLowerCase();
    case 'floor':      return r.bid?.floorSol ?? r.floorSol ?? 0;
    case 'volume':     return r.volumeSol ?? 0;
    case 'sales':      return r.salesCount ?? 0;
    case 'listedPct': {
      const count  = r.bid?.listedCount ?? r.listedCount;
      const supply = r.bid?.totalSupply ?? r.totalSupply;
      return count != null && supply != null && supply > 0 ? count / supply : 0;
    }
    case 'me_bid':     return r.bid?.meBidSol ?? 0;
    case 'tnsr_bid':   return r.bid?.tnsrBidSol ?? 0;
    case 'last':       return r.live?.latestTs ?? 0;
  }
}

/** Short "time since last sale" — same tiering as mints' fmtAgeShort
 *  (MintsTableRow.tsx / lib/format.ts), no "ago" suffix. Only meaningful
 *  while the live overlay is active (10m/1h/6h); '—' otherwise. */
function fmtLastAge(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 5_000)      return 'now';
  if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 14) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function numCmp(a: number, b: number): number {
  const da = Number.isFinite(a) ? a : 0;
  const db = Number.isFinite(b) ? b : 0;
  if (da < db) return -1;
  if (da > db) return 1;
  return 0;
}

function SortTh({ label, col, sortKey, sortDir, onSort, align = 'right' }: {
  label: string; col: SortKey; sortKey: SortKey | null; sortDir: SortDir;
  onSort: (k: SortKey) => void; align?: 'left' | 'right' | 'center';
}) {
  const active = sortKey === col;
  return (
    <th onClick={() => onSort(col)} style={{
      padding: '13px 10px', fontSize: 11, fontWeight: 700,
      color: `var(--th-label-color, ${VLText.muted})`,
      letterSpacing: '0.8px', textAlign: align, cursor: 'pointer',
      borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}`, whiteSpace: 'nowrap',
      background: '#1a1530', position: 'sticky', top: 0, zIndex: 1, textTransform: 'uppercase',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start' }}>
        {label}
        {active && <span style={{ color: rgb(VL.purpleTint) }}>{sortDir === 'desc' ? '↓' : '↑'}</span>}
      </span>
    </th>
  );
}

function TimeframePills({ active, onChange }: { active: Range; onChange: (t: Range) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'rgba(10,7,20,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 2 }}>
      {RANGES.map(({ key, label }) => (
        <Pill
          key={key}
          active={active === key}
          onClick={() => onChange(key)}
          label={label}
          size="sm"
          style={{
            border: active === key ? `1px solid ${alpha(VL.purpleTint, 0.55)}` : '1px solid transparent',
            background: active === key ? alpha(VL.purpleTint, 0.22) : 'transparent',
          }}
        />
      ))}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface RowProps {
  row: MergedRow;
  rank: number;
  isSelected: boolean;
  onClick: (row: MergedRow) => void;
}

function Row({ row, rank, isSelected, onClick }: RowProps) {
  const displayFloor = row.bid?.floorSol ?? row.floorSol;
  // Tensor (via /collections/bids) over the ME-trending base row — ME's own
  // /stats has no supply denominator at all, so Tensor is the only source
  // with a genuine listed/supply pair; recompute the pct from whichever
  // pair actually won rather than reusing row.listedPct (ME-only ratio).
  const displayListedCount = row.bid?.listedCount ?? row.listedCount;
  const displayTotalSupply = row.bid?.totalSupply ?? row.totalSupply;
  const displayListedPct = displayListedCount != null && displayTotalSupply != null && displayTotalSupply > 0
    ? displayListedCount / displayTotalSupply
    : null;
  const hasMomentum = row.live != null && row.live.newerFloor > row.live.prevFloor * MOMENTUM_THRESHOLD;
  const name = row.name ?? row.slug;
  const abbr = collectionMeta(name).abbr;
  const color = collectionMeta(name).color;
  const href = `/collection/${encodeURIComponent(row.slug)}`;
  const meUrl = `https://magiceden.io/marketplace/${row.slug}`;
  const tensorUrl = `https://www.tensor.trade/trade/${row.tensorSlug ?? row.slug}`;
  const rowHandlers = rowLinkHandlers(href, () => onClick(row));

  return (
    <tr
      {...rowHandlers}
      className={
        'dash-row mints-tracker-row tools-offer-row' +
        (isSelected ? ' mints-tracker-row-selected' : '') +
        (row.live?.flash === 'up' ? ' row-flash-up' : '')
      }
      style={{ cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
    >
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', position: 'relative' }}>
        <RowLinkOverlay href={href} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span
            style={{ color: VLText.muted, fontSize: 12, fontWeight: 500, fontFamily: MONO, minWidth: 18, textAlign: 'right', flexShrink: 0 }}
          >{rank}</span>
          <CollectionIcon imageUrl={compressImage(row.avatarUrl)} color={color} abbr={abbr} size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span title={name} style={{ width: 140, flexShrink: 0, fontSize: 16, fontWeight: 600, color: VLText.primary, letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortDashboardName(name)}</span>
              {row.isCompressed && (
                <span title="Compressed NFT (cNFT)" style={{
                  flexShrink: 0, padding: '1px 5px', fontSize: 8, fontWeight: 800, letterSpacing: '0.3px',
                  borderRadius: 3, lineHeight: 1.2, color: rgb(VL.purpleTint),
                  background: alpha(VL.purpleTint, 0.12), border: `1px solid ${alpha(VL.purpleTint, 0.40)}`,
                }}>cNFT</span>
              )}
              <a href={meUrl} target="_blank" rel="noopener noreferrer" title="Open on Magic Eden"
                 onClick={e => e.stopPropagation()}
                 style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/me.png" alt="ME" width={18} height={18} draggable={false} style={{ display: 'block', borderRadius: 3 }} />
              </a>
              <a href={tensorUrl} target="_blank" rel="noopener noreferrer" title="Open on Tensor"
                 onClick={e => e.stopPropagation()}
                 style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/tensor.png" alt="Tensor" width={18} height={18} draggable={false} style={{ display: 'block', borderRadius: 3 }} />
              </a>
            </div>
            {row.live && (
              <div style={{ fontSize: 10.5, color: '#877496', marginTop: 1 }}>{fmtAgo(row.live.latestTs)}</div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 14, fontWeight: 800, color: row.live ? salesTint(row.live.buyCount, row.live.sellCount) : SALES_TINT_NEUTRAL, letterSpacing: '-0.2px' }}>
        {row.live?.spike && <span style={{ fontSize: 10, marginRight: 4, verticalAlign: 'middle' }}>🔥</span>}
        {fmtInt(row.salesCount)}
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 14, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
        {fmtSol(displayFloor)}
        {hasMomentum && <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, color: rgb(VL.green), opacity: 0.9 }}>↑</span>}
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 13, fontWeight: 700, color: VLText.primary, fontFamily: MONO }}>
        {fmtSol(row.volumeSol)}
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 11.5, color: VLText.muted, fontWeight: 500 }}>
        {fmtBid(row.bid?.meBidSol ?? null)}
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 11.5, color: VLText.muted, fontWeight: 500 }}>
        {fmtBid(row.bid?.tnsrBidSol ?? null)}
      </td>
      <td
        title={displayListedCount != null && displayTotalSupply != null ? `${fmtInt(displayListedCount)} / ${fmtInt(displayTotalSupply)} listed` : undefined}
        style={{ padding: '14px 18px 14px 10px', textAlign: 'right', fontSize: 11.5 }}
      >
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ fontWeight: 700, color: VLText.primary, fontFamily: MONO }}>
            {displayListedPct != null ? `${(displayListedPct * 100).toFixed(1)}%` : '—'}
          </span>
          {displayListedPct != null && (
            <div style={{ width: 58, height: 4, borderRadius: 2, background: alpha(VL.purpleTint, 0.14), overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, displayListedPct * 100)}%`, height: '100%', background: `linear-gradient(90deg, ${rgb(VL.purpleDeep)}, ${rgb(VL.purpleTint)})` }} />
            </div>
          )}
        </div>
      </td>
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', fontSize: 12.5, color: VLText.muted, fontWeight: 600, fontFamily: MONO }}>
        {fmtLastAge(row.live?.latestTs)}
      </td>
    </tr>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  useEffect(() => { document.title = 'Dashboard | VictoryLabs'; }, []);

  const [range, setRange] = useState<Range>(loadSavedRange);
  const [selected, setSelected] = useState<string | null>(null);

  // ── ME-sourced (+ internal-supplement) rows ──────────────────────────────
  const [rows, setRows] = useState<TrendingCollection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inFlightRef = useRef(false);

  const load = useCallback(async (r: Range, opts?: { fromClick?: boolean; background?: boolean }) => {
    const { fromClick = false, background = false } = opts ?? {};
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (fromClick) playUiConfirm();
    if (!background) setBusy(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/tools/trending-collections?range=${encodeURIComponent(r)}&sort=volume&direction=desc&limit=${FETCH_LIMIT}`;
      const res = await fetch(url, { headers: { ...authHeaders() } });
      if (res.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (res.status === 502) { setError('Magic Eden stats temporarily unavailable. Try again shortly.'); return; }
      if (!res.ok) { setError(`Failed to load — HTTP ${res.status}.`); return; }
      const body = await res.json() as TrendingResponse;
      if (!body.ok || !Array.isArray(body.collections)) { setError(body.message ?? body.error ?? 'Unexpected response.'); return; }
      setRows(body.collections);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (!background) setBusy(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [range, load]);
  useEffect(() => {
    const id = setInterval(() => void load(range, { background: true }), TRENDING_POLL_MS);
    return () => clearInterval(id);
  }, [range, load]);

  // ── Live SSE overlay ──────────────────────────────────────────────────────
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [snapshotDone, setSnapshotDone] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());

  function addEvent(ev: FeedEvent) {
    if (seenRef.current.has(ev.signature)) return;
    seenRef.current.add(ev.signature);
    setEvents(prev => {
      const next = [ev, ...prev];
      if (next.length <= MAX_STORED_EVENTS) return next;
      const trimmed = next.slice(0, MAX_STORED_EVENTS);
      for (let i = MAX_STORED_EVENTS; i < next.length; i++) seenRef.current.delete(next[i].signature);
      return trimmed;
    });
  }

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;
    const scheduleReconnect = () => {
      if (cancelled || document.hidden) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connect, base + jitter);
      attempt++;
    };

    const connect = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('open', () => { attempt = 0; });
      es.addEventListener('sale', (e: MessageEvent) => {
        try { addEvent(fromBackend(JSON.parse(e.data) as BackendEvent)); }
        catch { /* malformed frame — skip */ }
      });
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data) as {
            mintAddress: string; signature: string;
            nftName: string | null; collectionName: string | null; meCollectionSlug: string | null;
          };
          setEvents(prev => {
            const hit = prev.some(ev => ev.signature === m.signature || ev.mintAddress === m.mintAddress);
            if (!hit) return prev;
            return prev.map(ev => {
              if (ev.signature !== m.signature && ev.mintAddress !== m.mintAddress) return ev;
              return {
                ...ev,
                mintAddress: m.mintAddress || ev.mintAddress,
                nftName: m.nftName ?? ev.nftName,
                collectionName: m.collectionName ?? ev.collectionName,
                meCollectionSlug: m.meCollectionSlug ?? ev.meCollectionSlug,
              };
            });
          });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (!signature) return;
          seenRef.current.delete(signature);
          setEvents(prev => prev.filter(ev => ev.signature !== signature));
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => { es?.close(); scheduleReconnect(); });
    };

    fetch(`${API_BASE}/api/events/latest?limit=${INITIAL_FETCH_LIMIT}`)
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const nowMs = Date.now();
        for (let i = data.events.length - 1; i >= 0; i--) {
          const row = data.events[i];
          if (!row.collection_name) {
            const ageMs = nowMs - new Date(row.block_time).getTime();
            if (ageMs > LEGACY_NULL_NAME_CUTOFF_MS) continue;
          }
          addEvent(fromBackend(fromRow(row)));
        }
      })
      .catch(() => { /* snapshot failed — live stream still connects */ })
      .finally(() => { if (!cancelled) { setSnapshotDone(true); connect(); } });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const liveBySlug = useMemo(() => aggregateLive(events, range, nowTick), [events, range, nowTick]);

  // ── Filter (dust / blacklist) ──────────────────────────────────────────────
  const visibleRows = useMemo(() => {
    return rows.filter(r => {
      if (r.source === 'internal' && r.floorSol != null && r.floorSol <= INTERNAL_DUST_FLOOR_SOL) return false;
      if (r.name && DASHBOARD_NAME_BLACKLIST.has(r.name.toLowerCase())) return false;
      if (DASHBOARD_SLUG_BLACKLIST.has(r.slug)) return false;
      return true;
    });
  }, [rows]);

  // ── Live ME/Tensor bid snapshots ──────────────────────────────────────────
  // Backend caps /api/collections/bids at 20 slugs per request (silent
  // truncation past that — src/server/collection-bids.ts's
  // MAX_SLUGS_PER_REQUEST) as an upstream-fanout guard. A single request
  // with every visible slug meant collections past the 20th (alphabetical,
  // since slugKey used to be one sorted, un-chunked string) never got bid
  // data at all — and which 20 "won" shifted as the visible row set
  // changed, reading as "sometimes shows, sometimes doesn't". Chunk into
  // ≤20-slug requests instead so every visible row is actually queried;
  // the backend's per-slug 60s cache means chunking costs nothing extra
  // for slugs any other chunk/tab already warmed.
  const BIDS_CHUNK_SIZE = 20;
  const [bids, setBids] = useState<Record<string, BidSnap>>({});
  const slugList = useMemo(() => visibleRows.map(r => r.slug).sort(), [visibleRows]);
  const slugKey = slugList.join(',');

  useEffect(() => {
    if (slugList.length === 0) return;
    let cancelled = false;
    const doLoad = async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < slugList.length; i += BIDS_CHUNK_SIZE) chunks.push(slugList.slice(i, i + BIDS_CHUNK_SIZE));

      const results = await Promise.all(chunks.map(async (chunk) => {
        try {
          const res = await fetch(`${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(chunk.join(','))}`);
          if (!res.ok) return null;
          return await res.json() as {
            bids: Record<string, {
              floorLamports: number | null; meBidLamports: number | null; tnsrBidLamports: number | null;
              listedCount: number | null; totalSupply: number | null;
            }>;
          };
        } catch { return null; }
      }));
      if (cancelled) return;

      const next: Record<string, BidSnap> = {};
      for (const json of results) {
        if (!json) continue;
        for (const [slug, v] of Object.entries(json.bids ?? {})) {
          next[slug] = {
            floorSol:    v.floorLamports   == null ? null : v.floorLamports   / 1e9,
            meBidSol:    v.meBidLamports   == null ? null : v.meBidLamports   / 1e9,
            tnsrBidSol:  v.tnsrBidLamports == null ? null : v.tnsrBidLamports / 1e9,
            listedCount: v.listedCount,
            totalSupply: v.totalSupply,
          };
        }
      }
      if (Object.keys(next).length > 0) setBids(prev => ({ ...prev, ...next }));
    };
    doLoad();
    const id = setInterval(doLoad, BIDS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugKey]);

  // ── Official artwork fallback — internal-source rows only. ME-sourced rows
  // always keep ME's own real image; we never substitute a last-sale image
  // for a row that already has the official one. ──────────────────────────
  const internalSlugsNeedingIcon = useMemo(
    () => visibleRows.filter(r => r.source === 'internal' && !r.image).map(r => r.slug),
    [visibleRows],
  );
  const iconBySlug = useCollectionIcons(internalSlugsNeedingIcon);

  const merged: MergedRow[] = useMemo(() => visibleRows.map(r => ({
    ...r,
    live: liveBySlug.get(r.slug) ?? null,
    bid: bids[r.slug] ?? null,
    avatarUrl: r.image ?? (r.source === 'internal' ? iconBySlug[r.slug] ?? null : null),
  })), [visibleRows, liveBySlug, bids, iconBySlug]);

  // ── Sort ───────────────────────────────────────────────────────────────────
  const SORT_KEYS = ['collection', 'floor', 'volume', 'sales', 'listedPct', 'me_bid', 'tnsr_bid', 'last'] as const;
  const [sortCol, setSortCol] = useState<SortKey | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const v = window.localStorage.getItem('vl.dashboard.sortCol');
      return (SORT_KEYS as readonly string[]).includes(v ?? '') ? (v as SortKey) : null;
    } catch { return null; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    if (typeof window === 'undefined') return 'desc';
    try { return window.localStorage.getItem('vl.dashboard.sortDir') === 'asc' ? 'asc' : 'desc'; } catch { return 'desc'; }
  });
  useEffect(() => {
    try {
      if (sortCol) window.localStorage.setItem('vl.dashboard.sortCol', sortCol);
      else window.localStorage.removeItem('vl.dashboard.sortCol');
    } catch { /* noop */ }
  }, [sortCol]);
  useEffect(() => { try { window.localStorage.setItem('vl.dashboard.sortDir', sortDir); } catch { /* noop */ } }, [sortDir]);
  const handleSortClick = (col: SortKey) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const liveActive = LIVE_OVERLAY_RANGES.has(range);
  const sortedRows = useMemo(() => {
    return [...merged].sort((a, b) => {
      let primary = 0;
      if (sortCol === null) {
        // Default (unsorted) order always favors most-recent activity when
        // the live overlay has data to sort by — this used to be gated
        // behind a RECENT tab; ACTIVE/RECENT was removed (column sort
        // covers "most active by count" via the Sales column instead), so
        // RECENT's behavior is now just the permanent default.
        if (liveActive) primary = numCmp(b.live?.latestTs ?? 0, a.live?.latestTs ?? 0);
        else primary = numCmp(b.volumeSol ?? 0, a.volumeSol ?? 0);
      } else {
        const sign = sortDir === 'asc' ? 1 : -1;
        const va = sortValueFor(a, sortCol);
        const vb = sortValueFor(b, sortCol);
        primary = typeof va === 'string' ? sign * va.localeCompare(vb as string) : sign * numCmp(va as number, vb as number);
      }
      if (primary !== 0) return primary;
      const tsCmp = numCmp(b.live?.latestTs ?? 0, a.live?.latestTs ?? 0);
      if (tsCmp !== 0) return tsCmp;
      return (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
    });
  }, [merged, sortCol, sortDir, liveActive]);

  const handleRowClick = (row: MergedRow) => {
    setSelected(row.slug);
    if (row.avatarUrl) {
      try { sessionStorage.setItem(`cp-preview:${row.slug}`, row.avatarUrl); } catch { /* quota/private-mode: ignore */ }
    }
    window.location.href = `/collection/${encodeURIComponent(row.slug)}`;
  };

  return (
    <div className="feed-root page-transition" data-page="dashboard">
      {/* TopNav rendered persistently by Gate (anti-flash). Single-card
          structure matching /feed and /multi's DashboardCollectionsPanel —
          no separate outer page title/subtitle block; the card's own
          header bar carries the title + live count + tabs + timeframe. */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%',
        maxWidth: 'var(--dashboard-max, 1200px)', margin: '14px auto 16px',
        background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
        border: `1px solid ${alpha(VL.purpleTint, 0.65)}`, borderRadius: 12,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep, 0.15)}`,
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}`, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
          background: alpha(VL.purpleTint, 0.04),
        }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4, minWidth: 0 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.2px', margin: 0 }}>Trending Collections</h1>
            <LiveDot />
            <span style={{ fontSize: 11, fontWeight: 500, color: VLText.muted, marginLeft: 4 }}>
              {loaded && !error ? `(${sortedRows.length.toLocaleString()})` : 'Loading…'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <TimeframePills active={range} onChange={r => { setRange(r); saveRange(r); }} />
          </div>
        </div>

        {error && (
          <div style={{ margin: '8px 14px 0', padding: '8px 12px', fontSize: 12, color: rgb(VL.red), background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5, flexShrink: 0 }}>
            {error}
          </div>
        )}

        <div className="scroll-area collection-table-scroll" style={{ flex: 1, overflow: 'auto', padding: '0 0 8px' }}>
          <table className="collections-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortTh label="Collection" col="collection" sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} align="left" />
                <SortTh label="Sales"      col="sales"      sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="Floor"      col="floor"      sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="Volume"     col="volume"     sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="ME Bid"     col="me_bid"     sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="Tnsr Bid"   col="tnsr_bid"   sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="Listed"     col="listedPct"  sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
                <SortTh label="Last"       col="last"       sortKey={sortCol} sortDir={sortDir} onSort={handleSortClick} />
              </tr>
            </thead>
            <tbody>
              {!snapshotDone && !loaded && sortedRows.length === 0 && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="mints-tracker-row" aria-hidden="true">
                  <td colSpan={8} style={{ padding: '14px 12px' }}>
                    <div style={{ height: 14, width: `${62 - i * 7}%`, borderRadius: 4, background: 'rgba(255,255,255,0.05)' }} />
                  </td>
                </tr>
              ))}
              {loaded && sortedRows.length === 0 && !busy && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: VLText.muted, padding: '64px 24px', fontSize: 13 }}>No collections for this timeframe.</td></tr>
              )}
              {sortedRows.map((row, i) => (
                <Row key={row.slug + ':' + (row.live?.flashKey ?? 0)}
                     row={row} rank={i + 1}
                     isSelected={selected === row.slug} onClick={handleRowClick} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
