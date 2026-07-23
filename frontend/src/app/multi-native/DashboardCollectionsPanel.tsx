'use client';

// VictoryLabs — native Trending Collections panel for /multi-native.
// Compact port of /dashboard's table: same data model (ME-sourced trending +
// internal supplement, /api/tools/trending-collections polled + /api/collections/bids
// polled) and the same live-overlay math (aggregateLive), but the live
// overlay is fed from the page's SHARED sale stream (useMultiSales(), which
// itself wraps useSaleStream()) instead of opening its own EventSource — this
// is the whole point of the /multi native rework: one connection for the
// page, not one per panel. /dashboard/page.tsx is NOT touched; this is an
// independent copy trimmed for a narrow column (see drops below), not an
// extraction shared with it.
//
// Dropped vs. /dashboard (too much for a narrow embedded column — same
// judgment call MintFeedPanel.tsx documents for its own drops):
//   • ACTIVE/RECENT tabs — no tab-only sort branch; default sort is Volume.
//   • Hover sales-preview popover (fixed-position card + its own fetch/cache).
//   • Per-row ME/Tensor external-link icons.
//   • Range/sort persisted to localStorage — local state only here.
//   • Internal-source icon-fallback fetch (useCollectionIcons) — internal
//     rows without ME artwork just show the abbr avatar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollectionIcon, LiveDot, Pill,
  compressImage, rowLinkHandlers, RowLinkOverlay,
} from '@/soloist/shared';
import { collectionMeta } from '@/soloist/from-backend';
import { FeedEvent, formatSol, timeAgo } from '@/soloist/mock-data';
import { authHeaders } from '@/runtime/auth';
import { useMultiSales } from './lib/multi-sales';
import { useSaleStreamConnected } from './lib/sale-event-stream';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── ME trending DTO (mirror of dashboard/page.tsx) ──────────────────────────
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

// '5m' isn't an ME window (ME stops at 10m) — the backend synthesizes it
// from our own sale_events (see tools-trending-collections.ts's is5m
// branch), same as /dashboard.
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
const FETCH_LIMIT = 60;
/** ME's own collection_stats cache is 45s-TTL upstream — matches dashboard. */
const TRENDING_POLL_MS = 45_000;

const RANGE_MS: Record<Range, number> = {
  '5m':        5 * 60_000,
  '10m':      10 * 60_000,
  '1h':       60 * 60_000,
  '6h':   6 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
  '7d':  7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};
const LIVE_OVERLAY_RANGES = new Set<Range>(['5m', '10m', '1h', '6h']);

const MOMENTUM_THRESHOLD = 1.005;
const FRESH_SALE_WINDOW_MS = 6_000;
const SPIKE_RATIO = 1.5;
const SPIKE_MIN_NEWER = 3;
const LIVE_PULSE_MS = 45_000;
const FLOW_TINT_BUY_LEAN  = 0.75;
const FLOW_TINT_SELL_LEAN = 0.25;
const BIDS_REFRESH_MS = 60_000;
const INTERNAL_DUST_FLOOR_SOL = 0.005;
const NOW_TICK_MS = 30_000;

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

function shortDashboardName(name: string): string {
  const clean = name.trim();
  if (clean.length <= 13) return clean;
  return clean.slice(0, 12).trimEnd() + '…';
}

function fmtSol(n: number | null): string { return n == null ? '—' : formatSol(n); }
function fmtInt(n: number | null): string { return n == null ? '—' : Math.round(n).toLocaleString(); }
function fmtBid(sol: number | null): string { return sol == null ? '—' : formatSol(sol); }

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

/** Copied from dashboard/page.tsx's aggregateLive — same math, fed from the
 *  shared /multi sale stream instead of a page-local EventSource. */
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

interface BidSnap {
  floorSol: number | null;
  meBidSol: number | null;
  tnsrBidSol: number | null;
  listedCount: number | null;
  totalSupply: number | null;
}

interface MergedRow extends TrendingCollection {
  live: LiveOverlay | null;
  bid: BidSnap | null;
  avatarUrl: string | null;
}

type SortKey = 'collection' | 'floor' | 'volume' | 'sales' | 'listedPct' | 'me_bid' | 'tnsr_bid' | 'last';
const SORT_KEYS = ['collection', 'floor', 'volume', 'sales', 'listedPct', 'me_bid', 'tnsr_bid', 'last'] as const;
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
      padding: '10px 10px', fontSize: 11, fontWeight: 700,
      color: VLText.muted,
      letterSpacing: '0.6px', textAlign: align, cursor: 'pointer',
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

function Row({ row, rank }: { row: MergedRow; rank: number }) {
  const displayFloor = row.bid?.floorSol ?? row.floorSol;
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
  const rowHandlers = rowLinkHandlers(href, () => { window.location.href = href; });

  return (
    <tr
      {...rowHandlers}
      className={'dash-row mints-tracker-row tools-offer-row' + (row.live?.flash === 'up' ? ' row-flash-up' : '')}
      style={{ cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
    >
      <td style={{ padding: '12px 10px', position: 'relative' }}>
        <RowLinkOverlay href={href} />
        {/* Per-collection accent spine — same structure as /mints'
            MintsTableRow (soft bleed + base rail + solid 3px marker) so the
            two tables read as one visual family instead of /mints looking
            "thicker"/more organized than this panel. */}
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 130, background: `linear-gradient(90deg, ${color}08 0%, transparent 100%)`, pointerEvents: 'none' }} />
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: alpha(VL.purpleTint, 0.045), pointerEvents: 'none' }} />
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: color, boxShadow: `0 0 5px ${color}59`, pointerEvents: 'none' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ color: VLText.muted, fontSize: 12, fontWeight: 500, fontFamily: MONO, minWidth: 16, textAlign: 'right', flexShrink: 0 }}>{rank}</span>
          <CollectionIcon imageUrl={compressImage(row.avatarUrl)} color={color} abbr={abbr} size={34} />
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span title={name} style={{ fontSize: 15, fontWeight: 600, color: VLText.primary, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortDashboardName(name)}</span>
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
        </div>
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 14, fontWeight: 800, color: row.live ? salesTint(row.live.buyCount, row.live.sellCount) : SALES_TINT_NEUTRAL }}>
        {row.live?.spike && <span style={{ fontSize: 10, marginRight: 4 }}>🔥</span>}
        {fmtInt(row.salesCount)}
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: '#ffffff' }}>
        {fmtSol(displayFloor)}
        {hasMomentum && <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, color: rgb(VL.green) }}>↑</span>}
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: VLText.primary, fontFamily: MONO }}>
        {fmtSol(row.volumeSol)}
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 11.5, color: VLText.muted, fontWeight: 500 }}>
        {fmtBid(row.bid?.meBidSol ?? null)}
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 11.5, color: VLText.muted, fontWeight: 500 }}>
        {fmtBid(row.bid?.tnsrBidSol ?? null)}
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 11.5 }}>
        <span style={{ fontWeight: 700, color: VLText.primary, fontFamily: MONO }}>
          {displayListedPct != null ? `${(displayListedPct * 100).toFixed(1)}%` : '—'}
        </span>
      </td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontSize: 12, color: VLText.muted, fontWeight: 600, fontFamily: MONO }}>
        {fmtLastAge(row.live?.latestTs)}
      </td>
    </tr>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function DashboardCollectionsPanel() {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);

  const [rows, setRows] = useState<TrendingCollection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inFlightRef = useRef(false);

  const load = useCallback(async (r: Range, opts?: { background?: boolean }) => {
    const { background = false } = opts ?? {};
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!background) setBusy(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/tools/trending-collections?range=${encodeURIComponent(r)}&sort=volume&direction=desc&limit=${FETCH_LIMIT}`;
      const res = await fetch(url, { headers: { ...authHeaders() } });
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
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

  // ── Live overlay — SHARED sale stream, not a page-local EventSource. This
  // is the same events array <SalesFeedPanel> renders (both come from the
  // single <SaleStreamProvider> ES via <MultiSalesProvider>/useMultiSales()).
  const { events } = useMultiSales();
  const connected = useSaleStreamConnected();

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const liveBySlug = useMemo(() => aggregateLive(events, range, nowTick), [events, range, nowTick]);

  const visibleRows = useMemo(() => rows.filter(r => {
    if (r.source === 'internal' && r.floorSol != null && r.floorSol <= INTERNAL_DUST_FLOOR_SOL) return false;
    if (r.name && DASHBOARD_NAME_BLACKLIST.has(r.name.toLowerCase())) return false;
    if (DASHBOARD_SLUG_BLACKLIST.has(r.slug)) return false;
    return true;
  }), [rows]);

  // ── Bids (chunked — backend caps at 20 slugs/request; see dashboard/page.tsx). ──
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

  const merged: MergedRow[] = useMemo(() => visibleRows.map(r => ({
    ...r,
    live: liveBySlug.get(r.slug) ?? null,
    bid: bids[r.slug] ?? null,
    avatarUrl: r.image ?? null,
  })), [visibleRows, liveBySlug, bids]);

  const [sortCol, setSortCol] = useState<SortKey | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const v = window.localStorage.getItem('vl.multi.sortCol');
      return (SORT_KEYS as readonly string[]).includes(v ?? '') ? (v as SortKey) : null;
    } catch { return null; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    if (typeof window === 'undefined') return 'desc';
    try { return window.localStorage.getItem('vl.multi.sortDir') === 'asc' ? 'asc' : 'desc'; } catch { return 'desc'; }
  });
  useEffect(() => {
    try {
      if (sortCol) window.localStorage.setItem('vl.multi.sortCol', sortCol);
      else window.localStorage.removeItem('vl.multi.sortCol');
    } catch { /* noop */ }
  }, [sortCol]);
  useEffect(() => { try { window.localStorage.setItem('vl.multi.sortDir', sortDir); } catch { /* noop */ } }, [sortDir]);
  const handleSortClick = (col: SortKey) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const sortedRows = useMemo(() => [...merged].sort((a, b) => {
    let primary: number;
    if (sortCol === null) {
      primary = numCmp(b.volumeSol ?? 0, a.volumeSol ?? 0);
    } else {
      const sign = sortDir === 'asc' ? 1 : -1;
      const va = sortValueFor(a, sortCol);
      const vb = sortValueFor(b, sortCol);
      primary = typeof va === 'string' ? sign * va.localeCompare(vb as string) : sign * numCmp(va as number, vb as number);
    }
    if (primary !== 0) return primary;
    return (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
  }), [merged, sortCol, sortDir]);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
      border: `1px solid ${alpha(VL.purpleTint, 0.65)}`, borderRadius: 12,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep, 0.15)}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0, gap: 10, flexWrap: 'wrap',
        borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}`,
        background: alpha(VL.purpleTint, 0.04),
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4, minWidth: 0 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.2px', margin: 0 }}>Trending Collections</h1>
          <LiveDot color={connected ? rgb(VL.green) : rgb(VL.gold)} />
          <span style={{ fontSize: 11, fontWeight: 500, color: VLText.muted, marginLeft: 4 }}>
            {loaded && !error ? `(${sortedRows.length.toLocaleString()})` : 'Loading…'}
          </span>
        </div>
        <TimeframePills active={range} onChange={setRange} />
      </div>

      {error && (
        <div style={{ margin: '8px 14px 0', padding: '6px 10px', fontSize: 11, color: rgb(VL.red), background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5, flexShrink: 0 }}>
          {error}
        </div>
      )}

      <div className="scroll-area collection-table-scroll multi-collections-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table className="collections-table" style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '28%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '8%' }} />
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
            {!loaded && sortedRows.length === 0 && Array.from({ length: 6 }).map((_, i) => (
              <tr key={`skeleton-${i}`} className="mints-tracker-row" aria-hidden="true">
                <td colSpan={8} style={{ padding: '10px 8px' }}>
                  <div style={{ height: 12, width: `${58 - i * 6}%`, borderRadius: 4, background: 'rgba(255,255,255,0.05)' }} />
                </td>
              </tr>
            ))}
            {loaded && sortedRows.length === 0 && !busy && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: VLText.muted, padding: '48px 16px', fontSize: 12 }}>No collections for this timeframe.</td></tr>
            )}
            {sortedRows.map((row, i) => (
              <Row key={row.slug + ':' + (row.live?.flashKey ?? 0)} row={row} rank={i + 1} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
