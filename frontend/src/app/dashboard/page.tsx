'use client';

// Soloist — Dashboard.
// Real data via the existing SSE feed (/api/events/stream). Events are stored
// in a rolling buffer, grouped by collection, and aggregated per selected
// timeframe on each render. Mock jiggle is gone; signals are derived from the
// event stream where possible, with a deterministic fallback for bid imbalance.

import { useEffect, useMemo, useState, useRef } from 'react';
import {
  COLLECTIONS_DB, Collection, FeedEvent,
  formatSol, timeAgo,
} from '@/soloist/mock-data';
import { fromBackend, fromRow } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { CollectionIcon, LiveDot, Pill, TopNav, BottomStatusBar, compressImage, rowLinkHandlers, RowLinkOverlay } from '@/soloist/shared';
import { useCollectionIcons } from '@/soloist/collection-icons';
import { isCnftDust } from '@/soloist/cnft-filter';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_STORED_EVENTS = 2000;
const INITIAL_FETCH_LIMIT = 500;
const TF_REFRESH_MS = 30_000;
/**
 * Snapshot-intake grace window for rows with null `collection_name`.
 * Rows older than this AND still unnamed are treated as legacy pre-fix noise
 * (they'll never receive a meta patch in this session) and skipped so the
 * rolling buffer prioritises post-fix usable rows. Anything newer is kept —
 * enrichment may still complete mid-session and meta-patch it into place.
 */
const LEGACY_NULL_NAME_CUTOFF_MS = 15 * 60_000;

const TIMEFRAMES = ['5M', '10M', '15M', '30M', '1H', '4H', '1D'] as const;
type Timeframe = typeof TIMEFRAMES[number];
type Tab = 'active' | 'recent';
type MktFilter = 'all' | 'me' | 'tensor';

interface LiveCollection extends Collection {
  _flash: 'up' | 'down' | null;
  _flashKey: number;
  /** Timestamp of the most recent sale inside the current timeframe window. */
  _latestTs: number;
  /** Floor (min price) in the OLDER half of the timeframe window. */
  _prevFloor: number;
  /** True when newer-half of the window has significantly more trades than older-half. */
  _spike: boolean;
  /** Mean sale price in the timeframe window. */
  _avgPrice: number;
  /** Most frequent ME slug among this collection's sales — key for the /bids lookup. */
  _meSlug: string | null;
  /** Reserved for the async collection-icon resolver (useCollectionIcons).
   *  Filled in at render time in the Dashboard component, not inside
   *  aggregate() — NFT item images must never be used as the collection icon. */
  _iconUrl: string | null;
}

/** Per-slug bid snapshot returned by /api/collections/bids. All values in SOL or null. */
interface BidSnap {
  floorSol:   number | null;
  meBidSol:   number | null;
  tnsrBidSol: number | null;
}
/**
 * Bid-imbalance triggers when the best available bid is close to (or above)
 * the floor — a signal that the collection is trading at near-floor bid
 * support. 0.97 = within 3% below floor.
 */
const BID_IMBALANCE_RATIO = 0.97;
/** Cadence for refreshing bid snapshots for currently visible slugs. */
const BIDS_REFRESH_MS = 60_000;

/** Timeframe window → ms. */
const TF_MS: Record<Timeframe, number> = {
  '5M':      5 * 60_000,
  '10M':    10 * 60_000,
  '15M':    15 * 60_000,
  '30M':    30 * 60_000,
  '1H':     60 * 60_000,
  '4H':  4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
};

/** Floor must rise by at least this fraction to show the momentum arrow. */
const MOMENTUM_THRESHOLD = 1.005;
/**
 * Any collection whose latest sale landed within this window is considered
 * "fresh" — drives the green row pulse, same visual signal the feed uses for
 * new sales. Window is short enough that the pulse feels tied to an arrival,
 * not to generic recency.
 */
const FRESH_SALE_WINDOW_MS = 6_000;
/** Spike fires when newer-half count exceeds older-half by this factor … */
const SPIKE_RATIO = 1.5;
/** … and the newer-half has at least this many events (noise floor). */
const SPIKE_MIN_NEWER = 3;

/** Cadence for refreshing per-collection 7D rollups (floor sparkline + volume bars). */
const ROLLUPS_REFRESH_MS = 5 * 60_000;

/** Render a bid value or em-dash when unavailable. */
function fmtBid(sol: number | null): string {
  if (sol == null) return '—';
  return formatSol(sol);
}

/**
 * Lowercased collection-name blacklist; mirrors NAME_BLACKLIST in
 * src/db/blacklist.ts. The dashboard ignores the `remove` SSE event, so we
 * also need to filter blacklisted names client-side once enrichment / meta
 * fills the name in (the backend deletes the row, but a card may have
 * already been added to the rolling buffer via the immediate `sale` frame).
 */
const DASHBOARD_NAME_BLACKLIST = new Set<string>([
  'collector crypt',
]);
/** Frontend-only slug blacklist — hide specific collections from the
 *  Dashboard without touching ingestion. Applied before aggregation so the
 *  slug never contributes to a row's stats. */
const DASHBOARD_SLUG_BLACKLIST = new Set<string>([
  'staratlascrew',
]);

/**
 * Group events by collection and derive tf-scoped stats.
 * Events older than the tf window are filtered out. Events with no
 * collectionName (or `'Unknown'`) are skipped to avoid a garbage bucket.
 */
function aggregate(events: FeedEvent[], tf: Timeframe, now: number): LiveCollection[] {
  const windowMs  = TF_MS[tf];
  const cutoff     = now - windowMs;
  const halfCutoff = now - windowMs / 2;

  const groups = new Map<string, FeedEvent[]>();
  for (const e of events) {
    if (!e.collectionName || e.collectionName === 'Unknown') continue;
    if (DASHBOARD_NAME_BLACKLIST.has(e.collectionName.toLowerCase())) continue;
    if (e.meCollectionSlug && DASHBOARD_SLUG_BLACKLIST.has(e.meCollectionSlug)) continue;
    if (e.ts < cutoff) continue;
    const arr = groups.get(e.collectionName);
    if (arr) arr.push(e);
    else groups.set(e.collectionName, [e]);
  }

  /** Pick the most common non-null ME slug across a collection's events. */
  function dominantSlug(evs: FeedEvent[]): string | null {
    const counts = new Map<string, number>();
    for (const e of evs) {
      const s = e.meCollectionSlug;
      if (!s) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: string | null = null, bestN = 0;
    for (const [s, n] of counts) if (n > bestN) { best = s; bestN = n; }
    return best;
  }

  const out: LiveCollection[] = [];
  for (const [name, evs] of groups) {
    let sum = 0, latestTs = 0;
    let overallMin = Infinity, newerMin = Infinity, olderMin = Infinity;
    let newerCount = 0, olderCount = 0;
    let latestEv: FeedEvent = evs[0];
    for (const e of evs) {
      sum += e.price;
      if (e.ts > latestTs) { latestTs = e.ts; latestEv = e; }
      if (e.price < overallMin) overallMin = e.price;
      if (e.ts >= halfCutoff) {
        newerCount++;
        if (e.price < newerMin) newerMin = e.price;
      } else {
        olderCount++;
        if (e.price < olderMin) olderMin = e.price;
      }
    }
    const count     = evs.length;
    const avg       = sum / count;
    const floor     = newerCount > 0 ? newerMin : overallMin;
    const prevFloor = olderCount > 0 ? olderMin : floor;
    const spike     = newerCount >= SPIKE_MIN_NEWER && newerCount > olderCount * SPIKE_RATIO;

    // Prefer the curated entry when available (carries supply / royalty / 7D arrays);
    // otherwise synthesize a stub so unknown collections still render with the
    // abbr/color the mapper already computed.
    const known = COLLECTIONS_DB.find(c => c.name === name);
    const base: Collection = known ?? {
      name,
      abbr:  latestEv.abbr,
      color: latestEv.color,
      floor,
      supply: 0,
      royalty: '—',
      trades1d: count, trades1h: count, trades10m: count,
      volume: 0, holders: 0, listings: 0,
      vol7d: [], floor7d: [],
    };

    // Fresh-sale pulse: if the latest sale in this window is very recent,
    // tag the row with _flash + a latestTs-keyed _flashKey. The parent uses
    // `col.name + ':' + col._flashKey` as the React key, so a new sale forces
    // a remount and the existing `.row-flash-up` CSS animation replays once.
    const isFresh = (now - latestTs) < FRESH_SALE_WINDOW_MS;
    out.push({
      ...base,
      trades1d: count,   // "SALES" column shows tf-scoped count
      floor,             // live floor (newer half) overrides the static seed
      _flash: isFresh ? 'up' : null,
      _flashKey: latestTs,
      _latestTs: latestTs,
      _prevFloor: prevFloor,
      _spike: spike,
      _avgPrice: avg,
      _meSlug: dominantSlug(evs),
      _iconUrl: null,                           // resolved at render time via useCollectionIcons
    });
  }
  return out;
}

// ── Sparkline SVG ────────────────────────────────────────────────────────────

/**
 * Build a smooth path using Catmull-Rom-ish midpoint cubic Béziers — each
 * segment's control points are the midpoint between neighbours, which is
 * cheap, library-free, and never overshoots the data envelope (no fake
 * peaks/troughs).
 */
function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const cx = (prev[0] + curr[0]) / 2;
    d += ` C${cx.toFixed(1)},${prev[1].toFixed(1)} ${cx.toFixed(1)},${curr[1].toFixed(1)} ${curr[0].toFixed(1)},${curr[1].toFixed(1)}`;
  }
  return d;
}

function Sparkline({ data, color = '#36b868', w = 80, h = 20 }: { data: number[]; color?: string; w?: number; h?: number }) {
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - 6) + 3;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return [x, y] as const;
  });
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={2} fill={color} opacity="0.6" />
      ))}
    </svg>
  );
}

// ── Volume Bars SVG ──────────────────────────────────────────────────────────

function VolBars({ data, color = '#36b868', w = 52, h = 20 }: { data: number[]; color?: string; w?: number; h?: number }) {
  if (!data || data.length === 0) return <svg width={w} height={h} />;
  const max = Math.max(...data);
  const sum = data.reduce((a, b) => a + b, 0);
  const barW = (w - (data.length - 1) * 2) / data.length;
  // Σ label rendered via overflow:visible above the bar canvas — keeps the
  // SVG's reserved layout box at exactly w × h so column heights don't grow,
  // while a small total drifts up into the cell's existing top padding.
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <text x={w} y={-2} fontSize="8" textAnchor="end" fill="#7a7a94" opacity="0.85" style={{ fontFamily: "'SF Mono','Fira Code',monospace" }}>
        Σ {sum >= 100 ? sum.toFixed(0) : sum.toFixed(sum >= 10 ? 1 : 2)}
      </text>
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * (h - 2));
        const x = i * (barW + 2);
        const y = h - bh;
        return <rect key={i} x={x} y={y} width={barW} height={bh} rx="1" fill={color} opacity="0.45" />;
      })}
    </svg>
  );
}

// ── Filter pill ──────────────────────────────────────────────────────────────

function FilterPill({ label }: { label: string }) {
  const [active, setActive] = useState(false);
  return <Pill active={active} onClick={() => setActive(a => !a)} label={label} size="sm" />;
}

// ── Timeframe pills ──────────────────────────────────────────────────────────

function TimeframePills({ active, onChange }: { active: Timeframe; onChange: (t: Timeframe) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'rgba(10,7,20,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 2 }}>
      {TIMEFRAMES.map(t => (
        <Pill
          key={t}
          active={active === t}
          onClick={() => onChange(t)}
          label={t}
          size="sm"
          style={{ border: active === t ? '1px solid rgba(168,144,232,0.55)' : '1px solid transparent',
                   background: active === t ? 'rgba(168,144,232,0.22)' : 'transparent' }}
        />
      ))}
    </div>
  );
}

// ── Row variants ─────────────────────────────────────────────────────────────

interface RowProps {
  col: LiveCollection;
  rank: number;
  onClick: (col: LiveCollection) => void;
  isSelected: boolean;
  bid: BidSnap | null;
  /** Link target for the collection page. `null` when the collection has no
   *  `_meSlug` — row still highlights on click but cannot be opened. */
  href: string | null;
}

/**
 * Bids more than BID_OUTLIER_RATIO × floor are dropped from the imbalance
 * check — they're typically stale single-pool quotes or attribute-traited
 * pools that don't reflect the broader collection bid. The cell still shows
 * the raw value; only the imbalance dot is suppressed.
 */
const BID_OUTLIER_RATIO = 2;

function isPlausibleBid(bid: number, floor: number): boolean {
  return bid > 0 && floor > 0 && bid <= floor * BID_OUTLIER_RATIO;
}

/** Max plausible bid triggers imbalance dot when it's within BID_IMBALANCE_RATIO of floor. */
function hasBidImbalance(col: LiveCollection, bid: BidSnap | null): boolean {
  if (!bid || col.floor <= 0) return false;
  const me   = bid.meBidSol   ?? 0;
  const tnsr = bid.tnsrBidSol ?? 0;
  const top = Math.max(
    isPlausibleBid(me,   col.floor) ? me   : 0,
    isPlausibleBid(tnsr, col.floor) ? tnsr : 0,
  );
  if (top <= 0) return false;
  return top >= col.floor * BID_IMBALANCE_RATIO;
}

function CollectionRow({ col, rank, onClick, isSelected, bid, href }: RowProps) {
  const [hovered, setHovered] = useState(false);
  const bg = isSelected ? 'rgba(128,104,216,0.08)' : hovered ? 'rgba(255,255,255,0.03)' : 'transparent';
  const volData   = col.vol7d   ?? [];
  const floorData = col.floor7d ?? [];
  // Displayed floor is the REAL marketplace floor from /api/collections/bids.
  // `col.floor` (aggregated min sale price in tf) only serves as a fallback
  // during the brief first-render window before bids resolve. Momentum arrow
  // still compares against the tf-scoped sale-price trajectory — that's the
  // "sale price rising" signal and remains useful independent of listings.
  const displayFloor = bid?.floorSol ?? col.floor;
  const hasMomentum = col.floor > col._prevFloor * MOMENTUM_THRESHOLD;
  const imbalance = hasBidImbalance(col, bid);
  // When we have a link, delegate middle/Cmd/Ctrl/Shift-click to the browser's
  // native new-tab behavior via `rowLinkHandlers`. The plain-left-click path
  // still routes through `onClick(col)` so selection + sessionStorage icon
  // handoff fire exactly as before.
  const rowHandlers = href
    ? rowLinkHandlers(href, () => onClick(col))
    : { onClick: () => onClick(col) };

  return (
    <tr
      {...rowHandlers}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={col._flash === 'up' ? 'row-flash-up' : col._flash === 'down' ? 'row-flash-down' : ''}
      style={{ background: bg, cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
    >
      {/* First cell hosts the link-overlay <a>. `<tr position: relative>` is
       *  unreliable across browsers as a containing block — if it loses
       *  effect, an `inset: 0` overlay escapes to the nearest positioned
       *  ancestor and swallows clicks on the timeframe / tab buttons, which
       *  would then route to the row onClick and navigate away. Anchoring on
       *  the <td> keeps the overlay strictly within the first cell. Whole-row
       *  middle / Cmd+click still works via the row-level rowLinkHandlers.
       */}
      <td style={{ padding: '12px 6px 12px 10px', position: 'relative' }}>
        <RowLinkOverlay href={href} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{rank}</span>
          <CollectionIcon imageUrl={col._iconUrl} color={col.color} abbr={col.abbr} size={38} />
          <span style={{ fontSize: 15, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px' }}>{col.name}</span>
        </div>
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.2px' }}>
        {col._spike && <span style={{ fontSize: 10, marginRight: 4, verticalAlign: 'middle', opacity: 1 }}>🔥</span>}
        {col.trades1d.toLocaleString()}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
        {formatSol(displayFloor)}
        {hasMomentum && <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, color: '#5ce0a0', opacity: 0.9 }}>↑</span>}
      </td>
      <td style={{ padding: '10px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {formatSol(col._avgPrice)}
      </td>
      <td style={{ padding: '10px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {imbalance && <span style={{ marginRight: 4, fontSize: 8, color: '#c9a820', opacity: 0.85, verticalAlign: 'middle' }}>●</span>}
        {fmtBid(bid?.meBidSol ?? null)}
      </td>
      <td style={{ padding: '10px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {fmtBid(bid?.tnsrBidSol ?? null)}
      </td>
      <td style={{ padding: '10px 4px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block' }}>
          <Sparkline data={floorData} color={col.color} w={64} h={18} />
        </div>
      </td>
      <td style={{ padding: '10px 8px 10px 4px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block' }}>
          <VolBars data={volData} color={col.color} w={64} h={18} />
        </div>
      </td>
    </tr>
  );
}

function RecentRow({ col, rank, onClick, isSelected, bid, href }: RowProps) {
  const [hovered, setHovered] = useState(false);
  // "ago" reflects the real latest sale; the Dashboard's nowTick (30s)
  // forces re-aggregation which re-renders this row, refreshing the label.
  const ago = timeAgo(col._latestTs);
  const volData   = col.vol7d   ?? [];
  const floorData = col.floor7d ?? [];
  const bg = isSelected ? 'rgba(128,104,216,0.08)' : hovered ? 'rgba(255,255,255,0.03)' : 'transparent';
  // See CollectionRow — real floor from /api/collections/bids, sale-min is fallback.
  const displayFloor = bid?.floorSol ?? col.floor;
  const hasMomentum = col.floor > col._prevFloor * MOMENTUM_THRESHOLD;
  const imbalance = hasBidImbalance(col, bid);
  const rowHandlers = href
    ? rowLinkHandlers(href, () => onClick(col))
    : { onClick: () => onClick(col) };

  return (
    <tr
      {...rowHandlers}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={col._flash === 'up' ? 'row-flash-up' : col._flash === 'down' ? 'row-flash-down' : ''}
      style={{ background: bg, cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
    >
      {/* See CollectionRow: overlay is anchored to the first <td>, not <tr>. */}
      <td style={{ padding: '12px 6px 12px 10px', position: 'relative' }}>
        <RowLinkOverlay href={href} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{rank}</span>
          <CollectionIcon imageUrl={col._iconUrl} color={col.color} abbr={col.abbr} size={38} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px' }}>{col.name}</div>
            <div style={{ fontSize: 10.5, color: '#877496', marginTop: 1 }}>{ago}</div>
          </div>
        </div>
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.2px' }}>
        {col._spike && <span style={{ fontSize: 10, marginRight: 4, verticalAlign: 'middle', opacity: 1 }}>🔥</span>}
        {col.trades1d.toLocaleString()}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
        {formatSol(displayFloor)}
        {hasMomentum && <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, color: '#5ce0a0', opacity: 0.9 }}>↑</span>}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {formatSol(col._avgPrice)}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {imbalance && <span style={{ marginRight: 4, fontSize: 8, color: '#c9a820', opacity: 0.85, verticalAlign: 'middle' }}>●</span>}
        {fmtBid(bid?.meBidSol ?? null)}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
        {fmtBid(bid?.tnsrBidSol ?? null)}
      </td>
      <td style={{ padding: '12px 4px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block' }}>
          <Sparkline data={floorData} color={col.color} w={64} h={18} />
        </div>
      </td>
      <td style={{ padding: '12px 8px 12px 4px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block' }}>
          <VolBars data={volData} color={col.color} w={64} h={18} />
        </div>
      </td>
    </tr>
  );
}

// ── Dashboard Page ───────────────────────────────────────────────────────────

export default function Dashboard() {
  // Read query directly off window.location to stay compatible with
  // Next's static prerender (useSearchParams would force a Suspense
  // boundary). Defaults to false on server, hydrates to the real value.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'VictoryLabs — Dashboard'; }, []);
  const [tf, setTf] = useState<Timeframe>('1H');
  const [tab, setTab] = useState<Tab>('active');
  const [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mkt, setMkt] = useState<MktFilter>('all');

  // Subtle fade on timeframe change — signals the table "snapped" to a new
  // view without layout shift. clearTimeout prevents animation stacking when
  // the user switches timeframes rapidly.
  const [tfFading, setTfFading] = useState(false);
  const tfFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTfChange = (next: Timeframe) => {
    setTf(next);
    if (tfFadeTimerRef.current) clearTimeout(tfFadeTimerRef.current);
    setTfFading(true);
    tfFadeTimerRef.current = setTimeout(() => setTfFading(false), 140);
  };
  useEffect(() => () => {
    if (tfFadeTimerRef.current) clearTimeout(tfFadeTimerRef.current);
  }, []);

  // Hydrate persisted timeframe after mount (avoids SSR/localStorage divergence).
  useEffect(() => {
    const saved = localStorage.getItem('sol-tf');
    if (saved && (TIMEFRAMES as readonly string[]).includes(saved)) setTf(saved as Timeframe);
  }, []);
  // Skip the first run of the write effect — otherwise it would fire with the
  // initial default tf ('1H') and overwrite whatever value the hydrate effect
  // just read, defeating persistence. Subsequent tf changes persist normally.
  const tfFirstWriteSkippedRef = useRef(false);
  useEffect(() => {
    if (!tfFirstWriteSkippedRef.current) {
      tfFirstWriteSkippedRef.current = true;
      return;
    }
    try { localStorage.setItem('sol-tf', tf); } catch {}
  }, [tf]);

  // Persist ACTIVE / RECENT tab with the same pattern as `tf`. Without this,
  // every refresh dropped the user back to 'active' regardless of prior pick.
  useEffect(() => {
    const saved = localStorage.getItem('sol-tab');
    if (saved === 'active' || saved === 'recent') setTab(saved);
  }, []);
  const tabFirstWriteSkippedRef = useRef(false);
  useEffect(() => {
    if (!tabFirstWriteSkippedRef.current) {
      tabFirstWriteSkippedRef.current = true;
      return;
    }
    try { localStorage.setItem('sol-tab', tab); } catch {}
  }, [tab]);

  // ── Real event stream ────────────────────────────────────────────────────
  // Rolling buffer of recent sales. On each render we aggregate into per-
  // collection stats scoped to the selected timeframe. Initial snapshot comes
  // from /api/events/latest; live deltas via SSE /api/events/stream.
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  function addEvent(ev: FeedEvent) {
    if (seenRef.current.has(ev.signature)) return;
    seenRef.current.add(ev.signature);
    setEvents(prev => {
      const next = [ev, ...prev];
      if (next.length <= MAX_STORED_EVENTS) return next;
      // Drop oldest beyond cap; also evict from seenRef so it doesn't grow unbounded.
      const trimmed = next.slice(0, MAX_STORED_EVENTS);
      for (let i = MAX_STORED_EVENTS; i < next.length; i++) {
        seenRef.current.delete(next[i].signature);
      }
      return trimmed;
    });
  }

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Exponential backoff with jitter on reconnect — caps the herd-thunder
    // pattern when the backend restarts (every connected tab would
    // otherwise hammer the just-rebooted backend on a 3 s grid).
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
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => { attempt = 0; });
      es.addEventListener('sale', (e: MessageEvent) => {
        try { addEvent(fromBackend(JSON.parse(e.data) as BackendEvent)); }
        catch { /* malformed frame — skip */ }
      });
      // Enrichment patches: fill in nftName / collectionName / meCollectionSlug
      // for events that landed with null metadata. Without this, freshly-ingested
      // sales would stay "Unknown" and never get grouped by the aggregator.
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data) as {
            mintAddress: string; signature: string;
            nftName: string | null; collectionName: string | null;
            meCollectionSlug: string | null;
          };
          setEvents(prev => prev.map(ev => {
            if (ev.signature !== m.signature && ev.mintAddress !== m.mintAddress) return ev;
            return {
              ...ev,
              mintAddress:      m.mintAddress     || ev.mintAddress,
              nftName:          m.nftName         ?? ev.nftName,
              collectionName:   m.collectionName  ?? ev.collectionName,
              meCollectionSlug: m.meCollectionSlug ?? ev.meCollectionSlug,
            };
          }));
        } catch { /* malformed frame — skip */ }
      });
      // Backend fires `remove` for rows deleted after enrichment (blacklisted
      // collections, late cNFT floor-gate). Without this listener an event
      // that landed via the earlier `sale` frame would stay in the rolling
      // buffer — blacklist filtering in aggregate() never catches it because
      // collectionName is null at sale time and no `meta` frame follows.
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (!signature) return;
          seenRef.current.delete(signature);
          setEvents(prev => prev.filter(ev => ev.signature !== signature));
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        scheduleReconnect();
      });
    };

    // Snapshot first so we have history for longer timeframes; SSE takes over after.
    // Filter out legacy pre-fix rows (null collection_name AND older than the
    // enrichment-grace cutoff) so the rolling buffer isn't dominated by rows
    // that can never be grouped. Live SSE (sale + meta) path is untouched.
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
      .finally(() => { if (!cancelled) connect(); });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  // Periodic "now" tick so the tf window slides even when no new events arrive —
  // otherwise stale events would linger in the window until the next sale.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), TF_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // ── Live bid snapshots (ME MMM pool bid + Tensor top bid) ───────────────
  // Fetch for the slugs of currently aggregated collections. Backend caches
  // per-slug for 60s so repeated polls are cheap and dashboards with identical
  // slug sets share the same origin cache.
  // Declared above `filteredEvents` because the cNFT dust gate reads
  // `bids[slug].floorSol` — TDZ if this lived at its original spot.
  const [bids, setBids] = useState<Record<string, BidSnap>>({});

  const filteredEvents = useMemo(() => {
    // cNFT dust gate — shared predicate with Live Feed. Applied pre-aggregate
    // so collections whose only events are sub-0.002-SOL-floor cNFTs drop out
    // of the Dashboard entirely (no row, no slug, no bids fetch). Lookup pulls
    // floor from the `bids` map that's already populated for every aggregated
    // slug; first pass may include a cNFT row until its floor lands, then the
    // next render filters it. Unknown floor ⇒ fail-safe, event passes.
    return events.filter(e => {
      if (isCnftDust(e, s => bids[s]?.floorSol)) return false;
      if (mkt !== 'all' && e.marketplace !== mkt) return false;
      return true;
    });
  }, [events, mkt, bids]);

  const aggregated = useMemo(() => aggregate(filteredEvents, tf, nowTick), [filteredEvents, tf, nowTick]);
  const slugList = useMemo(() => {
    const set = new Set<string>();
    for (const c of aggregated) if (c._meSlug) set.add(c._meSlug);
    return Array.from(set).sort();   // sorted so the fetch key is stable
  }, [aggregated]);
  const slugKey = slugList.join(',');

  useEffect(() => {
    if (!slugKey) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(slugKey)}`);
        if (!res.ok) return;
        const json = await res.json() as {
          bids: Record<string, { floorLamports: number | null; meBidLamports: number | null; tnsrBidLamports: number | null }>;
        };
        if (cancelled) return;
        const next: Record<string, BidSnap> = {};
        for (const [slug, v] of Object.entries(json.bids ?? {})) {
          next[slug] = {
            floorSol:   v.floorLamports   == null ? null : v.floorLamports   / 1e9,
            meBidSol:   v.meBidLamports   == null ? null : v.meBidLamports   / 1e9,
            tnsrBidSol: v.tnsrBidLamports == null ? null : v.tnsrBidLamports / 1e9,
          };
        }
        setBids(prev => ({ ...prev, ...next }));
      } catch { /* transient — retry on next interval */ }
    };
    load();
    const id = setInterval(load, BIDS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [slugKey]);

  // ── 7D rollups (floor sparkline + volume bars) ──────────────────────────
  // Keyed by collection name (not slug — rollups come from local sale_events,
  // which groups by name). Backend caches per-name for 5 min; client refreshes
  // on the same cadence. Sparse/no-history collections return empty arrays.
  const [rollups, setRollups] = useState<Record<string, { floor7d: number[]; vol7d: number[] }>>({});
  const nameList = useMemo(() => {
    const set = new Set<string>();
    for (const c of aggregated) if (c.name) set.add(c.name);
    return Array.from(set).sort();
  }, [aggregated]);
  const nameKey = nameList.join('\u0001');

  useEffect(() => {
    if (nameList.length === 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        const qs = nameList.map(n => `names=${encodeURIComponent(n)}`).join('&');
        const res = await fetch(`${API_BASE}/api/collections/rollups?${qs}`);
        if (!res.ok) return;
        const json = await res.json() as {
          rollups: Record<string, { floor7d: number[]; vol7d: number[] }>;
        };
        if (cancelled) return;
        setRollups(prev => ({ ...prev, ...(json.rollups ?? {}) }));
      } catch { /* transient — retry on next interval */ }
    };
    load();
    const id = setInterval(load, ROLLUPS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameKey]);

  // Resolve official collection icons (marketplace logos, NOT recent NFT item
  // images) for every slug in the current aggregation. Module-scoped cache in
  // the hook keeps repeated pulls cheap across re-renders.
  const iconBySlug = useCollectionIcons(slugList);

  // Merge rollups and resolved icons onto aggregated rows so sort + row
  // render see real history and the correct collection avatar.
  const aggregatedWithRollups = useMemo(() =>
    aggregated.map(c => {
      const r = rollups[c.name];
      const icon = c._meSlug ? iconBySlug[c._meSlug] ?? null : null;
      const withIcon = { ...c, _iconUrl: compressImage(icon) };
      if (!r) return withIcon;
      return { ...withIcon, floor7d: r.floor7d, vol7d: r.vol7d };
    }),
  [aggregated, rollups, iconBySlug]);

  // ── User-driven column sort ──────────────────────────────────────────────
  // When `sortCol` is null, fall back to the tab's default key (SALES for
  // ACTIVE, latestTs for RECENT). Once the user clicks any header we honour
  // their pick, preserving the current tab. First click → desc, then toggle.
  type SortKey = 'collection' | 'sales' | 'floor' | 'avg' | 'me_bid' | 'tnsr_bid' | 'floor_7d' | 'vol_7d';
  const [sortCol, setSortCol] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const handleSortClick = (col: SortKey) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };
  /** Comparable value for a row in a given column. Numeric except for COLLECTION.
   *  Missing bid data sorts as 0 → ends up last on desc and first on asc. */
  const sortValueFor = (col: LiveCollection, key: SortKey): number | string => {
    const bid = col._meSlug ? bids[col._meSlug] : null;
    switch (key) {
      case 'collection': return col.name.toLowerCase();
      case 'sales':      return col.trades1d;
      case 'floor':      return bid?.floorSol ?? col.floor;  // real marketplace floor, sale-min fallback
      case 'avg':        return col._avgPrice;
      case 'me_bid':     return bid?.meBidSol   ?? 0;
      case 'tnsr_bid':   return bid?.tnsrBidSol ?? 0;
      case 'floor_7d': {
        // Last bucket = today's floor; sort value is 0 when no history exists
        // so sparse collections land at the bottom on desc (same convention
        // as me_bid / tnsr_bid).
        const arr = col.floor7d;
        return arr && arr.length ? (arr[arr.length - 1] ?? 0) : 0;
      }
      case 'vol_7d': {
        const arr = col.vol7d;
        return arr && arr.length ? arr.reduce((a, b) => a + b, 0) : 0;
      }
    }
  };

  // ACTIVE: sort by tf-scoped trade count (desc).
  // RECENT: sort by most recent in-window sale timestamp (desc).
  // User column pick (sortCol !== null) overrides the tab default.
  //
  // Stability: numeric comparisons are NaN-coerced to 0 so a stray NaN can
  // never short-circuit the tiebreaker chain; ties cascade to _latestTs then
  // collection name (unique) — guarantees a deterministic order that doesn't
  // flicker when two rows share the primary column value.
  const numCmp = (a: number, b: number): number => {
    const da = Number.isFinite(a) ? a : 0;
    const db = Number.isFinite(b) ? b : 0;
    if (da < db) return -1;
    if (da > db) return  1;
    return 0;
  };

  const sortedCols = [...aggregatedWithRollups].sort((a, b) => {
    let primary = 0;
    if (sortCol === null) {
      primary = tab === 'recent' ? numCmp(b._latestTs, a._latestTs) : numCmp(b.trades1d, a.trades1d);
    } else {
      const sign = sortDir === 'asc' ? 1 : -1;
      const va = sortValueFor(a, sortCol);
      const vb = sortValueFor(b, sortCol);
      primary = typeof va === 'string'
        ? sign * va.localeCompare(vb as string)
        : sign * numCmp(va as number, vb as number);
    }
    if (primary !== 0) return primary;
    const tsCmp = numCmp(b._latestTs, a._latestTs);
    if (tsCmp !== 0) return tsCmp;
    return a.name.localeCompare(b.name);
  });

  /** Arrow indicator for a header — appears only on the actively-sorted column. */
  const sortArrow = (col: SortKey): string => {
    if (sortCol === col) return sortDir === 'desc' ? '↓' : '↑';
    // When no user pick, keep the existing ↓ on SALES for ACTIVE tab as visual anchor.
    if (sortCol === null && tab === 'active' && col === 'sales') return '↓';
    return '';
  };

  const handleRowClick = (col: LiveCollection) => {
    setSelected(col.name);
    // Slug is the only stable key for the dynamic /collection/[slug] route.
    // Without it (collection never enriched into ME's index) we can't open
    // the page meaningfully — keep selection for the row highlight, no nav.
    if (!col._meSlug) return;
    // Stash the currently-rendered preview image so the Collection page header
    // can show the SAME avatar on first paint — no visual jump to a different
    // NFT or initials while the page's own icon resolver warms up.
    const rawIcon = iconBySlug[col._meSlug] ?? null;
    if (rawIcon) {
      try { sessionStorage.setItem(`cp-preview:${col._meSlug}`, rawIcon); } catch { /* quota/private-mode: ignore */ }
    }
    window.location.href = `/collection/${encodeURIComponent(col._meSlug)}`;
  };

  const thStyle: React.CSSProperties = {
    padding: '11px 6px', fontSize: 10, fontWeight: 600, color: '#5a5a78',
    letterSpacing: '0.8px', textAlign: 'right', borderBottom: '1px solid rgba(168,144,232,0.12)',
    whiteSpace: 'nowrap', background: '#201a3a', position: 'sticky', top: 0, zIndex: 1,
  };

  return (
    <div
      className="feed-root"
      data-page="dashboard"
      data-embedded={embedded ? '1' : undefined}
    >
      {!embedded && <TopNav active="dashboard" />}

      {/* Header — hidden in multi-tab embed mode so the iframe can fit
          more collection rows in the same vertical space. */}
      {!embedded && (
        <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 1000, margin: '0 auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
                Trending collections
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <LiveDot />
                <span style={{ fontSize: 11, color: '#4fb67d' }}>Feed is live</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Promoted table card. In embed mode the maxWidth cap is removed
          so the card fills the iframe symmetrically (no auto-margin
          gutters that the iframe scrollbar would make look uneven). */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%',
        maxWidth: embedded ? 'none' : 1000,
        margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)',
        borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden',
        // No bottom margin in embed mode so the card sits flush with
        // the iframe edge — multi-tab pane chrome owns the spacing.
        marginBottom: embedded ? 0 : 16,
      }}>

        {/* Card header: tabs + filters + timeframe */}
        <div style={{
          padding: '7px 12px', borderBottom: '1px solid rgba(168,144,232,0.12)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(168,144,232,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {(['active', 'recent'] as const).map(t => (
              <Pill
                key={t}
                active={tab === t}
                onClick={() => setTab(t)}
                label={t}
                style={{ padding: '4px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
                         textTransform: 'uppercase',
                         border: tab === t ? '1px solid rgba(168,144,232,0.5)' : '1px solid transparent',
                         background: tab === t ? 'rgba(168,144,232,0.18)' : 'transparent' }}
              />
            ))}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 8px' }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', letterSpacing: '0.5px' }}>
              {sortedCols.length.toLocaleString()} <span style={{ color: '#3a3a52', fontWeight: 500 }}>collections</span>
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
            <TimeframePills active={tf} onChange={handleTfChange} />
          </div>
        </div>

        {/* Collapsible filters */}
        {filtersOpen && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, background: 'rgba(255,255,255,0.015)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Marketplace:</span>
              {([
                { k: 'all',    l: 'All',        c: '#a890e8' },
                { k: 'me',     l: 'Magic Eden', c: '#e87ab0' },
                { k: 'tensor', l: 'Tensor',     c: '#a890e8' },
              ] as const).map(f => (
                <Pill
                  key={f.k}
                  active={mkt === f.k}
                  color={f.c}
                  onClick={() => setMkt(f.k)}
                  label={f.l}
                  size="sm"
                />
              ))}
              <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 6px' }} />
              <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Min volume:</span>
              <FilterPill label="any" />
              <FilterPill label="100 SOL" />
              <FilterPill label="1K SOL" />
              <FilterPill label="10K SOL" />
              <div style={{ flex: 1 }} />
              <button style={{
                padding: '3px 10px', fontSize: 10, fontWeight: 600, borderRadius: 4,
                border: '1px solid rgba(92,224,160,0.4)', background: 'rgba(92,224,160,0.12)',
                color: '#5ce0a0', cursor: 'pointer',
              }}>+ Watchlist</button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="scroll-area" style={{
          flex: 1, overflow: 'auto', padding: '0 10px 8px',
          opacity: tfFading ? 0.6 : 1, transition: 'opacity 140ms ease',
        }}>
          <table className="collections-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '41%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '12%' }} />
            </colgroup>
            <thead>
              <tr>
                <th onClick={() => handleSortClick('collection')} style={{ ...thStyle, textAlign: 'left', paddingLeft: 8, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    COLLECTION {sortArrow('collection') && <span style={{ color: '#8068d8' }}>{sortArrow('collection')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('sales')} style={{ ...thStyle, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    SALES {sortArrow('sales') && <span style={{ color: '#8068d8' }}>{sortArrow('sales')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('floor')} style={{ ...thStyle, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    FLOOR {sortArrow('floor') && <span style={{ color: '#8068d8' }}>{sortArrow('floor')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('avg')} style={{ ...thStyle, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    AVG {sortArrow('avg') && <span style={{ color: '#8068d8' }}>{sortArrow('avg')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('me_bid')} style={{ ...thStyle, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    ME BID {sortArrow('me_bid') && <span style={{ color: '#8068d8' }}>{sortArrow('me_bid')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('tnsr_bid')} style={{ ...thStyle, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    TNSR BID {sortArrow('tnsr_bid') && <span style={{ color: '#8068d8' }}>{sortArrow('tnsr_bid')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('floor_7d')} style={{ ...thStyle, textAlign: 'center', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    7D FLOOR {sortArrow('floor_7d') && <span style={{ color: '#8068d8' }}>{sortArrow('floor_7d')}</span>}
                  </span>
                </th>
                <th onClick={() => handleSortClick('vol_7d')} style={{ ...thStyle, textAlign: 'center', paddingRight: 8, cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    7D VOLUME {sortArrow('vol_7d') && <span style={{ color: '#8068d8' }}>{sortArrow('vol_7d')}</span>}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedCols.map((col, i) => {
                const href = col._meSlug ? `/collection/${encodeURIComponent(col._meSlug)}` : null;
                const bid  = col._meSlug ? bids[col._meSlug] ?? null : null;
                return tab === 'active'
                  ? <CollectionRow key={col.name + ':' + col._flashKey} col={col} rank={i + 1} onClick={handleRowClick} isSelected={selected === col.name} bid={bid} href={href} />
                  : <RecentRow     key={col.name + ':' + col._flashKey} col={col} rank={i + 1} onClick={handleRowClick} isSelected={selected === col.name} bid={bid} href={href} />;
              })}
            </tbody>
          </table>
        </div>
      </div>
      {!embedded && <BottomStatusBar />}
    </div>
  );
}
