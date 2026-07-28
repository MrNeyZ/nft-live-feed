'use client';

// VictoryLabs — Tools › Collection Analyzer › Download Trait Collection.
// "Reconstruct reusable visual trait assets from a generative NFT collection."
// Honest framing throughout: results are INFERRED candidates, never called
// "original layers." Mirrors the Stage 3/4 bundle job architecture (SSE
// subscriber-only + REST poll fallback + sessionStorage-only job/scan id
// persistence, no long-term tracking).

import { useEffect, useRef, useState } from 'react';
import { playUiConfirm } from '@/soloist/use-ui-sound';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const SESSION_KEY_TE_JOB_ID = 'vl.collection-analyzer.traitExtractionJobId';

// ── Mirror of backend trait-extraction types ────────────────────────────
type EligibilityClassification = 'suitable' | 'possibly_suitable' | 'unsuitable';
interface TraitCollectionEligibility {
  totalAssets: number; assetsWithAttributes: number; percentWithAttributes: number;
  totalTraitCategories: number; categoriesWithRepeatedValues: number; totalRepeatedTraitValues: number;
  medianAssetsPerTraitValue: number; valuesOccurringOnce: number; assetsWithNoAttributes: number;
  malformedAttributeCount: number; percentInRepeatedStructure: number;
  classification: EligibilityClassification; reasons: string[];
}
type ExtractionPreset = 'fast' | 'balanced' | 'thorough';
type ConfidenceStatus = 'high_confidence' | 'medium_confidence' | 'low_confidence' | 'unresolved' | 'visually_identical';
type TeJobStatus = 'queued' | 'downloading' | 'processing' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';
interface TeProgress {
  jobId: string; scanId: string; status: TeJobStatus; phase: TeJobStatus;
  currentCategory: string | null; currentTraitValue: string | null;
  totalValues: number; processedValues: number;
  uniqueImagesDownloaded: number; comparisonsEvaluated: number;
  resolvedHigh: number; resolvedMedium: number; resolvedLow: number; resolvedUnresolved: number; resolvedVisuallyIdentical: number;
  failedImageCount: number; bytesDownloaded: number; elapsedMs: number; warning?: string;
}
type SearchStopReason =
  | 'exact_evidence_sufficient' | 'consensus_stabilized' | 'preset_pair_cap'
  | 'no_more_candidates' | 'timeout' | 'weighted_quality_threshold';
interface ValueSearchDiagnostics {
  assetsSearchable: number; exactBucketSize: number;
  level0CandidatesFound: number; level1CandidatesFound: number; level2CandidatesFound: number;
  candidatesRejectedHighImpact: number; pairsAccepted: number; lowQualityPairsCount: number;
  levelsExpandedTo: 0 | 1 | 2; adaptiveStopReason: SearchStopReason;
}
interface TeEvidenceSummary { traitType: string; traitValue: string; status: ConfidenceStatus; score: number; outputDirKey: string; searchDiagnostics?: ValueSearchDiagnostics }
interface TeStatusResponse {
  ok: boolean; jobId: string; status: TeJobStatus;
  config: { selections: Array<{ traitType: string; values?: string[] }>; preset: ExtractionPreset };
  progress: TeProgress;
  evidenceSummary: TeEvidenceSummary[];
  unresolvedValues: Array<{ traitType: string; traitValue: string; reason: string }>;
  error?: { code: string; message: string };
  collectionDisplayName: string;
  downloadAvailable: boolean;
}
interface ScanTraitCategory { traitType: string; values: Array<{ value: string; count: number }> }

const CLASSIFICATION_META: Record<EligibilityClassification, { label: string; color: string }> = {
  suitable: { label: 'SUITABLE', color: '#43b984' },
  possibly_suitable: { label: 'POSSIBLY SUITABLE', color: '#c7b479' },
  unsuitable: { label: 'UNSUITABLE', color: '#d96867' },
};
const STATUS_META: Record<ConfidenceStatus, { label: string; color: string }> = {
  high_confidence: { label: 'HIGH', color: '#43b984' },
  medium_confidence: { label: 'MEDIUM', color: '#7ea8d9' },
  low_confidence: { label: 'LOW', color: '#c7b479' },
  unresolved: { label: 'UNRESOLVED', color: '#9a9ab4' },
  visually_identical: { label: 'IDENTICAL', color: '#a890e8' },
};

const MONO = "'SF Mono','Fira Code',monospace";
const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)', borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6)',
  padding: 12, marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#9a9ab4', marginBottom: 6 };
function Chip({ children, color = '#a890e8' }: { children: React.ReactNode; color?: string }) {
  return <span style={{ display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 600, borderRadius: 5, fontFamily: MONO, color, background: `${color}14`, border: `1px solid ${color}3a` }}>{children}</span>;
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TraitExtractionPanelProps {
  scanId: string;
  traitCategories: ScanTraitCategory[];
  exactAssetCount: number;
}

export default function TraitExtractionPanel({ scanId, traitCategories, exactAssetCount }: TraitExtractionPanelProps) {
  const [stage, setStage] = useState<'cards' | 'configure' | 'running'>('cards');
  const [eligibility, setEligibility] = useState<TraitCollectionEligibility | null>(null);
  const [eligibilityBusy, setEligibilityBusy] = useState(false);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);

  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedValues, setSelectedValues] = useState<Map<string, Set<string>>>(new Map());
  const [preset, setPreset] = useState<ExtractionPreset>('balanced');
  const [allowUnsuitable, setAllowUnsuitable] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<TeJobStatus | 'idle'>('idle');
  const [progress, setProgress] = useState<TeProgress | null>(null);
  const [evidenceSummary, setEvidenceSummary] = useState<TeEvidenceSummary[]>([]);
  const [unresolvedValues, setUnresolvedValues] = useState<Array<{ traitType: string; traitValue: string; reason: string }>>([]);
  const [collectionDisplayName, setCollectionDisplayName] = useState('');
  const [jobError, setJobError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Array<{ traitType: string; traitValue: string; confidence: { status: ConfidenceStatus; score: number }; previewUrl: string | null }>>([]);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [previewTotal, setPreviewTotal] = useState(0);
  const PREVIEW_PAGE_SIZE = 12;

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const applyStatus = (body: TeStatusResponse) => {
    setStatus(body.status);
    setProgress(body.progress);
    setEvidenceSummary(body.evidenceSummary);
    setUnresolvedValues(body.unresolvedValues);
    setCollectionDisplayName(body.collectionDisplayName);
    if (body.error) setJobError(body.error.message);
    if (['completed', 'failed', 'cancelled'].includes(body.status)) { esRef.current?.close(); esRef.current = null; stopPolling(); }
    if (body.status === 'completed') void loadPreviews(body.jobId, 0);
  };

  const loadPreviews = async (id: string, offset: number) => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${id}/previews?offset=${offset}&limit=${PREVIEW_PAGE_SIZE}`);
      if (!r.ok) return;
      const body = await r.json();
      if (!body.ok) return;
      setPreviews(body.values);
      setPreviewOffset(body.offset);
      setPreviewTotal(body.total);
    } catch { /* transient */ }
  };

  const startPolling = (id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${id}`);
        if (r.status === 404) { setStatus('expired'); stopPolling(); esRef.current?.close(); return; }
        if (!r.ok) return;
        const body = await r.json() as TeStatusResponse;
        if (body.ok) applyStatus(body);
      } catch { /* transient */ }
    }, 4000);
  };
  const attachStream = (id: string) => {
    esRef.current?.close();
    const es = new EventSource(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${id}/stream`);
    esRef.current = es;
    es.onmessage = () => {
      void fetch(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body: TeStatusResponse | null) => { if (body?.ok) applyStatus(body); })
        .catch(() => {});
    };
    es.onerror = () => { /* the REST poll below covers us */ };
  };

  useEffect(() => {
    let storedJobId: string | null = null;
    try { storedJobId = sessionStorage.getItem(SESSION_KEY_TE_JOB_ID); } catch { /* private mode */ }
    if (!storedJobId) return;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${storedJobId}`);
        if (r.status === 404) { try { sessionStorage.removeItem(SESSION_KEY_TE_JOB_ID); } catch { /* ignore */ } return; }
        if (!r.ok) return;
        const body = await r.json() as TeStatusResponse;
        if (!body.ok) return;
        setJobId(storedJobId);
        setStage('running');
        applyStatus(body);
        if (!['completed', 'failed', 'cancelled'].includes(body.status)) { attachStream(storedJobId!); startPolling(storedJobId!); }
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { esRef.current?.close(); stopPolling(); }, []);

  const fetchEligibility = async () => {
    setEligibilityBusy(true);
    setEligibilityError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/scans/${scanId}/trait-extractions/eligibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await r.json();
      if (!body.ok) { setEligibilityError('Could not compute eligibility.'); return; }
      setEligibility(body.eligibility);
      setStage('configure');
    } catch (e) {
      setEligibilityError((e as Error).message);
    } finally {
      setEligibilityBusy(false);
    }
  };

  const toggleCategory = (traitType: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(traitType)) next.delete(traitType); else next.add(traitType);
      return next;
    });
  };
  const toggleValue = (traitType: string, value: string) => {
    setSelectedValues((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(traitType) ?? []);
      if (set.has(value)) set.delete(value); else set.add(value);
      next.set(traitType, set);
      return next;
    });
  };

  const startExtraction = async () => {
    if (selectedCategories.size === 0) { setJobError('Select at least one trait category.'); return; }
    playUiConfirm();
    setJobError(null);
    setStage('running');
    setStatus('queued');
    setEvidenceSummary([]);
    setUnresolvedValues([]);
    setPreviews([]);
    const selections = [...selectedCategories].map((traitType) => {
      const vals = selectedValues.get(traitType);
      return { traitType, values: vals && vals.size > 0 ? [...vals] : undefined };
    });
    try {
      const r = await fetch(`${API_BASE}/api/tools/collection-analyzer/scans/${scanId}/trait-extractions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections, preset, allowUnsuitable }),
      });
      const body = await r.json();
      if (!body.ok || !body.jobId) {
        setStatus('failed');
        setJobError(body.error === 'ineligible' ? 'This collection is classified unsuitable — enable the advanced override to proceed anyway.' : `Could not start extraction (${body.error ?? r.status}).`);
        return;
      }
      setJobId(body.jobId);
      try { sessionStorage.setItem(SESSION_KEY_TE_JOB_ID, body.jobId); } catch { /* private mode */ }
      attachStream(body.jobId);
      startPolling(body.jobId);
    } catch (e) {
      setStatus('failed');
      setJobError((e as Error).message);
    }
  };

  const cancelExtraction = async () => {
    if (!jobId) return;
    try { await fetch(`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${jobId}/cancel`, { method: 'POST' }); } catch { /* poll reflects eventual state */ }
  };
  const resetPanel = () => {
    esRef.current?.close(); esRef.current = null; stopPolling();
    setStage('cards'); setJobId(null); setStatus('idle'); setProgress(null);
    setEvidenceSummary([]); setUnresolvedValues([]); setPreviews([]); setJobError(null);
    try { sessionStorage.removeItem(SESSION_KEY_TE_JOB_ID); } catch { /* private mode */ }
  };

  // ── Render ──────────────────────────────────────────────────────────
  if (stage === 'cards') {
    return (
      <div style={PANEL}>
        <div style={SECTION_LABEL}>Download collection</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          <div style={{ border: '1px solid rgba(126,217,168,0.4)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f0eef8' }}>Download Trait Collection</div>
            <Chip color="#43b984">AVAILABLE</Chip>
            <div style={{ fontSize: 11.5, color: '#9a9ab4', marginTop: 8, lineHeight: 1.5 }}>
              For collections built from repeated traits such as Body, Hair, Eyes, Clothes, and Background.
              Reconstruct reusable visual trait assets from a generative NFT collection.
            </div>
            <div style={{ fontSize: 10, color: '#c7b479', marginTop: 8 }}>
              Trait images are inferred from final rendered NFTs. They may not exactly match the project&apos;s original source layers.
            </div>
            <button type="button" onClick={fetchEligibility} disabled={eligibilityBusy} data-uisnd="skip" style={{ marginTop: 10, padding: '7px 16px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', borderRadius: 5, cursor: eligibilityBusy ? 'not-allowed' : 'pointer', border: '1px solid rgba(126,217,168,0.55)', background: 'rgba(126,217,168,0.14)', color: '#43b984' }}>
              {eligibilityBusy ? 'Checking…' : 'Configure Trait Extraction'}
            </button>
            {eligibilityError && <div style={{ fontSize: 10.5, color: '#d96867', marginTop: 6 }}>{eligibilityError}</div>}
          </div>
          <div style={{ border: '1px solid rgba(168,144,232,0.22)', borderRadius: 8, padding: 14, opacity: 0.6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f0eef8' }}>Download 1/1 Collection</div>
            <Chip color="#9a9ab4">COMING LATER</Chip>
            <div style={{ fontSize: 11.5, color: '#9a9ab4', marginTop: 8, lineHeight: 1.5 }}>
              For collections made of unique standalone artworks without a reusable trait system.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (stage === 'configure' && eligibility) {
    const meta = CLASSIFICATION_META[eligibility.classification];
    const blocked = eligibility.classification === 'unsuitable' && !allowUnsuitable;
    const estimatedValues = [...selectedCategories].reduce((sum, cat) => {
      const vals = selectedValues.get(cat);
      const cat2 = traitCategories.find((c) => c.traitType === cat);
      return sum + (vals && vals.size > 0 ? vals.size : (cat2?.values.length ?? 0));
    }, 0);
    return (
      <div style={PANEL}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={SECTION_LABEL}>Configure trait extraction</div>
          <button type="button" onClick={() => setStage('cards')} data-uisnd="skip" style={{ padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.35)', background: 'transparent', color: '#c4b8e8' }}>← Back</button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <span style={{ padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 800, color: meta.color, background: `${meta.color}18`, border: `1.5px solid ${meta.color}55` }}>{meta.label}</span>
          <span style={{ fontSize: 11, color: '#9a9ab4', marginLeft: 8 }}>
            {eligibility.percentWithAttributes}% have attributes · {eligibility.totalTraitCategories} categories · {eligibility.categoriesWithRepeatedValues} with repeated values · median {eligibility.medianAssetsPerTraitValue}/value
          </span>
          {eligibility.classification !== 'suitable' && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11, color: '#c7b479', lineHeight: 1.5 }}>
              {eligibility.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          {eligibility.classification === 'unsuitable' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#d96867', marginTop: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={allowUnsuitable} onChange={() => setAllowUnsuitable((v) => !v)} />
              Advanced: attempt extraction anyway (metadata may be imperfect)
            </label>
          )}
        </div>

        <div style={SECTION_LABEL}>Trait categories</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 10 }} className="scroll-area">
          {traitCategories.map((cat) => (
            <div key={cat.traitType} style={{ border: '1px solid rgba(168,144,232,0.2)', borderRadius: 6, padding: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#f0eef8', cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedCategories.has(cat.traitType)} onChange={() => toggleCategory(cat.traitType)} />
                {cat.traitType} <span style={{ color: '#9a9ab4', fontWeight: 400 }}>({cat.values.length} values)</span>
              </label>
              {selectedCategories.has(cat.traitType) && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, paddingLeft: 20 }}>
                  {cat.values.map((v) => {
                    const active = selectedValues.get(cat.traitType)?.has(v.value) ?? false;
                    return (
                      <button key={v.value} type="button" onClick={() => toggleValue(cat.traitType, v.value)} data-uisnd="skip"
                        style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', fontFamily: MONO, border: `1px solid ${active ? 'rgba(126,217,168,0.55)' : 'rgba(168,144,232,0.3)'}`, background: active ? 'rgba(126,217,168,0.14)' : 'transparent', color: active ? '#43b984' : '#9a9ab4' }}>
                        {v.value} ×{v.count}
                      </button>
                    );
                  })}
                  <span style={{ fontSize: 9.5, color: '#6e6688', alignSelf: 'center' }}>{(selectedValues.get(cat.traitType)?.size ?? 0) === 0 ? '(none selected = all values)' : ''}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={SECTION_LABEL}>Extraction preset</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {(['fast', 'balanced', 'thorough'] as ExtractionPreset[]).map((p) => (
            <button key={p} type="button" onClick={() => setPreset(p)} data-uisnd="skip"
              style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer', border: `1px solid ${preset === p ? 'rgba(126,217,168,0.55)' : 'rgba(168,144,232,0.3)'}`, background: preset === p ? 'rgba(126,217,168,0.14)' : 'transparent', color: preset === p ? '#43b984' : '#9a9ab4' }}>
              {p}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10.5, color: '#9a9ab4', marginBottom: 10 }}>
          Estimated workload: ~{estimatedValues} trait value(s) across {selectedCategories.size} categor{selectedCategories.size === 1 ? 'y' : 'ies'} out of {exactAssetCount} scanned assets.
        </div>

        {jobError && <div style={{ fontSize: 11, color: '#d96867', marginBottom: 8 }}>{jobError}</div>}
        <button type="button" onClick={startExtraction} disabled={blocked || selectedCategories.size === 0} data-uisnd="skip"
          style={{ padding: '8px 20px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5, cursor: (blocked || selectedCategories.size === 0) ? 'not-allowed' : 'pointer', border: '1px solid rgba(126,217,168,0.55)', background: (blocked || selectedCategories.size === 0) ? 'rgba(126,217,168,0.08)' : 'rgba(126,217,168,0.18)', color: (blocked || selectedCategories.size === 0) ? '#6e6688' : '#43b984' }}>
          Start Extraction
        </button>
      </div>
    );
  }

  // stage === 'running'
  const isActive = ['queued', 'downloading', 'processing', 'archiving'].includes(status);
  const isDone = status === 'completed';
  const isFailedOrCancelled = status === 'failed' || status === 'cancelled' || status === 'expired';

  return (
    <div style={PANEL}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={SECTION_LABEL}>Download Trait Collection {collectionDisplayName ? `· ${collectionDisplayName}` : ''}</div>
        {isActive && <button type="button" onClick={cancelExtraction} data-uisnd="skip" style={{ padding: '4px 12px', fontSize: 10.5, fontWeight: 700, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(217,104,103,0.5)', background: 'rgba(217,104,103,0.10)', color: '#d96867' }}>Cancel</button>}
        {(isDone || isFailedOrCancelled) && <button type="button" onClick={resetPanel} data-uisnd="skip" style={{ padding: '4px 12px', fontSize: 10.5, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.45)', background: 'rgba(168,144,232,0.10)', color: '#c4b8e8' }}>Start over</button>}
      </div>
      <div style={{ fontSize: 10, color: '#c7b479', marginBottom: 10 }}>
        Attempts to reconstruct reusable visual traits from final rendered NFTs. Results are inferred and may not match the original source layers.
      </div>

      {isActive && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', textTransform: 'uppercase', marginBottom: 6 }}>{progress?.phase ?? status}…</div>
          {progress?.currentCategory && <div style={{ fontSize: 11, color: '#9a9ab4', marginBottom: 6 }}>Current: {progress.currentCategory} = {progress.currentTraitValue}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, fontFamily: MONO }}>
            <div><span style={{ color: '#9a9ab4' }}>values </span><span style={{ color: '#f0eef8' }}>{progress?.processedValues ?? 0}/{progress?.totalValues ?? 0}</span></div>
            <div><span style={{ color: '#9a9ab4' }}>images </span><span style={{ color: '#f0eef8' }}>{progress?.uniqueImagesDownloaded ?? 0}</span></div>
            <div><span style={{ color: '#9a9ab4' }}>comparisons </span><span style={{ color: '#f0eef8' }}>{progress?.comparisonsEvaluated ?? 0}</span></div>
            <div><span style={{ color: '#9a9ab4' }}>downloaded </span><span style={{ color: '#f0eef8' }}>{formatBytes(progress?.bytesDownloaded ?? 0)}</span></div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <Chip color="#43b984">{progress?.resolvedHigh ?? 0} high</Chip>
            <Chip color="#7ea8d9">{progress?.resolvedMedium ?? 0} medium</Chip>
            <Chip color="#c7b479">{progress?.resolvedLow ?? 0} low</Chip>
            <Chip color="#9a9ab4">{progress?.resolvedUnresolved ?? 0} unresolved</Chip>
            <Chip color="#a890e8">{progress?.resolvedVisuallyIdentical ?? 0} identical</Chip>
          </div>
          <div style={{ fontSize: 9.5, color: '#6e6688', marginTop: 8 }}>You can navigate away — extraction continues server-side and resumes here when you come back.</div>
        </div>
      )}

      {isFailedOrCancelled && (
        <div style={{ fontSize: 12, color: '#d96867' }}>{jobError ?? (status === 'expired' ? 'This extraction result has expired — start a new one.' : `Extraction ${status}.`)}</div>
      )}

      {isDone && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, fontFamily: MONO, marginBottom: 10 }}>
            <div><span style={{ color: '#9a9ab4' }}>extracted </span><span style={{ color: '#f0eef8' }}>{evidenceSummary.length}</span></div>
            <div><span style={{ color: '#9a9ab4' }}>unresolved </span><span style={{ color: '#f0eef8' }}>{unresolvedValues.length}</span></div>
          </div>
          {unresolvedValues.length > 0 && (
            <div style={{ fontSize: 10.5, color: '#c7b479', marginBottom: 10 }}>{unresolvedValues.length} value(s) could not be extracted — see unresolved-traits.json in the archive.</div>
          )}

          {/* Paginated preview grid - never all values at once */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
            {previews.map((p) => {
              const sMeta = STATUS_META[p.confidence.status];
              return (
                <div key={`${p.traitType}-${p.traitValue}`} style={{ border: '1px solid rgba(168,144,232,0.22)', borderRadius: 6, padding: 6, textAlign: 'center' }}>
                  <div style={{ width: '100%', aspectRatio: '1/1', borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.04)', marginBottom: 4 }}>
                    {p.previewUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`${API_BASE}${p.previewUrl}`} alt={p.traitValue} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <div style={{ fontSize: 9, color: '#6e6688', paddingTop: 40 }}>no preview</div>}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.traitValue}</div>
                  <div style={{ fontSize: 9, color: sMeta.color }}>{sMeta.label} · {p.confidence.score}</div>
                </div>
              );
            })}
          </div>
          {previewTotal > PREVIEW_PAGE_SIZE && jobId && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, fontFamily: MONO, color: '#9a9ab4', marginBottom: 10 }}>
              <button type="button" disabled={previewOffset === 0} onClick={() => loadPreviews(jobId, Math.max(0, previewOffset - PREVIEW_PAGE_SIZE))} style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.35)', background: 'transparent', color: '#c4b8e8' }}>‹ Prev</button>
              <span>{previewOffset + 1}–{Math.min(previewOffset + PREVIEW_PAGE_SIZE, previewTotal)} of {previewTotal}</span>
              <button type="button" disabled={previewOffset + PREVIEW_PAGE_SIZE >= previewTotal} onClick={() => loadPreviews(jobId, previewOffset + PREVIEW_PAGE_SIZE)} style={{ padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(168,144,232,0.35)', background: 'transparent', color: '#c4b8e8' }}>Next ›</button>
            </div>
          )}

          {/* Contact sheets per selected category */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            {[...new Set(evidenceSummary.map((e) => e.traitType))].sort().map((cat) => (
              <div key={cat}>
                <div style={{ fontSize: 10.5, color: '#9a9ab4', marginBottom: 4 }}>{cat} contact sheet</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${jobId}/contact-sheets/${encodeURIComponent(cat)}`} alt={`${cat} contact sheet`} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid rgba(168,144,232,0.22)' }} />
              </div>
            ))}
          </div>

          {evidenceSummary.some((e) => e.searchDiagnostics) && (
            <details style={{ marginBottom: 10, fontSize: 10.5, color: '#9a9ab4' }}>
              <summary style={{ cursor: 'pointer', color: '#c4b8e8', fontSize: 11 }}>Search diagnostics (Stage 5.1)</summary>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(() => {
                  const diags = evidenceSummary.map((e) => e.searchDiagnostics).filter((d): d is ValueSearchDiagnostics => !!d);
                  const assetsSearchable = diags[0]?.assetsSearchable ?? 0;
                  const sum = (f: (d: ValueSearchDiagnostics) => number) => diags.reduce((s, d) => s + f(d), 0);
                  const stopReasonCounts: Record<string, number> = {};
                  for (const d of diags) stopReasonCounts[d.adaptiveStopReason] = (stopReasonCounts[d.adaptiveStopReason] ?? 0) + 1;
                  return (
                    <>
                      <div>assets searchable (full collection): <span style={{ color: '#f0eef8' }}>{assetsSearchable}</span></div>
                      <div>exact (Level 0) pairs found: <span style={{ color: '#f0eef8' }}>{sum((d) => d.level0CandidatesFound)}</span></div>
                      <div>near (Level 1/2) pairs found: <span style={{ color: '#f0eef8' }}>{sum((d) => d.level1CandidatesFound + d.level2CandidatesFound)}</span></div>
                      <div>candidates rejected (high-impact mismatch): <span style={{ color: '#f0eef8' }}>{sum((d) => d.candidatesRejectedHighImpact)}</span></div>
                      <div>low-quality pairs used: <span style={{ color: '#f0eef8' }}>{sum((d) => d.lowQualityPairsCount)}</span></div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                        {Object.entries(stopReasonCounts).map(([reason, count]) => (
                          <Chip key={reason} color="#7ea8d9">{count}× {reason.replace(/_/g, ' ')}</Chip>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </div>
            </details>
          )}

          <a href={`${API_BASE}/api/tools/collection-analyzer/trait-extractions/${jobId}/download`}
            style={{ display: 'inline-block', padding: '8px 20px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5, textDecoration: 'none', border: '1px solid rgba(126,217,168,0.55)', background: 'rgba(126,217,168,0.14)', color: '#43b984' }}>
            Download ZIP
          </a>
        </div>
      )}
    </div>
  );
}
