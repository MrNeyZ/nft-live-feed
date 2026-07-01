'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot }                                            from '@/soloist/shared';
import { authHeaders }                                        from '@/runtime/auth';
import { VL, VLText, ALPHA, rgb, alpha }                     from '@/lib/palette';

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
  isMIP1:         boolean;
  anyOnly:        boolean;   // 'any' allowlist — invisible to the normal FVCA/MCC scan
}

type TokenType = 'Legacy' | 'pNFT' | 'Core' | 'Unknown';
const ALL_TOKEN_TYPES: TokenType[] = ['Legacy', 'pNFT', 'Core', 'Unknown'];

function poolTokenType(p: FlatPool): TokenType {
  if (p.alType === 'core_collection' || p.alType === 'group') return 'Core';
  if (p.isMIP1) return 'pNFT';
  if (p.alType === 'FVCA' || p.alType === 'MCC') return 'Legacy';
  return 'Unknown';
}

const TOKEN_TYPE_COLOR: Record<TokenType, string> = {
  Legacy:  '#7eb8f7',
  pNFT:    '#c084fc',
  Core:    '#4ade80',
  Unknown: '#6b7280',
};
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
  padding: '8px 10px', fontSize: 10, fontWeight: 700,
  color: '#6b6b85', letterSpacing: '0.8px', textAlign: 'right',
  background: 'rgba(16,11,30,0.98)', borderBottom: '1px solid rgba(168,144,232,0.10)',
  textTransform: 'uppercase', userSelect: 'none', whiteSpace: 'nowrap',
};
const TH_L: React.CSSProperties = { ...TH, textAlign: 'left' };
const TD: React.CSSProperties = {
  ...MONO, padding: '8px 10px', fontSize: 12, fontWeight: 600,
  color: '#f0eef8', textAlign: 'right', verticalAlign: 'middle',
  borderBottom: '1px solid rgba(255,255,255,0.016)',
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
function CopyKey({ value, label, color }: { value: string; label?: string; color?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span onClick={copy} title={value}
      style={{ cursor: 'pointer', color: copied ? '#43b984' : (color ?? '#a890e8'), fontSize: 11, ...MONO, userSelect: 'none' }}>
      {copied ? 'copied!' : (label ?? short(value))}
    </span>
  );
}
// Copies a ready-to-paste "pool key / escrow wallet" template — one click
// instead of copying each address separately, and a fixed shape the chat
// side parses without guessing which address is which.
function CopyPoolTemplateBtn({ poolKey, escrowPda }: { poolKey: string; escrowPda: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = `${poolKey} - pool key\n\n${escrowPda} - escrow wallet`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button type="button" onClick={copy}
      title="Copy pool key + escrow wallet template"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26,
        border: 'none', background: 'transparent',
        cursor: 'pointer', fontSize: 12, fontWeight: 700, color: copied ? '#43b984' : rgb(VL.purpleTint) }}>
      {copied ? '✓' : '⧉'}
    </button>
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
    <div style={{ display: 'flex', gap: 2, marginTop: 8, borderBottom: '1px solid rgba(168,144,232,0.18)' }}>
      {tabs.map(t => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          style={{
            padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: 'none', borderBottom: active === t.id ? '2px solid #a890e8' : '2px solid transparent',
            marginBottom: -1,
            background: active === t.id ? alpha(VL.purpleTint, ALPHA.tint) : 'transparent',
            color: active === t.id ? rgb(VL.purpleTint) : VLText.muted,
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

  // Persisted so a page reload lands back on whichever tab (esp. Pool Feed)
  // you were on — the tab itself was resetting to 'collection' even though
  // the underlying localStorage cache (vl.pf.result etc.) survived fine.
  const [activeTab, setActiveTabRaw] = useState<Tab>(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-cs.activeTab') : null;
    return stored === 'collection' || stored === 'triage' || stored === 'poolfeed' ? stored : 'collection';
  });
  const setActiveTab = useCallback((t: Tab) => {
    setActiveTabRaw(t);
    if (typeof window !== 'undefined') localStorage.setItem('vl.mmm-cs.activeTab', t);
  }, []);

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
      let fvca   = overrideFvca ?? (isDirectAddr ? trimmed : resolvedFvca);
      let mcc    = '';
      let symbol = '';
      if (!fvca && !isDirectAddr) {
        setResolving(true);
        const rr = await fetch(`${API_BASE}/api/tools/mmm-pools/resolve-slug?slug=${encodeURIComponent(trimmed)}`, { headers: { ...authHeaders() } });
        const rd = await rr.json().catch(() => null) as { ok: boolean; fvca?: string | null; mcc?: string | null; symbol?: string | null; collectionName?: string; error?: string } | null;
        setResolving(false);
        if (!rd?.ok || (!rd.fvca && !rd.mcc && !rd.symbol)) throw new Error(rd?.error ?? (rr.ok ? 'slug_not_found' : `HTTP ${rr.status}`));
        fvca   = rd.fvca   ?? '';
        mcc    = rd.mcc    ?? '';
        symbol = rd.symbol ?? '';
        setResolvedFvca(fvca || mcc || symbol);
        setCollectionName(rd.collectionName ?? '');
      }
      const scanParams = new URLSearchParams();
      if (fvca)   scanParams.set('fvca',   fvca);
      if (mcc)    scanParams.set('mcc',    mcc);
      if (symbol) scanParams.set('symbol', symbol);
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/collection-scan?${scanParams}`, { headers: { ...authHeaders() } });
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
  const [triageMinPct, setTriageMinPct] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-triage.minPct') : null) ?? '5');
  const triageFast = true;
  const [triageLogs,   setTriageLogs]   = useState<string[]>([]);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [triageBusy,   setTriageBusy]   = useState(false);
  const [triageError,  setTriageError]  = useState<string | null>(null);
  const [triageSearch, setTriageSearch] = useState('');

  type TriageSortCol = 'count' | 'bestPct' | 'avgPct' | 'bestSpotSol' | 'bestMissingSol';
  const VALID_TRIAGE_COLS: TriageSortCol[] = ['count', 'bestPct', 'avgPct', 'bestSpotSol', 'bestMissingSol'];
  const storedTriageCol = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-triage.sortCol') : null;
  const storedTriageDir = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-triage.sortDir') : null;
  const [triageSortCol, setTriageSortCol] = useState<TriageSortCol | null>(
    VALID_TRIAGE_COLS.includes(storedTriageCol as TriageSortCol) ? (storedTriageCol as TriageSortCol) : null
  );
  const [triageSortDir, setTriageSortDir] = useState<'asc' | 'desc'>(
    storedTriageDir === 'asc' || storedTriageDir === 'desc' ? storedTriageDir : 'desc'
  );
  const toggleTriageSort = (col: TriageSortCol) => {
    if (triageSortCol === col) {
      const next: 'asc' | 'desc' = triageSortDir === 'asc' ? 'desc' : 'asc';
      setTriageSortDir(next); localStorage.setItem('vl.mmm-triage.sortDir', next);
    } else {
      setTriageSortCol(col); localStorage.setItem('vl.mmm-triage.sortCol', col);
      setTriageSortDir('desc'); localStorage.setItem('vl.mmm-triage.sortDir', 'desc');
    }
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
  const [pfMinPct, setPfMinPct] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.minPct') : null) ?? '50');
  const pfFast = true;
  // Full scan: also pulls 'any'-allowlist ("buy any NFT") pools, invisible to the normal
  // FVCA/MCC-scoped scan. Separate result cache key so toggling never cross-serves.
  const [pfIncludeAny, setPfIncludeAny] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.includeAny') : null) === '1');
  const pfResultStorageKey = (includeAny: boolean) => includeAny ? 'vl.pf.result.any' : 'vl.pf.result';
  const togglePfIncludeAny = () => {
    setPfIncludeAny(prev => {
      const next = !prev;
      localStorage.setItem('vl.mmm-pf.includeAny', next ? '1' : '0');
      return next;
    });
    setPfResult(null);
    setPfError(null);
  };
  const [pfLogs,   setPfLogs]   = useState<string[]>([]);
  const [pfResult, setPfResult] = useState<PoolFeedResult | null>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(pfResultStorageKey(pfIncludeAny)) : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PoolFeedResult & { savedAt?: number };
      if (!parsed.savedAt || Date.now() - parsed.savedAt > 20 * 60 * 1000) return null;
      return { pools: parsed.pools, cached: true, cacheAgeMs: Date.now() - (parsed.savedAt ?? 0) };
    } catch { return null; }
  });
  const [pfBusy,   setPfBusy]   = useState(false);
  const [pfError,  setPfError]  = useState<string | null>(null);

  type PfSortCol = 'pct' | 'spotPriceSol' | 'realEscrowSol' | 'missingSol';
  const VALID_PF_COLS: PfSortCol[] = ['pct', 'spotPriceSol', 'realEscrowSol', 'missingSol'];
  const storedPfCol = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.sortCol') : null;
  const storedPfDir = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.sortDir') : null;
  const [pfSortCol, setPfSortCol] = useState<PfSortCol>(
    VALID_PF_COLS.includes(storedPfCol as PfSortCol) ? (storedPfCol as PfSortCol) : 'pct'
  );
  const [pfSortDir, setPfSortDir] = useState<'asc' | 'desc'>(
    storedPfDir === 'asc' || storedPfDir === 'desc' ? storedPfDir : 'desc'
  );
  const togglePfSort = (col: PfSortCol) => {
    if (pfSortCol === col) {
      const next: 'asc' | 'desc' = pfSortDir === 'asc' ? 'desc' : 'asc';
      setPfSortDir(next); localStorage.setItem('vl.mmm-pf.sortDir', next);
    } else {
      setPfSortCol(col); localStorage.setItem('vl.mmm-pf.sortCol', col);
      setPfSortDir('desc'); localStorage.setItem('vl.mmm-pf.sortDir', 'desc');
    }
  };
  const pfArrow = (col: PfSortCol) => pfSortCol === col ? (pfSortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const [pfTypeFilter, setPfTypeFilter] = useState<Set<TokenType>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.typeFilter') : null;
      if (!raw) return new Set<TokenType>();
      const arr = JSON.parse(raw) as string[];
      return new Set(arr.filter((x): x is TokenType => ALL_TOKEN_TYPES.includes(x as TokenType)));
    } catch { return new Set<TokenType>(); }
  });
  const togglePfType = (t: TokenType) => {
    setPfTypeFilter(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      localStorage.setItem('vl.mmm-pf.typeFilter', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  // Manually hidden pools — "tried this, doesn't work" markers. Client-only,
  // no backend signal for this (see the "prior FulfillBuy" heuristic
  // rejected earlier — underfunded pools by definition never sold, so
  // there's nothing server-side to detect "doesn't work" from).
  const [hiddenPools, setHiddenPools] = useState<Set<string>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('vl.mmm-pf.hidden') : null;
      if (!raw) return new Set<string>();
      return new Set(JSON.parse(raw) as string[]);
    } catch { return new Set<string>(); }
  });
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const hidePool = (poolKey: string) => {
    setHiddenPools(prev => {
      const next = new Set(prev);
      next.add(poolKey);
      localStorage.setItem('vl.mmm-pf.hidden', JSON.stringify(Array.from(next)));
      return next;
    });
  };
  const unhidePool = (poolKey: string) => {
    setHiddenPools(prev => {
      const next = new Set(prev);
      next.delete(poolKey);
      localStorage.setItem('vl.mmm-pf.hidden', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const runPoolFeed = useCallback((opts?: { force?: boolean }) => {
    if (pfBusy) return;
    setPfBusy(true);
    setPfLogs([]);
    setPfResult(null);
    setPfError(null);

    const minPct = parseFloat(pfMinPct) || 50;
    const params = new URLSearchParams({ min_pct: String(minPct), fast: pfFast ? '1' : '0', any: pfIncludeAny ? '1' : '0' });
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
          try { localStorage.setItem(pfResultStorageKey(pfIncludeAny), JSON.stringify({ ...r, savedAt: Date.now() })); } catch { /* quota */ }
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
  }, [pfBusy, pfMinPct, pfFast, pfIncludeAny]);

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
        <div style={{ padding: '14px 4px 0', width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
                MMM Collection Scanner
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: '#9a9ab4' }}>
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
                  onChange={e => { setTriageMinPct(e.target.value); localStorage.setItem('vl.mmm-triage.minPct', e.target.value); }} disabled={triageBusy}
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
          <div style={{ width: '100%', maxWidth: 'var(--tools-max,1100px)', margin: '0 auto', padding: '10px 4px' }}>

            {/* Controls — SCAN | divider | KPI · refresh · cached | filter */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginBottom: 12 }}>

              {/* SCAN — clearly clickable, not the eye anchor */}
              <button type="button" disabled={pfBusy} onClick={() => runPoolFeed()}
                style={{
                  padding: '8px 22px', fontSize: 13, fontWeight: 700, letterSpacing: '0.8px',
                  textTransform: 'uppercase', borderRadius: 6, cursor: pfBusy ? 'not-allowed' : 'pointer',
                  border: `1px solid ${!pfBusy ? alpha(VL.purpleTint, 0.38) : alpha(VL.purpleTint, 0.10)}`,
                  background: !pfBusy
                    ? `linear-gradient(160deg,${alpha(VL.purpleDeep,0.38)} 0%,${alpha(VL.purpleDeep,0.20)} 100%)`
                    : alpha(VL.purpleDeep,0.06),
                  color: !pfBusy ? VLText.primary : VLText.muted,
                  boxShadow: !pfBusy
                    ? `0 0 16px ${alpha(VL.purpleDeep,0.28)}, inset 0 1px 0 rgba(255,255,255,0.07)`
                    : 'none',
                  flexShrink: 0,
                }}>
                {pfBusy ? 'Scanning…' : 'Scan'}
              </button>

              {/* Divider */}
              {pfResult && !pfBusy && (
                <div style={{ width: 1, height: 28, background: alpha(VL.purpleTint, 0.12), margin: '0 14px', flexShrink: 0 }} />
              )}

              {/* Full-scan toggle — also pulls 'any'-allowlist ("buy any NFT") pools,
                  invisible to the normal FVCA/MCC-scoped scan above. */}
              <button type="button" onClick={togglePfIncludeAny} disabled={pfBusy}
                title="Also scan 'buy any NFT' pools (no FVCA/MCC allowlist) — the normal scan can't see these"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  height: 26, padding: '0 10px 0 4px', marginRight: 16,
                  border: `1px solid ${pfIncludeAny ? alpha(VL.gold, 0.45) : alpha(VL.purpleTint, 0.18)}`,
                  borderRadius: 13, cursor: pfBusy ? 'not-allowed' : 'pointer',
                  background: pfIncludeAny ? alpha(VL.gold, 0.10) : 'rgba(16,11,30,0.70)',
                  flexShrink: 0, transition: 'all 0.12s',
                }}>
                <span style={{
                  display: 'inline-block', width: 22, height: 13, borderRadius: 7, position: 'relative',
                  background: pfIncludeAny ? rgb(VL.gold) : alpha(VL.purpleTint, 0.25),
                  transition: 'background 0.15s', flexShrink: 0,
                }}>
                  <span style={{
                    position: 'absolute', top: 1, left: pfIncludeAny ? 10 : 1,
                    width: 11, height: 11, borderRadius: '50%', background: '#15101f',
                    transition: 'left 0.15s',
                  }} />
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
                  color: pfIncludeAny ? rgb(VL.gold) : alpha(VL.purpleTint, 0.45), whiteSpace: 'nowrap' }}>
                  Full scan (+any)
                </span>
              </button>

              {/* KPI — eye anchor of the toolbar */}
              {pfResult && !pfBusy && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
                  <span style={{ fontSize: 28, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                    {pfResult.pools.length}
                  </span>
                  <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                    active pools
                  </span>
                </div>
              )}

              {/* Refresh — ghost */}
              {pfResult?.cached && !pfBusy && (
                <button type="button" onClick={() => runPoolFeed({ force: true })}
                  style={{ padding: '3px 0', fontSize: 11, fontWeight: 500, background: 'none',
                    border: 'none', color: VLText.faint, cursor: 'pointer', marginRight: 10,
                    textDecoration: 'underline', textDecorationColor: alpha(VL.purpleTint, 0.25),
                    textUnderlineOffset: '3px', flexShrink: 0 }}>
                  ↺ refresh
                </button>
              )}

              {/* Cached — 2-line, secondary but readable */}
              {pfResult && !pfBusy && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, lineHeight: 1, flexShrink: 0 }}>
                  <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.42), textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>
                    {pfResult.cached ? 'cached' : 'live scan'}
                  </span>
                  {pfResult.cached && (
                    <span style={{ fontSize: 11, color: VLText.muted, ...MONO }}>
                      {Math.floor(pfResult.cacheAgeMs / 60_000)}m ago
                    </span>
                  )}
                </div>
              )}

              {/* Filter controls — far right group */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                {/* Token type filter chips */}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {ALL_TOKEN_TYPES.map(t => {
                    const active = pfTypeFilter.has(t);
                    const c = TOKEN_TYPE_COLOR[t];
                    return (
                      <button key={t} type="button" onClick={() => togglePfType(t)}
                        style={{ height: 26, padding: '0 9px', border: `1px solid ${active ? c : alpha(VL.purpleTint, 0.18)}`,
                          borderRadius: 5, background: active ? `${c}18` : 'rgba(16,11,30,0.70)',
                          color: active ? c : alpha(VL.purpleTint, 0.45),
                          fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.4px',
                          textTransform: 'uppercase' as const, transition: 'all 0.12s', whiteSpace: 'nowrap' as const }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
                {/* Funded ≥ chip */}
                <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                  border: `1px solid ${alpha(VL.purpleTint, 0.20)}`, borderRadius: 5,
                  background: 'rgba(16,11,30,0.90)', overflow: 'hidden' }}>
                  <span style={{ padding: '0 10px', height: 32, display: 'flex', alignItems: 'center',
                    fontSize: 9, color: alpha(VL.purpleTint, 0.45), textTransform: 'uppercase',
                    letterSpacing: '0.7px', fontWeight: 700,
                    borderRight: `1px solid ${alpha(VL.purpleTint, 0.12)}`, whiteSpace: 'nowrap' }}>
                    Funded ≥
                  </span>
                  <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                    <input type="text" inputMode="numeric" pattern="[0-9]*"
                      value={pfMinPct}
                      onChange={e => { if (/^\d{0,3}$/.test(e.target.value)) { setPfMinPct(e.target.value); localStorage.setItem('vl.mmm-pf.minPct', e.target.value); } }}
                      disabled={pfBusy}
                      style={{ width: 48, padding: '0 18px 0 8px', height: 32, fontSize: 13, ...MONO,
                        border: 'none', background: 'transparent', color: VLText.primary, outline: 'none' }}
                    />
                    <span style={{ position: 'absolute', right: 8, fontSize: 10, color: VLText.faint, pointerEvents: 'none' }}>%</span>
                  </div>
                </div>
                {/* Hidden pools toggle */}
                <button type="button" onClick={() => setShowHiddenPanel(v => !v)}
                  disabled={hiddenPools.size === 0}
                  style={{ height: 32, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
                    border: `1px solid ${showHiddenPanel ? alpha(VL.purpleTint, 0.24) : alpha(VL.purpleTint, 0.20)}`,
                    borderRadius: 5, background: showHiddenPanel ? 'rgba(16,11,30,0.95)' : 'rgba(16,11,30,0.90)',
                    color: hiddenPools.size === 0 ? alpha(VL.purpleTint, 0.30) : VLText.muted,
                    fontSize: 11, fontWeight: 700, cursor: hiddenPools.size === 0 ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap', flexShrink: 0 }}>
                  Hidden ({hiddenPools.size})
                </button>
              </div>
            </div>

            {/* Hidden pools panel */}
            {showHiddenPanel && hiddenPools.size > 0 && (
              <div style={{ marginBottom: 14, borderRadius: 8, border: `1px solid ${alpha(VL.purpleTint, 0.20)}`,
                background: 'rgba(16,11,30,0.90)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 14px', fontSize: 10, fontWeight: 700, letterSpacing: '0.6px',
                  textTransform: 'uppercase', color: alpha(VL.purpleTint, 0.55),
                  borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}` }}>
                  Hidden pools — marked &quot;doesn&apos;t work&quot;
                </div>
                {Array.from(hiddenPools).map(pk => (
                  <div key={pk} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '7px 14px', fontSize: 12, ...MONO, borderBottom: `1px solid ${alpha(VL.purpleTint, 0.06)}` }}>
                    <span style={{ color: VLText.primary }}>{pk}</span>
                    <button type="button" onClick={() => unhidePool(pk)}
                      style={{ fontSize: 11, fontWeight: 700, color: rgb(VL.gold), background: 'none',
                        border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                      Unhide
                    </button>
                  </div>
                ))}
              </div>
            )}

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
              const sorted = [...pfResult.pools]
                .filter(p => !hiddenPools.has(p.poolKey))
                .filter(p => pfTypeFilter.size === 0 || pfTypeFilter.has(poolTokenType(p)))
                .sort((a, b) => {
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
                          <col style={{ width: '18%' }} />
                          <col style={{ width: '16%' }} />
                          <col style={{ width:  '7%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width:  '9%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '12%' }} />
                        </colgroup>
                        <thead>
                          <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                            <th style={TH_L}>POOL</th>
                            <th style={TH_L}>COLLECTION</th>
                            <th style={{ ...TH, textAlign: 'center' }}>TYPE</th>
                            <th style={THp} onClick={() => togglePfSort('pct')}>% FUNDED{pfArrow('pct')}</th>
                            <th style={THp} onClick={() => togglePfSort('spotPriceSol')}>SPOT{pfArrow('spotPriceSol')}</th>
                            <th style={THp} onClick={() => togglePfSort('realEscrowSol')}>ESCROW{pfArrow('realEscrowSol')}</th>
                            <th style={THp} onClick={() => togglePfSort('missingSol')}>MISSING{pfArrow('missingSol')}</th>
                            <th style={TH_L}>ADDRESS</th>
                            <th style={{ ...TH, textAlign: 'center' }}>LINKS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((p, i) => (
                            <tr key={p.poolKey}
                              style={{ background: i % 2 === 1 ? alpha(VL.purpleTint, 0.022) : 'transparent' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = alpha(VL.purpleTint, 0.07); }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = i % 2 === 1 ? alpha(VL.purpleTint, 0.022) : ''; }}>
                              <td style={TD_L}>
                                <CopyKey value={p.poolKey} label={short(p.poolKey)} color={alpha(VL.purpleTint, 0.52)} />
                              </td>
                              <td style={TD_L}>
                                {p.collectionName
                                  ? <span style={{ fontSize: 12, color: rgb(VL.gold), fontWeight: 700, letterSpacing: '-0.3px',
                                      textShadow: `0 0 14px ${alpha(VL.gold, 0.22)}` }}>{p.collectionName}</span>
                                  : <span style={{ fontSize: 10, color: alpha(VL.purpleTint, 0.16) }}>—</span>
                                }
                                {p.anyOnly && (
                                  <span title="No FVCA/MCC allowlist — the normal scan can't find this pool, only full scan (+any) does"
                                    style={{ display: 'inline-block', marginLeft: 7, padding: '1px 5px', borderRadius: 3,
                                      border: `1px solid ${alpha(VL.red, 0.33)}`, background: alpha(VL.red, 0.08),
                                      color: rgb(VL.red), fontSize: 8, fontWeight: 700, letterSpacing: '0.4px',
                                      textTransform: 'uppercase', verticalAlign: 'middle' }}>
                                    ⚡ any-only
                                  </span>
                                )}
                              </td>
                              <td style={{ ...TD, textAlign: 'center' }}>
                                {(() => {
                                  const tt = poolTokenType(p);
                                  const c = TOKEN_TYPE_COLOR[tt];
                                  return (
                                    <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 4,
                                      border: `1px solid ${c}55`, background: `${c}12`,
                                      color: c, fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
                                      textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                                      {tt}
                                    </span>
                                  );
                                })()}
                              </td>
                              <td style={{ ...TD, textAlign: 'right', paddingBottom: 6 }}>
                                <span style={{ color: pctColor(p.pct), fontWeight: 700 }}>{p.pct.toFixed(1)}%</span>
                                <div style={{ height: 1, marginTop: 4,
                                  background: pctColor(p.pct),
                                  width: `${Math.min(p.pct, 100)}%`,
                                  opacity: 0.3, marginLeft: 'auto' }} />
                              </td>
                              <td style={TD}>
                                <span style={{ color: VLText.primary, fontWeight: 700 }}>{p.spotPriceSol.toFixed(4)}</span>
                                <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.30), marginLeft: 3 }}>◎</span>
                              </td>
                              <td style={TD}>
                                <a href={`https://solscan.io/account/${p.escrowPda}`} target="_blank" rel="noopener noreferrer"
                                  style={{ color: rgb(VL.gold), fontWeight: 600, textDecoration: 'none' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'none'; }}>
                                  {p.realEscrowSol.toFixed(4)}
                                </a>
                                <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.30), marginLeft: 3 }}>◎</span>
                              </td>
                              <td style={TD}>
                                <span style={{ color: p.missingSol === 0 ? rgb(VL.greenMuted) : rgb(VL.red), fontWeight: 700 }}>
                                  {p.missingSol.toFixed(4)}
                                </span>
                                <span style={{ fontSize: 8, color: alpha(VL.purpleTint, 0.28), marginLeft: 3 }}>◎</span>
                              </td>
                              <td style={TD_L}>
                                <span
                                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.color = VLText.primary; el.style.textDecoration = 'underline'; el.style.textDecorationColor = alpha(VL.purpleTint, 0.40); }}
                                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.color = alpha(VL.purpleTint, 0.52); el.style.textDecoration = 'none'; }}
                                  style={{ color: alpha(VL.purpleTint, 0.52), cursor: 'pointer', fontSize: 11, ...MONO }}
                                  onClick={() => void navigator.clipboard.writeText(p.alKey)}
                                  title={p.alKey}>
                                  {short(p.alKey)}
                                </span>
                              </td>
                              <td style={{ ...TD, textAlign: 'center' }}>
                                <div style={{ display: 'inline-flex', border: `1px solid ${alpha(VL.purpleTint, 0.18)}`, borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
                                  <a href={`https://magiceden.io/u/${p.owner}?chains=%5B%22solana%22%5D&wallets=%5B%22${p.owner}%22%5D&activeTab=%22offers%22`} target="_blank" rel="noopener noreferrer"
                                    title="ME Owner Offers"
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26,
                                      borderRight: `1px solid ${alpha(VL.purpleTint, 0.18)}`,
                                      cursor: 'pointer', textDecoration: 'none', lineHeight: 0 }}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src="/brand/me.png" alt="ME" width={20} height={20} draggable={false} style={{ display: 'block', objectFit: 'cover', pointerEvents: 'none' }} />
                                  </a>
                                  <CopyPoolTemplateBtn poolKey={p.poolKey} escrowPda={p.escrowPda} />
                                  <button type="button" onClick={() => hidePool(p.poolKey)}
                                    title="Hide — doesn't work"
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 26,
                                      border: 'none', borderLeft: `1px solid ${alpha(VL.purpleTint, 0.18)}`, background: 'transparent',
                                      cursor: 'pointer', fontSize: 12, color: alpha(VL.red, 0.65) }}>
                                    ✕
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
