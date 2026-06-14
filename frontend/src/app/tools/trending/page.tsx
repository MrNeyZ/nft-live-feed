'use client';

// VictoryLabs — Tools › Trending Collections (v1).
// Read-only leaderboard over our backend's ME pre-aggregated stats proxy.
// Data: GET /api/tools/trending-collections?range=<r>&sort=volume&direction=desc&limit=100
// No wallet, no signing, no DB writes. Layout/UX references the Magic Eden
// trending table (timeframe pills + compact ranked rows) but adopts the
// VictoryLabs palette/tokens — no ME branding, logos, or pink chrome.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, ItemThumb, compressImage } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// Mirror of backend DTO (src/enrichment/me-trending-stats.ts → TrendingCollection).
interface TrendingCollection {
  slug: string;
  name: string | null;
  image: string | null;
  floorSol: number | null;
  topOfferSol: number | null;
  volumeSol: number | null;
  salesCount: number | null;
  floorPctChange: number | null;
  volumePctChange: number | null;
  salesPctChange: number | null;
  listedCount: number | null;
  totalSupply: number | null;
  listedPct: number | null;
  ownerCount: number | null;
  uniqueOwnerRatio: number | null;
  isCompressed: boolean | null;
  isVerified: boolean | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  source: 'magic_eden';
  range: string;
}

interface TrendingResponse {
  ok: boolean;
  source?: string;
  range?: string;
  count?: number;
  collections?: TrendingCollection[];
  error?: string;
  message?: string;
}

type Range = '10m' | '1h' | '6h' | '1d' | '7d' | '30d';
const RANGES: ReadonlyArray<{ key: Range; label: string }> = [
  { key: '10m', label: '10M' },
  { key: '1h',  label: '1H'  },
  { key: '6h',  label: '6H'  },
  { key: '1d',  label: '1D'  },
  { key: '7d',  label: '7D'  },
  { key: '30d', label: '30D' },
];
const DEFAULT_RANGE: Range = '1d';
const FETCH_LIMIT = 100;

// Persist the selected timeframe so returning to the page (after navigating
// away) restores the last choice instead of snapping back to the default.
const RANGE_STORAGE_KEY = 'victorylabs:tools-trending:range';
const VALID_RANGES = new Set<Range>(RANGES.map(r => r.key));

/** Read the saved range, falling back to DEFAULT_RANGE when absent/invalid or
 *  when localStorage is unavailable (SSR / private mode). */
function loadSavedRange(): Range {
  if (typeof window === 'undefined') return DEFAULT_RANGE;
  try {
    const v = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (v && VALID_RANGES.has(v as Range)) return v as Range;
  } catch { /* private mode — ignore */ }
  return DEFAULT_RANGE;
}

function saveRange(r: Range): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(RANGE_STORAGE_KEY, r); } catch { /* ignore */ }
}

const MONO = "'SF Mono','Fira Code',monospace";

/** SOL formatter that tolerates the DTO's nullable numbers. */
function fmtSol(n: number | null): string {
  return n == null ? '—' : formatSol(n);
}

/** Integer counts (sales, listed, supply) with thousands separators. */
function fmtInt(n: number | null): string {
  return n == null ? '—' : Math.round(n).toLocaleString();
}

/** Percent-change cell value + color. Positive = green, negative = red,
 *  zero/missing = muted. Mirrors the green/red money palette used across
 *  /feed and /mints (#7ed9a8 / #d97c7c). */
function pctMeta(n: number | null): { text: string; color: string } {
  if (n == null || !Number.isFinite(n)) return { text: '—', color: '#56566e' };
  const rounded = Math.abs(n) < 0.05 ? 0 : n;
  if (rounded === 0) return { text: '0%', color: '#7a7a94' };
  const sign = rounded > 0 ? '+' : '';
  return {
    text: `${sign}${rounded.toFixed(1)}%`,
    color: rounded > 0 ? '#7ed9a8' : '#d97c7c',
  };
}

function PctCell({ value }: { value: number | null }) {
  const m = pctMeta(value);
  return <span style={{ color: m.color, fontWeight: 700 }}>{m.text}</span>;
}

/** Right-aligned sortable column header. Shows ↓/↑ on the active column (accent
 *  purple) and a faint ↕ affordance on the rest. No layout change vs the plain
 *  <th> — just an added glyph + click handler. */
function SortTh({ label, col, sortKey, sortDir, onSort }: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      data-uisnd="skip"
      style={{
        ...thStyleNum,
        cursor: 'pointer',
        color: active ? '#f0ebff' : '#56566e',
        fontWeight: active ? 800 : thStyleNum.fontWeight,
        // Strong-but-non-layout active cue: opaque-safe accent gradient + an
        // inset bottom bar (no border-box growth, so th height is unchanged).
        background: active
          ? 'linear-gradient(180deg, rgba(128,104,216,0.30) 0%, rgba(128,104,216,0.15) 100%), rgba(28,22,48,0.98)'
          : thStyle.background,
        boxShadow: active ? 'inset 0 -2px 0 #a890e8' : undefined,
      }}
    >
      {label}
      <span style={{ marginLeft: 6, color: active ? '#a890e8' : '#3a3a52', fontWeight: 800 }}>
        {active ? (sortDir === 'desc' ? '↓' : '↑') : '↕'}
      </span>
    </th>
  );
}

// ── Client-side sort ────────────────────────────────────────────────────────
// Sortable columns map to a numeric accessor on the DTO. Default is volume
// desc (matches the backend's own ordering). Nulls always sink to the bottom
// regardless of direction so missing-data rows never crowd the top.
type SortKey = 'floor' | 'topOffer' | 'floorPct' | 'volume' | 'sales' | 'listedPct';
type SortDir = 'asc' | 'desc';

const SORT_ACCESSOR: Record<SortKey, (c: TrendingCollection) => number | null> = {
  floor:     c => c.floorSol,
  topOffer:  c => c.topOfferSol,
  floorPct:  c => c.floorPctChange,
  volume:    c => c.volumeSol,
  sales:     c => c.salesCount,
  listedPct: c => c.listedPct,
};

function sortRows(rows: TrendingCollection[], key: SortKey, dir: SortDir): TrendingCollection[] {
  const acc  = SORT_ACCESSOR[key];
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = acc(a);
    const vb = acc(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls bottom, both directions
    if (vb == null) return -1;
    if (va === vb) return 0;
    return (va < vb ? -1 : 1) * mult;
  });
}

// ── Refresh diff highlight ───────────────────────────────────────────────────
// On each background refresh we compare each slug's new rank (position in the
// sorted list) against its previous rank: brand-new slug, moved up, or moved
// down. The row carries the tint for 3 s, then clears.
type HighlightKind = 'new' | 'up' | 'down';
const HIGHLIGHT_STYLE: Record<HighlightKind, { bg: string; bar: string }> = {
  new:  { bg: 'rgba(168,144,232,0.13)', bar: '#a890e8' },
  up:   { bg: 'rgba(126,217,168,0.12)', bar: '#7ed9a8' },
  down: { bg: 'rgba(217,124,124,0.11)', bar: '#d97c7c' },
};
const HIGHLIGHT_MS = 3000;
const POLL_MS = 10_000;

export default function TrendingCollectionsPage() {
  useEffect(() => { document.title = 'Trending | VictoryLabs'; }, []);

  // Lazy initializer reads the persisted range once on mount (client-only —
  // this subtree never SSRs, so no hydration mismatch / no extra fetch).
  const [range, setRange]   = useState<Range>(loadSavedRange);
  const [rows, setRows]     = useState<TrendingCollection[]>([]);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [highlights, setHighlights] = useState<Map<string, HighlightKind>>(new Map());

  // Sorted view the table actually renders; rank = index in this list.
  const sortedRows = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  // Refs so the stable `load` callback (and the poll interval) can read the
  // live sort + rows without re-creating themselves on every sort change.
  const sortKeyRef = useRef(sortKey); sortKeyRef.current = sortKey;
  const sortDirRef = useRef(sortDir); sortDirRef.current = sortDir;
  const rowsRef    = useRef(rows);    rowsRef.current    = rows;
  // Previous slug→rank map, used to diff ranks on each refresh.
  const prevRankRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef(false);
  const hlTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHighlightClear = useCallback(() => {
    if (hlTimerRef.current) clearTimeout(hlTimerRef.current);
    hlTimerRef.current = setTimeout(() => setHighlights(new Map()), HIGHLIGHT_MS);
  }, []);

  const load = useCallback(async (
    r: Range,
    opts?: { fromClick?: boolean; highlight?: boolean; background?: boolean },
  ) => {
    const { fromClick = false, highlight = false, background = false } = opts ?? {};
    // Drop overlapping fetches (a poll firing mid-request, etc.) so rows can't
    // be set out of order.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (fromClick) playUiConfirm();
    if (!background) setBusy(true);
    setError(null);
    try {
      const url =
        `${API_BASE}/api/tools/trending-collections` +
        `?range=${encodeURIComponent(r)}&sort=volume&direction=desc&limit=${FETCH_LIMIT}`;
      const res = await fetch(url, { headers: { ...authHeaders() } });
      if (res.status === 429) {
        setError('Rate limited — wait a moment and try again.');
        return;
      }
      if (res.status === 502) {
        setError('Magic Eden stats temporarily unavailable. Try again shortly.');
        return;
      }
      if (!res.ok) {
        setError(`Failed to load trending collections — HTTP ${res.status}.`);
        return;
      }
      const body = await res.json() as TrendingResponse;
      if (!body.ok || !Array.isArray(body.collections)) {
        setError(body.message ?? body.error ?? 'Unexpected response.');
        return;
      }
      // Rank the incoming data under the CURRENT sort so the diff is computed
      // against what the user is actually looking at.
      const nextSorted = sortRows(body.collections, sortKeyRef.current, sortDirRef.current);
      const nextRank = new Map(nextSorted.map((c, i) => [c.slug, i]));
      if (highlight) {
        const prev = prevRankRef.current;
        const hl = new Map<string, HighlightKind>();
        for (const [slug, idx] of nextRank) {
          if (!prev.has(slug)) { hl.set(slug, 'new'); continue; }
          const p = prev.get(slug)!;
          if (idx < p) hl.set(slug, 'up');
          else if (idx > p) hl.set(slug, 'down');
        }
        if (hl.size > 0) { setHighlights(hl); scheduleHighlightClear(); }
      } else {
        // Initial load / timeframe switch: reset the baseline, never highlight
        // (a different timeframe's ranks aren't comparable to the old ones).
        setHighlights(new Map());
      }
      prevRankRef.current = nextRank;
      setRows(body.collections);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (!background) setBusy(false);
    }
  }, [scheduleHighlightClear]);

  // Initial load + reload whenever the timeframe changes (no highlight).
  useEffect(() => { void load(range); }, [range, load]);

  // Live refresh — poll every 10 s, keep the current timeframe, run in the
  // background (no spinner/button flicker) and diff ranks for the highlight.
  useEffect(() => {
    const id = setInterval(() => {
      void load(range, { highlight: true, background: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [range, load]);

  // When the user changes the sort, re-baseline ranks under the new sort from
  // the current data so the next poll only highlights genuine data movement —
  // not the reordering the click itself caused. Never highlights.
  useEffect(() => {
    const sorted = sortRows(rowsRef.current, sortKey, sortDir);
    prevRankRef.current = new Map(sorted.map((c, i) => [c.slug, i]));
    setHighlights(new Map());
  }, [sortKey, sortDir]);

  // Clear the pending highlight timer on unmount.
  useEffect(() => () => { if (hlTimerRef.current) clearTimeout(hlTimerRef.current); }, []);

  const onSort = useCallback((key: SortKey) => {
    // No click sound on sort — header is a frequent, low-ceremony control.
    if (key === sortKey) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }, [sortKey]);

  return (
    <div className="feed-root page-transition" data-page="tools">
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      {/* Header — matches Mint Tracker / Offers scale (title 22/700,
          sub-line 11, pad 20/14, tools-max width). */}
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
              Trending Collections
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#7a7a94', flexWrap: 'wrap', rowGap: 2 }}>
              <LiveDot />
              <span>read-only · live · auto-refresh 10s</span>
              {loaded && !error && (
                <>
                  <span style={{ color: '#3a3a52', margin: '0 8px' }}>·</span>
                  <span>{rows.length} collections</span>
                </>
              )}
              <span style={{ color: '#3a3a52', margin: '0 8px' }}>·</span>
              <span>Source: <span style={{ color: '#a890e8' }}>Magic Eden</span></span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load(range, { fromClick: true })}
            disabled={busy}
            data-uisnd="skip"
            style={{
              padding: '7px 16px', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase',
              borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(168,144,232,0.55)',
              background: busy ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
              color: busy ? '#7a7a94' : '#d4d4e8',
              boxShadow: busy ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
              transition: 'all 0.15s',
            }}
          >
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* Timeframe pills */}
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {RANGES.map(({ key, label }) => {
            const active = key === range;
            return (
              <button
                key={key}
                type="button"
                onClick={() => { if (key !== range) { setRange(key); saveRange(key); } }}
                data-uisnd="skip"
                style={{
                  padding: '5px 14px', fontSize: 12, fontWeight: 700,
                  letterSpacing: '0.5px', borderRadius: 6, cursor: 'pointer',
                  fontFamily: MONO,
                  border: active ? '1px solid rgba(168,144,232,0.55)' : '1px solid rgba(255,255,255,0.10)',
                  background: active
                    ? 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)'
                    : 'rgba(255,255,255,0.025)',
                  color: active ? '#f0eef8' : '#8a8aa2',
                  boxShadow: active ? '0 0 12px rgba(128,104,216,0.18)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Results card */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.32)',
        borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.10)',
        overflow: 'hidden', marginBottom: 16,
      }}>
        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width:  '5%' }} />{/* #          */}
              <col style={{ width: '29%' }} />{/* Collection */}
              <col style={{ width: '12%' }} />{/* Floor      */}
              <col style={{ width: '12%' }} />{/* Top Offer  */}
              <col style={{ width:  '9%' }} />{/* Floor %    */}
              <col style={{ width: '12%' }} />{/* Volume     */}
              <col style={{ width:  '8%' }} />{/* Sales      */}
              <col style={{ width: '13%' }} />{/* Listed     */}
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'center', padding: '12px 8px' }}>#</th>
                <th style={thStyleNft}>COLLECTION</th>
                <SortTh label="FLOOR"     col="floor"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortTh label="TOP OFFER" col="topOffer"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortTh label="FLOOR %"   col="floorPct"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortTh label="VOLUME"    col="volume"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortTh label="SALES"     col="sales"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortTh label="LISTED"    col="listedPct" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {!loaded && busy && (
                <tr><td colSpan={8} style={emptyCell}>Loading trending collections…</td></tr>
              )}
              {loaded && rows.length === 0 && !busy && (
                <tr><td colSpan={8} style={emptyCell}>No collections returned for this timeframe.</td></tr>
              )}
              {sortedRows.map((c, i) => {
                const name = c.name ?? c.slug;
                const abbr = (name[0] ?? '?').toUpperCase() + (name[1] ?? '').toUpperCase();
                const hl = highlights.get(c.slug);
                const hlStyle = hl ? HIGHLIGHT_STYLE[hl] : null;
                return (
                  <tr key={c.slug} className="tools-offer-row" style={{
                    borderBottom: '1px solid rgba(255,255,255,0.022)',
                    // Refresh diff tint — left bar + soft row bg, fades out when
                    // the 3 s highlight window clears. transition keeps it from
                    // snapping; no layout shift (inset shadow, not a border box).
                    background: hlStyle ? hlStyle.bg : 'transparent',
                    boxShadow: hlStyle ? `inset 3px 0 0 ${hlStyle.bar}` : 'none',
                    transition: 'background 0.5s ease, box-shadow 0.5s ease',
                  }}>
                    <td style={{ ...tdStyleNum, textAlign: 'center', color: '#7a7a94', fontWeight: 700, padding: '12px 8px' }}>
                      {i + 1}
                    </td>
                    <td style={{ padding: '12px 8px 12px 14px', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <div style={{ flexShrink: 0, width: 38, height: 38 }}>
                          <ItemThumb imageUrl={compressImage(c.image ?? null)} color="#8068d8" abbr={abbr} size={38} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <a
                              href={`https://magiceden.io/marketplace/${c.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                              style={{ fontSize: 14, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none', display: 'block', minWidth: 0 }}
                            >{name}</a>
                            {c.isVerified && (
                              <span title="Verified collection" style={{
                                flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 900, lineHeight: 1,
                                color: '#0e0b22', background: '#7ea8d9',
                              }}>✓</span>
                            )}
                            {c.isCompressed && (
                              <span title="Compressed NFT (cNFT)" style={{
                                flexShrink: 0, padding: '1px 5px', fontSize: 8.5, fontWeight: 800,
                                letterSpacing: '0.3px', borderRadius: 3, lineHeight: 1.2,
                                color: '#a890e8', background: 'rgba(168,144,232,0.12)',
                                border: '1px solid rgba(168,144,232,0.40)',
                              }}>cNFT</span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: '#56566e', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ ...tdStyleNum, fontWeight: 700 }}>{fmtSol(c.floorSol)}</td>
                    <td style={{ ...tdStyleNum, color: '#7ed9a8' }}>{fmtSol(c.topOfferSol)}</td>
                    <td style={tdStyleNum}><PctCell value={c.floorPctChange} /></td>
                    <td style={{ ...tdStyleNum, fontWeight: 700 }}>{fmtSol(c.volumeSol)}</td>
                    <td style={{ ...tdStyleNum, color: '#aaaabf' }}>{fmtInt(c.salesCount)}</td>
                    <td style={tdStyleNum}>
                      {/* Listed = pct on top, count / supply beneath. */}
                      <div style={{ fontWeight: 700, color: '#f0eef8' }}>
                        {c.listedPct != null ? `${(c.listedPct * 100).toFixed(1)}%` : '—'}
                      </div>
                      <div style={{ fontSize: 10, fontWeight: 500, color: '#56566e', marginTop: 1 }}>
                        {fmtInt(c.listedCount)}<span style={{ color: '#3a3a52' }}> / </span>{fmtInt(c.totalSupply)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Shared table chrome — mirrors the Offers tool (Mint Tracker scale) ──────
const thStyle: React.CSSProperties = {
  padding: '12px 10px', fontSize: 11, fontWeight: 700,
  color: '#56566e', letterSpacing: '0.6px', textAlign: 'left',
  background: 'rgba(28,22,48,0.96)', borderBottom: '1px solid rgba(168,144,232,0.08)',
  textTransform: 'uppercase', userSelect: 'none',
  position: 'sticky', top: 0, zIndex: 1,
};
const thStyleNum: React.CSSProperties = { ...thStyle, textAlign: 'right' };
const thStyleNft: React.CSSProperties = { ...thStyle, padding: '12px 10px 12px 14px' };
const tdStyleNum: React.CSSProperties = {
  padding: '12px 10px', textAlign: 'right', fontSize: 13, fontWeight: 600,
  color: '#f0eef8', fontFamily: MONO, verticalAlign: 'middle',
};
const emptyCell: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '64px 24px', fontSize: 13, lineHeight: 1.5,
};
