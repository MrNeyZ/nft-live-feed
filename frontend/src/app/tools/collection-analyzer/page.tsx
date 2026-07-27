'use client';

// VictoryLabs — Tools › Collection Analyzer (Stage 1).
// Read-only Solana NFT collection preview analyzer. Paste a collection
// address, an NFT mint address, a Tensor collection URL, or a Magic Eden
// collection URL → backend resolves it to an on-chain collection and fetches
// a small preview page via Helius DAS. NO wallet connect, NO signing, NO full
// collection export.
// Data: GET /api/tools/collection-analyzer/analyze?input=<value>

import { useEffect, useRef, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Mirror of backend CollectionAnalysis (src/tools-collection-analyzer/types.ts)
type InputKind = 'collection' | 'mint' | 'tensor_url' | 'magiceden_url';
type AssetStandard = 'core' | 'pnft' | 'legacy' | 'compressed' | 'unknown';

interface NormalizedAttribute { trait_type: string; value: string; }
interface NormalizedAsset {
  mint: string;
  name: string | null;
  image: string | null;
  jsonUri: string | null;
  collectionAddress: string | null;
  compressed: boolean;
  standard: AssetStandard;
  attributes: NormalizedAttribute[];
}
interface TraitCategorySummary {
  traitType: string;
  values: Array<{ value: string; count: number }>;
}
interface CollectionAnalysis {
  inputKind: InputKind;
  inputValue: string;
  collectionAddress: string;
  totalAssets: number | null;
  previewCount: number;
  assets: NormalizedAsset[];
  traitCategories: TraitCategorySummary[];
  updatedAt: string;
  warnings: string[];
}

// ── Mirror of backend Stage 2 scan types (src/tools-collection-analyzer/scan-types.ts)
type ScanStatus = 'running' | 'completed' | 'error' | 'cancelled';
type ScanErrorCode = 'collection_too_large' | 'scan_timeout' | 'rpc_error' | 'cancelled' | 'capacity';
interface ScanErrorInfo { code: ScanErrorCode; message: string; pagesFetched: number; assetsScanned: number; }
interface ScanProgressSnapshot {
  scanId: string;
  status: ScanStatus;
  pagesFetched: number;
  assetsDiscovered: number;
  duplicatesSkipped: number;
  retryState: { page: number; attempt: number; waitMs: number; httpStatus: number | null } | null;
  elapsedMs: number;
  warning?: string;
}
interface QualityDiagnostics {
  totalAssets: number;
  assetsWithValidMetadata: number;
  assetsMissingAttributes: number;
  assetsMissingImage: number;
  assetsMissingName: number;
  compressedCount: number;
  regularCount: number;
  malformedAttributesSkipped: number;
  duplicateIdenticalAttributePairsCollapsed: number;
  conflictingDuplicateTraitTypeAssets: number;
  nullValueAttributes: number;
  emptyStringValueAttributes: number;
  nonStringTraitTypeCoerced: number;
}
interface FullTraitValueStat { value: string; count: number; percent: number; oneOfOne: boolean; }
interface FullTraitCategorySummary { traitType: string; values: FullTraitValueStat[]; missingCount: number; missingPercent: number; }
interface DuplicateGroupSummary { key: string; count: number; mints: string[]; truncated: boolean; }
interface TraitsPerNftBucket { traitsCount: number; nftCount: number; }
interface OneOfOneHighlight { traitType: string; value: string; mint: string; }
interface ScanResultSummary {
  scanId: string;
  collectionAddress: string;
  inputKind: InputKind;
  inputValue: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pagesFetched: number;
  exactAssetCount: number;
  duplicatesSkipped: number;
  quality: QualityDiagnostics;
  traitCategories: FullTraitCategorySummary[];
  duplicateMetadataGroups: DuplicateGroupSummary[];
  duplicateImageGroups: DuplicateGroupSummary[];
  traitsPerNftDistribution: TraitsPerNftBucket[];
  oneOfOneHighlights: OneOfOneHighlight[];
  oneOfOneHighlightsTruncated: boolean;
  warnings: string[];
}

const SCAN_ASSETS_PAGE_SIZE = 24;
const EXPORT_FILES = ['collection-summary.json', 'assets.json', 'assets.csv', 'trait-counts.json'] as const;

// ── Mirror of backend Stage 3 bundle types (src/tools-collection-analyzer/bundle/bundle-types.ts)
type BundleJobStatus = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';
interface BundleOptions {
  images: boolean;
  normalizedMetadata: boolean;
  originalMetadata: boolean;
  collectionSummary: boolean;
  assetsJson: boolean;
  assetsCsv: boolean;
  traitCounts: boolean;
  failureReport: boolean;
}
const DEFAULT_BUNDLE_OPTIONS: BundleOptions = {
  images: true, normalizedMetadata: true, originalMetadata: false,
  collectionSummary: true, assetsJson: true, assetsCsv: true, traitCounts: true, failureReport: true,
};
const BUNDLE_OPTION_LABEL: Record<keyof BundleOptions, string> = {
  images: 'Images',
  normalizedMetadata: 'Normalized metadata (per-NFT JSON)',
  originalMetadata: 'Original off-chain metadata JSON',
  collectionSummary: 'Collection summary',
  assetsJson: 'Assets JSON',
  assetsCsv: 'Assets CSV',
  traitCounts: 'Trait counts',
  failureReport: 'Failure report',
};
interface BundleProgressSnapshot {
  jobId: string;
  scanId: string;
  status: BundleJobStatus;
  phase: BundleJobStatus;
  totalAssets: number;
  processedAssets: number;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
  bytesDownloaded: number;
  archiveBytesWritten: number | null;
  elapsedMs: number;
  totalParts: number;
  currentPartNumber: number;
}

// ── Mirror of backend Stage 4 part/manifest wire types ─────────────────
type BundlePartStatus = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled';
interface BundlePartStatusWire {
  partNumber: number;
  status: BundlePartStatus;
  assetCount: number;
  firstMint: string;
  lastMint: string;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
  bytesDownloaded: number;
  archiveBytesWritten: number | null;
  sha256: string | null;
  filename: string | null;
  downloadAvailable: boolean;
  error?: { code: string; message: string };
}
interface BundleFullStatusResponse {
  ok: boolean;
  status: BundleJobStatus;
  progress: BundleProgressSnapshot;
  failures: Array<{ mint: string; name: string | null; resourceType: string; message: string }>;
  error?: { code: string; message: string };
  collectionDisplayName: string;
  totalParts: number;
  currentPartNumber: number;
  parts: BundlePartStatusWire[];
  manifestStatus: 'pending' | 'completed' | 'failed';
  manifestAvailable: boolean;
}

const SESSION_KEY_SCAN_ID = 'vl.collection-analyzer.scanId';
const SESSION_KEY_BUNDLE_JOB_ID = 'vl.collection-analyzer.bundleJobId';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const INPUT_KIND_LABEL: Record<InputKind, string> = {
  collection: 'Collection Address',
  mint: 'NFT Mint (resolved to collection)',
  tensor_url: 'Tensor URL',
  magiceden_url: 'Magic Eden URL',
};

const STANDARD_META: Record<AssetStandard, { label: string; color: string }> = {
  core:       { label: 'MPL CORE',   color: '#43b984' },
  pnft:       { label: 'PNFT',       color: '#7ea8d9' },
  legacy:     { label: 'LEGACY',     color: '#c7b479' },
  compressed: { label: 'COMPRESSED', color: '#a890e8' },
  unknown:    { label: 'UNKNOWN',    color: '#9a9ab4' },
};

function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : s;
}

const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.10)',
  padding: 12,
  marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
  color: '#9a9ab4', marginBottom: 6,
};
const MONO = "'SF Mono','Fira Code',monospace";

function Chip({ children, color = '#a890e8' }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 600,
      borderRadius: 5, fontFamily: MONO, color,
      background: `${color}14`, border: `1px solid ${color}3a`,
    }}>{children}</span>
  );
}

export default function CollectionAnalyzerPage() {
  useEffect(() => { document.title = 'Collection Analyzer | VictoryLabs'; }, []);

  const [input, setInput] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CollectionAnalysis | null>(null);

  // ── Stage 2: full-collection scan state ──────────────────────────────
  const [scanStatus, setScanStatus]     = useState<ScanStatus | 'idle' | 'expired'>('idle');
  const [scanId, setScanId]             = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressSnapshot | null>(null);
  const [scanSummary, setScanSummary]   = useState<ScanResultSummary | null>(null);
  const [scanError, setScanError]       = useState<string | null>(null);
  const scanEsRef = useRef<EventSource | null>(null);

  const [scanAssets, setScanAssets]       = useState<NormalizedAsset[]>([]);
  const [scanAssetsOffset, setScanAssetsOffset] = useState(0);
  const [scanAssetsTotal, setScanAssetsTotal]   = useState(0);
  const [scanAssetsBusy, setScanAssetsBusy]     = useState(false);

  const [traitSearch, setTraitSearch] = useState('');

  // ── Stage 3/4: collection bundle (download) state ─────────────────────
  const [bundleOptions, setBundleOptions] = useState<BundleOptions>({ ...DEFAULT_BUNDLE_OPTIONS });
  const [bundleStatus, setBundleStatus] = useState<BundleJobStatus | 'idle' | 'expired'>('idle');
  const [bundleJobId, setBundleJobId] = useState<string | null>(null);
  const [bundleProgress, setBundleProgress] = useState<BundleProgressSnapshot | null>(null);
  const [bundleFailures, setBundleFailures] = useState<Array<{ mint: string; name: string | null; resourceType: string; message: string }>>([]);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleParts, setBundleParts] = useState<BundlePartStatusWire[]>([]);
  const [bundleCollectionName, setBundleCollectionName] = useState<string>('');
  const [bundleManifestAvailable, setBundleManifestAvailable] = useState(false);
  const bundleEsRef = useRef<EventSource | null>(null);
  const bundlePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    scanEsRef.current?.close();
    bundleEsRef.current?.close();
    if (bundlePollRef.current) clearInterval(bundlePollRef.current);
  }, []);

  const loadScanAssetsPage = async (id: string, offset: number) => {
    setScanAssetsBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/scan/${id}/assets?offset=${offset}&limit=${SCAN_ASSETS_PAGE_SIZE}`);
      if (r.status === 404) { setScanStatus('expired'); return; }
      if (!r.ok) return;
      const body = await r.json() as { ok: boolean; total: number; offset: number; assets: NormalizedAsset[] };
      if (!body.ok) return;
      setScanAssets(body.assets);
      setScanAssetsOffset(body.offset);
      setScanAssetsTotal(body.total);
    } catch { /* transient — leave current page displayed */ }
    finally { setScanAssetsBusy(false); }
  };

  const toggleBundleOption = (key: keyof BundleOptions) => {
    setBundleOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const stopBundlePolling = () => {
    if (bundlePollRef.current) { clearInterval(bundlePollRef.current); bundlePollRef.current = null; }
  };

  const applyBundleStatus = (jobId: string, body: BundleFullStatusResponse) => {
    setBundleProgress(body.progress);
    setBundleFailures(body.failures ?? []);
    setBundleParts(body.parts ?? []);
    setBundleCollectionName(body.collectionDisplayName ?? '');
    setBundleManifestAvailable(!!body.manifestAvailable);
    setBundleStatus(body.status);
    if (body.status === 'failed' || body.status === 'cancelled') {
      setBundleError(body.error?.message ?? (body.status === 'cancelled' ? 'Bundle cancelled.' : 'Bundle generation failed.'));
    }
    if (['completed', 'failed', 'cancelled'].includes(body.status)) {
      bundleEsRef.current?.close();
      bundleEsRef.current = null;
      stopBundlePolling();
    }
    void jobId;
  };

  // REST poll — the durable, connection-independent progress path (works
  // across page refresh / SSE disconnect, per Stage 4 spec). SSE (below)
  // supplements it with faster updates while the tab stays open, but is
  // never required to stay connected.
  const startBundlePolling = (jobId: string) => {
    stopBundlePolling();
    bundlePollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/bundles/${jobId}`);
        if (r.status === 404) { setBundleStatus('expired'); stopBundlePolling(); bundleEsRef.current?.close(); return; }
        if (!r.ok) return;
        const body = await r.json() as BundleFullStatusResponse;
        if (!body.ok) return;
        applyBundleStatus(jobId, body);
      } catch { /* transient — next tick retries */ }
    }, 4000);
  };

  const attachBundleStream = (jobId: string) => {
    bundleEsRef.current?.close();
    const es = new EventSource(`${API_BASE}/api/tools/collection-analyzer/bundles/${jobId}/stream`);
    bundleEsRef.current = es;
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type: string; failures?: typeof bundleFailures; error?: { message?: string } } & Partial<BundleProgressSnapshot>;
        if (data.status) setBundleProgress(data as BundleProgressSnapshot);
        if (data.failures) setBundleFailures(data.failures);
        if (data.type === 'result') { setBundleStatus('completed'); es.close(); stopBundlePolling(); }
        else if (data.type === 'cancelled') { setBundleStatus('cancelled'); setBundleError(data.error?.message ?? 'Bundle cancelled.'); es.close(); stopBundlePolling(); }
        else if (data.type === 'error') { setBundleStatus('failed'); setBundleError(data.error?.message ?? 'Bundle generation failed.'); es.close(); stopBundlePolling(); }
        else if (data.status) setBundleStatus(data.status);
      } catch { /* ignore malformed frame */ }
      // Always fetch the FULL status too — SSE ticks carry only the
      // aggregate progress, not the parts/manifest wire shape.
      void fetch(`${API_BASE}/api/tools/collection-analyzer/bundles/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body: BundleFullStatusResponse | null) => { if (body?.ok) applyBundleStatus(jobId, body); })
        .catch(() => {});
    };
    es.onerror = () => { /* connection hiccup only — job keeps running server-side; the REST poll below covers us */ };
  };

  const clearBundleState = () => {
    bundleEsRef.current?.close();
    bundleEsRef.current = null;
    stopBundlePolling();
    setBundleStatus('idle');
    setBundleJobId(null);
    setBundleProgress(null);
    setBundleFailures([]);
    setBundleParts([]);
    setBundleCollectionName('');
    setBundleManifestAvailable(false);
    setBundleError(null);
    try { sessionStorage.removeItem(SESSION_KEY_BUNDLE_JOB_ID); } catch { /* private mode */ }
  };

  const startBundle = async () => {
    if (!scanId || bundleStatus === 'queued' || bundleStatus === 'downloading' || bundleStatus === 'archiving') return;
    if (!Object.values(bundleOptions).some(Boolean)) { setBundleError('Select at least one bundle option.'); return; }
    playUiConfirm();
    setBundleStatus('queued');
    setBundleJobId(null);
    setBundleProgress(null);
    setBundleFailures([]);
    setBundleParts([]);
    setBundleError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/scans/${scanId}/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: bundleOptions }),
      });
      const body = await r.json() as { ok: boolean; jobId?: string; error?: string };
      if (!body.ok || !body.jobId) {
        setBundleStatus('failed');
        setBundleError(body.error === 'empty_selection' ? 'Select at least one bundle option.' : `Could not start bundle generation (${body.error ?? r.status}).`);
        return;
      }
      setBundleJobId(body.jobId);
      try { sessionStorage.setItem(SESSION_KEY_BUNDLE_JOB_ID, body.jobId); } catch { /* private mode */ }
      attachBundleStream(body.jobId);
      startBundlePolling(body.jobId);
    } catch (e) {
      setBundleStatus('failed');
      setBundleError((e as Error).message);
    }
  };

  const cancelBundle = async () => {
    if (!bundleJobId) return;
    try {
      await fetch(`${API_BASE}/api/tools/collection-analyzer/bundles/${bundleJobId}/cancel`, { method: 'POST' });
    } catch { /* the stream/poll will reflect the eventual state regardless */ }
  };

  // Restore-on-mount: page refresh or reopened tab recovers progress via
  // REST alone (no SSE needed) as long as the job ID is still in session
  // storage. Only identifiers are persisted — no long-term tracking.
  useEffect(() => {
    let storedScanId: string | null = null;
    let storedJobId: string | null = null;
    try {
      storedScanId = sessionStorage.getItem(SESSION_KEY_SCAN_ID);
      storedJobId = sessionStorage.getItem(SESSION_KEY_BUNDLE_JOB_ID);
    } catch { /* private mode — nothing to restore */ }

    (async () => {
      if (storedScanId) {
        try {
          const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/scan/${storedScanId}/status`);
          if (r.ok) {
            const body = await r.json() as { ok: boolean; status?: ScanStatus; summary?: ScanResultSummary };
            if (body.ok && body.status === 'completed' && body.summary) {
              setScanId(storedScanId);
              setScanStatus('completed');
              setScanSummary(body.summary);
              void loadScanAssetsPage(storedScanId, 0);
            }
          }
        } catch { /* ignore — user can rescan */ }
      }
      if (storedJobId) {
        try {
          const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/bundles/${storedJobId}`);
          if (r.status === 404) { try { sessionStorage.removeItem(SESSION_KEY_BUNDLE_JOB_ID); } catch { /* ignore */ } return; }
          if (!r.ok) return;
          const body = await r.json() as BundleFullStatusResponse;
          if (!body.ok) return;
          setBundleJobId(storedJobId);
          applyBundleStatus(storedJobId, body);
          if (!['completed', 'failed', 'cancelled'].includes(body.status)) {
            attachBundleStream(storedJobId);
            startBundlePolling(storedJobId);
          }
        } catch { /* ignore — user can regenerate */ }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearScanState = () => {
    scanEsRef.current?.close();
    scanEsRef.current = null;
    setScanStatus('idle');
    setScanId(null);
    setScanProgress(null);
    setScanSummary(null);
    setScanError(null);
    setScanAssets([]);
    setScanAssetsOffset(0);
    setScanAssetsTotal(0);
    setTraitSearch('');
    try { sessionStorage.removeItem(SESSION_KEY_SCAN_ID); } catch { /* private mode */ }
    clearBundleState();
  };

  const startFullScan = () => {
    const trimmed = input.trim();
    if (trimmed.length === 0 || scanStatus === 'running') return;
    playUiConfirm();
    scanEsRef.current?.close();
    setScanStatus('running');
    setScanId(null);
    setScanProgress(null);
    setScanSummary(null);
    setScanError(null);
    setScanAssets([]);
    setScanAssetsOffset(0);
    setScanAssetsTotal(0);

    const url = `${API_BASE}/api/tools/collection-analyzer/scan-stream?input=${encodeURIComponent(trimmed)}`;
    const es = new EventSource(url);
    scanEsRef.current = es;
    const closeEs = () => { if (scanEsRef.current === es) scanEsRef.current = null; es.close(); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as
          | { type: 'progress' } & ScanProgressSnapshot
          | { type: 'result'; scanId: string; summary: ScanResultSummary }
          | { type: 'cancelled' | 'error'; scanId: string; error?: ScanErrorInfo };
        if (data.type === 'progress') {
          setScanId(data.scanId);
          setScanProgress(data);
        } else if (data.type === 'result') {
          setScanId(data.scanId);
          setScanSummary(data.summary);
          setScanStatus('completed');
          try { sessionStorage.setItem(SESSION_KEY_SCAN_ID, data.scanId); } catch { /* private mode */ }
          closeEs();
          void loadScanAssetsPage(data.scanId, 0);
        } else if (data.type === 'cancelled') {
          setScanStatus('cancelled');
          setScanError(data.error?.message ?? 'Scan cancelled.');
          closeEs();
        } else {
          setScanStatus('error');
          setScanError(data.error?.message ?? 'Scan failed.');
          closeEs();
        }
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      // Terminal frames close the connection themselves; a residual
      // onerror after that is just the browser noticing the closed
      // socket — don't stomp a status that already resolved.
      setScanStatus((prev) => (prev === 'running' ? 'error' : prev));
      setScanError((prev) => prev ?? 'Connection error during scan.');
      closeEs();
    };
  };

  const cancelScan = () => {
    // Closing the EventSource tears down the underlying HTTP connection,
    // which the backend detects as a client disconnect and treats as the
    // scan's ONLY cancellation trigger (see scan-stream route).
    scanEsRef.current?.close();
    scanEsRef.current = null;
    setScanStatus('cancelled');
  };

  const filteredTraitCategories = (scanSummary?.traitCategories ?? []).filter((cat) => {
    if (!traitSearch.trim()) return true;
    const q = traitSearch.trim().toLowerCase();
    return cat.traitType.toLowerCase().includes(q) || cat.values.some((v) => v.value.toLowerCase().includes(q));
  });

  const run = async () => {
    const trimmed = input.trim();
    if (busy || trimmed.length === 0) return;
    playUiConfirm();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/analyze?input=${encodeURIComponent(trimmed)}`, {
        headers: { ...authHeaders() },
      });
      if (r.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (r.status === 400) { setError('Invalid input — paste a collection address, an NFT mint address, a Tensor collection URL, or a Magic Eden collection URL.'); return; }
      if (r.status === 404) { setError('Could not resolve that collection — the slug or address may be wrong or unindexed.'); return; }
      if (r.status === 502) { setError('Upstream lookup failed — try again in a moment.'); return; }
      if (!r.ok) { setError(`Analyze failed — HTTP ${r.status}.`); return; }
      const body = await r.json() as { ok: boolean; analysis?: CollectionAnalysis; error?: string };
      if (!body.ok || !body.analysis) { setError('Analyze failed.'); return; }
      setAnalysis(body.analysis);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
          COLLECTION ANALYZER
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · collection address, NFT mint, Tensor URL, or Magic Eden URL → asset + trait preview</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: '#c7b479' }}>
          Stage 1 — analyzes a small preview only. Does not yet export the complete collection.
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder="Collection address, NFT mint, tensor.trade/trade/<slug>, or magiceden.io/marketplace/<slug>…"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              fontFamily: MONO, borderRadius: 5,
              border: '1px solid rgba(168,144,232,0.40)',
              background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={run}
            disabled={busy || input.trim().length === 0}
            data-uisnd="skip"
            style={{
              padding: '7px 18px', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
              cursor: (busy || input.trim().length === 0) ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(168,144,232,0.55)',
              background: (busy || input.trim().length === 0) ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
              color: (busy || input.trim().length === 0) ? '#9a9ab4' : '#f0eef8',
              boxShadow: (busy || input.trim().length === 0) ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
              transition: 'all 0.15s',
            }}
          >
            {busy ? 'Analyzing…' : 'Analyze'}
          </button>
          <button
            type="button"
            onClick={startFullScan}
            disabled={scanStatus === 'running' || input.trim().length === 0}
            data-uisnd="skip"
            title="Walks the full collection via bounded, retried Helius DAS pagination — may take a while and spends real RPC requests"
            style={{
              padding: '7px 18px', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
              cursor: (scanStatus === 'running' || input.trim().length === 0) ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(126,168,217,0.55)',
              background: (scanStatus === 'running' || input.trim().length === 0) ? 'rgba(126,168,217,0.10)' : 'linear-gradient(180deg, rgba(126,168,217,0.28) 0%, rgba(126,168,217,0.14) 100%)',
              color: (scanStatus === 'running' || input.trim().length === 0) ? '#9a9ab4' : '#f0eef8',
              transition: 'all 0.15s',
            }}
          >
            {scanStatus === 'running' ? 'Scanning…' : 'Scan Full Collection'}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 10.5, color: '#9a9ab4' }}>
          Full scan may take time for large collections and spends real Helius RPC requests (bounded — up to ~60,000 assets, ~10 min).
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#d96867',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Result */}
      {analysis && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '0 4px 24px' }}>

          {/* Summary */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Collection summary</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 12, fontFamily: MONO, marginBottom: 8 }}>
              <div><span style={{ color: '#9a9ab4' }}>input type </span><span style={{ color: '#f0eef8' }}>{INPUT_KIND_LABEL[analysis.inputKind]}</span></div>
              <div><span style={{ color: '#9a9ab4' }}>total assets </span><span style={{ color: '#f0eef8' }}>{analysis.totalAssets !== null ? analysis.totalAssets.toLocaleString() : '—'}</span></div>
              <div><span style={{ color: '#9a9ab4' }}>preview fetched </span><span style={{ color: '#f0eef8' }}>{analysis.previewCount}</span></div>
              <div><span style={{ color: '#9a9ab4' }}>trait categories </span><span style={{ color: '#f0eef8' }}>{analysis.traitCategories.length}</span></div>
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO, color: '#c4b8e8', wordBreak: 'break-all' }}>
              {analysis.collectionAddress}
            </div>
            {analysis.warnings.length > 0 && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 11.5, color: '#c7b479', lineHeight: 1.6 }}>
                {analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </div>

          {/* Trait categories */}
          {analysis.traitCategories.length > 0 && (
            <div style={PANEL}>
              <div style={SECTION_LABEL}>Trait categories (preview only)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {analysis.traitCategories.map((cat) => (
                  <div key={cat.traitType}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', marginBottom: 4 }}>{cat.traitType}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {cat.values.map((v) => (
                        <Chip key={v.value} color="#9a9ab4">{v.value} ×{v.count}</Chip>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Asset grid */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Preview assets ({analysis.assets.length})</div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 10,
            }}>
              {analysis.assets.map((a) => {
                const std = STANDARD_META[a.standard];
                return (
                  <div key={a.mint} style={{
                    border: '1px solid rgba(168,144,232,0.22)', borderRadius: 8,
                    padding: 8, background: 'rgba(255,255,255,0.02)',
                  }}>
                    <div style={{
                      width: '100%', aspectRatio: '1 / 1', borderRadius: 6, overflow: 'hidden',
                      background: 'rgba(255,255,255,0.04)', marginBottom: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {a.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.image} alt={a.name ?? a.mint} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ fontSize: 10, color: '#6e6688' }}>no image</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.name ?? shortAddr(a.mint)}
                    </div>
                    <a href={`https://solscan.io/token/${a.mint}`} target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: 10, fontFamily: MONO, color: '#9a9ab4', textDecoration: 'none' }}>
                      {shortAddr(a.mint)}
                    </a>
                    <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <Chip color={std.color}>{std.label}</Chip>
                      {a.compressed && <Chip color="#a890e8">CNFT</Chip>}
                    </div>
                    {a.attributes.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 10, color: '#9a9ab4', lineHeight: 1.5 }}>
                        {a.attributes.slice(0, 4).map((attr, i) => (
                          <div key={i}><span style={{ color: '#7ea8d9' }}>{attr.trait_type}</span>: {attr.value}</div>
                        ))}
                        {a.attributes.length > 4 && <div>+{a.attributes.length - 4} more</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}

      {/* ── Stage 2: full-collection scan ─────────────────────────────── */}
      {scanStatus !== 'idle' && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '0 4px 24px' }}>

          {scanStatus === 'running' && (
            <div style={PANEL}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={SECTION_LABEL}>Scanning full collection…</div>
                <button
                  type="button"
                  onClick={cancelScan}
                  data-uisnd="skip"
                  style={{
                    padding: '4px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px',
                    textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(217,104,103,0.5)', background: 'rgba(217,104,103,0.10)', color: '#d96867',
                  }}
                >
                  Cancel
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 12, fontFamily: MONO, marginTop: 8 }}>
                <div><span style={{ color: '#9a9ab4' }}>pages </span><span style={{ color: '#f0eef8' }}>{scanProgress?.pagesFetched ?? 0}</span></div>
                <div><span style={{ color: '#9a9ab4' }}>assets found </span><span style={{ color: '#f0eef8' }}>{scanProgress?.assetsDiscovered ?? 0}</span></div>
                <div><span style={{ color: '#9a9ab4' }}>duplicates skipped </span><span style={{ color: '#f0eef8' }}>{scanProgress?.duplicatesSkipped ?? 0}</span></div>
                <div><span style={{ color: '#9a9ab4' }}>elapsed </span><span style={{ color: '#f0eef8' }}>{Math.round((scanProgress?.elapsedMs ?? 0) / 1000)}s</span></div>
              </div>
              {scanProgress?.retryState && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#c7b479' }}>
                  Retrying page {scanProgress.retryState.page} (attempt {scanProgress.retryState.attempt}
                  {scanProgress.retryState.httpStatus ? `, HTTP ${scanProgress.retryState.httpStatus}` : ''}) — waiting {Math.round(scanProgress.retryState.waitMs / 1000)}s…
                </div>
              )}
            </div>
          )}

          {(scanStatus === 'cancelled' || scanStatus === 'error' || scanStatus === 'expired') && (
            <div style={{ ...PANEL, borderColor: 'rgba(217,104,103,0.4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ fontSize: 12, color: '#d96867' }}>
                  {scanStatus === 'cancelled' && 'Scan cancelled.'}
                  {scanStatus === 'error' && (scanError ?? 'Scan failed.')}
                  {scanStatus === 'expired' && 'This scan result has expired (TTL passed) — rescan to view it again.'}
                </div>
                <button
                  type="button"
                  onClick={clearScanState}
                  data-uisnd="skip"
                  style={{
                    padding: '4px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px',
                    textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8',
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {scanStatus === 'completed' && scanSummary && (
            <>
              <div style={PANEL}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                  <div style={SECTION_LABEL}>Full scan summary</div>
                  <button
                    type="button"
                    onClick={clearScanState}
                    data-uisnd="skip"
                    style={{
                      padding: '4px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px',
                      textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                      border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8',
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 12, fontFamily: MONO }}>
                  <div><span style={{ color: '#9a9ab4' }}>exact assets </span><span style={{ color: '#43b984', fontWeight: 700 }}>{scanSummary.exactAssetCount.toLocaleString()}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>pages fetched </span><span style={{ color: '#f0eef8' }}>{scanSummary.pagesFetched}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>duplicates skipped </span><span style={{ color: '#f0eef8' }}>{scanSummary.duplicatesSkipped}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>duration </span><span style={{ color: '#f0eef8' }}>{Math.round(scanSummary.durationMs / 1000)}s</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>compressed / regular </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.compressedCount} / {scanSummary.quality.regularCount}</span></div>
                </div>
                {scanSummary.warnings.length > 0 && (
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 11, color: '#c7b479', lineHeight: 1.6 }}>
                    {scanSummary.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>

              {/* Export buttons */}
              <div style={PANEL}>
                <div style={SECTION_LABEL}>Export</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {EXPORT_FILES.map((file) => (
                    <a
                      key={file}
                      href={`${API_BASE}/api/tools/collection-analyzer/scan/${scanId}/export/${file}`}
                      style={{
                        padding: '6px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.3px',
                        borderRadius: 5, textDecoration: 'none', fontFamily: MONO,
                        border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8',
                      }}
                    >
                      {file}
                    </a>
                  ))}
                </div>
              </div>

              {/* Metadata quality diagnostics */}
              <div style={PANEL}>
                <div style={SECTION_LABEL}>Metadata quality</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11.5, fontFamily: MONO }}>
                  <div><span style={{ color: '#9a9ab4' }}>valid metadata </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.assetsWithValidMetadata}/{scanSummary.quality.totalAssets}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>missing name </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.assetsMissingName}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>missing image </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.assetsMissingImage}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>missing attributes </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.assetsMissingAttributes}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>malformed attrs skipped </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.malformedAttributesSkipped}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>conflicting dup traits </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.conflictingDuplicateTraitTypeAssets}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>null / empty values </span><span style={{ color: '#f0eef8' }}>{scanSummary.quality.nullValueAttributes} / {scanSummary.quality.emptyStringValueAttributes}</span></div>
                </div>
                {(scanSummary.duplicateMetadataGroups.length > 0 || scanSummary.duplicateImageGroups.length > 0) && (
                  <div style={{ marginTop: 10, fontSize: 11, color: '#9a9ab4' }}>
                    {scanSummary.duplicateMetadataGroups.length} duplicate metadata signature group(s) · {scanSummary.duplicateImageGroups.length} duplicate image group(s)
                  </div>
                )}
              </div>

              {/* Trait explorer */}
              <div style={PANEL}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                  <div style={SECTION_LABEL}>Trait explorer ({scanSummary.traitCategories.length} categories)</div>
                  <input
                    type="text"
                    value={traitSearch}
                    onChange={(e) => setTraitSearch(e.target.value)}
                    placeholder="Search trait category or value…"
                    spellCheck={false}
                    style={{
                      padding: '5px 10px', fontSize: 11, fontFamily: MONO, borderRadius: 5, minWidth: 200,
                      border: '1px solid rgba(168,144,232,0.40)', background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }} className="scroll-area">
                  {filteredTraitCategories.map((cat) => (
                    <div key={cat.traitType}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', marginBottom: 4 }}>
                        {cat.traitType}
                        <span style={{ fontSize: 10, color: '#9a9ab4', fontWeight: 400 }}> · missing {cat.missingCount} ({cat.missingPercent}%)</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {cat.values.map((v) => (
                          <Chip key={v.value} color={v.oneOfOne ? '#a890e8' : '#9a9ab4'}>
                            {v.value} ×{v.count} ({v.percent}%){v.oneOfOne ? ' 1/1' : ''}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ))}
                  {filteredTraitCategories.length === 0 && (
                    <div style={{ fontSize: 11, color: '#6e6688' }}>No trait categories match &quot;{traitSearch}&quot;.</div>
                  )}
                </div>
              </div>

              {/* Paginated full-scan asset browser */}
              <div style={PANEL}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                  <div style={SECTION_LABEL}>All assets ({scanAssetsTotal.toLocaleString()})</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, fontFamily: MONO, color: '#9a9ab4' }}>
                    <button
                      type="button"
                      disabled={scanAssetsBusy || scanAssetsOffset === 0 || !scanId}
                      onClick={() => scanId && loadScanAssetsPage(scanId, Math.max(0, scanAssetsOffset - SCAN_ASSETS_PAGE_SIZE))}
                      style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.35)', background: 'transparent', color: '#c4b8e8' }}
                    >
                      ‹ Prev
                    </button>
                    <span>{scanAssetsTotal === 0 ? '0' : `${scanAssetsOffset + 1}–${Math.min(scanAssetsOffset + SCAN_ASSETS_PAGE_SIZE, scanAssetsTotal)}`} of {scanAssetsTotal}</span>
                    <button
                      type="button"
                      disabled={scanAssetsBusy || scanAssetsOffset + SCAN_ASSETS_PAGE_SIZE >= scanAssetsTotal || !scanId}
                      onClick={() => scanId && loadScanAssetsPage(scanId, scanAssetsOffset + SCAN_ASSETS_PAGE_SIZE)}
                      style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.35)', background: 'transparent', color: '#c4b8e8' }}
                    >
                      Next ›
                    </button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
                  {scanAssets.map((a) => (
                    <div key={a.mint} style={{ border: '1px solid rgba(168,144,232,0.22)', borderRadius: 8, padding: 8, background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{
                        width: '100%', aspectRatio: '1 / 1', borderRadius: 6, overflow: 'hidden',
                        background: 'rgba(255,255,255,0.04)', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {a.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.image} alt={a.name ?? a.mint} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <span style={{ fontSize: 9, color: '#6e6688' }}>no image</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.name ?? shortAddr(a.mint)}
                      </div>
                      <div style={{ fontSize: 9.5, fontFamily: MONO, color: '#9a9ab4' }}>{shortAddr(a.mint)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Stage 3: collection bundle download ───────────────────────── */}
      {scanStatus === 'completed' && scanSummary && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '0 4px 24px' }}>
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Download collection</div>
            <div style={{ fontSize: 11, color: '#c7b479', marginBottom: 10 }}>
              Downloads final rendered NFT images and metadata from their public off-chain hosts — some may fail if a host is slow or gone.
              This does NOT recover the project&apos;s original layered/source artwork files.
            </div>

            {(bundleStatus === 'idle' || bundleStatus === 'expired') && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6, marginBottom: 10 }}>
                  {(Object.keys(BUNDLE_OPTION_LABEL) as Array<keyof BundleOptions>).map((key) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#c8c8dc', cursor: 'pointer' }}>
                      <input type="checkbox" checked={bundleOptions[key]} onChange={() => toggleBundleOption(key)} />
                      {BUNDLE_OPTION_LABEL[key]}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 10.5, color: '#9a9ab4', marginBottom: 10 }}>
                  Estimated file count: ~{scanSummary.exactAssetCount * ((bundleOptions.images ? 1 : 0) + (bundleOptions.normalizedMetadata ? 1 : 0) + (bundleOptions.originalMetadata ? 1 : 0)) + 1}
                  {bundleStatus === 'expired' && <span style={{ color: '#d96867' }}> · Previous bundle expired — generate a new one.</span>}
                </div>
                <button
                  type="button"
                  onClick={startBundle}
                  data-uisnd="skip"
                  style={{
                    padding: '7px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
                    cursor: 'pointer', border: '1px solid rgba(126,168,217,0.55)',
                    background: 'linear-gradient(180deg, rgba(126,168,217,0.28) 0%, rgba(126,168,217,0.14) 100%)', color: '#f0eef8',
                  }}
                >
                  Generate ZIP
                </button>
              </>
            )}

            {(bundleStatus === 'queued' || bundleStatus === 'downloading' || bundleStatus === 'archiving') && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', textTransform: 'uppercase' }}>
                    {bundleProgress?.phase ?? bundleStatus}…
                    {(bundleProgress?.totalParts ?? 1) > 1 && (
                      <span style={{ color: '#9a9ab4', textTransform: 'none', fontWeight: 400 }}> — part {bundleProgress?.currentPartNumber ?? 1} of {bundleProgress?.totalParts}</span>
                    )}
                  </div>
                  <button type="button" onClick={cancelBundle} data-uisnd="skip" style={{ padding: '4px 12px', fontSize: 10.5, fontWeight: 700, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(217,104,103,0.5)', background: 'rgba(217,104,103,0.10)', color: '#d96867' }}>
                    Cancel
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11.5, fontFamily: MONO }}>
                  <div><span style={{ color: '#9a9ab4' }}>processed </span><span style={{ color: '#f0eef8' }}>{bundleProgress?.processedAssets ?? 0}/{bundleProgress?.totalAssets ?? scanSummary.exactAssetCount}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>images </span><span style={{ color: '#43b984' }}>{bundleProgress?.successfulImages ?? 0} ok</span><span style={{ color: '#d96867' }}> / {bundleProgress?.failedImages ?? 0} failed</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>downloaded </span><span style={{ color: '#f0eef8' }}>{formatBytes(bundleProgress?.bytesDownloaded ?? 0)}</span></div>
                </div>
                <div style={{ fontSize: 10, color: '#6e6688', marginTop: 8 }}>You can navigate away — this bundle keeps generating on the server and will still be here when you come back.</div>
              </div>
            )}

            {(bundleStatus === 'completed' || bundleStatus === 'failed') && bundleJobId && bundleParts.length > 0 && (
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11.5, fontFamily: MONO, marginBottom: 10 }}>
                  <div><span style={{ color: '#9a9ab4' }}>collection </span><span style={{ color: '#f0eef8' }}>{bundleCollectionName || '—'}</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>images </span><span style={{ color: '#43b984' }}>{bundleProgress?.successfulImages ?? 0} ok</span><span style={{ color: '#d96867' }}> / {bundleProgress?.failedImages ?? 0} failed</span></div>
                  <div><span style={{ color: '#9a9ab4' }}>parts </span><span style={{ color: '#f0eef8' }}>{bundleParts.filter((p) => p.status === 'completed').length}/{bundleParts.length} completed</span></div>
                </div>

                {bundleParts.some((p) => p.status === 'failed') && (
                  <div style={{ fontSize: 11, color: '#c7b479', marginBottom: 10, padding: '6px 10px', background: 'rgba(232,193,74,0.08)', border: '1px solid rgba(232,193,74,0.3)', borderRadius: 5 }}>
                    {bundleParts.filter((p) => p.status === 'failed').length} part(s) failed to generate — the completed parts below are still fully downloadable. Retrying regenerates the whole bundle.
                  </div>
                )}
                {bundleFailures.length > 0 && (
                  <div style={{ fontSize: 10.5, color: '#c7b479', marginBottom: 10 }}>{bundleFailures.length} individual download(s) failed — see failed-downloads.json in each part.</div>
                )}

                {/* Compact parts list — one row per PART, never per NFT */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {bundleParts.map((p) => (
                    <div key={p.partNumber} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
                      padding: '6px 10px', borderRadius: 5, border: '1px solid rgba(168,144,232,0.22)', background: 'rgba(255,255,255,0.02)',
                    }}>
                      <div style={{ fontSize: 11, fontFamily: MONO, display: 'flex', gap: 10, alignItems: 'center' }}>
                        <Chip color={p.status === 'completed' ? '#43b984' : p.status === 'failed' ? '#d96867' : '#9a9ab4'}>
                          {bundleParts.length > 1 ? `PART ${p.partNumber}` : 'BUNDLE'}
                        </Chip>
                        <span style={{ color: '#9a9ab4' }}>{p.assetCount} assets</span>
                        {p.archiveBytesWritten !== null && <span style={{ color: '#9a9ab4' }}>{formatBytes(p.archiveBytesWritten)}</span>}
                        <span style={{ color: '#6e6688', textTransform: 'uppercase' }}>{p.status}</span>
                      </div>
                      {p.downloadAvailable ? (
                        <a
                          href={`${API_BASE}/api/tools/collection-analyzer/bundles/${bundleJobId}/parts/${p.partNumber}/download`}
                          style={{ padding: '3px 12px', fontSize: 10.5, fontWeight: 700, borderRadius: 4, textDecoration: 'none', border: '1px solid rgba(126,217,168,0.5)', background: 'rgba(126,217,168,0.12)', color: '#43b984' }}
                        >
                          Download
                        </a>
                      ) : (
                        <span style={{ fontSize: 10.5, color: '#6e6688' }}>{p.error?.message ?? 'unavailable'}</span>
                      )}
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {bundleParts.length === 1 && bundleParts[0].downloadAvailable && (
                    <a
                      href={`${API_BASE}/api/tools/collection-analyzer/bundles/${bundleJobId}/download`}
                      style={{ padding: '7px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5, textDecoration: 'none', border: '1px solid rgba(126,217,168,0.55)', background: 'rgba(126,217,168,0.14)', color: '#43b984' }}
                    >
                      Download ZIP
                    </a>
                  )}
                  {bundleManifestAvailable && (
                    <a
                      href={`${API_BASE}/api/tools/collection-analyzer/bundles/${bundleJobId}/manifest`}
                      style={{ padding: '7px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5, textDecoration: 'none', border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8' }}
                    >
                      Download Manifest
                    </a>
                  )}
                  <button type="button" onClick={clearBundleState} data-uisnd="skip" style={{ padding: '7px 14px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8' }}>
                    Start over
                  </button>
                </div>
              </div>
            )}

            {((bundleStatus === 'failed' && bundleParts.length === 0) || bundleStatus === 'cancelled') && (
              <div>
                <div style={{ fontSize: 12, color: '#d96867', marginBottom: 8 }}>{bundleError ?? (bundleStatus === 'cancelled' ? 'Bundle cancelled.' : 'Bundle generation failed.')}</div>
                <button type="button" onClick={clearBundleState} data-uisnd="skip" style={{ padding: '6px 14px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8' }}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
