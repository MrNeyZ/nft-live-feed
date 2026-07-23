'use client';

// VictoryLabs — Tools › SPL20.
// "Pool Feed"-style full scanner over the on-chain SPL-20 inscription
// registry (BRC-20-style "deploy" accounts on program
// 8bvPnYE5Pvz2Z9dE6RAqWr1rzLknTndZ9hwvRE6kPDXP), modeled directly on
// /tools/mmm-collection-scanner's Pool Feed tab (same SSE contract:
// progress/result/error events, cached + force-refresh, localStorage-
// persisted last result). For every one of the 729 tickers: resolves the
// pool's fungible CA + still-unredeemed NFT inventory via
// getTokenAccountsByOwner on the ticker's deploy PDA (legacy Token +
// Token-2022, merged), prices the token via Jupiter (price index, with a
// swap-quote fallback for tokens the index has no price for), auto-resolves
// the marketplace collection from a sample NFT the pool still holds (no
// manually-typed slug needed), pulls the ME floor, and reports a spread +
// a VALUE score (spread% × redeemable liquidity depth) so a huge spread on
// an almost-empty pool doesn't drown out a modest spread with real depth
// behind it.
// Read-only: no wallet connect, no signing, no tx building.
// Data: GET /api/tools/spl20/scan-stream (SSE)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, TH_L, short } from '@/app/tools/mmm-shared';

type Direction = 'sell_nft_for_token' | 'buy_token_for_nft' | null;

interface ScanRow {
  tick: string;
  deployPda: string;
  max: string;
  limit: string;
  tokensPerNft: number | null;
  mint: string | null;
  nftInventoryCount: number;
  tokenBalance: number | null;
  tokenPriceSol: number | null;
  tokenValuePerNftSol: number | null;
  liquidityUsd: number | null;
  resolvedSlug: string | null;
  meFloorSol: number | null;
  meListedCount: number;
  spreadPct: number | null;
  direction: Direction;
  valueScore: number;
}
interface ScanResult { rows: ScanRow[]; cached: boolean; cacheAgeMs: number }

type SortCol = 'tick' | 'nftInventoryCount' | 'tokenValuePerNftSol' | 'liquidityUsd' | 'meFloorSol' | 'spreadPct' | 'valueScore';

const RESULT_KEY = 'vl.spl20.result';
// Never-expiring ledger of every tick that has ever shown a full spread —
// same idea as mmm-collection-scanner's Pool Feed "ever seen" ledger. Full
// rescans are unavoidable (no cheap on-chain "what changed" API), so this
// doesn't reduce scan cost — it just lets the feed read as additive: a tick
// showing a spread for the first time is tagged NEW, one that had a spread
// last scan but not this one is called out as dropped, instead of the whole
// table silently swapping out on every scan.
const EVER_SEEN_KEY = 'vl.spl20.everSeenSpreadTicks';

function loadEverSeen(): Set<string> {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(EVER_SEEN_KEY) : null;
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}
function saveEverSeen(s: Set<string>): void {
  try { localStorage.setItem(EVER_SEEN_KEY, JSON.stringify([...s])); } catch { /* quota */ }
}

// ── Live activity feed ──────────────────────────────────────────────────
// Not new RPC data — purely a diff between this scan's rows and the last
// scan's rows (already have both, same trick as the new/dropped ledger
// above), for tickers present in both. Surfaces on-chain activity (a redeem
// happened, ME floor moved) between scans without needing a second data
// source.
interface FeedEvent { ts: number; tick: string; from: string; to: string }
const FEED_LOG_KEY = 'vl.spl20.feedLog';
const FEED_LOG_CAP = 150;
// Only fires on spread magnitude *growing* by at least this many percentage
// points — not shrinking, not floor/inventory churn across the registry.
// That's the only thing the user cares about here: an opportunity getting
// more profitable. 5pp also filters out the noise from a dead token's
// spread drifting a little every scan purely from SOL/USD moving (spread is
// computed by converting through USD) even with zero real activity.
const SPREAD_CHANGE_THRESHOLD_PCT = 5;

function loadFeedLog(): FeedEvent[] {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(FEED_LOG_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    // Discard entries from older shapes (pre-table message string, or the
    // brief inventory/floor/spread "field" version) — not compatible.
    return parsed.filter((e): e is FeedEvent => typeof e === 'object' && e !== null && !('field' in e) && 'from' in e && 'to' in e);
  } catch { return []; }
}
function saveFeedLog(log: FeedEvent[]): void {
  try { localStorage.setItem(FEED_LOG_KEY, JSON.stringify(log.slice(0, FEED_LOG_CAP))); } catch { /* quota */ }
}

function fmtPct(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; }

function diffRow(prev: ScanRow, curr: ScanRow, ts: number): FeedEvent[] {
  if (prev.spreadPct == null || curr.spreadPct == null) return [];
  const grew = Math.abs(curr.spreadPct) - Math.abs(prev.spreadPct);
  if (grew < SPREAD_CHANGE_THRESHOLD_PCT) return [];
  return [{ ts, tick: curr.tick, from: fmtPct(prev.spreadPct), to: fmtPct(curr.spreadPct) }];
}

function fmtRelTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtSol(n: number): string { return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); }
function fmtNum(n: number): string { return n.toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function fmtUsd(n: number): string { return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }
function directionLabel(d: Direction): string {
  if (d === 'sell_nft_for_token') return 'sell NFT → token';
  if (d === 'buy_token_for_nft') return 'buy token → NFT';
  return '—';
}

export default function Spl20Page() {
  useEffect(() => { document.title = 'SPL20 | VictoryLabs'; }, []);

  // One-time seed: if the ever-seen ledger doesn't exist yet but a cached
  // scan result does, seed it from that result. Otherwise the first scan
  // after this feature ships would tag every already-known ticker as NEW.
  useEffect(() => {
    try {
      if (localStorage.getItem(EVER_SEEN_KEY) != null) return;
      const raw = localStorage.getItem(RESULT_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as ScanResult;
      const seed = new Set(cached.rows.filter(x => x.spreadPct != null).map(x => x.tick));
      saveEverSeen(seed);
    } catch { /* ignore */ }
  }, []);

  const [busy, setBusy]     = useState(false);
  const [logs, setLogs]     = useState<string[]>([]);
  const [result, setResult] = useState<ScanResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(RESULT_KEY) : null;
      return raw ? (JSON.parse(raw) as ScanResult) : null;
    } catch { return null; }
  });
  const [scanError, setScanError] = useState<string | null>(null);
  const [newTicks, setNewTicks] = useState<Set<string>>(new Set());
  const [droppedTicks, setDroppedTicks] = useState<string[]>([]);
  const [feedLog, setFeedLog] = useState<FeedEvent[]>(() => loadFeedLog());

  const [minAbsSpread, setMinAbsSpread] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.spl20.minSpread') : null) ?? '5');
  const [hideUnresolved, setHideUnresolved] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.spl20.hideUnresolved') : null) !== '0');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('valueScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => { try { localStorage.setItem('vl.spl20.minSpread', minAbsSpread); } catch { /* quota */ } }, [minAbsSpread]);
  useEffect(() => { try { localStorage.setItem('vl.spl20.hideUnresolved', hideUnresolved ? '1' : '0'); } catch { /* quota */ } }, [hideUnresolved]);

  const esRef = useRef<EventSource | null>(null);

  const runScan = useCallback((opts?: { force?: boolean }) => {
    if (busy) return;
    playUiConfirm();
    setBusy(true);
    setLogs([]);
    setScanError(null);

    const params = new URLSearchParams();
    if (opts?.force) params.set('force', '1');
    const url = `${API_BASE}/api/tools/spl20/scan-stream?${params.toString()}`;

    esRef.current?.close();
    const es = new EventSource(url);
    esRef.current = es;
    const closeEs = () => { if (esRef.current === es) esRef.current = null; es.close(); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type: string; msg?: string; rows?: ScanRow[]; cached?: boolean; cacheAgeMs?: number };
        if (data.type === 'progress' && data.msg) {
          setLogs(prev => [...prev.slice(-5), data.msg!]);
        } else if (data.type === 'result' && data.rows) {
          const r: ScanResult = { rows: data.rows, cached: data.cached ?? false, cacheAgeMs: data.cacheAgeMs ?? 0 };

          const prevSpreadTicks = new Set((result?.rows ?? []).filter(x => x.spreadPct != null).map(x => x.tick));
          const currSpreadTicks = new Set(r.rows.filter(x => x.spreadPct != null).map(x => x.tick));
          const everSeen = loadEverSeen();
          const fresh = new Set<string>();
          for (const t of currSpreadTicks) { if (!everSeen.has(t)) fresh.add(t); everSeen.add(t); }
          saveEverSeen(everSeen);
          const dropped = [...prevSpreadTicks].filter(t => !currSpreadTicks.has(t));
          setNewTicks(fresh);
          setDroppedTicks(dropped);

          if (result) {
            const prevByTick = new Map(result.rows.map(x => [x.tick, x]));
            const now = Date.now();
            const events: FeedEvent[] = [];
            for (const row of r.rows) {
              const prevRow = prevByTick.get(row.tick);
              if (!prevRow) continue;
              events.push(...diffRow(prevRow, row, now));
            }
            if (events.length > 0) {
              setFeedLog(prevLog => {
                const merged = [...events, ...prevLog].slice(0, FEED_LOG_CAP);
                saveFeedLog(merged);
                return merged;
              });
            }
          }

          setResult(r);
          try { localStorage.setItem(RESULT_KEY, JSON.stringify(r)); } catch { /* quota */ }
          closeEs();
          setBusy(false);
        } else if (data.type === 'error') {
          setScanError(data.msg ?? 'Unknown error');
          closeEs();
          setBusy(false);
        }
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => { setScanError('Connection error'); closeEs(); setBusy(false); };
  }, [busy, result]);

  useEffect(() => {
    return () => { esRef.current?.close(); esRef.current = null; };
  }, []);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortCol(col); setSortDir(col === 'tick' ? 'asc' : 'desc'); }
  };
  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const visibleRows = useMemo(() => {
    if (!result) return [];
    const minSpread = parseFloat(minAbsSpread) || 0;
    const q = search.trim().toLowerCase();
    let rows = result.rows.filter(r => {
      if (hideUnresolved && r.meFloorSol == null) return false;
      if (r.spreadPct != null && Math.abs(r.spreadPct) < minSpread) return false;
      if (r.spreadPct == null && minSpread > 0) return false;
      if (q && !r.tick.toLowerCase().includes(q)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortCol) {
        case 'tick': av = a.tick.toLowerCase(); bv = b.tick.toLowerCase(); break;
        case 'nftInventoryCount': av = a.nftInventoryCount; bv = b.nftInventoryCount; break;
        case 'tokenValuePerNftSol': av = a.tokenValuePerNftSol ?? -1; bv = b.tokenValuePerNftSol ?? -1; break;
        case 'liquidityUsd': av = a.liquidityUsd ?? -1; bv = b.liquidityUsd ?? -1; break;
        case 'meFloorSol': av = a.meFloorSol ?? -1; bv = b.meFloorSol ?? -1; break;
        case 'spreadPct': av = a.spreadPct ?? -Infinity; bv = b.spreadPct ?? -Infinity; break;
        default: av = a.valueScore; bv = b.valueScore;
      }
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [result, minAbsSpread, hideUnresolved, search, sortCol, sortDir]);

  const resolvedCount = result ? result.rows.filter(r => r.meFloorSol != null).length : 0;
  const spreadCount = result ? result.rows.filter(r => r.spreadPct != null).length : 0;
  const THs = { ...TH, cursor: 'pointer', userSelect: 'none' as const };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
          SPL20
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · scans all 729 on-chain SPL-20 tickers, resolves each CA + inventory + ME floor, spreads redeemed token value vs floor</span>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 16, marginBottom: 12 }}>
          <button type="button" disabled={busy} onClick={() => runScan()}
            style={{
              padding: '8px 22px', fontSize: 13, fontWeight: 700, letterSpacing: '0.8px',
              textTransform: 'uppercase', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer',
              border: `1px solid ${!busy ? alpha(VL.purpleTint, 0.38) : alpha(VL.purpleTint, 0.10)}`,
              background: !busy
                ? `linear-gradient(160deg,${alpha(VL.purpleDeep, 0.38)} 0%,${alpha(VL.purpleDeep, 0.20)} 100%)`
                : alpha(VL.purpleDeep, 0.06),
              color: !busy ? VLText.primary : VLText.muted,
              boxShadow: !busy ? `0 0 16px ${alpha(VL.purpleDeep, 0.28)}, inset 0 1px 0 rgba(255,255,255,0.07)` : 'none',
              flexShrink: 0,
            }}>
            {busy ? 'Scanning…' : 'Scan'}
          </button>

          {result && !busy && (
            <div style={{ width: 1, height: 28, background: alpha(VL.purpleTint, 0.12), margin: '0 14px', flexShrink: 0 }} />
          )}

          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {resolvedCount}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                priced tickers
              </span>
            </div>
          )}

          {result?.cached && !busy && (
            <button type="button" onClick={() => runScan({ force: true })}
              style={{
                padding: '3px 0', fontSize: 11, fontWeight: 500, background: 'none',
                border: 'none', color: VLText.faint, cursor: 'pointer', marginRight: 10,
                textDecoration: 'underline', textDecorationColor: alpha(VL.purpleTint, 0.25),
                textUnderlineOffset: '3px', flexShrink: 0,
              }}>
              ↺ refresh
            </button>
          )}

          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, lineHeight: 1, flexShrink: 0 }}>
              <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.42), textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>
                {result.cached ? 'cached' : 'live scan'}
              </span>
              {result.cached && (
                <span style={{ fontSize: 11, color: VLText.muted, ...MONO }}>{Math.floor(result.cacheAgeMs / 60_000)}m ago</span>
              )}
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter ticker…"
              spellCheck={false}
              style={{
                width: 130, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(20,14,34,0.85)',
                color: '#f0eef8', outline: 'none',
              }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#9a9ab4' }}>
              min |spread|
              <input
                type="number"
                value={minAbsSpread}
                onChange={(e) => setMinAbsSpread(e.target.value)}
                style={{
                  width: 52, padding: '5px 6px', fontSize: 11.5, ...MONO, borderRadius: 5,
                  border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(20,14,34,0.85)',
                  color: '#f0eef8', outline: 'none',
                }}
              />
              %
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#9a9ab4', cursor: 'pointer' }}>
              <input type="checkbox" checked={hideUnresolved} onChange={(e) => setHideUnresolved(e.target.checked)} />
              hide no-floor
            </label>
          </div>
        </div>

        {(busy || logs.length > 0) && !scanError && !result && (
          <div style={{ ...PANEL, padding: 12, marginBottom: 12 }}>
            {logs.map((l, i) => (
              <div key={i} style={{ fontSize: 11.5, color: i === logs.length - 1 ? '#c4b8e8' : '#6e6688', ...MONO, marginBottom: 2 }}>{l}</div>
            ))}
            {logs.length === 0 && <div style={{ fontSize: 11.5, color: '#6e6688', ...MONO }}>starting…</div>}
          </div>
        )}

        {scanError && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', fontSize: 12, color: '#d96867',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5,
          }}>
            {scanError}
          </div>
        )}

        {droppedTicks.length > 0 && !busy && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', fontSize: 11.5, color: '#9a9ab4',
            background: 'rgba(217,184,103,0.06)', border: '1px solid rgba(217,184,103,0.25)', borderRadius: 5,
          }}>
            <span style={{ color: '#d9b867', fontWeight: 700 }}>dropped since last scan</span> — no longer showing a spread: {droppedTicks.join(', ')}
          </div>
        )}

        {/* ── Feed table ───────────────────────────────────────────────────── */}
        {result && (
          <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
            {visibleRows.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: '#9a9ab4' }}>
                {result.rows.length === 0
                  ? 'Scan returned no tickers — something failed server-side.'
                  : spreadCount === 0
                    ? `Scanned ${result.rows.length} tickers, ${resolvedCount} have a live ME floor, but none currently have a computable token price too (most of these have no active market on one side or the other). Try "hide no-floor" off, or lower min |spread| to 0, to see what did resolve.`
                    : 'No tickers match the current filter — try lowering min |spread| or turning off "hide no-floor".'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={THs} onClick={() => toggleSort('tick')}>TICK{arrow('tick')}</th>
                      <th style={TH_L}>CA</th>
                      <th style={THs} onClick={() => toggleSort('nftInventoryCount')}>INVENTORY{arrow('nftInventoryCount')}</th>
                      <th style={THs} onClick={() => toggleSort('tokenValuePerNftSol')}>VALUE/NFT{arrow('tokenValuePerNftSol')}</th>
                      <th style={THs} onClick={() => toggleSort('liquidityUsd')} title="Jupiter price-index liquidity (USD) — blank when priced only via swap-quote fallback (unindexed, not confirmed zero)">LIQUIDITY{arrow('liquidityUsd')}</th>
                      <th style={THs} onClick={() => toggleSort('meFloorSol')}>ME FLOOR{arrow('meFloorSol')}</th>
                      <th style={THs} onClick={() => toggleSort('spreadPct')}>SPREAD{arrow('spreadPct')}</th>
                      <th style={TH}>DIRECTION</th>
                      <th style={THs} onClick={() => toggleSort('valueScore')} title="|spread%| × redeemable liquidity depth">VALUE{arrow('valueScore')}</th>
                      <th style={TH_L}>LINK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => (
                      <tr key={r.deployPda} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 700, color: '#f0eef8' }}>
                          {r.tick}
                          {newTicks.has(r.tick) && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 800, letterSpacing: '0.4px',
                              color: rgb(VL.gold), border: `1px solid ${alpha(VL.gold, 0.5)}`,
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>NEW</span>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px', ...MONO, color: '#9a9ab4' }}>{r.mint ? short(r.mint) : '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{r.nftInventoryCount}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{r.tokenValuePerNftSol != null ? fmtSol(r.tokenValuePerNftSol) : '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, color: r.liquidityUsd == null ? '#6e6688' : '#9a9ab4' }}>{r.liquidityUsd != null ? fmtUsd(r.liquidityUsd) : r.tokenPriceSol != null ? 'unindexed' : '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{r.meFloorSol != null ? fmtSol(r.meFloorSol) : '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontWeight: 700, color: r.spreadPct == null ? '#9a9ab4' : r.spreadPct > 0 ? '#43b984' : '#d96867' }}>
                          {r.spreadPct != null ? `${r.spreadPct > 0 ? '+' : ''}${r.spreadPct.toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', color: r.direction === 'sell_nft_for_token' ? '#43b984' : r.direction === 'buy_token_for_nft' ? '#d9b867' : '#9a9ab4', fontSize: 11 }}>
                          {directionLabel(r.direction)}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, color: rgb(VL.gold) }}>{r.valueScore >= 1 ? fmtNum(r.valueScore) : ''}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {r.resolvedSlug && (
                            <a href={`https://magiceden.io/marketplace/${r.resolvedSlug}`} target="_blank" rel="noopener noreferrer" style={{ color: '#c4b8e8', textDecoration: 'none' }}>ME →</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Live activity feed — diffs between consecutive scans ────────── */}
        {result && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#9a9ab4', marginBottom: 8 }}>
              Last changes
            </div>
            <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
              {feedLog.length === 0 ? (
                <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: '#9a9ab4' }}>
                  No changes detected yet — run another scan to compare against this one.
                </div>
              ) : (
              <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={TH_L}>TIME</th>
                      <th style={TH_L}>TICK</th>
                      <th style={TH_L}>SPREAD FROM</th>
                      <th style={TH_L}>SPREAD TO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feedLog.map((e, i) => (
                      <tr key={`${e.ts}-${e.tick}-${i}`} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 8px', ...MONO, color: '#6e6688', whiteSpace: 'nowrap', width: 1 }}>{fmtRelTime(e.ts)}</td>
                        <td style={{ padding: '6px 8px', fontWeight: 700, color: '#f0eef8' }}>{e.tick}</td>
                        <td style={{ padding: '6px 8px', ...MONO, color: '#9a9ab4' }}>{e.from}</td>
                        <td style={{ padding: '6px 8px', ...MONO, color: '#43b984', fontWeight: 700 }}>{e.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          </div>
        )}

        {!result && !busy && logs.length === 0 && (
          <div style={{ ...PANEL, padding: '32px 16px', textAlign: 'center', fontSize: 12, color: '#9a9ab4' }}>
            Hit Scan to walk all 729 on-chain SPL-20 tickers and price them against ME floors.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 6 }}>
          Read-only: no wallet connect, no signing, no tx sent. VALUE = |spread%| × redeemable liquidity depth (unredeemed NFTs for the sell-NFT direction, buyable NFT-equivalents for the buy-token direction) — ranks real opportunities above a huge spread on an almost-dry pool.
        </div>
      </div>
      </div>
    </div>
  );
}
