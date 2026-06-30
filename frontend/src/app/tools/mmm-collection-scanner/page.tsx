'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot }                                            from '@/soloist/shared';
import { authHeaders }                                        from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const ADDR_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Types ────────────────────────────────────────────────────────────────────
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
  ok:              true;
  fvca:            string | null;
  mcc:             string | null;
  collectionName?: string;
  collectionSlug?: string;
  totalFound:      number;
  expired:         number;
  activeTotal:     number;
  executable:      number;
  underfunded:     number;
  emptyEscrow:     number;
  pools:           UnderfundedPool[];
  scannedAt:       string;
}
interface TriageCollection {
  alType:          string;
  alKey:           string;
  count:           number;
  bestPct:         number;
  avgPct:          number;
  bestPool:        string;
  bestSpotSol:     number;
  bestRealSol:     number;
  bestMissingSol:  number;
  totalMissingSol: number;
  tier:            'HIGH' | 'LOW' | 'VERY_LOW' | 'SKIP';
  collectionName:  string;
  collectionSlug:  string;
}
interface TriageResult {
  collections:      TriageCollection[];
  totalPools:       number;
  underfundedTotal: number;
  collectionCount:  number;
  minPct:           number;
  cached?:          boolean;
  cacheAgeMs?:      number;
  fast?:            boolean;
}
interface FlatPool {
  poolKey:        string;
  escrowPda:      string;
  owner:          string;
  spotPriceSol:   number;
  realEscrowSol:  number;
  missingSol:     number;
  pct:            number;
  alType:         string;
  alKey:          string;
  collectionName: string;
}
interface PoolFeedResult {
  pools:      FlatPool[];
  cached:     boolean;
  cacheAgeMs: number;
}

// ── Shared styles ─────────────────────────────────────────────────────────────
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
  ...MONO, padding: '9px 10px', fontSize: 12, fontWeight: 600,
  color: '#f0eef8', textAlign: 'right', verticalAlign: 'middle',
  borderBottom: '1px solid rgba(255,255,255,0.022)',
};
const TD_L: React.CSSProperties = { ...TD, textAlign: 'left' };

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtSol(lamports: number): string {
  const s = lamports / 1e9;
  return s >= 1 ? s.toFixed(3) : s.toFixed(4);
}
function short(s: string): string {
  return s.length > 10 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s;
}
function pctFunded(p: UnderfundedPool): number {
  return p.spotPrice > 0 ? (p.realEscrow / p.spotPrice) * 100 : 0;
}
function pctColor(pct: number): string {
  if (pct >= 20) return '#43b984';
  if (pct >=  5) return '#c7b479';
  return '#d96867';
}
function tierColor(t: string): string {
  if (t === 'HIGH')     return '#43b984';
  if (t === 'LOW')      return '#c7b479';
  if (t === 'VERY_LOW') return '#a890e8';
  return '#9a9ab4';
}

// ── Atom components ───────────────────────────────────────────────────────────
function CopyKey({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span onClick={copy} title={value}
      style={{ cursor: 'pointer', color: copied ? '#43b984' : '#a890e8', fontSize: 11, ...MONO, userSelect: 'none' }}>
      {copied ? 'copied!' : (label ?? short(value))}
    </span>
  );
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
function TierChip({ tier }: { tier: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: 10,
      fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase',
      color: tierColor(tier),
      background: `${tierColor(tier)}22`,
      border: `1px solid ${tierColor(tier)}55`,
    }}>{tier === 'VERY_LOW' ? 'V.LOW' : tier}</span>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
type Tab = 'collection' | 'triage' | 'poolfeed';
function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'collection', label: 'Collection Scan' },
    { id: 'triage',     label: 'Triage' },
    { id: 'poolfeed',   label: 'Pool Feed' },
  ];
  return (
    <div style={{ display: 'flex', gap: 2, marginTop: 14, borderBottom: '1px solid rgba(168,144,232,0.18)' }}>
      {tabs.map(t => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          style={{
            padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: 'none', borderBottom: active === t.id ? '2px solid #a890e8' : '2px solid transparent',
            marginBottom: -1,
            background: active === t.id ? 'rgba(168,144,232,0.13)' : 'transparent',
            color: active === t.id ? '#c4aef8' : '#9a9ab4',
            borderRadius: '6px 6px 0 0',
            letterSpacing: '0.3px',
            transition: 'all 0.12s',
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function MmmCollectionScannerPage() {
  useEffect(() => { document.title = 'MMM Collection Scanner | VictoryLabs'; }, []);

  const [activeTab, setActiveTab] = useState<Tab>('collection');

  // ── Collection scan state ─────────────────────────────────────────────────
  const [slugInput,      setSlugInput]      = useState('');
  const [resolvedFvca,    setResolvedFvca]    = useState('');
  const [collectionName,  setCollectionName]  = useState('');
  const [collectionSlugS, setCollectionSlugS] = useState('');
  const [resolving,       setResolving]       = useState(false);
  const [busy,           setBusy]           = useState(false);
  const [scanResult,     setScanResult]     = useState<ScanResult | null>(null);
  const [scanError,      setScanError]      = useState<string | null>(null);

  // Ref holding an FVCA that should be auto-scanned when Collection Scan tab opens.
  // Set by jumpToCollectionScan; consumed by the useEffect below.
  const pendingAutoScanRef = useRef<string | null>(null);

  type SortCol = 'spot' | 'escrow' | 'missing' | 'pct';
  const VALID_COLS: SortCol[] = ['spot', 'escrow', 'missing', 'pct'];
  const storedCol = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-cs.sortCol') : null;
  const storedDir = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-cs.sortDir') : null;
  const [sortCol, setSortCol] = useState<SortCol>(VALID_COLS.includes(storedCol as SortCol) ? (storedCol as SortCol) : 'missing');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(storedDir === 'asc' || storedDir === 'desc' ? storedDir : 'asc');

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) {
      const next: 'asc' | 'desc' = sortDir === 'desc' ? 'asc' : 'desc';
      setSortDir(next); localStorage.setItem('vl.mmm-cs.sortDir', next);
    } else {
      const next: 'asc' | 'desc' = col === 'missing' || col === 'pct' ? 'asc' : 'desc';
      setSortCol(col); setSortDir(next);
      localStorage.setItem('vl.mmm-cs.sortCol', col);
      localStorage.setItem('vl.mmm-cs.sortDir', next);
    }
  };
  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

  const trimmed      = slugInput.trim();
  const isDirectAddr = ADDR_RE.test(trimmed);
  const canScan      = !busy && !resolving && trimmed.length > 0;

  const sortedPools = useMemo(() => {
    if (!scanResult) return [];
    return [...scanResult.pools].sort((a, b) => {
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
  }, [scanResult, sortCol, sortDir]);

  const runCollectionScan = useCallback(async (overrideFvca?: string) => {
    if (!overrideFvca && !canScan) return;
    setBusy(true); setScanError(null);
    try {
      let fvca = overrideFvca ?? (isDirectAddr ? trimmed : resolvedFvca);
      if (!fvca && !isDirectAddr) {
        setResolving(true);
        const rr = await fetch(`${API_BASE}/api/tools/mmm-pools/resolve-slug?slug=${encodeURIComponent(trimmed)}`, { headers: { ...authHeaders() } });
        const rd = await rr.json().catch(() => null) as { ok: boolean; fvca?: string; collectionName?: string; error?: string } | null;
        setResolving(false);
        if (!rd?.ok || !rd.fvca) throw new Error(rd?.error ?? (rr.ok ? 'slug_not_found' : `HTTP ${rr.status}`));
        fvca = rd.fvca;
        setResolvedFvca(fvca);
        setCollectionName(rd.collectionName ?? '');
      }
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/collection-scan?fvca=${encodeURIComponent(fvca)}`, { headers: { ...authHeaders() } });
      if (!r.ok) {
        const b = await r.json().catch(() => null) as { message?: string; error?: string } | null;
        throw new Error(b?.message ?? b?.error ?? `HTTP ${r.status}`);
      }
      const result = await r.json() as ScanResult;
      setScanResult(result);
      // Prefer name from scan response (resolved server-side via DAS+Tensor)
      // over whatever was set by slug resolution or triage jump (which may be empty)
      if (result.collectionName) setCollectionName(result.collectionName);
      if (result.collectionSlug) setCollectionSlugS(result.collectionSlug);
    } catch (e) {
      setResolving(false);
      setScanError((e as Error).message);
    } finally { setBusy(false); }
  }, [canScan, isDirectAddr, trimmed, resolvedFvca]);

  // Auto-scan when tab switches to collection with a pending FVCA from Triage/FromFile
  useEffect(() => {
    if (activeTab !== 'collection') return;
    const fvca = pendingAutoScanRef.current;
    if (!fvca) return;
    pendingAutoScanRef.current = null;
    void runCollectionScan(fvca);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Jump from Triage/FromFile → Collection Scan with auto-scan
  const jumpToCollectionScan = useCallback((fvca: string, name?: string, slug?: string) => {
    setSlugInput(fvca);
    setResolvedFvca(fvca);
    setCollectionName(name ?? '');
    setCollectionSlugS(slug ?? '');
    setScanResult(null);
    setScanError(null);
    pendingAutoScanRef.current = fvca;
    setActiveTab('collection');
  }, []);

  // ── Triage state ──────────────────────────────────────────────────────────
  const [triageMinPct, setTriageMinPct] = useState('5');
  const triageFast = true;
  const [triageLogs,   setTriageLogs]   = useState<string[]>([]);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [triageBusy,   setTriageBusy]   = useState(false);
  const [triageError,  setTriageError]  = useState<string | null>(null);
  const [triageSearch, setTriageSearch] = useState('');

  type TriageSortCol = 'count' | 'bestPct' | 'avgPct' | 'bestSpotSol' | 'bestMissingSol';
  const [triageSortCol, setTriageSortCol] = useState<TriageSortCol | null>(null);
  const [triageSortDir, setTriageSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleTriageSort = (col: TriageSortCol) => {
    if (triageSortCol === col) setTriageSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setTriageSortCol(col); setTriageSortDir('desc'); }
  };
  const triageArrow = (col: TriageSortCol) => triageSortCol === col ? (triageSortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const runTriage = useCallback((opts?: { force?: boolean; fast?: boolean; resultCallback?: (r: TriageResult) => void }) => {
    if (triageBusy) return;
    setTriageBusy(true);
    setTriageLogs([]);
    setTriageResult(null);
    setTriageError(null);
    setTriageSearch('');

    const minPct   = parseFloat(triageMinPct) || 5;
    const fastMode = opts?.fast ?? triageFast;
    const params   = new URLSearchParams({ min_pct: String(minPct) });
    if (fastMode)    params.set('fast',  '1');
    if (opts?.force) params.set('force', '1');
    const url = `${API_BASE}/api/tools/mmm-pools/triage-stream?${params}`;
    const es  = new EventSource(url);

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type: string; msg?: string } & Partial<TriageResult>;
        if (data.type === 'progress' && data.msg) {
          setTriageLogs(prev => [...prev.slice(-6), data.msg!]);
        } else if (data.type === 'result' && data.collections) {
          const r: TriageResult = {
            collections:      data.collections,
            totalPools:       data.totalPools ?? 0,
            underfundedTotal: data.underfundedTotal ?? 0,
            collectionCount:  data.collectionCount ?? 0,
            minPct:           data.minPct ?? minPct,
            cached:           data.cached ?? false,
            cacheAgeMs:       data.cacheAgeMs ?? 0,
            fast:             data.fast ?? fastMode,
          };
          setTriageResult(r);
          if (opts?.resultCallback) opts.resultCallback(r);
          es.close();
          setTriageBusy(false);
        } else if (data.type === 'error') {
          setTriageError(data.msg ?? 'Unknown error');
          es.close();
          setTriageBusy(false);
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => {
      setTriageError('Connection error');
      es.close();
      setTriageBusy(false);
    };
  }, [triageBusy, triageMinPct, triageFast]);

  // ── Pool Feed state ───────────────────────────────────────────────────────
  const [pfMinPct, setPfMinPct] = useState('50');
  const pfFast = true;
  const [pfLogs,   setPfLogs]   = useState<string[]>([]);
  const [pfResult, setPfResult] = useState<PoolFeedResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('vl.pf.result') : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PoolFeedResult & { savedAt?: number };
      if (!parsed.savedAt || Date.now() - parsed.savedAt > 20 * 60 * 1000) return null;
      return { pools: parsed.pools, cached: true, cacheAgeMs: Date.now() - (parsed.savedAt ?? 0) };
    } catch { return null; }
  });
  const [pfBusy,   setPfBusy]   = useState(false);
  const [pfError,  setPfError]  = useState<string | null>(null);

  type PfSortCol = 'pct' | 'spotPriceSol' | 'realEscrowSol' | 'missingSol';
  const [pfSortCol, setPfSortCol] = useState<PfSortCol>('pct');
  const [pfSortDir, setPfSortDir] = useState<'asc' | 'desc'>('desc');
  const togglePfSort = (col: PfSortCol) => {
    if (pfSortCol === col) setPfSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setPfSortCol(col); setPfSortDir('desc'); }
  };
  const pfArrow = (col: PfSortCol) => pfSortCol === col ? (pfSortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const runPoolFeed = useCallback((opts?: { force?: boolean }) => {
    if (pfBusy) return;
    setPfBusy(true);
    setPfLogs([]);
    setPfResult(null);
    setPfError(null);

    const minPct = parseFloat(pfMinPct) || 50;
    const params = new URLSearchParams({ min_pct: String(minPct), fast: pfFast ? '1' : '0' });
    if (opts?.force) params.set('force', '1');
    const url = `${API_BASE}/api/tools/mmm-pools/pool-stream?${params}`;
    const es  = new EventSource(url);

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type: string; msg?: string; pools?: FlatPool[]; cached?: boolean; cacheAgeMs?: number };
        if (data.type === 'progress' && data.msg) {
          setPfLogs(prev => [...prev.slice(-5), data.msg!]);
        } else if (data.type === 'result' && data.pools) {
          const r: PoolFeedResult = { pools: data.pools, cached: data.cached ?? false, cacheAgeMs: data.cacheAgeMs ?? 0 };
          setPfResult(r);
          try { localStorage.setItem('vl.pf.result', JSON.stringify({ ...r, savedAt: Date.now() })); } catch { /* quota */ }
          es.close();
          setPfBusy(false);
        } else if (data.type === 'error') {
          setPfError(data.msg ?? 'Unknown error');
          es.close();
          setPfBusy(false);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { setPfError('Connection error'); es.close(); setPfBusy(false); };
  }, [pfBusy, pfMinPct, pfFast]);

  // ── Triage table ──────────────────────────────────────────────────────────
  const renderTriageTable = (collections: TriageCollection[]) => {
    const q    = triageSearch.toLowerCase();
    const rows = q
      ? collections.filter(c =>
          c.collectionName.toLowerCase().includes(q) ||
          c.alKey.toLowerCase().includes(q))
      : collections;

    if (!rows.length) return (
      <div style={{ textAlign: 'center', color: '#9a9ab4', padding: '40px 24px', fontSize: 13 }}>
        {q ? `No collections matching "${triageSearch}"` : 'No collections found above threshold.'}
      </div>
    );

    const tierOrder = ['HIGH', 'LOW', 'VERY_LOW', 'SKIP'] as const;
    const byTier    = Object.fromEntries(tierOrder.map(t => [t, rows.filter(c => c.tier === t)]));
    const THs = { ...TH, cursor: 'pointer', userSelect: 'none' as const };

    return (
      <>
        {tierOrder.map(t => {
          const group = byTier[t];
          if (!group?.length) return null;
          const sortedGroup = triageSortCol
            ? [...group].sort((a, b) => {
                const v = (a[triageSortCol] ?? 0) - (b[triageSortCol] ?? 0);
                return triageSortDir === 'asc' ? v : -v;
              })
            : group;
          return (
            <div key={t} style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px', marginBottom: 6 }}>
                <TierChip tier={t} />
                <span style={{ fontSize: 11, color: '#9a9ab4' }}>{group.length} collection{group.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={PANEL}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 780 }}>
                    <colgroup>
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '17%' }} />
                      <col style={{ width:  '6%' }} />
                      <col style={{ width:  '7%' }} />
                      <col style={{ width:  '7%' }} />
                      <col style={{ width:  '9%' }} />
                      <col style={{ width:  '9%' }} />
                      <col style={{ width:  '8%' }} />
                      <col style={{ width:  '9%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={TH_L}>ADDRESS</th>
                        <th style={TH_L}>COLLECTION</th>
                        <th style={THs} onClick={() => toggleTriageSort('count')}>#{ triageArrow('count')}</th>
                        <th style={THs} onClick={() => toggleTriageSort('bestPct')}>BEST %{triageArrow('bestPct')}</th>
                        <th style={THs} onClick={() => toggleTriageSort('avgPct')}>AVG %{triageArrow('avgPct')}</th>
                        <th style={THs} onClick={() => toggleTriageSort('bestSpotSol')}>SPOT{triageArrow('bestSpotSol')}</th>
                        <th style={TH}>ESCROW</th>
                        <th style={THs} onClick={() => toggleTriageSort('bestMissingSol')}>MISSING{triageArrow('bestMissingSol')}</th>
                        <th style={{ ...TH, textAlign: 'center' }}>DEEP SCAN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedGroup.map(c => (
                        <tr key={c.alKey}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.022)', cursor: 'pointer' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(168,144,232,0.04)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                          <td style={TD_L}>
                            <CopyKey value={c.alKey} label={short(c.alKey)} />
                          </td>
                          <td style={TD_L}>
                            {c.collectionName
                              ? <span style={{ fontSize: 12, color: '#c7b479', fontWeight: 600 }}>{c.collectionName}</span>
                              : <span style={{ fontSize: 11, color: '#6b6b85' }}>—</span>
                            }
                          </td>
                          <td style={TD}>{c.count}</td>
                          <td style={{ ...TD, color: pctColor(c.bestPct), fontWeight: 700 }}>{c.bestPct.toFixed(1)}%</td>
                          <td style={{ ...TD, color: '#9a9ab4' }}>{c.avgPct.toFixed(1)}%</td>
                          <td style={TD}>{c.bestSpotSol.toFixed(4)}<span style={{ fontSize: 9, color: '#9a9ab4', marginLeft: 2 }}>◎</span></td>
                          <td style={TD}>{c.bestRealSol > 0 ? c.bestRealSol.toFixed(4) : <span style={{ color: '#6b6b85' }}>bpa</span>}<span style={{ fontSize: 9, color: '#9a9ab4', marginLeft: 2 }}>◎</span></td>
                          <td style={{ ...TD, color: '#d96867' }}>{c.bestMissingSol.toFixed(4)}<span style={{ fontSize: 9, color: '#9a9ab4', marginLeft: 2 }}>◎</span></td>
                          <td style={{ ...TD, textAlign: 'center' }}>
                            <button onClick={() => jumpToCollectionScan(c.alKey, c.collectionName || undefined, c.collectionSlug || undefined)}
                              type="button"
                              title="Deep scan this collection"
                              style={{
                                padding: '4px 12px', fontSize: 11, fontWeight: 700, borderRadius: 4,
                                border: '1px solid rgba(168,144,232,0.45)',
                                background: 'rgba(168,144,232,0.10)',
                                color: '#a890e8', cursor: 'pointer', whiteSpace: 'nowrap',
                              }}>
                              Scan →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="feed-root page-transition" data-page="tools-mmm-collection-scanner">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
        <div style={{ padding: '20px 4px 0', width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
                MMM Collection Scanner
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4' }}>
                <LiveDot />
                <span>Live scanner for underfunded infinite-lifetime MMM buy pools</span>
              </div>
            </div>
          </div>
          <TabBar active={activeTab} onChange={setActiveTab} />
        </div>

        {/* ── Collection Scan ─────────────────────────────────────────────── */}
        {activeTab === 'collection' && (
          <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '16px 4px' }}>

            {/* Search bar */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <label style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                  Collection slug or FVCA address
                </label>
                <input
                  type="text" value={slugInput}
                  onChange={e => {
                    setSlugInput(e.target.value);
                    setResolvedFvca('');
                    setCollectionName('');
                    setCollectionSlugS('');
                    setScanResult(null);
                    setScanError(null);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') void runCollectionScan(); }}
                  placeholder="e.g. bozo, open_solmap, or paste FVCA address…"
                  spellCheck={false} disabled={busy || resolving}
                  style={{
                    padding: '9px 14px', fontSize: 13,
                    ...MONO, borderRadius: 6,
                    border: `1px solid ${busy ? 'rgba(168,144,232,0.6)' : 'rgba(168,144,232,0.35)'}`,
                    background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
                    transition: 'border-color 0.15s',
                  }}
                />
              </div>
              <button type="button" onClick={() => void runCollectionScan()} disabled={!canScan}
                style={{
                  padding: '9px 24px', fontSize: 13, fontWeight: 700, letterSpacing: '0.4px',
                  textTransform: 'uppercase', borderRadius: 6,
                  cursor: canScan ? 'pointer' : 'not-allowed',
                  border: '1px solid rgba(168,144,232,0.55)',
                  background: canScan ? 'linear-gradient(180deg,rgba(128,104,216,0.28) 0%,rgba(128,104,216,0.14) 100%)' : 'rgba(128,104,216,0.08)',
                  color: canScan ? '#f0eef8' : '#9a9ab4',
                  boxShadow: canScan ? '0 0 14px rgba(128,104,216,0.2)' : 'none',
                  transition: 'all 0.15s', alignSelf: 'flex-end',
                  minWidth: 90,
                }}>
                {resolving ? 'Resolving…' : busy ? 'Scanning…' : 'Scan'}
              </button>
            </div>

            {/* Context strip — show resolved name / FVCA when came from slug */}
            {(collectionName || (resolvedFvca && resolvedFvca !== trimmed)) && !scanError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                padding: '7px 12px', borderRadius: 6,
                background: 'rgba(168,144,232,0.05)', border: '1px solid rgba(168,144,232,0.18)',
                fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap',
              }}>
                {collectionName && (
                  collectionSlugS
                    ? <a href={`https://magiceden.io/marketplace/${collectionSlugS}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontWeight: 700, color: '#c7b479', fontSize: 14, textDecoration: 'none' }}
                        onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
                        onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}>
                        {collectionName} ↗
                      </a>
                    : <span style={{ fontWeight: 700, color: '#c7b479', fontSize: 14 }}>{collectionName}</span>
                )}
                {resolvedFvca && resolvedFvca !== trimmed && (
                  <CopyKey value={resolvedFvca} label={short(resolvedFvca)} />
                )}
              </div>
            )}

            {scanError && (
              <div style={{ marginBottom: 12, padding: '8px 14px', fontSize: 12, color: '#d96867', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 6 }}>
                {scanError}
              </div>
            )}

            {busy && !scanResult && (
              <div style={{ marginBottom: 12, padding: '8px 14px', fontSize: 12, color: '#9a9ab4', background: 'rgba(168,144,232,0.05)', border: '1px solid rgba(168,144,232,0.14)', borderRadius: 6, ...MONO }}>
                Querying 6 allowlist slots × 4 types via getProgramAccounts…
              </div>
            )}

            {scanResult && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 16px' }}>
                <StatChip label="Total Found"    value={scanResult.totalFound} />
                <StatChip label="Expired"        value={scanResult.expired}    color="#9a9ab4" />
                <StatChip label="Active"         value={scanResult.activeTotal} />
                <StatChip label="Executable"     value={scanResult.executable}  color="#43b984" />
                <StatChip label="Underfunded"    value={scanResult.underfunded} color="#c7b479" />
                <StatChip label="Empty escrow"   value={scanResult.emptyEscrow} color="#9a9ab4" />
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
                  <span style={{ ...MONO, fontSize: 10, color: '#6b6b85' }}>
                    {new Date(scanResult.scannedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}

            <div style={PANEL}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 800 }}>
                  <colgroup>
                    <col style={{ width: '22%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width:  '8%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '12%' }} />
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
                    {!scanResult && !busy && (
                      <tr><td colSpan={8} style={{ textAlign: 'center', color: '#9a9ab4', padding: '64px 24px', fontSize: 13, lineHeight: 1.7 }}>
                        Enter a collection slug or FVCA address above and press <kbd style={{ padding: '1px 6px', borderRadius: 3, border: '1px solid rgba(168,144,232,0.3)', fontSize: 11, background: 'rgba(168,144,232,0.08)', color: '#a890e8' }}>Enter</kbd> or click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan</span>.
                        <br /><span style={{ fontSize: 11 }}>Shows underfunded infinite-lifetime MMM pools invisible in the ME UI.</span>
                      </td></tr>
                    )}
                    {scanResult && scanResult.pools.length === 0 && !busy && (
                      <tr><td colSpan={8} style={{ textAlign: 'center', color: '#43b984', padding: '64px 24px', fontSize: 13, fontWeight: 600 }}>
                        ✓ No underfunded infinite-lifetime pools found for this collection.
                      </td></tr>
                    )}
                    {sortedPools.map(p => {
                      const pct = pctFunded(p);
                      return (
                        <tr key={p.poolKey}>
                          <td style={TD_L}><CopyKey value={p.poolKey} /></td>
                          <td style={TD}>
                            <span style={{ color: '#f0eef8', fontWeight: 700 }}>{fmtSol(p.spotPrice)}</span>
                            <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                          </td>
                          <td style={TD}>
                            <a href={`https://solscan.io/account/${p.escrowPda}`} target="_blank" rel="noopener noreferrer"
                              title={p.escrowPda}
                              style={{ color: '#c7b479', textDecoration: 'none', ...MONO, fontSize: 12, fontWeight: 600 }}
                              onMouseEnter={e => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
                              onMouseLeave={e => { (e.target as HTMLElement).style.textDecoration = 'none'; }}>
                              {fmtSol(p.realEscrow)}
                            </a>
                            <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                          </td>
                          <td style={TD}>
                            <span style={{ color: '#d96867', fontWeight: 700 }}>{fmtSol(p.missing)}</span>
                            <span style={{ fontSize: 10, color: '#9a9ab4', marginLeft: 3 }}>◎</span>
                          </td>
                          <td style={{ ...TD, color: pctColor(pct), fontWeight: 700 }}>{pct.toFixed(1)}%</td>
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
                              <a href={`https://magiceden.io/mmm/pool/${p.poolKey}`} target="_blank" rel="noopener noreferrer"
                                title="ME Pool"
                                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 5, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', textDecoration: 'none', flexShrink: 0, lineHeight: 0 }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src="/brand/me.png" alt="ME" width={22} height={22} draggable={false} style={{ display: 'block', width: 22, height: 22, objectFit: 'cover', pointerEvents: 'none' }} />
                              </a>
                              <a href={`/tools/mmm-pool-lookup?pool=${encodeURIComponent(p.poolKey)}`} title="Pool Lookup"
                                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 5, border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(168,144,232,0.08)', cursor: 'pointer', textDecoration: 'none', fontSize: 11, fontWeight: 700, color: '#a890e8' }}>
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
        )}

        {/* ── Triage ──────────────────────────────────────────────────────── */}
        {activeTab === 'triage' && (
          <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '16px 4px' }}>

            {/* Controls */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Min % funded</label>
                <input type="number" value={triageMinPct} min="0" max="100" step="0.1"
                  onChange={e => setTriageMinPct(e.target.value)} disabled={triageBusy}
                  style={{ width: 80, padding: '7px 10px', fontSize: 12, ...MONO, borderRadius: 5, border: '1px solid rgba(168,144,232,0.4)', background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none' }}
                />
              </div>



              <button type="button" disabled={triageBusy} onClick={() => runTriage()}
                style={{
                  padding: '8px 22px', fontSize: 12, fontWeight: 700, letterSpacing: '0.4px',
                  textTransform: 'uppercase', borderRadius: 5, cursor: triageBusy ? 'not-allowed' : 'pointer',
                  border: '1px solid rgba(168,144,232,0.55)',
                  background: !triageBusy ? 'linear-gradient(180deg,rgba(128,104,216,0.28) 0%,rgba(128,104,216,0.14) 100%)' : 'rgba(128,104,216,0.08)',
                  color: !triageBusy ? '#f0eef8' : '#9a9ab4',
                  boxShadow: !triageBusy ? '0 0 14px rgba(128,104,216,0.2)' : 'none',
                  alignSelf: 'flex-end', marginBottom: 0,
                }}>
                {triageBusy ? 'Scanning…' : 'Scan'}
              </button>

              {triageResult?.cached && !triageBusy && (
                <button type="button" onClick={() => runTriage({ force: true })}
                  style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, borderRadius: 5, border: '1px solid rgba(168,144,232,0.22)', background: 'transparent', color: '#9a9ab4', cursor: 'pointer', alignSelf: 'flex-end' }}>
                  ↺ Refresh
                </button>
              )}

              {/* Search — shown only once we have results */}
              {triageResult && !triageBusy && (
                <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <label style={{ fontSize: 10, color: '#9a9ab4', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Search</label>
                  <input
                    type="text" value={triageSearch} placeholder="Collection name or FVCA…"
                    onChange={e => setTriageSearch(e.target.value)}
                    style={{ padding: '7px 12px', fontSize: 12, borderRadius: 5, border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none' }}
                  />
                </div>
              )}

            </div>

            {/* Progress log */}
            {(triageBusy || (triageLogs.length > 0 && !triageResult)) && !triageError && (
              <div style={{
                marginBottom: 14, padding: '10px 14px', borderRadius: 8,
                background: 'rgba(168,144,232,0.04)', border: '1px solid rgba(168,144,232,0.16)',
                ...MONO, fontSize: 11,
              }}>
                {triageLogs.map((l, i) => (
                  <div key={i} style={{ color: i === triageLogs.length - 1 ? '#c7b479' : '#9a9ab4', padding: '1px 0' }}>
                    {i === triageLogs.length - 1 && triageBusy ? '› ' : '✓ '}{l}
                  </div>
                ))}
                {triageBusy && <div style={{ color: '#a890e8', padding: '1px 0' }}>…</div>}
              </div>
            )}

            {triageError && (
              <div style={{ marginBottom: 14, padding: '8px 14px', fontSize: 12, color: '#d96867', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 6 }}>
                {triageError}
              </div>
            )}

            {/* Summary chips */}
            {triageResult && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
                <StatChip label="All Pools"   value={triageResult.totalPools.toLocaleString()} />
                <StatChip label="Underfunded" value={triageResult.underfundedTotal} color="#c7b479" />
                <StatChip label="Collections" value={triageResult.collectionCount}  color="#a890e8" />
                <StatChip label="HIGH ≥20%"   value={triageResult.collections.filter(c => c.tier === 'HIGH').length}     color="#43b984" />
                <StatChip label="LOW 5–19%"   value={triageResult.collections.filter(c => c.tier === 'LOW').length}      color="#c7b479" />
                <StatChip label="V.LOW 2–4%"  value={triageResult.collections.filter(c => c.tier === 'VERY_LOW').length} color="#a890e8" />
                <div style={{
                  padding: '6px 12px', borderRadius: 8,
                  border: '1px solid rgba(168,144,232,0.14)',
                  background: triageResult.cached ? 'rgba(67,185,132,0.06)' : 'rgba(168,144,232,0.05)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: triageResult.cached ? '#43b984' : '#a890e8', ...MONO }}>
                    {triageResult.cached
                      ? `⚡ cached · ${Math.floor((triageResult.cacheAgeMs ?? 0) / 60_000)}m ago`
                      : triageResult.fast ? '⚡ fast mode' : '✓ live scan'}
                  </span>
                  <span style={{ fontSize: 10, color: '#6b6b85' }}>
                    {triageResult.fast ? 'bpa · 0 balance fetches' : 'real escrow balances'}
                  </span>
                </div>
              </div>
            )}

            {!triageResult && !triageBusy && !triageError && (
              <div style={{ textAlign: 'center', color: '#9a9ab4', padding: '72px 24px', fontSize: 13, lineHeight: 1.6 }}>
                Click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan</span> to find all collections with underfunded MMM bids.
                <br /><span style={{ fontSize: 11, color: '#6b6b85' }}>One RPC dump of all infinite-lifetime pools. Click <strong style={{ color: '#a890e8' }}>Scan →</strong> on any row to deep-dive instantly.</span>
              </div>
            )}

            {triageResult && renderTriageTable(triageResult.collections)}
          </div>
        )}

        {/* ── Pool Feed ───────────────────────────────────────────────────── */}
        {activeTab === 'poolfeed' && (
          <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '16px 4px' }}>

            {/* Controls */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
              {/* Min funded filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: 9, color: '#6b6b85', textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 700 }}>Min Funded</label>
                <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                  <input type="number" value={pfMinPct} min="0" max="100" step="1"
                    onChange={e => setPfMinPct(e.target.value)} disabled={pfBusy}
                    style={{ width: 70, padding: '7px 22px 7px 10px', fontSize: 13, ...MONO, borderRadius: 5,
                      border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(20,14,34,0.9)',
                      color: '#f0eef8', outline: 'none' }}
                  />
                  <span style={{ position: 'absolute', right: 8, fontSize: 11, color: '#6b6b85', pointerEvents: 'none' }}>%</span>
                </div>
              </div>

              {/* Scan */}
              <button type="button" disabled={pfBusy} onClick={() => runPoolFeed()}
                style={{
                  padding: '9px 28px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px',
                  textTransform: 'uppercase', borderRadius: 5, cursor: pfBusy ? 'not-allowed' : 'pointer',
                  border: `1px solid ${!pfBusy ? 'rgba(168,144,232,0.7)' : 'rgba(168,144,232,0.2)'}`,
                  background: !pfBusy ? 'linear-gradient(180deg,rgba(128,104,216,0.32) 0%,rgba(128,104,216,0.16) 100%)' : 'rgba(128,104,216,0.06)',
                  color: !pfBusy ? '#f0eef8' : '#9a9ab4',
                  boxShadow: !pfBusy ? '0 0 18px rgba(128,104,216,0.22), inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
                }}>
                {pfBusy ? 'Scanning…' : 'Scan'}
              </button>

              {/* Refresh */}
              {pfResult?.cached && !pfBusy && (
                <button type="button" onClick={() => runPoolFeed({ force: true })}
                  style={{ padding: '9px 12px', fontSize: 11, fontWeight: 600, borderRadius: 5,
                    border: '1px solid rgba(168,144,232,0.18)', background: 'transparent',
                    color: '#6b6b85', cursor: 'pointer' }}>
                  ↺ Refresh
                </button>
              )}

              {/* KPI: pools count */}
              {pfResult && !pfBusy && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '5px 14px', borderRadius: 6,
                  border: '1px solid rgba(199,180,121,0.22)', background: 'rgba(199,180,121,0.05)',
                  lineHeight: 1, gap: 3 }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#c7b479', ...MONO, letterSpacing: '-0.5px' }}>
                    {pfResult.pools.length}
                  </span>
                  <span style={{ fontSize: 8, color: '#7a7040', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>
                    POOLS
                  </span>
                </div>
              )}

              {/* Cache status — secondary */}
              {pfResult && !pfBusy && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                  padding: '5px 10px', borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.05)', background: 'transparent', gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: pfResult.cached ? '#52785c' : '#4a6b5a',
                    textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                    {pfResult.cached ? 'Cached' : 'Live'}
                  </span>
                  {pfResult.cached && (
                    <span style={{ fontSize: 9, color: '#5a5a6a', ...MONO }}>
                      {Math.floor(pfResult.cacheAgeMs / 60_000)}m ago
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Progress log */}
            {(pfBusy || pfLogs.length > 0) && !pfError && !pfResult && (
              <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 8, background: 'rgba(168,144,232,0.04)', border: '1px solid rgba(168,144,232,0.16)', ...MONO, fontSize: 11 }}>
                {pfLogs.map((l, i) => (
                  <div key={i} style={{ color: i === pfLogs.length - 1 ? '#c7b479' : '#9a9ab4', padding: '1px 0' }}>
                    {i === pfLogs.length - 1 && pfBusy ? '› ' : '✓ '}{l}
                  </div>
                ))}
                {pfBusy && <div style={{ color: '#a890e8', padding: '1px 0' }}>…</div>}
              </div>
            )}

            {pfError && (
              <div style={{ marginBottom: 14, padding: '8px 14px', fontSize: 12, color: '#d96867', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 6 }}>
                {pfError}
              </div>
            )}

            {pfResult && (() => {
              const sorted = [...pfResult.pools].sort((a, b) => {
                const v = a[pfSortCol] - b[pfSortCol];
                return pfSortDir === 'asc' ? v : -v;
              });
              const THp = { ...TH, cursor: 'pointer', userSelect: 'none' as const };
              return (
                <>
                  <div style={PANEL}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 800 }}>
                        <colgroup>
                          <col style={{ width: '20%' }} />
                          <col style={{ width: '18%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width: '14%' }} />
                          <col style={{ width: '12%' }} />
                        </colgroup>
                        <thead>
                          <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                            <th style={TH_L}>POOL</th>
                            <th style={TH_L}>COLLECTION</th>
                            <th style={THp} onClick={() => togglePfSort('pct')}>% FUNDED{pfArrow('pct')}</th>
                            <th style={THp} onClick={() => togglePfSort('spotPriceSol')}>SPOT{pfArrow('spotPriceSol')}</th>
                            <th style={THp} onClick={() => togglePfSort('realEscrowSol')}>ESCROW{pfArrow('realEscrowSol')}</th>
                            <th style={THp} onClick={() => togglePfSort('missingSol')}>MISSING{pfArrow('missingSol')}</th>
                            <th style={TH_L}>ADDRESS</th>
                            <th style={{ ...TH, textAlign: 'center' }}>LINKS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map(p => (
                            <tr key={p.poolKey}
                              style={{ borderBottom: '1px solid rgba(255,255,255,0.022)' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                              <td style={TD_L}><CopyKey value={p.poolKey} label={short(p.poolKey)} /></td>
                              <td style={TD_L}>
                                {p.collectionName
                                  ? <span style={{ fontSize: 12, color: '#c7b479', fontWeight: 700 }}>{p.collectionName}</span>
                                  : <span style={{ fontSize: 11, color: '#3e3e52' }}>—</span>
                                }
                              </td>
                              <td style={{ ...TD, textAlign: 'right' }}>
                                <span style={{ color: pctColor(p.pct), fontWeight: 700 }}>{p.pct.toFixed(1)}%</span>
                                <div style={{ height: 2, borderRadius: 1, marginTop: 3,
                                  background: pctColor(p.pct), width: `${Math.min(p.pct, 100)}%`,
                                  opacity: 0.35, marginLeft: 'auto' }} />
                              </td>
                              <td style={TD}>
                                <span style={{ color: '#f0eef8', fontWeight: 700 }}>{p.spotPriceSol.toFixed(4)}</span>
                                <span style={{ fontSize: 9, color: '#5a5a78', marginLeft: 2 }}>◎</span>
                              </td>
                              <td style={TD}>
                                <span style={{ color: '#c7b479' }}>{p.realEscrowSol.toFixed(4)}</span>
                                <span style={{ fontSize: 9, color: '#5a5a78', marginLeft: 2 }}>◎</span>
                              </td>
                              <td style={{ ...TD, color: p.missingSol === 0 ? '#4a8c6a' : '#d96867', fontWeight: 700 }}>
                                {p.missingSol.toFixed(4)}<span style={{ fontSize: 9, color: '#5a5a78', marginLeft: 2 }}>◎</span>
                              </td>
                              <td style={TD_L}>
                                <span
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#e8e6f4'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#5a5a7a'; }}
                                  style={{ color: '#5a5a7a', cursor: 'pointer', fontSize: 11, ...MONO }}
                                  onClick={() => void navigator.clipboard.writeText(p.alKey)}
                                  title={p.alKey}>
                                  {short(p.alKey)}
                                </span>
                              </td>
                              <td style={{ ...TD, textAlign: 'center' }}>
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                                  <a href={`https://magiceden.io/u/${p.owner}?chains=%5B%22solana%22%5D&wallets=%5B%22${p.owner}%22%5D&activeTab=%22offers%22`} target="_blank" rel="noopener noreferrer"
                                    title="ME Owner Offers"
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 5, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', textDecoration: 'none', flexShrink: 0, lineHeight: 0 }}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src="/brand/me.png" alt="ME" width={22} height={22} draggable={false} style={{ display: 'block', width: 22, height: 22, objectFit: 'cover', pointerEvents: 'none' }} />
                                  </a>
                                  <button type="button"
                                    title="Pool Lookup"
                                    onClick={() => { sessionStorage.setItem('vl.pfl.pending', p.poolKey); window.open('/tools/mmm-pool-lookup', '_blank'); }}
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 5, border: '1px solid rgba(168,144,232,0.35)', background: 'rgba(168,144,232,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#a890e8' }}>
                                    ↗
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              );
            })()}

            {!pfResult && !pfBusy && !pfError && (
              <div style={{ textAlign: 'center', color: '#9a9ab4', padding: '72px 24px', fontSize: 13, lineHeight: 1.6 }}>
                Click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan</span> to view all underfunded pools sorted by % funded.<br />
                <span style={{ fontSize: 11, color: '#6b6b85' }}>Default min 50% — shows pools close to executable. Reuses Triage cache if available.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
