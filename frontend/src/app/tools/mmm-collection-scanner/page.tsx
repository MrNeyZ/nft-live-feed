'use client';

// VictoryLabs — Tools › MMM Collection Scanner.
// Scans all MMM pools for a collection by FVCA/MCC on-chain.
// Shows only active (non-expired) pools where 0 < realEscrow < spotPrice.
// These "ghost bids" are invisible in the ME UI but executable on-chain
// if the escrow is topped up to the spot price.

import { useEffect, useMemo, useState } from 'react';
import { LiveDot }                      from '@/soloist/shared';
import { authHeaders }                  from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const ADDR_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;


interface UnderfundedPool {
  poolKey:       string;
  escrowPda:     string;
  owner:         string;
  spotPrice:     number;
  spotPriceSol:  number;
  realEscrow:    number;
  realEscrowSol: number;
  missing:       number;
  missingSol:    number;
  expiry:        number;
  allowlists:    Array<{ type: string; pubkey: string }>;
}

interface ScanResult {
  ok:          true;
  fvca:        string | null;
  mcc:         string | null;
  totalFound:  number;
  expired:     number;
  activeTotal: number;
  executable:  number;
  underfunded: number;
  emptyEscrow: number;
  pools:       UnderfundedPool[];
  scannedAt:   string;
}

// ── Styles ───────────────────────────────────────────────────────────────────
const MONO: React.CSSProperties = { fontFamily: "'SF Mono','Fira Code',monospace" };
const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg,#1a1530 0%,#1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06),0 16px 50px rgba(0,0,0,0.6),0 0 0 1px rgba(0,0,0,0.4),0 0 28px rgba(128,104,216,0.10)',
  overflow: 'hidden',
  marginBottom: 16,
};
const TH: React.CSSProperties = {
  padding: '10px 10px', fontSize: 11, fontWeight: 700,
  color: '#9a9ab4', letterSpacing: '0.6px', textAlign: 'right',
  background: 'rgba(28,22,48,0.96)', borderBottom: '1px solid rgba(168,144,232,0.08)',
  textTransform: 'uppercase', userSelect: 'none', whiteSpace: 'nowrap',
};
const TH_L: React.CSSProperties = { ...TH, textAlign: 'left' };
const TD: React.CSSProperties = {
  ...MONO, padding: '10px 10px', fontSize: 12, fontWeight: 600,
  color: '#f0eef8', textAlign: 'right', verticalAlign: 'middle',
  borderBottom: '1px solid rgba(255,255,255,0.022)',
};
const TD_L: React.CSSProperties = { ...TD, textAlign: 'left' };

function fmtSol(lamports: number): string {
  const s = lamports / 1e9;
  return s >= 1 ? s.toFixed(3) : s.toFixed(4);
}
function short(s: string): string {
  return s.length > 10 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s;
}
function SolLink({ addr, label }: { addr: string; label?: string }) {
  return (
    <a href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer"
      style={{ color: '#a890e8', textDecoration: 'none', ...MONO, fontSize: 11 }}
      onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
      onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}>
      {label ?? short(addr)}
    </a>
  );
}
function CopyKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span onClick={copy} title={value}
      style={{ cursor: 'pointer', color: copied ? '#43b984' : '#a890e8', fontSize: 11, ...MONO, userSelect: 'none' }}>
      {copied ? 'copied!' : short(value)}
    </span>
  );
}

function pctFunded(p: UnderfundedPool): number {
  return p.spotPrice > 0 ? (p.realEscrow / p.spotPrice) * 100 : 0;
}
function pctColor(pct: number): string {
  if (pct >= 75) return '#43b984';
  if (pct >= 40) return '#c7b479';
  return '#d96867';
}

function StatChip({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '8px 16px', borderRadius: 8,
      background: 'rgba(168,144,232,0.06)', border: '1px solid rgba(168,144,232,0.14)',
    }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: color ?? '#f0eef8', ...MONO }}>{value}</span>
      <span style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 2 }}>{label}</span>
    </div>
  );
}

export default function MmmCollectionScannerPage() {
  useEffect(() => { document.title = 'MMM Collection Scanner | VictoryLabs'; }, []);

  const [slugInput,    setSlugInput]    = useState('');
  const [resolvedFvca, setResolvedFvca] = useState('');
  const [resolving,    setResolving]    = useState(false);
  const [busy,         setBusy]         = useState(false);
  const [result,       setResult]       = useState<ScanResult | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  type SortCol = 'spot' | 'escrow' | 'missing' | 'pct';
  const VALID_COLS: SortCol[] = ['spot', 'escrow', 'missing', 'pct'];
  const storedCol = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-cs.sortCol') : null;
  const storedDir = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-cs.sortDir') : null;
  const [sortCol, setSortCol] = useState<SortCol>(
    VALID_COLS.includes(storedCol as SortCol) ? (storedCol as SortCol) : 'missing'
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(
    storedDir === 'asc' || storedDir === 'desc' ? storedDir : 'asc'
  );

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) {
      const next: 'asc' | 'desc' = sortDir === 'desc' ? 'asc' : 'desc';
      setSortDir(next);
      localStorage.setItem('vl.mmm-cs.sortDir', next);
    } else {
      const next: 'asc' | 'desc' = col === 'missing' || col === 'pct' ? 'asc' : 'desc';
      setSortCol(col);
      setSortDir(next);
      localStorage.setItem('vl.mmm-cs.sortCol', col);
      localStorage.setItem('vl.mmm-cs.sortDir', next);
    }
  };
  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

  const trimmed = slugInput.trim();
  const isDirectAddr = ADDR_RE.test(trimmed);
  const canScan = !busy && !resolving && trimmed.length > 0;

  const sortedPools = useMemo(() => {
    if (!result) return [];
    return [...result.pools].sort((a, b) => {
      const va = sortCol === 'spot'   ? a.spotPrice
               : sortCol === 'escrow' ? a.realEscrow
               : sortCol === 'pct'    ? (a.spotPrice > 0 ? a.realEscrow / a.spotPrice : 0)
               : a.missing;
      const vb = sortCol === 'spot'   ? b.spotPrice
               : sortCol === 'escrow' ? b.realEscrow
               : sortCol === 'pct'    ? (b.spotPrice > 0 ? b.realEscrow / b.spotPrice : 0)
               : b.missing;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }, [result, sortCol, sortDir]);

  const runScan = async () => {
    if (!canScan) return;
    setBusy(true); setError(null);
    try {
      let fvca = isDirectAddr ? trimmed : resolvedFvca;
      if (!fvca && !isDirectAddr) {
        setResolving(true);
        const rr = await fetch(`${API_BASE}/api/tools/mmm-pools/resolve-slug?slug=${encodeURIComponent(trimmed)}`, {
          headers: { ...authHeaders() },
        });
        const rd = await rr.json().catch(() => null) as { ok: boolean; fvca?: string; error?: string } | null;
        setResolving(false);
        if (!rd || !rd.ok || !rd.fvca) throw new Error(rd?.error ?? (rr.ok ? 'slug_not_found' : `HTTP ${rr.status}`));
        fvca = rd.fvca;
        setResolvedFvca(fvca);
      }
      const params = new URLSearchParams();
      params.set('fvca', fvca);
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/collection-scan?${params}`, {
        headers: { ...authHeaders() },
      });
      if (!r.ok) {
        const b = await r.json().catch(() => null) as { message?: string; error?: string } | null;
        throw new Error(b?.message ?? b?.error ?? `HTTP ${r.status}`);
      }
      setResult(await r.json() as ScanResult);
    } catch (e) {
      setResolving(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feed-root page-transition" data-page="tools-mmm-collection-scanner">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
        <div style={{
          padding: '20px 4px 14px', flexShrink: 0, width: '100%',
          maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', boxSizing: 'border-box',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
                MMM Collection Scanner
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4' }}>
                <LiveDot />
                <span>active pools only · ESCROW = per-pool PDA balance (click to verify on Solscan) · POOL = pool account key</span>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                ME Collection Slug or FVCA
              </label>
              <input
                type="text"
                value={slugInput}
                onChange={e => { setSlugInput(e.target.value); setResolvedFvca(''); setResult(null); setError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') void runScan(); }}
                placeholder="e.g. open_solmap, magicticket, or paste FVCA…"
                spellCheck={false}
                disabled={busy || resolving}
                style={{
                  minWidth: 320, padding: '7px 12px', fontSize: 12,
                  ...MONO, borderRadius: 5, border: '1px solid rgba(168,144,232,0.45)',
                  background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
                }}
              />
            </div>

            {resolvedFvca && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Resolved FVCA</label>
                <div style={{ ...MONO, fontSize: 11, color: '#a890e8', padding: '7px 12px',
                  border: '1px solid rgba(168,144,232,0.22)', borderRadius: 5,
                  background: 'rgba(168,144,232,0.04)' }}>
                  {short(resolvedFvca)}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => void runScan()}
              disabled={!canScan}
              style={{
                padding: '7px 18px', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.5px', textTransform: 'uppercase',
                borderRadius: 5, cursor: canScan ? 'pointer' : 'not-allowed',
                border: '1px solid rgba(168,144,232,0.55)',
                background: canScan
                  ? 'linear-gradient(180deg,rgba(128,104,216,0.28) 0%,rgba(128,104,216,0.14) 100%)'
                  : 'rgba(128,104,216,0.10)',
                color: canScan ? '#f0eef8' : '#9a9ab4',
                boxShadow: canScan ? '0 0 12px rgba(128,104,216,0.18)' : 'none',
                transition: 'all 0.15s', alignSelf: 'flex-end',
              }}
            >
              {resolving ? 'Resolving…' : busy ? 'Scanning…' : 'Scan'}
            </button>
          </div>

          {error && (
            <div style={{
              marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#d96867',
              background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5,
            }}>
              scan failed — {error}
            </div>
          )}
        </div>

        <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '0 4px' }}>

          {/* Summary chips */}
          {result && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <StatChip label="Total Found"   value={result.totalFound} />
              <StatChip label="Expired (skip)" value={result.expired}    color="#9a9ab4" />
              <StatChip label="Active"         value={result.activeTotal} />
              <StatChip label="Executable"     value={result.executable}  color="#43b984" />
              <StatChip label="Underfunded"    value={result.underfunded} color="#c7b479" />
              <StatChip label="Empty"          value={result.emptyEscrow} color="#9a9ab4" />
              <div style={{ ...MONO, fontSize: 10, color: '#9a9ab4', alignSelf: 'flex-end', paddingBottom: 4 }}>
                {new Date(result.scannedAt).toLocaleTimeString()}
              </div>
            </div>
          )}

          {/* Results table */}
          <div style={PANEL}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 800 }}>
                <colgroup>
                  <col style={{ width: '22%' }} />{/* POOL */}
                  <col style={{ width: '10%' }} />{/* SPOT */}
                  <col style={{ width: '10%' }} />{/* ESCROW */}
                  <col style={{ width: '10%' }} />{/* MISSING */}
                  <col style={{ width:  '8%' }} />{/* % FUNDED */}
                  <col style={{ width: '18%' }} />{/* OWNER */}
                  <col style={{ width: '10%' }} />{/* EXPIRY */}
                  <col style={{ width: '12%' }} />{/* LINKS */}
                </colgroup>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={TH_L}>POOL</th>
                    <th style={{ ...TH, cursor: 'pointer' }} onClick={() => toggleSort('spot')}>SPOT{arrow('spot')}</th>
                    <th style={{ ...TH, cursor: 'pointer' }} onClick={() => toggleSort('escrow')}>ESCROW{arrow('escrow')}</th>
                    <th style={{ ...TH, cursor: 'pointer' }} onClick={() => toggleSort('missing')}>MISSING{arrow('missing')}</th>
                    <th style={{ ...TH, cursor: 'pointer' }} onClick={() => toggleSort('pct')}>% FUNDED{arrow('pct')}</th>
                    <th style={TH_L}>OWNER</th>
                    <th style={TH}>EXPIRY</th>
                    <th style={{ ...TH, textAlign: 'center' }}>LINKS</th>
                  </tr>
                </thead>
                <tbody>
                  {!result && !busy && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: '#9a9ab4', padding: '64px 24px', fontSize: 13, lineHeight: 1.5 }}>
                      Select a collection and click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan</span> to find underfunded MMM pools.
                      <br />
                      <span style={{ fontSize: 11 }}>These pools are invisible in the ME UI but can execute on-chain if the escrow is topped up.</span>
                    </td></tr>
                  )}
                  {busy && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: '#9a9ab4', padding: '64px 24px', fontSize: 13 }}>
                      Querying {6} allowlist slots × 2 types via getProgramAccounts…
                    </td></tr>
                  )}
                  {result && result.pools.length === 0 && !busy && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: '#9a9ab4', padding: '64px 24px', fontSize: 13 }}>
                      No underfunded active pools found for this collection.
                    </td></tr>
                  )}
                  {sortedPools.map(p => {
                    const pct = pctFunded(p);
                    return (
                      <tr key={p.poolKey} style={{ borderBottom: '1px solid rgba(255,255,255,0.022)' }}>
                        <td style={TD_L}>
                          <CopyKey value={p.poolKey} />
                        </td>
                        <td style={TD}>
                          <span style={{ color: '#f0eef8', fontWeight: 700 }}>{fmtSol(p.spotPrice)}</span>
                          <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                        </td>
                        <td style={TD}>
                          <a
                            href={`https://solscan.io/account/${p.escrowPda}`}
                            target="_blank" rel="noopener noreferrer"
                            title={`Escrow PDA: ${p.escrowPda}`}
                            style={{ color: '#c7b479', textDecoration: 'none', ...MONO, fontSize: 12, fontWeight: 600 }}
                            onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
                            onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}
                          >
                            {fmtSol(p.realEscrow)}
                          </a>
                          <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                        </td>
                        <td style={TD}>
                          <span style={{ color: '#d96867', fontWeight: 700 }}>{fmtSol(p.missing)}</span>
                          <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                        </td>
                        <td style={{ ...TD, color: pctColor(pct), fontWeight: 700 }}>
                          {pct.toFixed(1)}%
                        </td>
                        <td style={TD_L}>
                          <a href={`https://magiceden.io/u/${p.owner}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: '#a890e8', textDecoration: 'none', ...MONO, fontSize: 11 }}
                            onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
                            onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}>
                            {short(p.owner)}
                          </a>
                        </td>
                        <td style={{ ...TD, color: '#9a9ab4', fontSize: 11 }}>
                          {p.expiry === 0 ? 'no expiry' : new Date(p.expiry * 1000).toLocaleDateString()}
                        </td>
                        <td style={{ ...TD, textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                            <a
                              href={`https://magiceden.io/mmm/pool/${p.poolKey}`}
                              target="_blank" rel="noopener noreferrer"
                              title="ME Pool"
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 26, height: 26, borderRadius: 5, overflow: 'hidden',
                                border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
                                textDecoration: 'none', flexShrink: 0, lineHeight: 0,
                              }}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/brand/me.png" alt="ME" width={22} height={22}
                                draggable={false} style={{ display: 'block', width: 22, height: 22, objectFit: 'cover', pointerEvents: 'none' }} />
                            </a>
                            <a
                              href={`/tools/mmm-pool-lookup?pool=${encodeURIComponent(p.poolKey)}`}
                              title="Pool Lookup"
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 26, height: 26, borderRadius: 5,
                                border: '1px solid rgba(168,144,232,0.35)',
                                background: 'rgba(168,144,232,0.08)',
                                cursor: 'pointer', textDecoration: 'none',
                                fontSize: 11, fontWeight: 700, color: '#a890e8',
                              }}
                            >
                              ↗
                            </a>
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
      </div>
    </div>
  );
}
