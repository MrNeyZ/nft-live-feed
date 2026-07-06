'use client';

// VictoryLabs — Tools › Pixel Forge (trait-library builder, not a
// collection generator). Claude draws/revises individual reusable pixel-art
// trait layers by calling tools against a shared grid (backend:
// src/pixel-agent/), rendering + inspecting its own progress each turn
// rather than generating an image directly. Claude only ever expands this
// library — a future, AI-free compositor will combine approved traits into
// a full collection by z-order, with zero further API calls. Personal use
// only: requireAuth-gated backend, burns real Anthropic credits per run —
// cost control (model presets, hard turn caps, Stop) is load-bearing here.
//
// Data: POST /api/tools/pixel-forge/jobs, POST .../jobs/:id/stop,
//       GET .../jobs/:id (poll), POST .../traits/:id/revise,
//       GET/PATCH/DELETE .../traits[/:id]

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const POLL_MS = 1500;
const CANVAS_SIZES = [16, 24, 32, 48];

// ── Reference Mode MVP — client-side mirrors of the backend's caps
// (src/pixel-agent/reference-analysis.ts) so a bad upload is rejected
// instantly instead of round-tripping to the server first. The backend
// re-validates independently regardless — these are a UX nicety only.
const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
const REFERENCE_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

/** Reads a File as base64 (no `data:` URL prefix) for inline JSON upload —
 *  matches the rest of this app's "base64 inline, no multipart" convention
 *  (see src/pixel-agent/store.ts's own header comment). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read reference image file'));
    reader.readAsDataURL(file);
  });
}

/** Short display label for a reference file's declared mime type — UI
 *  polish only, purely cosmetic. */
function referenceMimeTypeLabel(mimeType: string): string {
  if (mimeType === 'image/png') return 'PNG';
  if (mimeType === 'image/jpeg') return 'JPEG';
  return mimeType;
}
const LAYER_TYPES = ['background', 'body', 'eyes', 'mouth', 'accessory', 'icon', 'other'] as const;
type LayerType = typeof LAYER_TYPES[number];

type Quality = 'fast' | 'normal' | 'premium';
const QUALITY_OPTIONS: Array<{ value: Quality; label: string }> = [
  { value: 'fast', label: 'Fast / Cheap (Haiku)' },
  { value: 'normal', label: 'Normal (Sonnet) — default' },
  { value: 'premium', label: 'Premium (Opus) — manual override' },
];
// Mirrors src/pixel-agent/agent-loop.ts PRESET_DEFAULT_MAX_TURNS — a UI
// convenience default, not authoritative (the backend re-validates/clamps).
const PRESET_MAX_TURNS: Record<Quality, number> = { fast: 4, normal: 8, premium: 12 };
const MAX_TURNS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 4, label: 'Quick (4 turns)' },
  { value: 8, label: 'Normal (8 turns)' },
  { value: 12, label: 'High Quality (12 turns)' },
];

// ── Generation-form persistence (localStorage, no backend involvement) ────
const FORM_STORAGE_KEY = 'pixel-forge.form.v1';
const FORM_SAVE_DEBOUNCE_MS = 200;

interface PersistedForm {
  prompt: string;
  canvasSize: number;
  layerType: LayerType | '';
  quality: Quality;
  maxTurns: number;
  anchor: string;
  paletteText: string;
  name: string;
  zIndexText: string;
  tagsText: string;
  notes: string;
}
const DEFAULT_FORM: PersistedForm = {
  prompt: '', canvasSize: 32, layerType: '', quality: 'normal', maxTurns: PRESET_MAX_TURNS.normal,
  anchor: '', paletteText: '', name: '', zIndexText: '', tagsText: '', notes: '',
};

function isValidCanvasSize(v: unknown): v is number {
  return typeof v === 'number' && (CANVAS_SIZES as readonly number[]).includes(v);
}
function isValidLayerType(v: unknown): v is LayerType | '' {
  return v === '' || (typeof v === 'string' && (LAYER_TYPES as readonly string[]).includes(v));
}
function isValidQuality(v: unknown): v is Quality {
  return typeof v === 'string' && QUALITY_OPTIONS.some(o => o.value === v);
}
function isValidMaxTurns(v: unknown): v is number {
  return typeof v === 'number' && MAX_TURNS_OPTIONS.some(o => o.value === v);
}

/** Reads + validates the persisted form from localStorage. Any field that's
 *  missing, malformed, or out of range is simply omitted — the caller keeps
 *  whatever default it already has, per "ignore invalid stored values and
 *  fall back to defaults." Never throws (corrupt JSON, disabled storage, a
 *  future incompatible shape all just yield an empty result). */
function loadPersistedForm(): Partial<PersistedForm> {
  if (typeof window === 'undefined') return {};
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('stored form is not an object');
    }
    const p = parsed as Record<string, unknown>;
    const out: Partial<PersistedForm> = {};
    if (typeof p.prompt === 'string') out.prompt = p.prompt;
    if (isValidCanvasSize(p.canvasSize)) out.canvasSize = p.canvasSize;
    if (isValidLayerType(p.layerType)) out.layerType = p.layerType;
    if (isValidQuality(p.quality)) out.quality = p.quality;
    if (isValidMaxTurns(p.maxTurns)) out.maxTurns = p.maxTurns;
    if (typeof p.anchor === 'string') out.anchor = p.anchor;
    if (typeof p.paletteText === 'string') out.paletteText = p.paletteText;
    if (typeof p.name === 'string') out.name = p.name;
    if (typeof p.zIndexText === 'string') out.zIndexText = p.zIndexText;
    if (typeof p.tagsText === 'string') out.tagsText = p.tagsText;
    if (typeof p.notes === 'string') out.notes = p.notes;
    return out;
  } catch (e) {
    console.warn('[pixel-forge] discarding corrupt localStorage form, resetting to defaults', e);
    try { window.localStorage.removeItem(FORM_STORAGE_KEY); } catch {
      // localStorage unavailable entirely — nothing more we can do, defaults still apply
    }
    return {};
  }
}

// ── Evaluation v2 / RepairPlan (Revision V3) ───────────────────────────────
// See docs/pixel-forge-revision-v3.md. Older stored traits still have the
// v1 shape below (no schemaVersion/issues) — isV2Evaluation discriminates
// so the gallery can render either without crashing on missing fields.
interface RepairItem {
  id: string;
  category: string;
  severity: 'critical' | 'major' | 'minor';
  location: string;
  problem: string;
  reason: string;
  repairStrategy: string;
  expectedResult: string;
  dependsOn: string[];
}
interface StoredRepairItem extends RepairItem {
  attempts: number;
  firstSeenRevision: number;
  regressed: boolean;
}
interface PreserveItem { id: string; description: string; reason: string; }
interface RepairTier { tier: number; label: string; issueIds: string[]; }
type OverallSeverity = 'none' | 'minor' | 'major' | 'critical';
interface RepairPlan {
  schemaVersion: number;
  sourceRevision: number;
  subject: string;
  currentDescription: string;
  issues: StoredRepairItem[];
  preserve: PreserveItem[];
  doNotModify: string[];
  intentionalChoices: string[];
  deferred: StoredRepairItem[];
  sequence: RepairTier[];
  successCriteria: string[];
  overallSeverity: OverallSeverity;
  createdAt: number;
}

interface Evaluation {
  schemaVersion: number;
  blindDescription: string;
  recognizableAsSubject: boolean;
  issues: RepairItem[];
  preserve: PreserveItem[];
  doNotModify: string[];
  intentionalChoices: string[];
  notes: string;
}
/** Pre-Revision-V3 stored shape — kept only so old records still render. */
interface LegacyEvaluation {
  cleanSilhouette: boolean;
  readableAtNativeSize: boolean;
  noStrayPixels: boolean;
  transparentBgPreserved: boolean;
  matchesLayerType: boolean;
  missingFeatures: string[];
  notes: string;
}
type AnyEvaluation = Evaluation | LegacyEvaluation;

// ── Defensive accessors (crash fix) ─────────────────────────────────────
// Stored trait JSON predates fields the current schema expects — one real
// record (`b428ab3d…`) has NO `missingFeatures` key at all despite being
// the pre-V3 shape, which crashed `.length`/`.join` calls that assumed it
// was always an array. Every helper below returns a safe fallback instead
// of throwing, and every render path uses these instead of touching a
// possibly-missing nested field directly. See docs/pixel-forge-revision-v3.md.
function isV2Evaluation(e: AnyEvaluation | null | undefined): e is Evaluation {
  return !!e && Array.isArray((e as Evaluation).issues);
}

function safeIssues(repairPlan: RepairPlan | null | undefined): StoredRepairItem[] {
  return repairPlan && Array.isArray(repairPlan.issues) ? repairPlan.issues.filter(Boolean) : [];
}

/** Legacy-shape missingFeatures, defensively — [] for a v2 evaluation, a
 *  missing/malformed field, or a wholly missing evaluation. */
function legacyMissingFeaturesOf(e: AnyEvaluation | null | undefined): string[] {
  if (!e || isV2Evaluation(e)) return [];
  const mf = (e as LegacyEvaluation).missingFeatures;
  return Array.isArray(mf) ? mf : [];
}

const SEVERITY_META: Record<'critical' | 'major' | 'minor', { label: string; color: string }> = {
  critical: { label: 'critical', color: '#d96867' },
  major: { label: 'major', color: '#c7b479' },
  minor: { label: 'minor', color: '#9a9ab4' },
};
/** Never throws, never indexes a map with an unchecked key — unknown/
 *  missing severity values fall back to a neutral grey "unknown" label. */
function getSeverityMeta(value: unknown): { label: string; color: string } {
  if (value === 'critical' || value === 'major' || value === 'minor') return SEVERITY_META[value];
  return { label: 'unknown', color: '#9a9ab4' };
}

const CATEGORY_LABELS: Record<string, string> = {
  silhouette: 'Silhouette', recognizability: 'Recognizability', face: 'Face', eye: 'Eye',
  palette: 'Palette', hue_shift: 'Hue shift', outline: 'Outline', material: 'Material',
  lighting: 'Lighting', cluster: 'Cluster', composition: 'Composition', background: 'Background',
  trait_specific: 'Trait-specific', technical_hygiene: 'Technical hygiene', other: 'Other',
};
/** Falls back to the raw string (or "other") rather than throwing/blanking
 *  on a category value outside the known enum — old/malformed data should
 *  still show *something* readable. */
function getCategoryLabel(value: unknown): string {
  if (typeof value === 'string' && CATEGORY_LABELS[value]) return CATEGORY_LABELS[value];
  return typeof value === 'string' && value.trim() ? value : 'other';
}
const LEGACY_EVAL_CHECKS: Array<{ key: keyof Omit<LegacyEvaluation, 'notes' | 'missingFeatures'>; label: string }> = [
  { key: 'cleanSilhouette', label: 'Clean silhouette' },
  { key: 'readableAtNativeSize', label: 'Readable at native size' },
  { key: 'noStrayPixels', label: 'No stray pixels' },
  { key: 'transparentBgPreserved', label: 'Transparent bg preserved' },
  { key: 'matchesLayerType', label: 'Matches layer type' },
];

interface TokenUsage { inputTokens: number; outputTokens: number; }
interface JobIteration { turn: number; phase: 'draft' | 'seed' | 'refine' | 'evaluate'; note: string; pngBase64: string; }
interface JobResult {
  variantId: string; pngBase64: string; evaluation: AnyEvaluation; repairPlan: RepairPlan | null;
  tokenUsage: TokenUsage; estimatedCostUsd: number | null;
  referenceGuidanceNote: string | null;
}
interface JobPollResponse {
  ok: boolean;
  status?: 'running' | 'done' | 'error';
  iterations?: JobIteration[];
  result?: JobResult;
  error?: string;
  errorCode?: string;
}

// Maps the backend's safe error codes (src/pixel-agent/agent-loop.ts
// classifyAnthropicError) to short, actionable copy. Falls back to the
// backend's own safeMessage (JobPollResponse.error) for unmapped codes.
const ERROR_CODE_MESSAGES: Record<string, string> = {
  pixel_forge_start_rate_limited: 'Pixel Forge start limit hit — wait 1 minute.',
  pixel_forge_poll_rate_limited: 'Pixel Forge polling limit hit — wait 1 minute.',
  anthropic_rate_limited: 'Anthropic rate limit — wait and retry later.',
  anthropic_insufficient_quota: 'Insufficient quota/billing — check Anthropic Console credits.',
  anthropic_overloaded: 'Anthropic is temporarily overloaded — retry shortly.',
  anthropic_auth_error: 'Anthropic API key rejected — check ANTHROPIC_API_KEY on the backend.',
  opus_disabled: 'Opus disabled — use Sonnet or enable PIXEL_FORGE_ALLOW_OPUS on the backend.',
  invalid_reference_image: 'Reference image field is malformed.',
  reference_rights_not_confirmed: 'Confirm you have the right to use this reference image.',
  invalid_reference_mime_type: 'Reference image must be PNG or JPEG.',
  invalid_reference_encoding: 'Reference image data is corrupt — try re-uploading.',
  reference_image_too_large: 'Reference image is too large (max 2 MB).',
  reference_image_unreadable: 'Could not read that file as an image.',
  reference_image_dimensions_too_large: 'Reference image dimensions too large (max 1024×1024).',
};
type TraitStatus = 'candidate' | 'approved' | 'rejected';
const STATUS_META: Record<TraitStatus, { label: string; color: string }> = {
  candidate: { label: 'CANDIDATE', color: '#c7b479' },
  approved: { label: 'APPROVED', color: '#43b984' },
  rejected: { label: 'REJECTED', color: '#d96867' },
};

interface TraitAssetSummary {
  id: string; name: string; slug: string; zIndex: number; layerType: LayerType; size: number; prompt: string;
  modelPreset: Quality; actualModel: string; status: TraitStatus; tags: string[]; notes: string | null;
  evaluation: AnyEvaluation; repairPlan: RepairPlan | null; revision: number; createdAt: number; updatedAt: number;
  pngBase64: string;
  /** Text-only provenance from an optional reference image used at
   *  generation time — see docs/pixel-forge-reference-mode-mvp.md. Never
   *  the image itself; null when no reference was used. */
  referenceGuidanceNote: string | null;
}

/** Full trait record, only fetched on demand for JSON download. */
interface TraitAssetFull extends TraitAssetSummary {
  palette: string[];
  pixels: number[];
  anchor: string | null;
  maxTurns: number;
  generationMode: 'fresh' | 'revision';
  lastRevisionPrompt: string | null;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  createdAt: number;
}

// ── Validation-run previews (read-only) ────────────────────────────────
// Already-generated smoke/benchmark-run PNGs under
// data/pixel-forge/validation-runs/*/previews/ — served by a separate,
// read-only backend endpoint (src/pixel-agent/validation-previews.ts) that
// never touches the real trait store. Rendered in their own section below,
// never merged into `traits`/`visibleTraits` — no Approve/Reject/Revise/
// Delete affordance exists for these, on purpose.
interface ValidationPreviewItem {
  seq: number;
  runId: string;
  promptId: string;
  promptText: string | null;
  roundNumber: number | null;
  jobType: 'fresh' | 'revision' | null;
  model: string | null;
  costUsd: number | null;
  recognizableAsSubject: boolean | null;
  overallSeverity: string | null;
  openIssueCount: number | null;
  pngBase64: string;
}

function downloadBlob(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
const FIELD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, fontFamily: MONO, borderRadius: 5,
  border: '1px solid rgba(168,144,232,0.40)',
  background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
};
// Nearest-neighbor scaling so small grids stay crisp at any display size —
// no blur / no antialiasing, unlike the browser's default bilinear scaling.
const PIXELATED: React.CSSProperties = {
  imageRendering: 'pixelated',
  // Safari/older WebKit fallback; harmless no-op elsewhere.
  ...( { WebkitImageRendering: 'pixelated' } as React.CSSProperties ),
};

function PixelImg({ src, size, alt }: { src: string; size: number; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{ ...PIXELATED, width: size, height: size, borderRadius: 6, border: '1px solid rgba(168,144,232,0.30)', background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 16px 16px' }}
    />
  );
}

// ── Legacy (pre-Revision-V3) evaluation display — unchanged rendering for
// records that predate the repair-plan schema, so old traits still show
// something sensible rather than crashing on missing fields. ─────────────
function legacyMissingFeaturesRevisionText(missingFeatures: string[]): string {
  return `Add these missing/weak features: ${missingFeatures.join('; ')}`;
}

function LegacyMissingFeaturesList({ missingFeatures }: { missingFeatures: string[] }) {
  if (missingFeatures.length === 0) return null;
  const copy = () => { navigator.clipboard?.writeText(legacyMissingFeaturesRevisionText(missingFeatures)).catch(() => {}); };
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: '#c7b479' }}>
          Missing features
        </span>
        <button
          type="button"
          onClick={copy}
          data-uisnd="skip"
          style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
            border: '1px solid rgba(199,180,121,0.40)', background: 'rgba(199,180,121,0.08)', color: '#c7b479',
          }}
        >Copy for revision</button>
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10.5, color: '#c7b479', lineHeight: 1.5 }}>
        {missingFeatures.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
    </div>
  );
}

function LegacyEvalBadges({ evaluation }: { evaluation: LegacyEvaluation | null | undefined }) {
  if (!evaluation) return <div style={{ fontSize: 11, color: '#9a9ab4' }}>No evaluation data.</div>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {LEGACY_EVAL_CHECKS.map(({ key, label }) => {
          const ok = Boolean(evaluation[key]);
          const color = ok ? '#43b984' : '#d96867';
          return (
            <span key={key} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
              fontSize: 10.5, fontWeight: 600, borderRadius: 4, fontFamily: MONO,
              color, background: `${color}14`, border: `1px solid ${color}3a`,
            }}>{ok ? '✓' : '✗'} {label}</span>
          );
        })}
      </div>
      <LegacyMissingFeaturesList missingFeatures={legacyMissingFeaturesOf(evaluation)} />
      {evaluation.notes && (
        <div style={{ fontSize: 11, color: '#9a9ab4', marginTop: 6 }}>{evaluation.notes}</div>
      )}
    </div>
  );
}

function legacyEvalAllPass(evaluation: LegacyEvaluation | null | undefined): boolean {
  if (!evaluation) return false;
  return LEGACY_EVAL_CHECKS.every(({ key }) => Boolean(evaluation[key]));
}

// ── Revision V3 — RepairPlan display ────────────────────────────────────
// See docs/pixel-forge-revision-v3.md. `repairPlan` is null for a trait
// that has never been graded by the v2 evaluator (legacy record, or a run
// stopped before evaluation) — every component here accepts null/undefined
// at every level and falls back rather than throwing (see the crash-fix
// note on the helpers above this block).
function overallSeverityColor(sev: OverallSeverity | string | null | undefined): string {
  if (sev === 'none') return '#43b984';
  if (sev === 'critical' || sev === 'major' || sev === 'minor') return getSeverityMeta(sev).color;
  return '#9a9ab4';
}
function openIssueCount(t: { repairPlan?: RepairPlan | null }): number {
  return safeIssues(t.repairPlan).length;
}

function IssueRow({ issue }: { issue: (RepairItem & { attempts?: number; regressed?: boolean }) | null | undefined }) {
  if (!issue) return null;
  const meta = getSeverityMeta(issue.severity);
  return (
    <div style={{ marginBottom: 6, paddingLeft: 8, borderLeft: `2px solid ${meta.color}` }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: meta.color, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        [{getCategoryLabel(issue.category)}] {issue.location || 'unspecified location'}
        {issue.regressed && <span style={{ color: '#d96867' }}> ⚠ REGRESSION</span>}
        {!!issue.attempts && issue.attempts > 0 && <span style={{ color: '#9a9ab4', fontWeight: 400, textTransform: 'none' }}> — attempt #{issue.attempts + 1}</span>}
      </div>
      <div style={{ fontSize: 10.5, color: '#c8c8dc', marginTop: 1 }}>{issue.problem || '—'}</div>
      <div style={{ fontSize: 9.5, color: '#9a9ab4', marginTop: 1 }}>Fix: {issue.repairStrategy || '—'}</div>
    </div>
  );
}

// Display-only restatement of the model's own self-assessment — never
// trusted blindly, it's the model grading its own work. Dual-renders: v2
// evaluations (with or without a persisted RepairPlan) get the structured
// view; anything else (including a wholly missing evaluation) falls back
// to the legacy badge view rather than throwing.
function RepairPlanSummary({ evaluation, repairPlan }: { evaluation: AnyEvaluation | null | undefined; repairPlan: RepairPlan | null | undefined }) {
  if (!isV2Evaluation(evaluation)) return <LegacyEvalBadges evaluation={evaluation} />;
  const issues: Array<RepairItem & { attempts?: number; regressed?: boolean }> =
    repairPlan ? safeIssues(repairPlan) : (Array.isArray(evaluation.issues) ? evaluation.issues.filter(Boolean) : []);
  const overallSeverity: OverallSeverity = repairPlan?.overallSeverity
    ?? (issues.length === 0 ? 'none' : issues.some(i => i.severity === 'critical') ? 'critical' : issues.some(i => i.severity === 'major') ? 'major' : 'minor');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
          fontSize: 10.5, fontWeight: 700, borderRadius: 4, fontFamily: MONO,
          color: overallSeverityColor(overallSeverity), background: `${overallSeverityColor(overallSeverity)}14`,
          border: `1px solid ${overallSeverityColor(overallSeverity)}3a`,
        }}>
          {overallSeverity === 'none' ? '✓ no open issues' : `${issues.length} open issue${issues.length === 1 ? '' : 's'} (${overallSeverity})`}
        </span>
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: evaluation.recognizableAsSubject ? '#43b984' : '#d96867',
        }}>
          {evaluation.recognizableAsSubject ? '✓ recognizable as the specific subject' : '✗ not recognizable as the specific subject'}
        </span>
      </div>
      {evaluation.blindDescription && (
        <div style={{ fontSize: 10.5, color: '#9a9ab4', marginTop: 5, fontStyle: 'italic' }}>&ldquo;{evaluation.blindDescription}&rdquo;</div>
      )}
      {issues.length > 0 && (
        <div style={{ marginTop: 7 }}>
          {issues.map(i => <IssueRow key={i.id} issue={i} />)}
        </div>
      )}
      {Array.isArray(repairPlan?.deferred) && repairPlan!.deferred.length > 0 && (
        <div style={{ fontSize: 9.5, color: '#9a9ab4', marginTop: 2 }}>
          +{repairPlan!.deferred.length} lower-priority issue{repairPlan!.deferred.length === 1 ? '' : 's'} deferred to a later revision
        </div>
      )}
      {evaluation.notes && (
        <div style={{ fontSize: 11, color: '#9a9ab4', marginTop: 6 }}>{evaluation.notes}</div>
      )}
    </div>
  );
}

function usageLine(usage: TokenUsage, estimatedCostUsd: number | null): string {
  const tokens = `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`;
  return estimatedCostUsd != null ? `${tokens} · ~$${estimatedCostUsd.toFixed(4)}` : tokens;
}

export default function PixelForgePage() {
  useEffect(() => { document.title = 'Pixel Forge | VictoryLabs'; }, []);

  const [prompt, setPrompt]         = useState('');
  const [canvasSize, setCanvasSize] = useState(32);
  const [paletteText, setPaletteText] = useState('');
  const [quality, setQuality]       = useState<Quality>('normal');
  const [maxTurns, setMaxTurns]     = useState(PRESET_MAX_TURNS.normal);
  const [layerType, setLayerType]   = useState<LayerType | ''>('');
  const [anchor, setAnchor]         = useState('');
  const [tagsText, setTagsText]     = useState('');
  const [notes, setNotes]           = useState('');
  const [name, setName]             = useState('');
  const [zIndexText, setZIndexText] = useState('');

  // ── Reference Mode MVP (docs/pixel-forge-reference-mode-mvp.md) ──────
  // Deliberately NOT part of PersistedForm/localStorage — a reference is
  // per-generation only, never reused, never saved. Fresh-draft form only,
  // no revision equivalent.
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceBase64, setReferenceBase64] = useState<string | null>(null);
  const [referenceMimeType, setReferenceMimeType] = useState<'image/png' | 'image/jpeg' | null>(null);
  const [referencePreviewUrl, setReferencePreviewUrl] = useState<string | null>(null);
  const [referenceRightsConfirmed, setReferenceRightsConfirmed] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [currentJobHasReference, setCurrentJobHasReference] = useState(false);
  /** Read client-side from the loaded preview <img> (naturalWidth/Height) —
   *  purely a display nicety, never sent to the backend. Null until the
   *  preview has actually loaded, or if it never does. */
  const [referenceDimensions, setReferenceDimensions] = useState<{ width: number; height: number } | null>(null);

  // Restore the persisted form once on initial mount.
  useEffect(() => {
    const restored = loadPersistedForm();
    if (restored.prompt !== undefined) setPrompt(restored.prompt);
    if (restored.canvasSize !== undefined) setCanvasSize(restored.canvasSize);
    if (restored.layerType !== undefined) setLayerType(restored.layerType);
    if (restored.quality !== undefined) setQuality(restored.quality);
    if (restored.maxTurns !== undefined) setMaxTurns(restored.maxTurns);
    if (restored.anchor !== undefined) setAnchor(restored.anchor);
    if (restored.paletteText !== undefined) setPaletteText(restored.paletteText);
    if (restored.name !== undefined) setName(restored.name);
    if (restored.zIndexText !== undefined) setZIndexText(restored.zIndexText);
    if (restored.tagsText !== undefined) setTagsText(restored.tagsText);
    if (restored.notes !== undefined) setNotes(restored.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced auto-save on every field change — not cleared after a
  // successful generation, since the same setup is often reused to draw
  // several similar traits in a row.
  const formSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (formSaveTimer.current) clearTimeout(formSaveTimer.current);
    formSaveTimer.current = setTimeout(() => {
      const toSave: PersistedForm = {
        prompt, canvasSize, layerType, quality, maxTurns, anchor, paletteText, name, zIndexText, tagsText, notes,
      };
      try {
        window.localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(toSave));
      } catch {
        // localStorage unavailable/full — form still works, just unpersisted
      }
    }, FORM_SAVE_DEBOUNCE_MS);
    return () => { if (formSaveTimer.current) clearTimeout(formSaveTimer.current); };
  }, [prompt, canvasSize, layerType, quality, maxTurns, anchor, paletteText, name, zIndexText, tagsText, notes]);

  const resetForm = () => {
    if (!window.confirm('Reset the Pixel Forge form? This clears all saved field values.')) return;
    try { window.localStorage.removeItem(FORM_STORAGE_KEY); } catch { /* ignore */ }
    setPrompt(DEFAULT_FORM.prompt);
    setCanvasSize(DEFAULT_FORM.canvasSize);
    setLayerType(DEFAULT_FORM.layerType);
    setQuality(DEFAULT_FORM.quality);
    setMaxTurns(DEFAULT_FORM.maxTurns);
    setAnchor(DEFAULT_FORM.anchor);
    setPaletteText(DEFAULT_FORM.paletteText);
    setName(DEFAULT_FORM.name);
    setZIndexText(DEFAULT_FORM.zIndexText);
    setTagsText(DEFAULT_FORM.tagsText);
    setNotes(DEFAULT_FORM.notes);
    setReferenceFile(null);
    setReferenceBase64(null);
    setReferenceMimeType(null);
    setReferencePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setReferenceRightsConfirmed(false);
    setReferenceError(null);
    setReferenceDimensions(null);
  };

  const clearReferenceImage = useCallback(() => {
    setReferenceFile(null);
    setReferenceBase64(null);
    setReferenceMimeType(null);
    setReferencePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setReferenceRightsConfirmed(false);
    setReferenceError(null);
    setReferenceDimensions(null);
  }, []);

  const onReferenceFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!REFERENCE_ALLOWED_MIME_TYPES.has(file.type)) {
      setReferenceError('Reference image must be PNG or JPEG.');
      return;
    }
    if (file.size > REFERENCE_MAX_BYTES) {
      setReferenceError('Reference image is too large (max 2 MB).');
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      clearReferenceImage();
      setReferenceFile(file);
      setReferenceBase64(base64);
      setReferenceMimeType(file.type as 'image/png' | 'image/jpeg');
      setReferencePreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setReferenceError((err as Error).message);
    }
  };

  const [busy, setBusy]             = useState(false);
  const [jobId, setJobId]           = useState<string | null>(null);
  const [jobError, setJobError]     = useState<string | null>(null);
  const [iterations, setIterations] = useState<JobIteration[]>([]);
  const [result, setResult]         = useState<JobResult | null>(null);
  const [revisingTraitId, setRevisingTraitId] = useState<string | null>(null);

  const [traits, setTraits]         = useState<TraitAssetSummary[]>([]);
  const [traitsError, setTraitsError] = useState<string | null>(null);
  const [reviseDraftId, setReviseDraftId] = useState<string | null>(null);
  const [reviseDraftText, setReviseDraftText] = useState('');

  const [filterLayerType, setFilterLayerType] = useState<LayerType | ''>('');
  const [filterStatus, setFilterStatus] = useState<TraitStatus | ''>('');
  const [approvedOnly, setApprovedOnly] = useState(false);

  const [validationPreviews, setValidationPreviews] = useState<ValidationPreviewItem[]>([]);
  const [validationPreviewsError, setValidationPreviewsError] = useState<string | null>(null);
  const [showValidationPreviews, setShowValidationPreviews] = useState(true);
  const [validationRunFilter, setValidationRunFilter] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTraits = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/traits`, { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; traits?: TraitAssetSummary[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Failed to load traits.');
      setTraits(body.traits ?? []);
      setTraitsError(null);
    } catch (e) {
      setTraitsError((e as Error).message);
    }
  }, []);

  const loadValidationPreviews = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/validation-previews`, { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; previews?: ValidationPreviewItem[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Failed to load validation previews.');
      setValidationPreviews(body.previews ?? []);
      setValidationPreviewsError(null);
    } catch (e) {
      setValidationPreviewsError((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadTraits(); }, [loadTraits]);
  useEffect(() => { void loadValidationPreviews(); }, [loadValidationPreviews]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollJob = (id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/pixel-forge/jobs/${id}`, { headers: { ...authHeaders() } });
        if (r.status === 429) { setJobError(ERROR_CODE_MESSAGES.pixel_forge_poll_rate_limited); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json() as JobPollResponse;
        if (!body.ok) throw new Error(body.error ?? 'Job lookup failed.');
        setIterations(body.iterations ?? []);
        if (body.status === 'done') {
          stopPolling();
          setBusy(false);
          setResult(body.result ?? null);
          void loadTraits();
        } else if (body.status === 'error') {
          stopPolling();
          setBusy(false);
          setJobError((body.errorCode && ERROR_CODE_MESSAGES[body.errorCode]) || body.error || 'Drawing job failed.');
        }
      } catch (e) {
        stopPolling();
        setBusy(false);
        setJobError((e as Error).message);
      }
    }, POLL_MS);
  };

  const changeQuality = (q: Quality) => {
    setQuality(q);
    setMaxTurns(PRESET_MAX_TURNS[q]);
  };

  const generate = async () => {
    const trimmed = prompt.trim();
    if (busy || trimmed.length === 0 || !layerType) return;
    if (referenceFile && !referenceRightsConfirmed) return;
    playUiConfirm();
    setBusy(true);
    setJobError(null);
    setIterations([]);
    setResult(null);
    setRevisingTraitId(null);
    setJobId(null);
    const usingReference = referenceBase64 !== null && referenceMimeType !== null;
    setCurrentJobHasReference(usingReference);
    try {
      const palette = paletteText.trim().length > 0
        ? paletteText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const tags = tagsText.trim().length > 0
        ? tagsText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const zIndex = zIndexText.trim().length > 0 ? Number(zIndexText) : undefined;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          prompt: trimmed, layerType, canvasSize, palette, modelPreset: quality, maxTurns,
          anchor: anchor.trim() || undefined, tags, notes: notes.trim() || undefined,
          name: name.trim() || undefined, zIndex,
          ...(usingReference ? {
            referenceImage: { base64: referenceBase64, mimeType: referenceMimeType },
            referenceRightsConfirmed: true,
          } : {}),
        }),
      });
      if (r.status === 429) { setJobError(ERROR_CODE_MESSAGES.pixel_forge_start_rate_limited); setBusy(false); return; }
      if (r.status === 403) { setJobError(ERROR_CODE_MESSAGES.opus_disabled); setBusy(false); return; }
      if (r.status === 503) { setJobError('ANTHROPIC_API_KEY not configured on the backend.'); setBusy(false); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        const code = body?.error;
        setJobError((code && ERROR_CODE_MESSAGES[code]) || code || `Start failed — HTTP ${r.status}.`);
        setBusy(false);
        return;
      }
      const body = await r.json() as { ok: boolean; jobId?: string; error?: string };
      if (!body.ok || !body.jobId) { setJobError(body.error ?? 'Start failed.'); setBusy(false); return; }
      setJobId(body.jobId);
      // Reference is per-generation only — never reused, never persisted
      // client-side either. Clear it once the job has actually started.
      clearReferenceImage();
      pollJob(body.jobId);
    } catch (e) {
      setJobError((e as Error).message);
      setBusy(false);
    }
  };

  const reviseTrait = async (id: string) => {
    const trimmed = reviseDraftText.trim();
    // A revision no longer requires manually-typed text — a trait with a
    // stored repairPlan (open issues) can be revised on the plan alone;
    // the backend folds it into the revision prompt automatically. See
    // docs/pixel-forge-revision-v3.md §8.
    const trait = traits.find(tr => tr.id === id);
    const hasRepairWork = openIssueCount(trait ?? { repairPlan: null }) > 0;
    if (busy || (trimmed.length === 0 && !hasRepairWork)) return;
    playUiConfirm();
    setBusy(true);
    setJobError(null);
    setIterations([]);
    setResult(null);
    setRevisingTraitId(id);
    setJobId(null);
    setReviseDraftId(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/traits/${id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ prompt: trimmed, modelPreset: quality, maxTurns }),
      });
      if (r.status === 429) { setJobError(ERROR_CODE_MESSAGES.pixel_forge_start_rate_limited); setBusy(false); return; }
      if (r.status === 403) { setJobError(ERROR_CODE_MESSAGES.opus_disabled); setBusy(false); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        setJobError(body?.error ?? `Revise failed — HTTP ${r.status}.`);
        setBusy(false);
        return;
      }
      const body = await r.json() as { ok: boolean; jobId?: string; error?: string };
      if (!body.ok || !body.jobId) { setJobError(body.error ?? 'Revise failed.'); setBusy(false); return; }
      setJobId(body.jobId);
      pollJob(body.jobId);
    } catch (e) {
      setJobError((e as Error).message);
      setBusy(false);
    }
  };

  const stopJob = async () => {
    if (!jobId) return;
    try {
      await fetch(`${API_BASE}/api/tools/pixel-forge/jobs/${jobId}/stop`, {
        method: 'POST', headers: { ...authHeaders() },
      });
    } catch {
      // best-effort — polling will surface the final state either way
    }
  };

  const discardResult = async () => {
    if (!result) return;
    try {
      await fetch(`${API_BASE}/api/tools/pixel-forge/traits/${result.variantId}`, {
        method: 'DELETE', headers: { ...authHeaders() },
      });
    } catch {
      // best-effort; the gallery refresh below will reconcile either way
    }
    setResult(null);
    void loadTraits();
  };

  const deleteTrait = async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/tools/pixel-forge/traits/${id}`, {
        method: 'DELETE', headers: { ...authHeaders() },
      });
      setTraits(prev => prev.filter(t => t.id !== id));
    } catch (e) {
      setTraitsError((e as Error).message);
    }
  };

  const patchTraitMeta = async (
    id: string,
    patch: { tags?: string[]; notes?: string | null; status?: TraitStatus; name?: string; zIndex?: number },
  ) => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/traits/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      void loadTraits();
    } catch (e) {
      setTraitsError((e as Error).message);
    }
  };

  const setTraitStatus = (id: string, status: TraitStatus) => { playUiConfirm(); void patchTraitMeta(id, { status }); };

  const downloadPng = (t: TraitAssetSummary) => {
    downloadBlob(`${t.slug}.png`, Uint8Array.from(atob(t.pngBase64), c => c.charCodeAt(0)), 'image/png');
  };

  const downloadJson = async (t: TraitAssetSummary) => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/traits/${t.id}`, { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; trait?: TraitAssetFull; error?: string };
      if (!body.ok || !body.trait) throw new Error(body.error ?? 'Failed to load trait.');
      downloadBlob(`${t.slug}.json`, JSON.stringify(body.trait, null, 2), 'application/json');
    } catch (e) {
      setTraitsError((e as Error).message);
    }
  };

  const visibleTraits = useMemo(() => traits.filter(t => (
    (filterLayerType === '' || t.layerType === filterLayerType)
    && (filterStatus === '' || t.status === filterStatus)
    && (!approvedOnly || t.status === 'approved')
  )), [traits, filterLayerType, filterStatus, approvedOnly]);

  const visibleValidationPreviews = useMemo(() => {
    const q = validationRunFilter.trim().toLowerCase();
    if (!q) return validationPreviews;
    return validationPreviews.filter(p => p.runId.toLowerCase().includes(q) || p.promptId.toLowerCase().includes(q));
  }, [validationPreviews, validationRunFilter]);

  const latestPreview = iterations.length > 0 ? iterations[iterations.length - 1].pngBase64 : null;
  const generateDisabled = busy || prompt.trim().length === 0 || !layerType
    || (referenceFile !== null && !referenceRightsConfirmed);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
            PIXEL FORGE
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
            <LiveDot />
            <span>trait-library builder — Claude only expands reusable layers, never generates the collection itself</span>
          </div>

          {/* Controls */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Draw a new trait</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. a small red heart, centered, thick black outline"
              rows={2}
              disabled={busy}
              style={{ ...FIELD, width: '100%', boxSizing: 'border-box', resize: 'vertical', marginBottom: 10 }}
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                CANVAS
                <select value={canvasSize} onChange={(e) => setCanvasSize(Number(e.target.value))} disabled={busy} style={FIELD}>
                  {CANVAS_SIZES.map(n => <option key={n} value={n}>{n}×{n}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                LAYER TYPE (required)
                <select
                  value={layerType}
                  onChange={(e) => setLayerType(e.target.value as LayerType | '')}
                  disabled={busy}
                  style={{ ...FIELD, border: layerType ? FIELD.border : '1px solid rgba(217,124,124,0.55)' }}
                >
                  <option value="">select…</option>
                  {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                QUALITY
                <select
                  value={quality}
                  onChange={(e) => changeQuality(e.target.value as Quality)}
                  disabled={busy}
                  style={{ ...FIELD, minWidth: 260 }}
                >
                  {QUALITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                MAX TURNS
                <select value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} disabled={busy} style={FIELD}>
                  {MAX_TURNS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
            {quality === 'premium' && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#c7b479' }}>
                Uses the most expensive model. Use only for hard traits or final polish.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', flex: 1, minWidth: 220 }}>
                ANCHOR / ALIGNMENT HINT (optional — keeps traits of the same layer consistent)
                <input
                  type="text" value={anchor} disabled={busy}
                  onChange={(e) => setAnchor(e.target.value)}
                  placeholder="e.g. head center at x=16, y=15"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', flex: 1, minWidth: 220 }}>
                PALETTE (hex, comma-separated — blank = default 16-color)
                <input
                  type="text" value={paletteText} disabled={busy}
                  onChange={(e) => setPaletteText(e.target.value)}
                  placeholder="#1a1c2c, #ef7d57, #38b764, …"
                  style={FIELD}
                />
              </label>
            </div>

            {/* Reference Mode MVP — see docs/pixel-forge-reference-mode-mvp.md.
                Fresh-draft form only; no revision equivalent. */}
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: '1px solid rgba(168,144,232,0.22)', background: 'rgba(168,144,232,0.04)' }}>
              <div style={{ fontSize: 10.5, color: '#9a9ab4', marginBottom: 6 }}>
                STYLE REFERENCE (optional, image)
              </div>
              <div style={{ fontSize: 10, color: '#9a9ab4', lineHeight: 1.5, marginBottom: 8 }}>
                Used once, as a structure/style hint for this generation only — never reused,
                never saved. Only proportions, outline weight, palette-ramp behavior, and
                silhouette are inherited. The reference&apos;s specific subject, accessories,
                symbols, and exact colors are never copied.
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {referencePreviewUrl ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <div style={{ position: 'relative' }}>
                      <img
                        src={referencePreviewUrl}
                        alt="reference preview"
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setReferenceDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                        }}
                        style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 5, border: '1px solid rgba(168,144,232,0.35)' }}
                      />
                      <button
                        type="button"
                        onClick={clearReferenceImage}
                        disabled={busy}
                        data-uisnd="skip"
                        title="Remove reference image"
                        style={{
                          position: 'absolute', top: -6, right: -6, width: 18, height: 18, lineHeight: '16px',
                          borderRadius: '50%', fontSize: 11, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer',
                          border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: '#d96867',
                        }}
                      >×</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5, color: '#9a9ab4', paddingTop: 2 }}>
                      <span style={{ color: '#43b984', fontWeight: 700 }}>reference loaded</span>
                      {referenceFile && <span>{referenceMimeTypeLabel(referenceFile.type)}</span>}
                      {referenceDimensions && (
                        <span>{referenceDimensions.width}×{referenceDimensions.height}px</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={busy}
                    onChange={(e) => { void onReferenceFileChange(e); }}
                    style={{ fontSize: 10.5, color: '#9a9ab4' }}
                  />
                )}
                {referenceFile && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#c8c8dc', maxWidth: 380 }}>
                    <input
                      type="checkbox"
                      checked={referenceRightsConfirmed}
                      disabled={busy}
                      onChange={(e) => setReferenceRightsConfirmed(e.target.checked)}
                    />
                    I have the right to use this image as a style reference.
                  </label>
                )}
              </div>
              {referenceError && (
                <div style={{ fontSize: 10.5, color: '#d96867', marginTop: 6 }}>{referenceError}</div>
              )}
              {referenceFile && !referenceRightsConfirmed && (
                <div style={{ fontSize: 10, color: '#c7b479', marginTop: 6 }}>
                  Confirm the checkbox above to enable Generate with this reference attached.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', flex: 1, minWidth: 220 }}>
                NAME (optional — blank = auto from prompt)
                <input
                  type="text" value={name} disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Red Heart Icon"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                Z-INDEX (optional — default by layer type)
                <input
                  type="number" value={zIndexText} disabled={busy}
                  onChange={(e) => setZIndexText(e.target.value)}
                  placeholder="auto"
                  style={{ ...FIELD, width: 90 }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', flex: 1, minWidth: 220 }}>
                TAGS (optional, comma-separated)
                <input
                  type="text" value={tagsText} disabled={busy}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="e.g. winter, rare, blue"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', flex: 1, minWidth: 220 }}>
                NOTES (optional)
                <input
                  type="text" value={notes} disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="your own notes about this trait"
                  style={FIELD}
                />
              </label>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={generate}
                disabled={generateDisabled}
                data-uisnd="skip"
                style={{
                  padding: '7px 18px', fontSize: 12, fontWeight: 700,
                  letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
                  cursor: generateDisabled ? 'not-allowed' : 'pointer',
                  border: '1px solid rgba(168,144,232,0.55)',
                  background: generateDisabled ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
                  color: generateDisabled ? '#9a9ab4' : '#f0eef8',
                  boxShadow: generateDisabled ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
                  transition: 'all 0.15s',
                }}
              >
                {busy && !revisingTraitId ? 'Drawing…' : 'Generate'}
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={stopJob}
                  data-uisnd="skip"
                  style={{
                    padding: '7px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px',
                    textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(217,124,124,0.55)', background: 'rgba(217,104,104,0.14)', color: '#d96867',
                  }}
                >Stop</button>
              )}
              <button
                type="button"
                onClick={resetForm}
                disabled={busy}
                data-uisnd="skip"
                style={{
                  padding: '7px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.5px',
                  textTransform: 'uppercase', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer',
                  border: '1px solid rgba(122,122,148,0.35)', background: 'rgba(122,122,148,0.08)',
                  color: '#9a9ab4', marginLeft: 'auto',
                }}
              >Reset form</button>
            </div>
          </div>

          {jobError && (
            <div style={{
              padding: '8px 12px', fontSize: 12, color: '#d96867',
              background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
              borderRadius: 5, marginBottom: 11,
            }}>
              {jobError}
            </div>
          )}

          {/* Live progress + preview */}
          {(busy || iterations.length > 0) && (
            <div style={PANEL}>
              <div style={{ ...SECTION_LABEL, display: 'flex', alignItems: 'center', gap: 6 }}>
                {busy && currentJobHasReference && iterations.length === 0 ? (
                  <>
                    <LiveDot color="#a890e8" />
                    <span>Analyzing reference…</span>
                  </>
                ) : (
                  <span>
                    {busy
                      ? (revisingTraitId ? 'Revising…' : 'Drawing…')
                      : (result ? (revisingTraitId ? 'Revised' : 'Result') : 'Last run')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {(result?.pngBase64 ?? latestPreview) && (
                  <PixelImg src={`data:image/png;base64,${result?.pngBase64 ?? latestPreview}`} size={224} alt="canvas preview" />
                )}
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ maxHeight: 224, overflowY: 'auto', fontFamily: MONO, fontSize: 11, color: '#c8c8dc', lineHeight: 1.6 }} className="scroll-area">
                    {iterations.map((it, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <span style={{ color: '#a890e8', fontWeight: 700 }}>{it.phase}{it.phase === 'refine' ? ` #${it.turn}` : ''}</span>
                        <span style={{ color: '#9a9ab4' }}> — {it.note}</span>
                      </div>
                    ))}
                    {busy && <div style={{ color: '#9a9ab4' }}>waiting for next turn…</div>}
                  </div>
                  {result && (
                    <>
                      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{
                          display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 700,
                          borderRadius: 5, color: STATUS_META.candidate.color, background: `${STATUS_META.candidate.color}1a`,
                          border: `1px solid ${STATUS_META.candidate.color}55`,
                        }}>{revisingTraitId ? 'REVISED — CANDIDATE' : STATUS_META.candidate.label}</span>
                        <button
                          type="button"
                          onClick={() => setTraitStatus(result.variantId, 'approved')}
                          data-uisnd="skip"
                          style={{
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: '#43b984',
                          }}
                        >Approve</button>
                        <button
                          type="button"
                          onClick={() => setTraitStatus(result.variantId, 'rejected')}
                          data-uisnd="skip"
                          style={{
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid rgba(217,124,124,0.45)', background: 'rgba(217,104,104,0.10)', color: '#d96867',
                          }}
                        >Reject</button>
                        {!revisingTraitId && (
                          <button
                            type="button"
                            onClick={discardResult}
                            data-uisnd="skip"
                            style={{
                              padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                              border: '1px solid rgba(122,122,148,0.35)', background: 'rgba(122,122,148,0.08)', color: '#9a9ab4',
                            }}
                          >Delete</button>
                        )}
                        <span style={{ fontSize: 10.5, color: '#9a9ab4', fontFamily: MONO }}>
                          {usageLine(result.tokenUsage, result.estimatedCostUsd)}
                        </span>
                      </div>
                      {result.referenceGuidanceNote && (
                        <div style={{
                          marginTop: 8, fontSize: 10, color: '#9a9ab4', padding: '5px 8px', borderRadius: 4,
                          border: '1px solid rgba(168,144,232,0.22)', background: 'rgba(168,144,232,0.04)',
                        }}>
                          <span style={{ fontWeight: 700, color: '#a890e8' }}>Reference guidance used: </span>
                          {result.referenceGuidanceNote}
                        </div>
                      )}
                      <div style={{ marginTop: 10 }}>
                        <RepairPlanSummary evaluation={result.evaluation} repairPlan={result.repairPlan} />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Trait library */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Trait library ({visibleTraits.length} / {traits.length})</div>
            {traitsError && <div style={{ fontSize: 11, color: '#d96867', marginBottom: 8 }}>{traitsError}</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                FILTER: LAYER TYPE
                <select value={filterLayerType} onChange={(e) => setFilterLayerType(e.target.value as LayerType | '')} style={FIELD}>
                  <option value="">all</option>
                  {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4' }}>
                FILTER: STATUS
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TraitStatus | '')} style={FIELD}>
                  <option value="">all</option>
                  <option value="candidate">candidate</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9a9ab4', paddingBottom: 8 }}>
                <input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} />
                Approved only
              </label>
            </div>
            {visibleTraits.length === 0 ? (
              <div style={{ fontSize: 12, color: '#9a9ab4' }}>{traits.length === 0 ? 'Nothing saved yet.' : 'No traits match these filters.'}</div>
            ) : (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {visibleTraits.map(t => (
                  <div key={t.id} style={{ width: 132 }}>
                    <div style={{ position: 'relative' }}>
                      <PixelImg src={`data:image/png;base64,${t.pngBase64}`} size={132} alt={t.prompt} />
                      <span
                        title={
                          isV2Evaluation(t.evaluation)
                            ? (t.repairPlan
                                ? (openIssueCount(t) > 0 ? `${openIssueCount(t)} open issue(s) — see below` : 'No open issues')
                                : (t.evaluation.notes || 'Not graded yet'))
                            : (legacyMissingFeaturesOf(t.evaluation).length > 0
                                ? `Missing: ${legacyMissingFeaturesOf(t.evaluation).join('; ')}`
                                : ((t.evaluation && t.evaluation.notes) || (legacyEvalAllPass(t.evaluation) ? 'All checks passed' : 'Some checks failed')))
                        }
                        style={{
                          position: 'absolute', top: 4, right: 4, width: 9, height: 9, borderRadius: '50%',
                          background: isV2Evaluation(t.evaluation)
                            ? overallSeverityColor(t.repairPlan?.overallSeverity ?? (openIssueCount(t) > 0 ? 'major' : 'none'))
                            : (legacyEvalAllPass(t.evaluation) ? '#43b984' : '#d96867'),
                          boxShadow: '0 0 0 2px rgba(20,14,34,0.85)',
                        }}
                      />
                    </div>
                    {isV2Evaluation(t.evaluation) ? (
                      openIssueCount(t) > 0 && (
                        <button
                          type="button"
                          onClick={() => { setReviseDraftId(t.id); setReviseDraftText(''); }}
                          disabled={busy}
                          data-uisnd="skip"
                          title={safeIssues(t.repairPlan).map(i => `[${getSeverityMeta(i.severity).label}] ${i.location || '?'}: ${i.problem || '?'}`).join('\n')}
                          style={{
                            display: 'block', width: '100%', marginTop: 3, padding: '2px 5px', fontSize: 9,
                            fontWeight: 700, borderRadius: 3, textAlign: 'left', cursor: busy ? 'not-allowed' : 'pointer',
                            border: '1px solid rgba(199,180,121,0.35)', background: 'rgba(199,180,121,0.08)', color: '#c7b479',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}
                        >⚠ {openIssueCount(t)} open issue{openIssueCount(t) > 1 ? 's' : ''} — Revise applies plan automatically</button>
                      )
                    ) : (
                      legacyMissingFeaturesOf(t.evaluation).length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setReviseDraftId(t.id);
                            setReviseDraftText(legacyMissingFeaturesRevisionText(legacyMissingFeaturesOf(t.evaluation)));
                          }}
                          disabled={busy}
                          data-uisnd="skip"
                          title={legacyMissingFeaturesOf(t.evaluation).join('; ')}
                          style={{
                            display: 'block', width: '100%', marginTop: 3, padding: '2px 5px', fontSize: 9,
                            fontWeight: 700, borderRadius: 3, textAlign: 'left', cursor: busy ? 'not-allowed' : 'pointer',
                            border: '1px solid rgba(199,180,121,0.35)', background: 'rgba(199,180,121,0.08)', color: '#c7b479',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}
                        >⚠ {legacyMissingFeaturesOf(t.evaluation).length} missing feature{legacyMissingFeaturesOf(t.evaluation).length > 1 ? 's' : ''}</button>
                      )
                    )}
                    <input
                      type="text"
                      defaultValue={t.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) void patchTraitMeta(t.id, { name: e.target.value.trim() }); }}
                      style={{ ...FIELD, width: '100%', boxSizing: 'border-box', fontSize: 10.5, fontWeight: 700, padding: '3px 6px', marginTop: 4 }}
                    />
                    <div title={t.prompt} style={{
                      fontSize: 9.5, color: '#9a9ab4', marginTop: 3, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        [{t.layerType}] {t.prompt}{t.revision > 0 ? ` (rev ${t.revision})` : ''}
                      </span>
                      <input
                        type="number"
                        defaultValue={t.zIndex}
                        title="z-index (compositing order)"
                        onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== t.zIndex) void patchTraitMeta(t.id, { zIndex: n }); }}
                        style={{ ...FIELD, width: 40, flexShrink: 0, fontSize: 9, padding: '2px 4px' }}
                      />
                    </div>
                    <span style={{
                      display: 'inline-block', marginTop: 3, padding: '1px 5px', fontSize: 8.5, fontWeight: 700,
                      letterSpacing: '0.3px', borderRadius: 3, color: STATUS_META[t.status].color,
                      background: `${STATUS_META[t.status].color}1a`, border: `1px solid ${STATUS_META[t.status].color}55`,
                    }}>{STATUS_META[t.status].label}</span>
                    {t.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
                        {t.tags.map(tag => (
                          <span key={tag} style={{
                            fontSize: 9, padding: '1px 5px', borderRadius: 3, color: '#a890e8',
                            background: 'rgba(168,144,232,0.10)', border: '1px solid rgba(168,144,232,0.28)',
                          }}>{tag}</span>
                        ))}
                      </div>
                    )}
                    {t.referenceGuidanceNote && (
                      <div
                        title={t.referenceGuidanceNote}
                        style={{
                          fontSize: 8.5, color: '#9a9ab4', marginTop: 3, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: '#a890e8' }}>ref: </span>{t.referenceGuidanceNote}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => setTraitStatus(t.id, 'approved')}
                        disabled={t.status === 'approved'}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                          cursor: t.status === 'approved' ? 'default' : 'pointer',
                          opacity: t.status === 'approved' ? 0.5 : 1,
                          border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: '#43b984',
                        }}
                      >Approve</button>
                      <button
                        type="button"
                        onClick={() => setTraitStatus(t.id, 'rejected')}
                        disabled={t.status === 'rejected'}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                          cursor: t.status === 'rejected' ? 'default' : 'pointer',
                          opacity: t.status === 'rejected' ? 0.5 : 1,
                          border: '1px solid rgba(217,124,124,0.40)', background: 'rgba(217,104,104,0.08)', color: '#d96867',
                        }}
                      >Reject</button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => { setReviseDraftId(reviseDraftId === t.id ? null : t.id); setReviseDraftText(''); }}
                        disabled={busy}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                          cursor: busy ? 'not-allowed' : 'pointer',
                          border: '1px solid rgba(168,144,232,0.40)', background: 'rgba(168,144,232,0.08)', color: '#a890e8',
                        }}
                      >Revise</button>
                      <button
                        type="button"
                        onClick={() => deleteTrait(t.id)}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgba(122,122,148,0.35)', background: 'rgba(122,122,148,0.08)', color: '#9a9ab4',
                        }}
                      >Delete</button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => downloadJson(t)}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgba(168,144,232,0.40)', background: 'rgba(168,144,232,0.06)', color: '#9a9ab4',
                        }}
                      >JSON</button>
                      <button
                        type="button"
                        onClick={() => downloadPng(t)}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgba(168,144,232,0.40)', background: 'rgba(168,144,232,0.06)', color: '#9a9ab4',
                        }}
                      >PNG</button>
                    </div>
                    {reviseDraftId === t.id && (() => {
                      const hasRepairWork = openIssueCount(t) > 0;
                      const canSubmit = reviseDraftText.trim().length > 0 || hasRepairWork;
                      return (
                        <div style={{ marginTop: 6 }}>
                          {hasRepairWork && (
                            <div style={{ fontSize: 9.5, color: '#9a9ab4', marginBottom: 4 }}>
                              {openIssueCount(t)} open issue{openIssueCount(t) > 1 ? 's' : ''} from the stored repair plan will
                              be applied automatically — text below is optional, additional instruction only.
                            </div>
                          )}
                          <textarea
                            value={reviseDraftText}
                            onChange={(e) => setReviseDraftText(e.target.value)}
                            placeholder={hasRepairWork ? 'optional — additional instructions…' : 'revision instructions…'}
                            rows={2}
                            style={{ ...FIELD, width: '100%', boxSizing: 'border-box', fontSize: 10.5, resize: 'vertical' }}
                          />
                          <button
                            type="button"
                            onClick={() => reviseTrait(t.id)}
                            disabled={busy || !canSubmit}
                            data-uisnd="skip"
                            style={{
                              marginTop: 4, width: '100%', padding: '3px 6px', fontSize: 10, fontWeight: 700,
                              borderRadius: 4, cursor: (busy || !canSubmit) ? 'not-allowed' : 'pointer',
                              border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: '#43b984',
                            }}
                          >Submit revision</button>
                        </div>
                      );
                    })()}
                    <input
                      type="text"
                      defaultValue={t.notes ?? ''}
                      placeholder="notes…"
                      onBlur={(e) => { if (e.target.value !== (t.notes ?? '')) void patchTraitMeta(t.id, { notes: e.target.value.trim() || null }); }}
                      style={{ ...FIELD, width: '100%', boxSizing: 'border-box', fontSize: 9.5, padding: '3px 6px', marginTop: 4 }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Validation runs (read-only, never editable/deletable) */}
          <div style={PANEL}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: showValidationPreviews ? 6 : 0 }}>
              <div style={{ ...SECTION_LABEL, marginBottom: 0, flex: 1 }}>
                Validation runs / test generations ({visibleValidationPreviews.length} / {validationPreviews.length})
              </div>
              <button
                type="button"
                onClick={() => setShowValidationPreviews(v => !v)}
                data-uisnd="skip"
                style={{
                  padding: '2px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', borderRadius: 4,
                  cursor: 'pointer', border: '1px solid rgba(122,122,148,0.35)',
                  background: 'rgba(122,122,148,0.08)', color: '#9a9ab4',
                }}
              >{showValidationPreviews ? 'Hide' : 'Show'}</button>
            </div>
            {showValidationPreviews && (
              <>
                <div style={{ fontSize: 10.5, color: '#9a9ab4', marginBottom: 8 }}>
                  Previews from paid smoke/benchmark runs under <code style={{ fontFamily: MONO }}>data/pixel-forge/validation-runs/</code> — read-only, not part of the trait library, numbered oldest → newest.
                </div>
                {validationPreviewsError && <div style={{ fontSize: 11, color: '#d96867', marginBottom: 8 }}>{validationPreviewsError}</div>}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: '#9a9ab4', maxWidth: 260 }}>
                    FILTER: RUN ID / PROMPT ID
                    <input
                      type="text" value={validationRunFilter}
                      onChange={(e) => setValidationRunFilter(e.target.value)}
                      placeholder="e.g. 2026-07-06 or bust-wizard"
                      style={FIELD}
                    />
                  </label>
                </div>
                {visibleValidationPreviews.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9a9ab4' }}>
                    {validationPreviews.length === 0 ? 'No validation preview PNGs found.' : 'No previews match this filter.'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {visibleValidationPreviews.map(p => (
                      <div key={`${p.runId}-${p.promptId}-${p.roundNumber ?? 'x'}`} style={{ width: 132 }}>
                        <div style={{ position: 'relative' }}>
                          <PixelImg
                            src={`data:image/png;base64,${p.pngBase64}`}
                            size={132}
                            alt={p.promptText ?? `${p.runId}/${p.promptId}`}
                          />
                          <span style={{
                            position: 'absolute', top: 4, left: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700,
                            borderRadius: 3, fontFamily: MONO, color: '#f0eef8', background: 'rgba(20,14,34,0.78)',
                          }}>#{String(p.seq).padStart(3, '0')}</span>
                          <span
                            title="Read-only — imported from a validation run, not a real trait"
                            style={{
                              position: 'absolute', top: 4, right: 4, padding: '1px 5px', fontSize: 8, fontWeight: 700,
                              letterSpacing: '0.3px', borderRadius: 3, color: '#9a9ab4',
                              background: 'rgba(20,14,34,0.78)', border: '1px solid rgba(154,154,180,0.45)',
                            }}
                          >VALIDATION</span>
                          {p.overallSeverity && (
                            <span
                              title={`overallSeverity: ${p.overallSeverity}`}
                              style={{
                                position: 'absolute', bottom: 4, right: 4, width: 9, height: 9, borderRadius: '50%',
                                background: overallSeverityColor(p.overallSeverity),
                                boxShadow: '0 0 0 2px rgba(20,14,34,0.85)',
                              }}
                            />
                          )}
                        </div>
                        <div title={p.promptText ?? ''} style={{
                          fontSize: 9.5, color: '#c8c8dc', marginTop: 4, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 700,
                        }}>{p.promptId}</div>
                        <div style={{ fontSize: 9, color: '#9a9ab4', marginTop: 2, fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.runId}{p.roundNumber !== null ? ` · round ${p.roundNumber}` : ''}{p.jobType ? ` · ${p.jobType}` : ''}
                        </div>
                        <div style={{ fontSize: 9, color: '#9a9ab4', marginTop: 2, fontFamily: MONO }}>
                          {p.model ?? 'model n/a'}{p.costUsd !== null ? ` · $${p.costUsd.toFixed(4)}` : ''}
                        </div>
                        <div style={{ fontSize: 9, marginTop: 2, display: 'flex', gap: 6, alignItems: 'center', color: '#9a9ab4' }}>
                          <span style={{ color: p.recognizableAsSubject === null ? '#9a9ab4' : (p.recognizableAsSubject ? '#43b984' : '#d96867') }}>
                            {p.recognizableAsSubject === null ? 'recognizable: n/a' : (p.recognizableAsSubject ? 'recognizable ✓' : 'recognizable ✗')}
                          </span>
                          {p.openIssueCount !== null && <span>· {p.openIssueCount} open</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
