'use client';

// VictoryLabs — Tools › Tensor Low Floor.
// Full-market scan over every Tensor-indexed collection (~38.6k) for
// legacy / pNFT collections with a real cheapest active listing under a
// threshold. MPL Core, cNFT, SPL-20, inscriptions, Token-2022, and SFT are
// excluded server-side against the REAL per-mint listing data, not just the
// (sometimes stale) collection-level flags — see tools-tensor-floor-scan.ts
// header comment. Modeled on /tools/spl20's scan-stream contract
// (progress/result/error SSE events, cached + force-refresh).
// Read-only: no wallet connect, no signing, no tx building.
// Data: GET /api/tools/tensor-floor-scan/scan-stream (SSE)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, CtaButton } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, TH_L } from '@/app/tools/mmm-shared';

interface Candidate {
  name: string;
  slugDisplay: string;
  collId: string;
  tokenStandard: string | null;
  listingPriceLamports: number;
  numListed: number;
  royaltyBps: number | null;
  tensorUrl: string;
}
interface ScanResult { candidates: Candidate[]; cached: boolean; cacheAgeMs: number; totalCollections: number }

type SortCol = 'price' | 'name' | 'numListed' | 'royalty';
type TypeFilter = 'all' | 'pnft' | 'legacy';

const RESULT_KEY = 'vl.tensorFloor.result';
const DEFAULT_THRESHOLD_SOL = '0.0075';

function standardLabel(ts: string | null): string {
  if (ts === 'PROGRAMMABLE_NON_FUNGIBLE' || ts === 'PROGRAMMABLE_NON_FUNGIBLE_EDITION') return 'pNFT';
  if (ts === 'NON_FUNGIBLE' || ts === 'NON_FUNGIBLE_EDITION' || ts === null) return 'legacy';
  return ts;
}
function isPnft(ts: string | null): boolean {
  return ts === 'PROGRAMMABLE_NON_FUNGIBLE' || ts === 'PROGRAMMABLE_NON_FUNGIBLE_EDITION';
}
function fmtSol(lamports: number): string {
  return (lamports / 1e9).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

export default function TensorLowFloorPage() {
  useEffect(() => { document.title = 'Tensor Low Floor | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<ScanResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(RESULT_KEY) : null;
      return raw ? (JSON.parse(raw) as ScanResult) : null;
    } catch { return null; }
  });
  const [scanError, setScanError] = useState<string | null>(null);

  const [thresholdSol, setThresholdSol] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.tensorFloor.threshold') : null) ?? DEFAULT_THRESHOLD_SOL);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => ((typeof window !== 'undefined' ? localStorage.getItem('vl.tensorFloor.type') : null) as TypeFilter) ?? 'all');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('price');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => { try { localStorage.setItem('vl.tensorFloor.threshold', thresholdSol); } catch { /* quota */ } }, [thresholdSol]);
  useEffect(() => { try { localStorage.setItem('vl.tensorFloor.type', typeFilter); } catch { /* quota */ } }, [typeFilter]);

  const esRef = useRef<EventSource | null>(null);

  const runScan = useCallback((opts?: { force?: boolean }) => {
    if (busy) return;
    playUiConfirm();
    setBusy(true);
    setLogs([]);
    setScanError(null);

    const params = new URLSearchParams();
    if (opts?.force) params.set('force', '1');
    const url = `${API_BASE}/api/tools/tensor-floor-scan/scan-stream?${params.toString()}`;

    esRef.current?.close();
    const es = new EventSource(url);
    esRef.current = es;
    const closeEs = () => { if (esRef.current === es) esRef.current = null; es.close(); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type: string; msg?: string; candidates?: Candidate[]; cached?: boolean; cacheAgeMs?: number; totalCollections?: number };
        if (data.type === 'progress' && data.msg) {
          setLogs(prev => [...prev.slice(-6), data.msg!]);
        } else if (data.type === 'result' && data.candidates) {
          const r: ScanResult = { candidates: data.candidates, cached: data.cached ?? false, cacheAgeMs: data.cacheAgeMs ?? 0, totalCollections: data.totalCollections ?? 0 };
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
  }, [busy]);

  useEffect(() => {
    return () => { esRef.current?.close(); esRef.current = null; };
  }, []);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortCol(col); setSortDir(col === 'name' ? 'asc' : 'asc'); }
  };
  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const visibleRows = useMemo(() => {
    if (!result) return [];
    const thresholdLamports = (parseFloat(thresholdSol) || 0) * 1e9;
    const q = search.trim().toLowerCase();
    let rows = result.candidates.filter(c => {
      if (thresholdLamports > 0 && c.listingPriceLamports >= thresholdLamports) return false;
      if (typeFilter === 'pnft' && !isPnft(c.tokenStandard)) return false;
      if (typeFilter === 'legacy' && isPnft(c.tokenStandard)) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.slugDisplay.toLowerCase().includes(q)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortCol) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'numListed': av = a.numListed; bv = b.numListed; break;
        case 'royalty': av = a.royaltyBps ?? -1; bv = b.royaltyBps ?? -1; break;
        default: av = a.listingPriceLamports; bv = b.listingPriceLamports;
      }
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [result, thresholdSol, typeFilter, search, sortCol, sortDir]);

  const THs = { ...TH, cursor: 'pointer', userSelect: 'none' as const };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          TENSOR LOW FLOOR
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · scans every Tensor-indexed collection, verifies each candidate against its real cheapest listing · legacy + pNFT only (no Core / cNFT / SFT / Token-2022 / spl20 / inscriptions)</span>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 16, marginBottom: 12 }}>
          <CtaButton disabled={busy} onClick={() => runScan()} style={{ flexShrink: 0 }}>
            {busy ? 'Scanning…' : 'Scan'}
          </CtaButton>

          {result && !busy && (
            <div style={{ width: 1, height: 28, background: alpha(VL.purpleTint, 0.12), margin: '0 14px', flexShrink: 0 }} />
          )}

          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {result.candidates.length}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                candidates (≤0.01 SOL)
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
                <span style={{ fontSize: 11, color: VLText.muted, ...MONO }}>{Math.floor(result.cacheAgeMs / 60_000)}m ago · {result.totalCollections.toLocaleString()} collections scanned</span>
              )}
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter name/slug…"
              spellCheck={false}
              style={{
                width: 140, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                color: 'var(--vl-text-primary)', outline: 'none',
              }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--vl-text-muted)' }}>
              floor &lt;
              <input
                type="number"
                step="0.0001"
                value={thresholdSol}
                onChange={(e) => setThresholdSol(e.target.value)}
                style={{
                  width: 68, padding: '5px 6px', fontSize: 11.5, ...MONO, borderRadius: 5,
                  border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                  color: 'var(--vl-text-primary)', outline: 'none',
                }}
              />
              SOL
            </label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
              style={{
                padding: '6px 8px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                color: 'var(--vl-text-primary)', outline: 'none', cursor: 'pointer',
              }}
            >
              <option value="all">all</option>
              <option value="pnft">pNFT only</option>
              <option value="legacy">legacy only</option>
            </select>
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
        {busy && result && logs.length > 0 && (
          <div style={{ ...PANEL, padding: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: '#c4b8e8', ...MONO }}>{logs[logs.length - 1]}</div>
          </div>
        )}

        {scanError && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
            background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5,
          }}>
            {scanError}
          </div>
        )}

        {/* ── Results table ────────────────────────────────────────────────── */}
        {result && (
          <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
            {visibleRows.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
                {result.candidates.length === 0
                  ? 'Scan found nothing under 0.01 SOL right now.'
                  : 'No candidates match the current filter — try raising the floor threshold or switching type filter to "all".'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={THs} onClick={() => toggleSort('price')}>FLOOR{arrow('price')}</th>
                      <th style={THs} onClick={() => toggleSort('name')}>COLLECTION{arrow('name')}</th>
                      <th style={TH}>STANDARD</th>
                      <th style={THs} onClick={() => toggleSort('numListed')}>LISTED{arrow('numListed')}</th>
                      <th style={THs} onClick={() => toggleSort('royalty')}>ROYALTY{arrow('royalty')}</th>
                      <th style={TH_L}>LINK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((c) => (
                      <tr key={c.collId} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontWeight: 700, color: rgb(VL.gold) }}>{fmtSol(c.listingPriceLamports)}</td>
                        <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--vl-text-primary)' }}>{c.name}</td>
                        <td style={{ padding: '6px 8px', fontSize: 11, color: isPnft(c.tokenStandard) ? 'var(--vl-green-primary)' : 'var(--vl-text-muted)' }}>{standardLabel(c.tokenStandard)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{c.numListed}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, color: 'var(--vl-text-muted)' }}>{c.royaltyBps != null ? `${(c.royaltyBps / 100).toFixed(1)}%` : '—'}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <a href={c.tensorUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#c4b8e8', textDecoration: 'none' }}>Tensor →</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!result && !busy && logs.length === 0 && (
          <div style={{ ...PANEL, padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
            Hit Scan to walk every Tensor-indexed collection (~38.6k) and find legacy/pNFT floors under 0.01 SOL. Takes a couple minutes on a cold cache; instant on a warm one (20 min TTL).
          </div>
        )}

        <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 6 }}>
          Read-only: no wallet connect, no signing, no tx sent. Every row is verified against its real cheapest active listing (not just cached collection stats) — Core, cNFT, SPL-20, inscriptions, Token-2022, and SFT are excluded. OCP (Open Creator Protocol) has no distinct flag in Tensor's API and is not separately excluded — check manually if that matters for a given row.
        </div>
      </div>
      </div>
    </div>
  );
}
