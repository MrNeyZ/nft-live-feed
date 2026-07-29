'use client';

// VictoryLabs — Tools › MMM Pool Scanner.
// Read-only: shows on-chain state of all MMM bid pools for a given owner.
// Reports spotPrice, tracked bpa, real escrow balance, missing, divergence.
// No wallet, no signing, no transactions.

import { useEffect, useState } from 'react';
import { LiveDot }             from '@/soloist/shared';
import { authHeaders }         from '@/runtime/auth';
import { API_BASE, ADDR_RE, MONO, PANEL, ToolButton, ToolTextInput, fmtSol, short, CopyKey, TH, TH_L } from '@/app/tools/mmm-shared';

interface MmmPool {
  poolKey:        string;
  escrowPda:      string;
  collectionName: string;
  collectionSymbol: string;
  poolType:       string;
  isMIP1:         boolean;
  spotPrice:      number;
  spotPriceSol:   number;
  bpa:            number;
  bpaSol:         number;
  realEscrow:     number;
  realEscrowSol:  number;
  missing:        number;
  missingSol:     number;
  divergence:     number;
  divergenceSol:  number;
  expiry:         number;
  executable:     boolean;
  underfunded:    boolean;
  diverged:       boolean;
  allowlists:     Array<{ type: string; pubkey: string }>;
}

interface ScanResult {
  ok:          true;
  owner:       string;
  total:       number;
  executable:  number;
  underfunded: number;
  diverged:    number;
  pools:       MmmPool[];
  scannedAt:   string;
}

// ── Styles ───────────────────────────────────────────────────────────────────
const TD: React.CSSProperties = {
  ...MONO, padding: '11px 10px', fontSize: 12, fontWeight: 600,
  color: '#f0eef8', textAlign: 'right', verticalAlign: 'middle',
  borderBottom: '1px solid rgba(255,255,255,0.022)',
};
const TD_L: React.CSSProperties = { ...TD, textAlign: 'left' };

function pill(label: string, color: string, bg: string, border: string): React.ReactElement {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', fontSize: 9, fontWeight: 700,
      letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 3,
      lineHeight: 1.3, fontFamily: "'SF Mono','Fira Code',monospace",
      color, background: bg, border: `1px solid ${border}`,
    }}>{label}</span>
  );
}

function ExecPill({ executable }: { executable: boolean }) {
  return executable
    ? pill('EXEC', '#43b984', 'rgba(92,224,160,0.15)', 'rgba(92,224,160,0.45)')
    : pill('no',   '#9a9ab4', 'rgba(122,122,148,0.06)', 'rgba(122,122,148,0.20)');
}
function DivPill({ diverged, sol }: { diverged: boolean; sol: number }) {
  if (!diverged || sol <= 0) return null;
  return pill(`+${fmtSol(sol * 1e9)}`, '#c7b479', 'rgba(232,193,74,0.12)', 'rgba(232,193,74,0.35)');
}

// ── Component ────────────────────────────────────────────────────────────────
export default function MmmPoolsPage() {
  useEffect(() => { document.title = 'MMM Pool Scanner | VictoryLabs'; }, []);

  const [inputVal, setInputVal]   = useState('');
  const [busy, setBusy]           = useState(false);
  const [result, setResult]       = useState<ScanResult | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const LS = (k: string) => typeof window !== 'undefined' ? localStorage.getItem(k) : null;
  const VALID_SCAN_COLS = ['bpa', 'spot', 'missing'] as const;
  type ScanSortCol = 'bpa' | 'spot' | 'missing';
  const storedSortCol = LS('vl.mmm-scan.sortCol');
  const storedSortDir = LS('vl.mmm-scan.sortDir');
  const [sortCol, setSortCol] = useState<ScanSortCol | null>(
    VALID_SCAN_COLS.includes(storedSortCol as ScanSortCol) ? (storedSortCol as ScanSortCol) : null
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(
    storedSortDir === 'asc' || storedSortDir === 'desc' ? storedSortDir : 'desc'
  );

  const toggleSort = (col: ScanSortCol) => {
    if (sortCol === col) {
      const next: 'asc' | 'desc' = sortDir === 'desc' ? 'asc' : 'desc';
      setSortDir(next); localStorage.setItem('vl.mmm-scan.sortDir', next);
    } else {
      setSortCol(col); localStorage.setItem('vl.mmm-scan.sortCol', col);
      setSortDir('desc'); localStorage.setItem('vl.mmm-scan.sortDir', 'desc');
    }
  };

  const canScan = ADDR_RE.test(inputVal.trim()) && !busy;

  const runScan = async () => {
    if (!canScan) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/tools/mmm-pools/scan?owner=${encodeURIComponent(inputVal.trim())}`,
        { headers: { ...authHeaders() } },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as ScanResult;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void runScan(); };

  const highlighted = (() => {
    const base = result?.pools.filter(p => p.underfunded) ?? [];
    if (!sortCol) return base;
    return [...base].sort((a, b) => {
      const va = sortCol === 'bpa' ? a.bpa : sortCol === 'spot' ? a.spotPrice : a.missing;
      const vb = sortCol === 'bpa' ? b.bpa : sortCol === 'spot' ? b.spotPrice : b.missing;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  })();

  return (
    <div className="feed-root page-transition" data-page="tools-mmm-pools" style={{ overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
              MMM Pool Scanner
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4' }}>
              <LiveDot />
              <span>read-only · on-chain escrow audit · no wallet needed</span>
              {result && (
                <>
                  <span style={{ color: '#241f3b', margin: '0 6px' }}>·</span>
                  <span>{result.total} pools</span>
                  {result.executable > 0 && (
                    <><span style={{ color: '#241f3b', margin: '0 6px' }}>·</span>
                    <span style={{ color: '#43b984', fontWeight: 700 }}>{result.executable} executable</span></>
                  )}
                  {result.underfunded > 0 && (
                    <><span style={{ color: '#241f3b', margin: '0 6px' }}>·</span>
                    <span style={{ color: '#c7b479' }}>{result.underfunded} underfunded</span></>
                  )}
                  {result.diverged > 0 && (
                    <><span style={{ color: '#241f3b', margin: '0 6px' }}>·</span>
                    <span style={{ color: '#a890e8' }}>{result.diverged} diverged</span></>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Input row */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <ToolTextInput
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={onKey}
            placeholder="Owner wallet address (base58)"
            style={{ flex: 1, minWidth: 280 }}
          />
          <ToolButton onClick={() => void runScan()} disabled={!canScan}>
            {busy ? 'Scanning…' : 'Scan Pools'}
          </ToolButton>
        </div>

        {error && (
          <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, color: '#d96867', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5 }}>
            scan failed — {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto' }}>
          {result.executable === 0 && highlighted.length === 0 && (
            <div style={{ padding: '10px 4px', fontSize: 12, color: '#9a9ab4' }}>
              No pools match filter (expiry=0, tracked&gt;0, tracked&lt;spot). Total pools: {result.total}.
            </div>
          )}
          {highlighted.length > 0 && (
            <div style={{ ...PANEL }}>
              {/* Summary strip */}
              <div style={{ padding: '10px 14px', fontSize: 11, color: '#9a9ab4', borderBottom: '1px solid rgba(168,144,232,0.08)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ color: '#f0eef8', fontWeight: 600 }}>
                  {highlighted.length} pool{highlighted.length !== 1 ? 's' : ''} · expiry=0 · tracked&gt;0 · tracked&lt;spot
                </span>
                {result.executable > 0 && <span style={{ color: '#43b984', fontWeight: 700 }}>{result.executable} EXECUTABLE</span>}
                <span style={{ ...MONO, fontSize: 10 }}>{short(result.owner)}</span>
                <span style={{ marginLeft: 'auto', ...MONO, fontSize: 10 }}>{new Date(result.scannedAt).toLocaleTimeString()}</span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
                  <colgroup>
                    <col style={{ minWidth: 130 }} />{/* Collection  */}
                    <col style={{ minWidth: 100 }} />{/* Pool Key   */}
                    <col style={{ minWidth: 100 }} />{/* Escrow PDA */}
                    <col style={{ minWidth: 90  }} />{/* Spot        */}
                    <col style={{ minWidth: 90  }} />{/* Tracked     */}
                    <col style={{ minWidth: 90  }} />{/* Real        */}
                    <col style={{ minWidth: 90  }} />{/* Missing     */}
                    <col style={{ minWidth: 80  }} />{/* Divergence  */}
                    <col style={{ minWidth: 55  }} />{/* Expiry      */}
                    <col style={{ minWidth: 70  }} />{/* Pool Type   */}
                    <col style={{ minWidth: 60  }} />{/* Exec        */}
                  </colgroup>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <th style={TH_L}>Collection</th>
                      <th style={TH_L}>Pool Key</th>
                      <th style={TH_L}>Escrow PDA</th>
                      <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('spot')}>Spot{sortCol==='spot' ? (sortDir==='desc'?' ↓':' ↑') : ''}</th>
                      <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('bpa')}>Tracked{sortCol==='bpa' ? (sortDir==='desc'?' ↓':' ↑') : ''}</th>
                      <th style={TH}>Real</th>
                      <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('missing')}>Missing{sortCol==='missing' ? (sortDir==='desc'?' ↓':' ↑') : ''}</th>
                      <th style={TH}>Divergence</th>
                      <th style={TH}>Expiry</th>
                      <th style={TH}>Type</th>
                      <th style={{ ...TH, textAlign: 'center' }}>Exec</th>
                    </tr>
                  </thead>
                  <tbody>
                    {highlighted.map(p => {
                      const rowBg = p.executable
                        ? 'rgba(92,224,160,0.04)'
                        : p.diverged
                        ? 'rgba(232,193,74,0.03)'
                        : undefined;
                      const colSym = p.collectionName || p.collectionSymbol || '—';
                      const allowStr = p.allowlists.length > 0
                        ? `${p.allowlists[0].type}:${short(p.allowlists[0].pubkey)}`
                        : 'any';

                      return (
                        <tr key={p.poolKey} style={{ background: rowBg }}>
                          <td style={TD_L}>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#f0eef8' }}>
                              {colSym.length > 22 ? colSym.slice(0, 20) + '…' : colSym}
                            </div>
                            <div style={{ fontSize: 10, color: '#9a9ab4', marginTop: 1 }}>{allowStr}</div>
                          </td>
                          <td style={TD_L}>
                            <CopyKey value={p.poolKey} />
                          </td>
                          <td style={TD_L}>
                            <a
                              href={`https://solscan.io/account/${p.escrowPda}`}
                              target="_blank" rel="noopener noreferrer"
                              style={{ color: '#9a9ab4', textDecoration: 'none', fontSize: 11, ...MONO }}
                              onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
                              onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}
                              title={p.escrowPda}
                            >
                              {short(p.escrowPda)}
                            </a>
                          </td>
                          <td style={TD}>{fmtSol(p.spotPrice)}</td>
                          <td style={{ ...TD, color: '#c7b479' }}>{fmtSol(p.bpa)}</td>
                          <td style={{ ...TD, color: p.executable ? '#43b984' : '#f0eef8' }}>
                            {fmtSol(p.realEscrow)}
                          </td>
                          <td style={{ ...TD, color: p.missing <= 0 ? '#43b984' : '#d96867' }}>
                            {p.missing <= 0 ? '0' : fmtSol(p.missing)}
                          </td>
                          <td style={{ ...TD, color: p.diverged ? '#c7b479' : '#9a9ab4' }}>
                            {p.diverged ? (
                              <DivPill diverged={p.diverged} sol={p.divergence / 1e9} />
                            ) : '—'}
                          </td>
                          <td style={{ ...TD, color: '#9a9ab4', fontSize: 11 }}>
                            {p.expiry === 0 ? 'none' : String(p.expiry)}
                          </td>
                          <td style={{ ...TD, fontSize: 10, color: '#9a9ab4' }}>
                            {p.poolType || '—'}
                            {p.isMIP1 && <div style={{ fontSize: 9, color: '#a890e8' }}>MIP1</div>}
                          </td>
                          <td style={{ ...TD, textAlign: 'center' }}>
                            <ExecPill executable={p.executable} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* All pools (collapsed summary) */}
          {result.total > highlighted.length && (
            <details style={{ padding: '0 4px', marginBottom: 12 }}>
              <summary style={{ fontSize: 11, color: '#9a9ab4', cursor: 'pointer', userSelect: 'none', padding: '4px 0' }}>
                All {result.total} pools (including bpa=0 and fully-funded)
              </summary>
              <div style={{ ...PANEL, marginTop: 8 }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={TH_L}>Collection</th>
                        <th style={TH_L}>Pool Key</th>
                        <th style={TH}>Spot</th>
                        <th style={TH}>Tracked</th>
                        <th style={TH}>Real</th>
                        <th style={TH}>Missing</th>
                        <th style={TH}>Expiry</th>
                        <th style={{ ...TH, textAlign: 'center' }}>Exec</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.pools.map(p => (
                        <tr key={p.poolKey}>
                          <td style={TD_L}>{(p.collectionName || p.collectionSymbol || '—').slice(0, 24)}</td>
                          <td style={TD_L}>
                            <CopyKey value={p.poolKey} />
                          </td>
                          <td style={TD}>{fmtSol(p.spotPrice)}</td>
                          <td style={{ ...TD, color: '#c7b479' }}>{fmtSol(p.bpa)}</td>
                          <td style={{ ...TD, color: p.executable ? '#43b984' : '#f0eef8' }}>{fmtSol(p.realEscrow)}</td>
                          <td style={{ ...TD, color: p.missing <= 0 ? '#43b984' : '#9a9ab4' }}>
                            {p.missing <= 0 ? '0' : fmtSol(p.missing)}
                          </td>
                          <td style={{ ...TD, color: '#9a9ab4', fontSize: 11 }}>{p.expiry === 0 ? 'none' : String(p.expiry)}</td>
                          <td style={{ ...TD, textAlign: 'center' }}><ExecPill executable={p.executable} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          )}
        </div>
      )}

      {!result && !busy && !error && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '0 4px' }}>
          <div style={{ ...PANEL, padding: '48px 24px', textAlign: 'center', color: '#9a9ab4', fontSize: 13, lineHeight: 1.6 }}>
            Paste an owner wallet address and click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan Pools</span>.<br />
            Returns all MMM bid pools with live escrow balances. Read-only.
          </div>
        </div>
      )}
    </div>
  );
}
