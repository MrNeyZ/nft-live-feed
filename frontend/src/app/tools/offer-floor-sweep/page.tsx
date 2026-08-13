'use client';

// VictoryLabs — Tools › Offer > Floor Sweep.
// Full-market sweep: Tensor's bulk collections list (volume7d desc, ME has
// no bulk stats field at all) filters ~38.6k collections down to ~150-250
// active ones (>= ~10 SOL/30d, proxied via volume7d). Each survivor is then
// checked ME-only (offers_received per cheapest-listed mint) for a personal
// offer priced ABOVE the current listing ask. Tensor never touches the
// offer side — that's exclusively ME, same engine as /tools/offers
// (tools-retardio-offers.ts's runScan, reused as-is).
// Slow scan (~15-20 min cold), cached 4h server-side.
// Read-only: no wallet connect, no signing, no tx building.
// Data: GET /api/tools/offer-floor-sweep/scan-stream (SSE, requireAuth)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, CtaButton } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, TH_L } from '@/app/tools/mmm-shared';
import { authHeaders } from '@/runtime/auth';

type OfferStatus = 'AVAILABLE' | 'EXPIRED' | 'EXPECTED';
type FundingStatus = 'funded' | 'low_balance' | 'empty' | 'unknown';

interface Hit {
  mint: string;
  nftName: string | null;
  imageUrl: string | null;
  listingPrice: number | null;
  bestOfferPrice: number;
  spreadSol: number | null;
  listed: boolean;
  bestOfferId: string;
  bestOfferStatus: OfferStatus;
  bestOfferCreatedAt: number | null;
  fundingWallet: string | null;
  fundingBalanceSol: number | null;
  fundingStatus: FundingStatus;
  meUrl: string;
  tensorUrl: string;
  collectionSlug: string;
  collectionName: string;
}
interface SweepResult {
  hits: Hit[];
  collectionsScanned: number;
  collectionsCandidate: number;
  totalTensorCollections: number;
  cached: boolean;
  cacheAgeMs: number;
}

type SortCol = 'spread' | 'offer' | 'listing' | 'collection';

const RESULT_KEY = 'vl.offerFloorSweep.result';

function fmtSol(sol: number | null): string {
  if (sol == null) return '—';
  return sol.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
function statusColor(s: OfferStatus): string {
  if (s === 'AVAILABLE') return 'var(--vl-green-primary)';
  if (s === 'EXPECTED') return rgb(VL.gold);
  return 'var(--vl-text-muted)';
}
function statusLabel(s: OfferStatus): string {
  return s === 'AVAILABLE' ? 'active' : s === 'EXPECTED' ? 'infinite' : 'expired';
}
function fundingColor(s: FundingStatus): string {
  if (s === 'funded') return 'var(--vl-green-primary)';
  if (s === 'low_balance') return rgb(VL.gold);
  if (s === 'empty') return 'var(--vl-red-primary)';
  return 'var(--vl-text-muted)';
}

export default function OfferFloorSweepPage() {
  useEffect(() => { document.title = 'Offer > Floor Sweep | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<SweepResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(RESULT_KEY) : null;
      return raw ? (JSON.parse(raw) as SweepResult) : null;
    } catch { return null; }
  });
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('spread');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const esRef = useRef<EventSource | null>(null);

  const runScan = useCallback((opts?: { force?: boolean }) => {
    if (busy) return;
    playUiConfirm();
    setBusy(true);
    setLogs([]);
    setScanError(null);

    const params = new URLSearchParams();
    if (opts?.force) params.set('force', '1');
    const authToken = authHeaders().Authorization?.replace(/^Bearer\s+/i, '');
    if (authToken) params.set('token', authToken);
    const url = `${API_BASE}/api/tools/offer-floor-sweep/scan-stream?${params.toString()}`;

    esRef.current?.close();
    const es = new EventSource(url);
    esRef.current = es;
    const closeEs = () => { if (esRef.current === es) esRef.current = null; es.close(); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as {
          type: string; msg?: string; hits?: Hit[];
          collectionsScanned?: number; collectionsCandidate?: number; totalTensorCollections?: number;
          cached?: boolean; cacheAgeMs?: number;
        };
        if (data.type === 'progress' && data.msg) {
          setLogs(prev => [...prev.slice(-6), data.msg!]);
        } else if (data.type === 'result' && data.hits) {
          const r: SweepResult = {
            hits: data.hits,
            collectionsScanned: data.collectionsScanned ?? 0,
            collectionsCandidate: data.collectionsCandidate ?? 0,
            totalTensorCollections: data.totalTensorCollections ?? 0,
            cached: data.cached ?? false,
            cacheAgeMs: data.cacheAgeMs ?? 0,
          };
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
    else { setSortCol(col); setSortDir('desc'); }
  };
  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const visibleRows = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    let rows = result.hits.filter(h => {
      if (q && !h.collectionName.toLowerCase().includes(q) && !h.collectionSlug.toLowerCase().includes(q) && !(h.nftName ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortCol) {
        case 'offer':      av = a.bestOfferPrice;    bv = b.bestOfferPrice;    break;
        case 'listing':    av = a.listingPrice ?? 0;  bv = b.listingPrice ?? 0; break;
        case 'collection': av = a.collectionName.toLowerCase(); bv = b.collectionName.toLowerCase(); break;
        default:            av = a.spreadSol ?? 0;     bv = b.spreadSol ?? 0;
      }
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [result, search, sortCol, sortDir]);

  const THs = { ...TH, cursor: 'pointer', userSelect: 'none' as const };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          OFFER &gt; FLOOR SWEEP
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · Tensor volume filters ~38.6k collections down to active ones (≥~10 SOL/30d proxy) · ME-only personal offers checked against real listing prices · expired offers excluded, infinite-lifetime offers included</span>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 16, marginBottom: 12 }}>
          <CtaButton disabled={busy} onClick={() => runScan()} style={{ flexShrink: 0 }}>
            {busy ? 'Sweeping…' : 'Sweep'}
          </CtaButton>

          {result && !busy && (
            <div style={{ width: 1, height: 28, background: alpha(VL.purpleTint, 0.12), margin: '0 14px', flexShrink: 0 }} />
          )}

          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {result.hits.length}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                offers above ask
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
              <span style={{ fontSize: 11, color: VLText.muted, ...MONO }}>
                {result.cached ? `${Math.floor(result.cacheAgeMs / 60_000)}m ago · ` : ''}
                {result.collectionsScanned}/{result.collectionsCandidate} collections
              </span>
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter collection/nft…"
              spellCheck={false}
              style={{
                width: 160, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                color: 'var(--vl-text-primary)', outline: 'none',
              }}
            />
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
                {result.hits.length === 0
                  ? 'Sweep found no listing with a personal offer above ask right now.'
                  : 'No hits match the current filter.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={THs} onClick={() => toggleSort('spread')}>SPREAD{arrow('spread')}</th>
                      <th style={THs} onClick={() => toggleSort('listing')}>LISTING{arrow('listing')}</th>
                      <th style={THs} onClick={() => toggleSort('offer')}>OFFER{arrow('offer')}</th>
                      <th style={TH}>STATUS</th>
                      <th style={TH}>FUNDING</th>
                      <th style={THs} onClick={() => toggleSort('collection')}>COLLECTION{arrow('collection')}</th>
                      <th style={TH}>NFT</th>
                      <th style={TH_L}>LINK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((h) => (
                      <tr key={h.bestOfferId} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontWeight: 700, color: rgb(VL.gold) }}>+{fmtSol(h.spreadSol)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, color: 'var(--vl-text-muted)' }}>{fmtSol(h.listingPrice)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{fmtSol(h.bestOfferPrice)}</td>
                        <td style={{ padding: '6px 8px', fontSize: 11, color: statusColor(h.bestOfferStatus) }}>{statusLabel(h.bestOfferStatus)}</td>
                        <td style={{ padding: '6px 8px', fontSize: 11, color: fundingColor(h.fundingStatus) }}>
                          {h.fundingStatus}{h.fundingBalanceSol != null ? ` (${fmtSol(h.fundingBalanceSol)})` : ''}
                        </td>
                        <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--vl-text-primary)' }}>{h.collectionName}</td>
                        <td style={{ padding: '6px 8px', fontSize: 11, color: 'var(--vl-text-muted)' }}>{h.nftName ?? `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <a href={h.meUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#c4b8e8', textDecoration: 'none' }}>ME →</a>
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
            Hit Sweep to scan every active ME collection for a personal offer priced above the current cheapest listing. Slow on a cold cache (~15-20 min, background) — cached 4h server-side after that.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 6 }}>
          Read-only: no wallet connect, no signing, no tx sent. FUNDING reflects the buyer&apos;s M2 escrow balance at scan time — &quot;empty&quot;/&quot;low_balance&quot; offers may not actually be acceptable even though ME still lists them. STATUS &quot;infinite&quot; = offer has no expiry set (same concept as an MMM pool with expiry=0), &quot;active&quot; = expiry in the future. Expired offers are excluded entirely.
        </div>
      </div>
      </div>
    </div>
  );
}
