'use client';

// VictoryLabs — Tools › OpenSea (OS2) vs Magic Eden Flip Scanner.
// Full on-chain sweep of OpenSea Solana's live MPL Core listings
// (7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V program, no IDL —
// reverse-engineered, see tools-opensea-arb.ts header for the byte layout
// and what was verified vs guessed), grouped into collections via Helius
// DAS, floor compared against Magic Eden's own floor + top MMM pool bid.
//
// Two tables, split by direction (buy cheap, flip on the other market):
//   CHEAPER ON OS2 — OS2's real floor undercuts ME's real top MMM bid.
//     Buy on OS2, instant-sell into the ME bid. Both legs are ground-truth
//     on-chain/API data.
//   DEARER ON OS2 — ME's floor undercuts OS2's floor. Buy on ME, list on
//     OS2 under its current floor. This is a list-and-wait flip, not an
//     instant one — OS2's own top BID per collection isn't attributable
//     to a specific collection at scale (its collection field is an
//     opaque off-chain ID with no derivable link — see backend header).
//
// profitNetSol subtracts creator royalty (Tensor sellRoyaltyFeeBPS) off
// the sell-side price only. Marketplace cuts (~1.5-2% each side, ME/OS2)
// are NOT included — real net is a bit lower still.
//
// Read-only: no wallet connect, no signing, no tx sent.
// Data: GET /api/tools/opensea-arb/scan-stream (SSE)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, CtaButton } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, TH_L } from '@/app/tools/mmm-shared';

interface ArbRow {
  name: string;
  collection: string;
  slug: string | null;
  osFloorSol: number;
  osCount: number;
  meFloorSol: number | null;
  meTopBidSol: number | null;
  royaltyBps: number | null;
  profitSol: number;
  profitNetSol: number;
  profitPct: number;
}

interface ScanResult {
  cheaperOnOS: ArbRow[];
  dearerOnOS: ArbRow[];
  totalCollectionsScanned: number;
  cached: boolean;
  cacheAgeMs: number;
}

const RESULT_KEY = 'vl.openseaArb.result';

function fmtSol(sol: number | null | undefined): string {
  if (sol == null) return '—';
  return sol.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
function fmtPct(bps: number | null): string {
  if (bps == null) return '—';
  return `${(bps / 100).toFixed(1)}%`;
}

function ArbTable({ rows, buySide, sellSide, buyLabel, sellLabel, emptyMsg }: {
  rows: ArbRow[];
  buySide: (r: ArbRow) => number;
  sellSide: (r: ArbRow) => number;
  buyLabel: string;
  sellLabel: string;
  emptyMsg: string;
}) {
  if (rows.length === 0) {
    return <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>{emptyMsg}</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={TH_L}>COLLECTION</th>
            <th style={TH}>{buyLabel}</th>
            <th style={TH}>{sellLabel}</th>
            <th style={TH}>SPREAD</th>
            <th style={TH}>ROYALTY</th>
            <th style={TH}>NET PROFIT</th>
            <th style={TH}>OS2 LISTED</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.collection} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--vl-text-primary)' }}>{r.name}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, color: 'var(--vl-text-muted)' }}>{fmtSol(buySide(r))}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{fmtSol(sellSide(r))}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontWeight: 700, color: rgb(VL.gold) }}>+{r.profitPct.toFixed(1)}%</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontSize: 11, color: 'var(--vl-text-muted)' }}>{fmtPct(r.royaltyBps)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontWeight: 700, color: r.profitNetSol > 0 ? 'var(--vl-green-primary)' : 'var(--vl-red-primary)' }}>
                {r.profitNetSol > 0 ? '+' : ''}{fmtSol(r.profitNetSol)}
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO, fontSize: 11, color: 'var(--vl-text-muted)' }}>{r.osCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OpenseaArbPage() {
  useEffect(() => { document.title = 'OpenSea vs ME Flip | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<ScanResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(RESULT_KEY) : null;
      return raw ? (JSON.parse(raw) as ScanResult) : null;
    } catch { return null; }
  });
  const [scanError, setScanError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  const runScan = useCallback((opts?: { force?: boolean }) => {
    if (busy) return;
    playUiConfirm();
    setBusy(true);
    setLogs([]);
    setScanError(null);

    const params = new URLSearchParams();
    if (opts?.force) params.set('force', '1');
    const url = `${API_BASE}/api/tools/opensea-arb/scan-stream?${params.toString()}`;

    esRef.current?.close();
    const es = new EventSource(url);
    esRef.current = es;
    const closeEs = () => { if (esRef.current === es) esRef.current = null; es.close(); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as {
          type: string; msg?: string;
          cheaperOnOS?: ArbRow[]; dearerOnOS?: ArbRow[]; totalCollectionsScanned?: number;
          cached?: boolean; cacheAgeMs?: number;
        };
        if (data.type === 'progress' && data.msg) {
          setLogs(prev => [...prev.slice(-6), data.msg!]);
        } else if (data.type === 'result' && data.cheaperOnOS && data.dearerOnOS) {
          const r: ScanResult = {
            cheaperOnOS: data.cheaperOnOS,
            dearerOnOS: data.dearerOnOS,
            totalCollectionsScanned: data.totalCollectionsScanned ?? 0,
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

  const totalHits = useMemo(() => (result ? result.cheaperOnOS.length + result.dearerOnOS.length : 0), [result]);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          OPENSEA (OS2) vs MAGIC EDEN — FLIP SCANNER
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · on-chain OS2 listings (MPL Core only, no IDL exists) vs ME floor + top MMM pool bid · NET PROFIT deducts creator royalty only, not marketplace fees</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 16, marginBottom: 12 }}>
          <CtaButton disabled={busy} onClick={() => runScan()} style={{ flexShrink: 0 }}>
            {busy ? 'Scanning…' : 'Scan'}
          </CtaButton>

          {result && !busy && (
            <div style={{ width: 1, height: 28, background: alpha(VL.purpleTint, 0.12), margin: '0 14px', flexShrink: 0 }} />
          )}
          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>{totalHits}</span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>flip opportunities</span>
            </div>
          )}
          {result?.cached && !busy && (
            <button type="button" onClick={() => runScan({ force: true })}
              style={{ padding: '3px 0', fontSize: 11, fontWeight: 500, background: 'none', border: 'none', color: VLText.faint, cursor: 'pointer', marginRight: 10, textDecoration: 'underline', textDecorationColor: alpha(VL.purpleTint, 0.25), textUnderlineOffset: '3px', flexShrink: 0 }}>
              ↺ refresh
            </button>
          )}
          {result && !busy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, lineHeight: 1, flexShrink: 0 }}>
              <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.42), textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>{result.cached ? 'cached' : 'live scan'}</span>
              <span style={{ fontSize: 11, color: VLText.muted, ...MONO }}>
                {result.cached ? `${Math.floor(result.cacheAgeMs / 60_000)}m ago · ` : ''}{result.totalCollectionsScanned} OS2 collections scanned
              </span>
            </div>
          )}
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
          <div style={{ marginBottom: 12, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)', background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5 }}>
            {scanError}
          </div>
        )}

        {result && (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: rgb(VL.gold), textTransform: 'uppercase', letterSpacing: '0.8px', margin: '4px 0 6px' }}>
              Cheaper on OS2 — buy OS2 floor, sell into ME&apos;s top bid (instant flip)
            </div>
            <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
              <ArbTable
                rows={result.cheaperOnOS}
                buySide={(r) => r.osFloorSol}
                sellSide={(r) => r.meTopBidSol ?? 0}
                buyLabel="OS2 FLOOR"
                sellLabel="ME TOP BID"
                emptyMsg="No collection currently cheaper on OS2 than ME's top bid."
              />
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.8px', margin: '16px 0 6px' }}>
              Dearer on OS2 — buy ME floor, list on OS2 under its floor (list-and-wait flip)
            </div>
            <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
              <ArbTable
                rows={result.dearerOnOS}
                buySide={(r) => r.meFloorSol ?? 0}
                sellSide={(r) => r.osFloorSol}
                buyLabel="ME FLOOR"
                sellLabel="OS2 FLOOR"
                emptyMsg="No collection currently cheaper on ME than OS2's floor."
              />
            </div>
          </>
        )}

        {!result && !busy && logs.length === 0 && (
          <div style={{ ...PANEL, padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
            Hit Scan to sweep every live OpenSea Solana (OS2) MPL Core listing, group by collection, and compare against Magic Eden. Takes a couple minutes cold (Tensor slug resolve is rate-limited to 1 req/sec) — cached 20m server-side after that.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 6 }}>
          Read-only: no wallet connect, no signing, no tx sent. OS2 has no public IDL — listings were reverse-engineered byte-by-byte and verified against live instruction data; legacy (pre-Core) OS2 listings are not covered, MPL Core only. &quot;Dearer on OS2&quot; is floor-vs-floor (a list-and-wait flip), not bid-vs-bid — OS2&apos;s own collection-wide bids exist on-chain but carry an opaque off-chain collection ID with no general way to attribute a bid to a collection, so they&apos;re not scanned here.
        </div>
      </div>
      </div>
    </div>
  );
}
