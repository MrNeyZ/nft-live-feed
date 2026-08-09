'use client';

// VictoryLabs — Tools › Pixel Forge (trait-library builder, not a
// collection generator). Claude drawing/revision generation has been
// removed (see docs/pixel-forge-image-to-traits-pipeline-mvp.md) — the
// Draw tab's Generate button and the Trait Library's Revise controls are
// disabled in place (their backend routes are gone) rather than torn out,
// to keep that removal a minimal change. Pixel Forge is OpenAI-only now:
// the "Generate Source (OpenAI)" panel below (Stage 6, gpt-image-1) DOES
// spend real API credits per click — it does not depend on Anthropic at
// all, and no route here calls Anthropic.
//
// Stage 10.1 UI cleanup (see docs/pixel-forge-stage10-trait-family-sheet):
// Pixel Forge is pivoting from full-NFT + decompose-cells generation to a
// single 10x8 Trait Family Sheet per call. `SHOW_LEGACY_UI` (below) hides
// the now-superseded Draw tab, dead Revise controls, the old 2/4/8-cell
// sheet mode + Validate Sheet UI, the old Import Trait Sheet crop panel,
// the Preview Split heuristic decomposer, and the validation-runs gallery
// — all via conditional rendering, nothing deleted. Flip it back to `true`
// to restore the pre-Stage-10.1 UI if needed.
//
// Data: GET/PATCH/DELETE /api/tools/pixel-forge/traits[/:id],
//       GET/POST/PATCH/DELETE .../collections[/:id],
//       POST .../raster/normalize, .../raster/import, .../raster/split,
//       .../raster/import-split (see tools-pixel-forge-raster.ts),
//       GET .../validation-previews (read-only, no AI)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders, clearAuth } from '@/runtime/auth';
import {
  groupTraitsForStack, sortSelectedLayersForPreview, getStackCanvasSize,
  isTraitCanvasCompatible, detectStackWarnings,
} from './layer-stack';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const POLL_MS = 1500;
const CANVAS_SIZES = [16, 24, 32, 48];

// Stage 10.1 — hide (never delete) UI superseded by the Trait Family Sheet
// pivot: the Draw tab, dead Revise controls, the old 2/4/8-cell sheet mode
// + its Validate Sheet buttons, the old Import Trait Sheet crop panel, the
// Preview Split heuristic decomposer, and the validation-runs gallery. Set
// back to `true` to restore all of it at once.
const SHOW_LEGACY_UI = false;

// ── Reference Mode MVP — client-side mirrors of the backend's caps
// (src/pixel-agent/reference-analysis.ts) so a bad upload is rejected
// instantly instead of round-tripping to the server first. The backend
// re-validates independently regardless — these are a UX nicety only.
const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
const REFERENCE_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

// ── Image-to-Traits Stage 1 (Raster Import) — see
// docs/pixel-forge-image-to-traits-pipeline-mvp.md. A full source NFT
// image, not a style hint, so a more generous cap than the reference-image
// one above; mirrors tools-pixel-forge-raster.ts's own MAX_UPLOAD_BYTES.
const RASTER_MAX_BYTES = 10 * 1024 * 1024;
const RASTER_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const RASTER_TARGET_SIZES = [32, 48] as const;

// ── Stage 9.2 (Trait Sheet import) — see
// docs/pixel-forge-trait-sheet-stage9-design.md and
// src/pixel-agent/trait-sheet.ts. Mirrors that file's own
// LAYER_SHEET_2X4/FAMILY_SHEET_4X4 cellId/label/suggestedLayerType values
// exactly — a small, static duplication (same convention this codebase
// already uses for KNOWN_LAYER_TYPES in layer-stack.ts) so this panel can
// render cell checkboxes without a round-trip just to learn the layout
// shape. The 'preview' cell and every 4x4-family-sheet cell have
// layerType null — never selected by default (mirrors the backend
// route's own default: only real layer cells are pre-checked).
const SHEET_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SHEET_MAX_BYTES = 10 * 1024 * 1024;
interface SheetLayoutCellOption { cellId: string; label: string; layerType: LayerType | null; }
const TRAIT_SHEET_LAYOUT_CELLS: Record<'2x4-layer-sheet' | '4x4-family-sheet', SheetLayoutCellOption[]> = {
  '2x4-layer-sheet': [
    { cellId: 'preview', label: 'Full composed preview', layerType: null },
    { cellId: 'background', label: 'Background', layerType: 'background' },
    { cellId: 'body_hoodie', label: 'Body / Hoodie', layerType: 'body' },
    { cellId: 'head_fur', label: 'Head / Fur', layerType: 'body' },
    { cellId: 'face_mask', label: 'Face Mask', layerType: 'other' },
    { cellId: 'eyes', label: 'Eyes', layerType: 'eyes' },
    { cellId: 'nose_mouth', label: 'Nose / Mouth', layerType: 'mouth' },
    { cellId: 'hat_accessory', label: 'Hat / Accessory', layerType: 'accessory' },
  ],
  '4x4-family-sheet': Array.from({ length: 16 }, (_, i) => ({ cellId: `family-${i}`, label: `Family member ${i + 1}`, layerType: null })),
};

// ── Image-to-Traits Stage 6 (OpenAI Image Source) — see
// docs/pixel-forge-image-to-traits-pipeline-mvp.md and the Stage 6 design
// notes. Reference upload for the OpenAI generate-source call — allows
// WEBP in addition to PNG/JPEG (gpt-image-1 accepts it, and a real
// ChatGPT-style reference image could plausibly be WEBP), same 10MB cap
// as the manual-upload path for consistency.
const GEN_REF_MAX_BYTES = 10 * 1024 * 1024;
const GEN_REF_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GEN_PROMPT_PLACEHOLDER = 'Create the same style NFT, but make it a raccoon instead of a monkey. '
  + 'Preserve the pixel-art aesthetic, framing, proportions, outline weight, simple shading, and '
  + 'collectible avatar composition. Do not copy exact identity.';
const GEN_PROMPT_MAX_LEN = 2000;

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

/** Safely parses a raster/generate-source fetch response as JSON. Every
 *  one of those routes always returns `application/json` on both success
 *  and its own handled errors — but a request can fail BEFORE it ever
 *  reaches that code (nginx rejecting an oversized body with its own
 *  default 413 HTML page, or Express's own default HTML error page for a
 *  body-parser limit), in which case blindly calling `r.json()` throws a
 *  raw, confusing browser SyntaxError ("JSON.parse: unexpected character
 *  at line 1 column 1..."). Checking Content-Type first and falling back
 *  to reading the body as text avoids ever surfacing that raw error to a
 *  user again, regardless of which layer produced the non-JSON response. */
async function parseJsonResponse<T extends { ok: boolean }>(r: Response): Promise<T | { ok: false; error: string }> {
  const contentType = r.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await r.text().catch(() => '');
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const statusLine = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
    return { ok: false, error: snippet ? `${statusLine}: ${snippet}` : statusLine };
  }
  try {
    return await r.json() as T;
  } catch {
    return { ok: false, error: `HTTP ${r.status}: invalid JSON response` };
  }
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

// ── Layer Stack Preview (Stage 4.2) — display-only combo labels. `icon`
// and `accessory` are the real, only-shipped LayerType values that stand
// in for a "head-like" or "headwear" slot today — there is no real
// `head`/`headwear` LayerType yet (see
// docs/pixel-forge-layer-stack-compositor-mvp.md §2), so this ONLY
// relabels the existing values for display; it never invents a new
// backend value.
const LAYER_TYPE_LABELS: Partial<Record<string, string>> = {
  background: 'Background',
  body: 'Body / Base',
  eyes: 'Eyes',
  mouth: 'Mouth',
  accessory: 'Accessory / Headwear',
  icon: 'Icon / Head-like',
  other: 'Other',
};

// ── Layer-first workflow guidance (Layer Workflow MVP) — UI copy only,
// shown next to the LAYER TYPE select so the mental model is "one layer
// at a time," not "one full character." This does NOT change what's sent
// to the backend or any system prompt — the model still only sees
// `prompt`/`layerType` exactly as before; this is purely a client-side
// nudge to write a better, layer-scoped prompt in the first place.
const LAYER_TYPE_GUIDANCE: Partial<Record<string, string>> = {
  background: 'Generate only the background/backdrop layer.\nKeep it simple — every other layer sits on top of it.',
  body: 'Generate only the reusable body/base silhouette.\nDo not include eyes, mouth, hats or accessories.',
  eyes: 'Generate only the eye layer.\nTransparent background.\nNo body.',
  mouth: 'Generate only the mouth/nose layer.',
  accessory: 'Generate only wearable accessories.\nDo not redraw the body.',
  icon: 'Generate a standalone icon, not a wearable trait.',
  other: "Generate a custom layer that doesn't fit the standard slots — describe exactly what it should contain.",
};

// ── Collections (Stage 2 backend, Stage 3 UI — see
// docs/pixel-forge-collection-mvp-plan.md). A Collection is a thin,
// optional pointer: which built-in DNA preset to resolve (today only
// 'smb-animal', mirroring the backend's ALLOWED_COLLECTION_PRESETS
// exactly) plus an optional palette override. Using one during generation
// is entirely optional — the no-collection path is unchanged. The hidden
// `collectionPreset` dev field is a separate, backend-only quick-test
// path and is deliberately never exposed here. ─────────────────────────
const COLLECTION_PRESET_OPTIONS = ['smb-animal'] as const;
interface Collection {
  id: string;
  name: string;
  presetId: string;
  paletteOverride: string[] | null;
  createdAt: number;
  updatedAt: number;
}

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
// Stage 9.3 — mirrors src/pixel-agent/image-source.ts's ImageSourceMode
// union verbatim (backend source of truth; this is a display-only mirror,
// not re-exported, since the frontend can't import backend TS directly).
// Stage 10.4 added 'trait-family-sheet-10x8' backend-side; the three old
// 'trait-sheet-*' (2/4/8-cell) modes are kept in this union (not removed —
// the backend still accepts them, and old Generated Sources Library items
// may still carry one of these values) but are deliberately NOT in
// GEN_SOURCE_MODE_OPTIONS below, per Stage 10.1/10.5's "hide, don't
// re-expose" rule.
type GenSourceMode =
  | 'single-image' | 'trait-sheet-2-cell' | 'trait-sheet-4-cell' | 'trait-sheet-8-cell' | 'trait-family-sheet-10x8';
// Stage 10.5 — only these two modes are user-selectable. The old
// 2/4/8-cell trait-sheet modes are superseded (see project memory
// project_pixel_forge_stage10_pivot) and must not be re-exposed here.
const GEN_SOURCE_MODE_OPTIONS: { value: GenSourceMode; label: string }[] = [
  { value: 'single-image', label: 'Single Image' },
  { value: 'trait-family-sheet-10x8', label: 'Trait Family Sheet 10×8' },
];
interface JobIteration { turn: number; phase: 'draft' | 'seed' | 'refine' | 'evaluate'; note: string; pngBase64: string; }
/** One normalized candidate returned by POST /raster/normalize — see
 *  docs/pixel-forge-image-to-traits-pipeline-mvp.md. `pngBase64` is always
 *  the exact, displayable result for this variant (never re-quantized for
 *  display) — the backend's own approximation tradeoffs for storage
 *  (palette size) live server-side only, never surfaced here. */
// Generated Sources Library — read-only summaries of what
// tools-pixel-forge-generated-sources.ts already has on disk under
// data/pixel-forge/generated-sources/<id>/. `pngBase64` here is a
// server-generated thumbnail, not the full source PNG (see that file's
// LIST_THUMBNAIL_SIZE) — "Use for Normalize" and "Download PNG" both
// fetch the full-size PNG via GET .../generated-sources/:id first.
interface GeneratedSourceSummary {
  id: string; createdAt: number; prompt: string; model: string; size: string; quality: string;
  estimatedCostUsd: number | null; tokenUsage: TokenUsage | null; pngBase64: string;
  referenceImageHash: string; outputMatchesReferenceHash?: boolean;
  sourceMode: GenSourceMode;
}

// Stage 9.4 — Trait Sheet validation (POST /raster/validate-trait-sheet).
// Deterministic, no AI call — see src/pixel-agent/trait-sheet-validation.ts.
type TraitSheetVerdict = 'pass' | 'warn' | 'fail';
type TraitSheetRecommendedNextStep = 'try_import' | 'regenerate' | 'run_4_cell' | 'run_8_cell';
interface TraitSheetValidationIssue { code: string; severity: 'warn' | 'fail'; cellId?: string; message: string; }
interface TraitSheetValidationSummary {
  verdict: TraitSheetVerdict; score: number; issues: TraitSheetValidationIssue[];
  cellReports: { cellId: string; issues: TraitSheetValidationIssue[] }[];
  recommendedNextStep: TraitSheetRecommendedNextStep;
}
const RECOMMENDED_NEXT_STEP_LABEL: Record<TraitSheetRecommendedNextStep, string> = {
  try_import: 'Try Import Trait Sheet', regenerate: 'Regenerate', run_4_cell: 'Run 4-cell test', run_8_cell: 'Run 8-cell test',
};
const VERDICT_COLOR: Record<TraitSheetVerdict, string> = { pass: '#43b984', warn: '#d9a867', fail: '#d96867' };

// Stale-auth fix — Gate.tsx only checks token PRESENCE (not validity, see
// runtime/Gate.tsx's own resolve()), so a session can render the full app
// with an expired token still in localStorage. The first genuinely
// requireAuth-gated call then 401s. clearAuth() + this message (mirrors
// the existing runtime/mode.ts / runtime/mint-tracker.ts "401 -> clearAuth"
// pattern) surfaces that honestly instead of a raw "HTTP 401", and lets a
// page refresh correctly bounce back to the login screen (Gate re-resolves
// on every mount and isAuthed() will now be false).
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please sign in again.';

// Stage 8 (Collection DNA Lock / Fit Check) — see
// src/pixel-agent/collection-fit.ts and
// tools-pixel-forge-collection-fit.ts. Mirrors those files' own types
// exactly; the profile itself is never persisted server-side, so the
// frontend is what carries it from "Create DNA profile" to "Check
// collection fit".
interface FitBBox { x: number; y: number; w: number; h: number; }
interface FitPoint { x: number; y: number; }
interface CollectionFitProfile {
  id: string; name: string; canvasSize: 48;
  targetForegroundBBox: FitBBox; targetSubjectCenter: FitPoint;
  allowedCenterDriftPx: number; allowedBBoxDriftPx: number;
  allowedCoverageRange: [number, number]; allowedPaletteDistance: number;
  allowedOutlineRatioRange: [number, number]; targetPalette: string[]; notes?: string;
}
interface CollectionFitMetrics {
  canvasSize: number; foregroundBBox: FitBBox | null; foregroundCoveragePct: number; transparentRatio: number;
  canvasCenter: FitPoint; subjectCenter: FitPoint | null;
  headBBox: FitBBox | null; eyeLineY: number | null; eyeLineConfidence: 'high' | 'low';
  mouthLineY: number | null; mouthLineConfidence: 'high' | 'low'; bodyBBox: FitBBox | null;
  dominantPalette: string[]; darkOutlineRatio: number; warnings: string[];
}
interface CollectionFitIssue { code: string; severity: 'warn' | 'fail'; message: string; expected: string; actual: string; }
interface CollectionFitResult { score: number; verdict: 'pass' | 'warn' | 'fail'; metrics: CollectionFitMetrics; issues: CollectionFitIssue[]; }

interface RasterVariant {
  variantId: string; label: string; size: number; pngBase64: string; paletteSize: number;
  /** Stage 2 (deterministic cleanup) — see
   *  docs/pixel-forge-image-to-traits-pipeline-mvp.md. `cleanupApplied` is
   *  false for every Stage 1 variant regardless of whether cleanup was
   *  requested for this normalize call at all. */
  cleanupApplied: boolean;
  pixelsChanged: number;
  componentsRemoved: number;
  /** Stage 4 (deterministic repair) — see
   *  docs/pixel-forge-image-to-traits-pipeline-mvp.md and
   *  src/pixel-agent/raster-repair.ts. `repairApplied` is false for every
   *  non "-repair" variant regardless of whether repair was requested for
   *  this normalize call at all. `pixelsChanged`/`componentsRemoved` above
   *  are shared with Stage 2 — a variant is never both cleaned AND
   *  repaired, so reuse is unambiguous per variant (see the backend's own
   *  VariantChangeStats doc comment). */
  repairApplied: boolean;
  repairStrength: 'safe' | 'medium' | null;
  holesFilled: number;
  outlinePixelsAdjusted: number;
  warnings: string[];
}

// ── Image-to-Traits Stage 3 (Split preview) — see
// docs/pixel-forge-image-to-traits-pipeline-mvp.md and
// src/pixel-agent/raster-split.ts. Preview-only: this never creates a
// TraitAsset, it just proposes candidate layers for a human to eyeball.
type SplitLayerId = 'background' | 'hat_accessory' | 'body_hoodie' | 'head_fur' | 'face_mask' | 'eyes' | 'nose_mouth';
type SplitConfidence = 'high' | 'medium' | 'low';
type SplitMethod = 'color-mask' | 'component' | 'heuristic';
interface SplitBbox { x: number; y: number; w: number; h: number; }
interface SplitLayer {
  layerId: SplitLayerId; label: string; suggestedLayerType: LayerType;
  confidence: SplitConfidence; method: SplitMethod; pixelCount: number;
  bbox: SplitBbox; warnings: string[]; pngBase64: string;
}
interface SplitPreviewResult { layers: SplitLayer[]; composite: string; warnings: string[]; }
const SPLIT_CONFIDENCE_META: Record<SplitConfidence, { color: string }> = {
  high: { color: '#43b984' }, medium: { color: '#c7b479' }, low: { color: '#d96867' },
};

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
  invalid_direct_reference_image: 'Direct reference field is malformed.',
  direct_reference_requires_reference_image: 'Direct reference requires a reference image to be attached.',
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
  /** Which stored Collection (if any) this trait belongs to — id only.
   *  Null for every trait generated without one (today's status quo). */
  collectionId: string | null;
  /** Which DNA preset was actually resolved at generation time — see
   *  src/pixel-agent/collection-prompt-composer.ts. Null when no
   *  collection/preset was used. */
  collectionPresetId: string | null;
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
  background: 'linear-gradient(180deg, var(--vl-gray-surface) 0%, var(--vl-gray-surface) 100%)',
  border: '1px solid rgb(var(--vl-purple-tint) / 0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgb(var(--vl-purple-deep) / 0.10)',
  padding: 12,
  marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
  color: 'var(--vl-text-muted)', marginBottom: 6,
};
const MONO = "'SF Mono','Fira Code',monospace";
const FIELD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, fontFamily: MONO, borderRadius: 5,
  border: '1px solid rgb(var(--vl-purple-tint) / 0.40)',
  background: 'rgba(20,14,34,0.85)', color: 'var(--vl-text-primary)', outline: 'none',
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
      style={{ ...PIXELATED, width: size, height: size, borderRadius: 6, border: '1px solid rgb(var(--vl-purple-tint) / 0.30)', background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 16px 16px' }}
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
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-gold-primary)' }}>
          Missing features
        </span>
        <button
          type="button"
          onClick={copy}
          data-uisnd="skip"
          style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
            border: '1px solid rgb(var(--vl-gold) / 0.40)', background: 'rgb(var(--vl-gold) / 0.08)', color: 'var(--vl-gold-primary)',
          }}
        >Copy for revision</button>
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10.5, color: 'var(--vl-gold-primary)', lineHeight: 1.5 }}>
        {missingFeatures.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
    </div>
  );
}

function LegacyEvalBadges({ evaluation }: { evaluation: LegacyEvaluation | null | undefined }) {
  if (!evaluation) return <div style={{ fontSize: 11, color: 'var(--vl-text-muted)' }}>No evaluation data.</div>;
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
        <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginTop: 6 }}>{evaluation.notes}</div>
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
        {issue.regressed && <span style={{ color: 'var(--vl-red-primary)' }}> ⚠ REGRESSION</span>}
        {!!issue.attempts && issue.attempts > 0 && <span style={{ color: 'var(--vl-text-muted)', fontWeight: 400, textTransform: 'none' }}> — attempt #{issue.attempts + 1}</span>}
      </div>
      <div style={{ fontSize: 10.5, color: '#c8c8dc', marginTop: 1 }}>{issue.problem || '—'}</div>
      <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', marginTop: 1 }}>Fix: {issue.repairStrategy || '—'}</div>
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
          fontSize: 10.5, fontWeight: 600, color: evaluation.recognizableAsSubject ? 'var(--vl-green-primary)' : 'var(--vl-red-primary)',
        }}>
          {evaluation.recognizableAsSubject ? '✓ recognizable as the specific subject' : '✗ not recognizable as the specific subject'}
        </span>
      </div>
      {evaluation.blindDescription && (
        <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)', marginTop: 5, fontStyle: 'italic' }}>&ldquo;{evaluation.blindDescription}&rdquo;</div>
      )}
      {issues.length > 0 && (
        <div style={{ marginTop: 7 }}>
          {issues.map(i => <IssueRow key={i.id} issue={i} />)}
        </div>
      )}
      {Array.isArray(repairPlan?.deferred) && repairPlan!.deferred.length > 0 && (
        <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', marginTop: 2 }}>
          +{repairPlan!.deferred.length} lower-priority issue{repairPlan!.deferred.length === 1 ? '' : 's'} deferred to a later revision
        </div>
      )}
      {evaluation.notes && (
        <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginTop: 6 }}>{evaluation.notes}</div>
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

  // ── Collections (Stage 3 UI) — optional, never persisted to
  // localStorage (a stored Collection is server-side truth; re-selecting
  // one per session is cheap and avoids a stale/deleted id lingering in
  // the form). `selectedCollectionId` doubles as both "active collection"
  // (Collections panel) and "Use collection" (generation form) — one
  // shared value, two render sites, per the plan's "optional" UX.
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [collectionsBusy, setCollectionsBusy] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionPresetId, setNewCollectionPresetId] = useState<string>(COLLECTION_PRESET_OPTIONS[0]);
  const [newCollectionPaletteText, setNewCollectionPaletteText] = useState('');

  // ── Reference Mode MVP (docs/pixel-forge-reference-mode-mvp.md) ──────
  // Deliberately NOT part of PersistedForm/localStorage — a reference is
  // per-generation only, never reused, never saved. Fresh-draft form only,
  // no revision equivalent.
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceBase64, setReferenceBase64] = useState<string | null>(null);
  const [referenceMimeType, setReferenceMimeType] = useState<'image/png' | 'image/jpeg' | null>(null);
  const [referencePreviewUrl, setReferencePreviewUrl] = useState<string | null>(null);
  const [referenceRightsConfirmed, setReferenceRightsConfirmed] = useState(false);
  /** Direct Reference Mode, Option B (see
   *  docs/pixel-forge-direct-reference-mode-audit.md) — separate, optional
   *  consent on top of `referenceRightsConfirmed`: lets the drawing model
   *  see the actual reference image once (draft call only) instead of only
   *  the derived text guidance. Defaults off; only enabled when the rights
   *  checkbox is also checked (see the checkbox's `disabled` below). */
  const [directReferenceImageAllowed, setDirectReferenceImageAllowed] = useState(false);
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
    setDirectReferenceImageAllowed(false);
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

  // ── Image-to-Traits Stage 1 (Raster Import) — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md. Entirely separate
  // from the "Draw a new trait" flow's state above; `activeTab` switches
  // which panel is shown. Deliberately NOT part of PersistedForm — same
  // per-generation-only rationale as the reference-image upload state.
  const [activeTab, setActiveTab] = useState<'draw' | 'import'>(SHOW_LEGACY_UI ? 'draw' : 'import');
  const [rasterFile, setRasterFile] = useState<File | null>(null);
  const [rasterBase64, setRasterBase64] = useState<string | null>(null);
  const [rasterMimeType, setRasterMimeType] = useState<'image/png' | 'image/jpeg' | null>(null);
  const [rasterPreviewUrl, setRasterPreviewUrl] = useState<string | null>(null);
  const [rasterTargetSize, setRasterTargetSize] = useState<number>(48);
  // Stage 2 (deterministic cleanup) — default OFF: brand-new, purely
  // algorithmic pass (see docs/pixel-forge-image-to-traits-pipeline-mvp.md
  // and raster-convert.ts's cleanupRasterImage), tested against synthetic
  // cases and one real image — but this UI's whole point is comparing
  // variants side-by-side, so the safer default is to show the plain
  // Stage 1 variants first and let cleanup be an explicit, informed
  // opt-in rather than silently doubling what's shown by default.
  const [rasterCleanup, setRasterCleanup] = useState(false);
  const [rasterMinComponentSize, setRasterMinComponentSize] = useState(2);
  // Stage 4 (deterministic repair) — default OFF, same rationale as Stage
  // 2's cleanup checkbox above: a new algorithmic pass, and this UI's point
  // is side-by-side comparison, so repaired variants are an explicit,
  // informed opt-in rather than silently doubling what's shown by default.
  // Independent of `rasterCleanup` — both can be on at once, each produces
  // its own separate variant family (never chained together).
  const [rasterRepair, setRasterRepair] = useState(false);
  const [rasterRepairStrength, setRasterRepairStrength] = useState<'safe' | 'medium'>('safe');
  const [rasterError, setRasterError] = useState<string | null>(null);
  const [rasterBusy, setRasterBusy] = useState(false);
  const [rasterExperimentId, setRasterExperimentId] = useState<string | null>(null);
  const [rasterVariants, setRasterVariants] = useState<RasterVariant[]>([]);
  const [rasterSelectedVariantId, setRasterSelectedVariantId] = useState<string | null>(null);
  const [rasterName, setRasterName] = useState('');
  const [rasterLayerType, setRasterLayerType] = useState<LayerType>('icon');
  const [rasterTagsText, setRasterTagsText] = useState('');
  const [rasterNotes, setRasterNotes] = useState('');
  const [rasterImporting, setRasterImporting] = useState(false);
  const [rasterImportError, setRasterImportError] = useState<string | null>(null);
  const [rasterImportedTrait, setRasterImportedTrait] = useState<{ id: string; name: string } | null>(null);

  // ── Image-to-Traits Stage 3 (Split preview) — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md and
  // src/pixel-agent/raster-split.ts. Tied to whichever variant is currently
  // selected above; cleared whenever the selected variant or the whole
  // upload changes, since a stale split preview from a different variant
  // would be actively misleading sitting next to the wrong thumbnail.
  const [rasterSplitBusy, setRasterSplitBusy] = useState(false);
  const [rasterSplitError, setRasterSplitError] = useState<string | null>(null);
  const [rasterSplitResult, setRasterSplitResult] = useState<SplitPreviewResult | null>(null);

  // ── Image-to-Traits Stage 5 (Split import) — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md. Per-layerId checkbox
  // state, keyed by SplitLayerId; (re)initialized whenever a fresh split
  // result arrives (see previewSplit below) so it always matches the
  // layers actually on screen. Reuses the single-import section's own
  // NAME/TAGS/NOTES/collection fields as the base name/tags/notes for
  // every imported layer — same source image, no reason to duplicate
  // those inputs for a second, adjacent action.
  const [rasterSplitLayerSelection, setRasterSplitLayerSelection] = useState<Partial<Record<SplitLayerId, boolean>>>({});
  const [rasterImportSplitBusy, setRasterImportSplitBusy] = useState(false);
  const [rasterImportSplitError, setRasterImportSplitError] = useState<string | null>(null);
  const [rasterImportSplitResult, setRasterImportSplitResult] = useState<{ created: { id: string; name: string; layerId: SplitLayerId }[]; skippedCount: number } | null>(null);

  // ── Stage 9.2 (Trait Sheet import) — see
  // docs/pixel-forge-trait-sheet-stage9-design.md and
  // src/pixel-agent/trait-sheet.ts. Entirely separate upload from the
  // manual-upload/split state above — a trait sheet is a different KIND
  // of source image (a whole grid of layers, not one character). Reuses
  // `selectedCollectionId` (shared page state, same as every other import
  // panel) rather than its own collection picker. Never persisted.
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [sheetBase64, setSheetBase64] = useState<string | null>(null);
  const [sheetMimeType, setSheetMimeType] = useState<'image/png' | 'image/jpeg' | 'image/webp' | null>(null);
  const [sheetPreviewUrl, setSheetPreviewUrl] = useState<string | null>(null);
  const [sheetLayoutId, setSheetLayoutId] = useState<'2x4-layer-sheet' | '4x4-family-sheet'>('2x4-layer-sheet');
  const [sheetBaseName, setSheetBaseName] = useState('');
  const [sheetTagsText, setSheetTagsText] = useState('');
  const [sheetNotes, setSheetNotes] = useState('');
  const [sheetBackgroundMode, setSheetBackgroundMode] = useState<'keep' | 'remove' | 'key-color'>('keep');
  const [sheetKeyColorHex, setSheetKeyColorHex] = useState('#FF00FF');
  const [sheetRepair, setSheetRepair] = useState(false);
  const [sheetCellSelection, setSheetCellSelection] = useState<Record<string, boolean>>({});
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetImportResult, setSheetImportResult] = useState<{
    created: { id: string; name: string; cellId: string; layerType: LayerType; zIndex: number }[];
    skipped: { cellId: string; reason: string }[];
  } | null>(null);

  // Re-initializes the cell checkbox list whenever the layout changes —
  // real-layer cells default checked, non-layer cells (the 2x4 layout's
  // own 'preview' cell, or every 4x4-family-sheet cell) default
  // unchecked, mirroring the backend route's own default selection.
  useEffect(() => {
    const cells = TRAIT_SHEET_LAYOUT_CELLS[sheetLayoutId];
    const next: Record<string, boolean> = {};
    for (const c of cells) next[c.cellId] = c.layerType !== null;
    setSheetCellSelection(next);
  }, [sheetLayoutId]);

  const clearSheetUpload = () => {
    if (sheetPreviewUrl) URL.revokeObjectURL(sheetPreviewUrl);
    setSheetFile(null);
    setSheetBase64(null);
    setSheetMimeType(null);
    setSheetPreviewUrl(null);
    setSheetImportResult(null);
    setSheetError(null);
  };

  const onSheetFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    if (!SHEET_ALLOWED_MIME_TYPES.has(file.type)) {
      setSheetError('Image must be PNG, JPEG, or WebP.');
      return;
    }
    if (file.size > SHEET_MAX_BYTES) {
      setSheetError('Image is too large (max 10 MB).');
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      clearSheetUpload();
      setSheetFile(file);
      setSheetBase64(base64);
      setSheetMimeType(file.type as 'image/png' | 'image/jpeg' | 'image/webp');
      setSheetPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setSheetError((err as Error).message);
    }
  };

  const toggleSheetCell = (cellId: string) => {
    setSheetCellSelection(prev => ({ ...prev, [cellId]: !prev[cellId] }));
  };

  /** POST /raster/import-trait-sheet — crops the uploaded sheet, normalizes
   *  each checked cell to 48×48, and saves each as a candidate TraitAsset.
   *  No AI call, never auto-approves, never overwrites (see
   *  tools-pixel-forge-import-trait-sheet.ts). */
  const importTraitSheet = async () => {
    if (sheetBusy || !sheetBase64 || !sheetMimeType) return;
    if (sheetBackgroundMode === 'key-color' && !/^#[0-9a-fA-F]{6}$/.test(sheetKeyColorHex)) {
      setSheetError('Key color must be a 6-digit hex value, e.g. #FF00FF.');
      return;
    }
    playUiConfirm();
    setSheetBusy(true);
    setSheetError(null);
    setSheetImportResult(null);
    try {
      const selectedCellIds = Object.entries(sheetCellSelection).filter(([, checked]) => checked).map(([cellId]) => cellId);
      const tags = sheetTagsText.trim().length > 0
        ? sheetTagsText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/import-trait-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          imageBase64: sheetBase64, mimeType: sheetMimeType, layoutId: sheetLayoutId,
          selectedCellIds, baseName: sheetBaseName.trim() || undefined, tags, notes: sheetNotes.trim() || undefined,
          backgroundMode: sheetBackgroundMode,
          ...(sheetBackgroundMode === 'key-color' ? { keyColorHex: sheetKeyColorHex } : {}),
          repair: sheetRepair,
          ...(selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
        }),
      });
      if (r.status === 429) { setSheetError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{
        ok: boolean;
        created?: { id: string; name: string; cellId: string; layerType: LayerType; zIndex: number }[];
        skipped?: { cellId: string; reason: string }[];
        error?: string;
      }>(r);
      if (!r.ok || !body.ok || !body.created) {
        setSheetError(body.error ?? `Import failed — HTTP ${r.status}.`);
        return;
      }
      setSheetImportResult({ created: body.created, skipped: body.skipped ?? [] });
      void loadTraits();
    } catch (e) {
      setSheetError((e as Error).message);
    } finally {
      setSheetBusy(false);
    }
  };

  // ── Image-to-Traits Stage 6 (OpenAI Image Source) — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md. Entirely separate
  // from the manual-upload state above until "Use for Normalize" is
  // clicked, at which point its result is copied into the SAME
  // rasterBase64/rasterMimeType/rasterPreviewUrl state manual upload
  // already populates — see useGeneratedSourceForNormalize below. Never
  // persisted (localStorage or otherwise) — a reference image + prompt are
  // per-generation-only, same rationale as the old Reference Mode's own
  // upload state.
  const [genRefFile, setGenRefFile] = useState<File | null>(null);
  const [genRefBase64, setGenRefBase64] = useState<string | null>(null);
  const [genRefMimeType, setGenRefMimeType] = useState<'image/png' | 'image/jpeg' | 'image/webp' | null>(null);
  const [genRefPreviewUrl, setGenRefPreviewUrl] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState('');
  const [genRightsConfirmed, setGenRightsConfirmed] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // Stage 9.3 — staged trait-sheet validation (design doc's own A6
  // "cheapest test first" plan). 'single-image' is the pre-existing
  // default/only behavior; the sheet modes only change the prompt sent
  // server-side (openai-trait-sheet-prompts.ts) — everything downstream
  // of a successful generation (preview, "Use for Normalize") is
  // unchanged, and nothing auto-imports regardless of mode.
  const [genSourceMode, setGenSourceMode] = useState<GenSourceMode>('single-image');
  const [genResult, setGenResult] = useState<{
    sourceId: string; pngBase64: string; sourceMode: GenSourceMode;
    tokenUsage: { inputTokens: number; outputTokens: number } | null;
    estimatedCostUsd: number | null;
  } | null>(null);
  // Stage 9.4 — validation for the immediate post-generation preview
  // above (keyed implicitly to genResult.sourceId; reset whenever a new
  // generation starts). Deterministic, no AI call — see
  // src/pixel-agent/trait-sheet-validation.ts. Never auto-run, never
  // auto-imports.
  const [genValidateBusy, setGenValidateBusy] = useState(false);
  const [genValidateError, setGenValidateError] = useState<string | null>(null);
  const [genValidateResult, setGenValidateResult] = useState<TraitSheetValidationSummary | null>(null);

  // Generated Sources Library — separate from genResult above, which is
  // only the immediate post-generation preview. This is the persisted
  // list (survives refresh) fetched from
  // GET /raster/generated-sources — see tools-pixel-forge-generated-sources.ts.
  const [genSources, setGenSources] = useState<GeneratedSourceSummary[]>([]);
  const [genSourcesError, setGenSourcesError] = useState<string | null>(null);
  const [genSourcesBusyId, setGenSourcesBusyId] = useState<string | null>(null);
  // Stage 9.4 — per-card validation state, keyed by generatedSourceId.
  const [libraryValidateBusyId, setLibraryValidateBusyId] = useState<string | null>(null);
  const [libraryValidateResults, setLibraryValidateResults] = useState<Record<string, TraitSheetValidationSummary>>({});
  const [libraryValidateErrors, setLibraryValidateErrors] = useState<Record<string, string>>({});
  // Stage 10.5 — "Import Trait Family Sheet" state, keyed by
  // generatedSourceId, same pattern as the validate state above. Shared by
  // both the immediate genResult preview and a Generated Sources Library
  // card — see importTraitFamilySheet.
  const [familySheetImportBusyId, setFamilySheetImportBusyId] = useState<string | null>(null);
  const [familySheetImportResults, setFamilySheetImportResults] = useState<Record<string, {
    created: { id: string; name: string; cellId: string; layerType: LayerType; zIndex: number }[];
    skipped: { cellId: string; reason: string }[];
  }>>({});
  const [familySheetImportErrors, setFamilySheetImportErrors] = useState<Record<string, string>>({});

  // Stage 8 (Collection DNA Lock / Fit Check) — see
  // src/pixel-agent/collection-fit.ts. `collectionFitProfile` is the
  // reference DNA (built from one variant, never persisted server-side —
  // this state IS its only storage) and stays put across a variant
  // reselection; `collectionFitResult` is per-check and is cleared
  // whenever the selected variant changes (see selectRasterVariant),
  // since a stale result next to a different thumbnail would be
  // misleading. Advisory only — nothing here blocks import.
  const [collectionFitProfileName, setCollectionFitProfileName] = useState('');
  const [collectionFitProfile, setCollectionFitProfile] = useState<CollectionFitProfile | null>(null);
  const [collectionFitProfileBusy, setCollectionFitProfileBusy] = useState(false);
  const [collectionFitProfileError, setCollectionFitProfileError] = useState<string | null>(null);
  const [collectionFitResult, setCollectionFitResult] = useState<CollectionFitResult | null>(null);
  const [collectionFitCheckBusy, setCollectionFitCheckBusy] = useState(false);
  const [collectionFitCheckError, setCollectionFitCheckError] = useState<string | null>(null);

  const [filterLayerType, setFilterLayerType] = useState<LayerType | ''>('');
  const [filterStatus, setFilterStatus] = useState<TraitStatus | ''>('');
  const [approvedOnly, setApprovedOnly] = useState(false);

  const [validationPreviews, setValidationPreviews] = useState<ValidationPreviewItem[]>([]);
  const [validationPreviewsError, setValidationPreviewsError] = useState<string | null>(null);
  const [showValidationPreviews, setShowValidationPreviews] = useState(true);
  const [validationRunFilter, setValidationRunFilter] = useState('');

  // ── Layer Stack Preview (Stage 4.2, client-side only — see
  // docs/pixel-forge-layer-stack-compositor-mvp.md). Keyed by `layerType`,
  // one trait id per slot. A plain object (not a Map) so key insertion
  // order — which JS guarantees iterates in first-set order — doubles as
  // "which slot was picked first," exactly what `getStackCanvasSize`'s
  // "first selected" contract (layer-stack.ts) needs, with no extra
  // bookkeeping. Never persisted (localStorage or otherwise) — this is a
  // look-and-compare scratchpad, not saved state.
  const [stackSelection, setStackSelection] = useState<Record<string, string>>({});

  // Stage 9.2 — real backend PNG compose for the Layer Stack above (the
  // CSS `<img>` stack stays for the free, instant live preview while
  // picking slots; this is the actual downloadable export, computed
  // server-side via POST /raster/compose-traits — see
  // src/pixel-agent/trait-compositor.ts / docs/pixel-forge-trait-sheet-
  // stage9-design.md Part C4: "do not rely on CSS stacking for final
  // export." Never persisted, never auto-triggered — one explicit click.
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeResult, setComposeResult] = useState<{
    rawPngBase64: string | null; upscaled384PngBase64: string | null;
    layersUsed: { id: string; name: string; zIndex: number; layerType: LayerType }[];
    outputSize: number; scale: number;
  } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Layer Workflow MVP — lets the empty-state "suggested workflow" steps
  // (see the Layer Stack Preview panel below) jump straight to the
  // generation form with the right LAYER TYPE preset, instead of just
  // describing the steps as inert text.
  const drawFormRef = useRef<HTMLDivElement>(null);

  const loadTraits = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/traits`, { headers: { ...authHeaders() } });
      if (r.status === 401) { clearAuth(); setTraitsError(SESSION_EXPIRED_MESSAGE); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; traits?: TraitAssetSummary[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Failed to load traits.');
      setTraits(body.traits ?? []);
      setTraitsError(null);
    } catch (e) {
      setTraitsError((e as Error).message);
    }
  }, []);

  // ── Image-to-Traits Stage 1 (Raster Import) ─────────────────────────
  const clearRasterUpload = useCallback(() => {
    setRasterFile(null);
    setRasterBase64(null);
    setRasterMimeType(null);
    setRasterPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setRasterError(null);
    setRasterExperimentId(null);
    setRasterVariants([]);
    setRasterSelectedVariantId(null);
    setRasterImportError(null);
    setRasterImportedTrait(null);
    setRasterSplitBusy(false);
    setRasterSplitError(null);
    setRasterSplitResult(null);
    setRasterSplitLayerSelection({});
    setRasterImportSplitError(null);
    setRasterImportSplitResult(null);
  }, []);

  // ── Image-to-Traits Stage 6 (OpenAI Image Source) ───────────────────
  const clearGenRef = useCallback(() => {
    setGenRefFile(null);
    setGenRefBase64(null);
    setGenRefMimeType(null);
    setGenRefPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setGenRightsConfirmed(false);
    setGenError(null);
    setGenResult(null);
  }, []);

  const onGenRefFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    if (!GEN_REF_ALLOWED_MIME_TYPES.has(file.type)) {
      setGenError('Reference image must be PNG, JPEG, or WEBP.');
      return;
    }
    if (file.size > GEN_REF_MAX_BYTES) {
      setGenError('Reference image is too large (max 10 MB).');
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      clearGenRef();
      setGenRefFile(file);
      setGenRefBase64(base64);
      setGenRefMimeType(file.type as 'image/png' | 'image/jpeg' | 'image/webp');
      setGenRefPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setGenError((err as Error).message);
    }
  };

  /** POSTs the reference image + prompt to the Stage 6 OpenAI route.
   *  Preview-only on success — no TraitAsset created, no normalize/split
   *  call made here. The user must explicitly click "Use for Normalize"
   *  (below) to feed the result into the existing, unmodified pipeline. */
  const generateSource = async () => {
    if (genBusy || !genRefBase64 || !genRefMimeType || genPrompt.trim().length === 0 || !genRightsConfirmed) return;
    playUiConfirm();
    setGenBusy(true);
    setGenError(null);
    setGenResult(null);
    setGenValidateResult(null);
    setGenValidateError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/generate-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          referenceImageBase64: genRefBase64, referenceMimeType: genRefMimeType,
          prompt: genPrompt.trim(), referenceRightsConfirmed: true, sourceMode: genSourceMode,
        }),
      });
      if (r.status === 401) { clearAuth(); setGenError(SESSION_EXPIRED_MESSAGE); return; }
      if (r.status === 429) { setGenError('Rate limit hit — wait a moment and try again.'); return; }
      if (r.status === 503) { setGenError('OpenAI API key not configured on the backend.'); return; }
      const body = await parseJsonResponse<{
        ok: boolean; sourceId?: string; sourceMode?: GenSourceMode; pngBase64?: string;
        tokenUsage?: { inputTokens: number; outputTokens: number } | null;
        estimatedCostUsd?: number | null; error?: string;
      }>(r);
      if (!r.ok || !body.ok || !body.sourceId || !body.pngBase64) {
        setGenError(body.error ?? `Generate failed — HTTP ${r.status}.`);
        return;
      }
      setGenResult({
        sourceId: body.sourceId, pngBase64: body.pngBase64, sourceMode: body.sourceMode ?? genSourceMode,
        tokenUsage: body.tokenUsage ?? null, estimatedCostUsd: body.estimatedCostUsd ?? null,
      });
      void loadGeneratedSources();
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  /** Stage 9.4 — POSTs to the deterministic, no-AI validate-trait-sheet
   *  route. Never mutates anything, never imports, never auto-runs — the
   *  caller always triggers this from an explicit "Validate Sheet" click. */
  const runValidateTraitSheet = async (generatedSourceId: string, sourceMode: GenSourceMode): Promise<TraitSheetValidationSummary> => {
    const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/validate-trait-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ generatedSourceId, sourceMode }),
    });
    const body = await parseJsonResponse<{
      ok: boolean; verdict?: TraitSheetVerdict; score?: number; issues?: TraitSheetValidationIssue[];
      cellReports?: { cellId: string; issues: TraitSheetValidationIssue[] }[];
      recommendedNextStep?: TraitSheetRecommendedNextStep; error?: string;
    }>(r);
    if (!r.ok || !body.ok || body.verdict === undefined || body.score === undefined || body.recommendedNextStep === undefined) {
      throw new Error(body.error ?? `Validate failed — HTTP ${r.status}.`);
    }
    return { verdict: body.verdict, score: body.score, issues: body.issues ?? [], cellReports: body.cellReports ?? [], recommendedNextStep: body.recommendedNextStep };
  };

  const validateGenResult = async () => {
    if (!genResult || genValidateBusy) return;
    playUiConfirm();
    setGenValidateBusy(true);
    setGenValidateError(null);
    try {
      setGenValidateResult(await runValidateTraitSheet(genResult.sourceId, genResult.sourceMode));
    } catch (e) {
      setGenValidateError((e as Error).message);
    } finally {
      setGenValidateBusy(false);
    }
  };

  /** Shared render for a TraitSheetValidationSummary — verdict badge,
   *  score, top 3 issues, recommended next step. Used by both the
   *  Generate Source panel's immediate result and each Generated Sources
   *  Library card (Stage 9.4). Pure display — never triggers a
   *  re-validate or any mutation itself. */
  const renderValidationSummary = (result: TraitSheetValidationSummary) => (
    <div style={{ marginTop: 6, padding: 8, borderRadius: 5, border: `1px solid ${VERDICT_COLOR[result.verdict]}55`, background: `${VERDICT_COLOR[result.verdict]}0f` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, fontWeight: 700, color: VERDICT_COLOR[result.verdict] }}>
        <span>{result.verdict.toUpperCase()}</span>
        <span style={{ color: 'var(--vl-text-muted)', fontWeight: 400 }}>score {result.score}/100</span>
      </div>
      {result.issues.length + result.cellReports.reduce((n, c) => n + c.issues.length, 0) > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 9, color: 'var(--vl-text-muted)', lineHeight: 1.5 }}>
          {[...result.issues, ...result.cellReports.flatMap(c => c.issues)].slice(0, 3).map((issue, i) => (
            <li key={i} style={{ color: issue.severity === 'fail' ? 'var(--vl-red-primary)' : 'var(--vl-text-muted)' }}>{issue.message}</li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 6, fontSize: 9.5, color: '#c8c8dc' }}>
        Next: <strong>{RECOMMENDED_NEXT_STEP_LABEL[result.recommendedNextStep]}</strong>
      </div>
    </div>
  );

  const validateLibrarySource = async (source: GeneratedSourceSummary) => {
    if (libraryValidateBusyId) return;
    playUiConfirm();
    setLibraryValidateBusyId(source.id);
    setLibraryValidateErrors(prev => { const next = { ...prev }; delete next[source.id]; return next; });
    try {
      const result = await runValidateTraitSheet(source.id, source.sourceMode);
      setLibraryValidateResults(prev => ({ ...prev, [source.id]: result }));
    } catch (e) {
      setLibraryValidateErrors(prev => ({ ...prev, [source.id]: (e as Error).message }));
    } finally {
      setLibraryValidateBusyId(null);
    }
  };

  /** The one bridge into the existing, unmodified pipeline: copies the
   *  generated PNG into the exact same state the manual-upload dropzone
   *  populates, then everything downstream (target size, cleanup/repair,
   *  Normalize, variant grid, Preview Split, Import Selected Split Layers)
   *  runs completely unchanged — zero new code in any of it. A data: URL
   *  (not an object URL) is used for the preview since there's no real
   *  File object here; clearRasterUpload's unconditional
   *  URL.revokeObjectURL call is a harmless no-op on a data: URL. */
  const useGeneratedSourceForNormalize = useCallback(() => {
    if (!genResult) return;
    clearRasterUpload();
    setRasterBase64(genResult.pngBase64);
    setRasterMimeType('image/png');
    setRasterPreviewUrl(`data:image/png;base64,${genResult.pngBase64}`);
    setRasterName(`generated-${genResult.sourceId.slice(0, 8)}`);
  }, [genResult, clearRasterUpload]);

  /** Library list cards only carry a thumbnail (see GeneratedSourceSummary
   *  doc comment) — fetches the full-size source PNG via GET :id first.
   *  Returns null (and sets genSourcesError) on failure. */
  const fetchGeneratedSourceFull = async (id: string): Promise<string | null> => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/generated-sources/${id}`, { headers: { ...authHeaders() } });
      const body = await parseJsonResponse<{ ok: boolean; pngBase64?: string; error?: string }>(r);
      if (!r.ok || !body.ok || !body.pngBase64) {
        setGenSourcesError(body.error ?? `Fetch failed — HTTP ${r.status}.`);
        return null;
      }
      return body.pngBase64;
    } catch (e) {
      setGenSourcesError((e as Error).message);
      return null;
    }
  };

  /** Same bridge as useGeneratedSourceForNormalize above, reused for a
   *  library card instead of the immediate post-generation preview — same
   *  target state, same "nothing downstream runs automatically" contract. */
  const useLibrarySourceForNormalize = async (source: GeneratedSourceSummary) => {
    setGenSourcesBusyId(source.id);
    try {
      const pngBase64 = await fetchGeneratedSourceFull(source.id);
      if (!pngBase64) return;
      clearRasterUpload();
      setRasterBase64(pngBase64);
      setRasterMimeType('image/png');
      setRasterPreviewUrl(`data:image/png;base64,${pngBase64}`);
      setRasterName(`generated-${source.id.slice(0, 8)}`);
    } finally {
      setGenSourcesBusyId(null);
    }
  };

  /** Stage 10.5 — "Import Trait Family Sheet": POSTs the full-size sheet
   *  PNG straight to the existing, unmodified /raster/import-trait-sheet
   *  route with layoutId='trait-family-sheet-10x8' and no selectedCellIds
   *  — the backend's own default selection already imports every cell
   *  with a real suggestedLayerType, which is all 80 for this layout (see
   *  tools-pixel-forge-import-trait-sheet.ts). backgroundMode is 'keep'
   *  since the sheet is generated with background=transparent already
   *  (Stage 10.1's own API params). No Normalize/Split detour — unlike
   *  useGeneratedSourceForNormalize/useLibrarySourceForNormalize above,
   *  this never touches rasterBase64/the manual-upload state at all.
   *  Never auto-approves (every created trait lands as `candidate`, same
   *  as any other import), never overwrites (saveTraitAsset always
   *  mints a fresh id). Keyed by `sourceId` so the same busy/result/error
   *  state serves both the immediate genResult preview and a Generated
   *  Sources Library card. */
  const importTraitFamilySheet = async (sourceId: string, pngBase64: string) => {
    if (familySheetImportBusyId) return;
    playUiConfirm();
    setFamilySheetImportBusyId(sourceId);
    setFamilySheetImportErrors(prev => { const next = { ...prev }; delete next[sourceId]; return next; });
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/import-trait-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          imageBase64: pngBase64, mimeType: 'image/png', layoutId: 'trait-family-sheet-10x8',
          baseName: `trait-family-${sourceId.slice(0, 8)}`, backgroundMode: 'keep',
          ...(selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
        }),
      });
      if (r.status === 429) {
        setFamilySheetImportErrors(prev => ({ ...prev, [sourceId]: 'Rate limit hit — wait a moment and try again.' }));
        return;
      }
      const body = await parseJsonResponse<{
        ok: boolean;
        created?: { id: string; name: string; cellId: string; layerType: LayerType; zIndex: number }[];
        skipped?: { cellId: string; reason: string }[];
        error?: string;
      }>(r);
      if (!r.ok || !body.ok || !body.created) {
        setFamilySheetImportErrors(prev => ({ ...prev, [sourceId]: body.error ?? `Import failed — HTTP ${r.status}.` }));
        return;
      }
      setFamilySheetImportResults(prev => ({ ...prev, [sourceId]: { created: body.created as NonNullable<typeof body.created>, skipped: body.skipped ?? [] } }));
      void loadTraits();
    } catch (e) {
      setFamilySheetImportErrors(prev => ({ ...prev, [sourceId]: (e as Error).message }));
    } finally {
      setFamilySheetImportBusyId(null);
    }
  };

  const downloadLibrarySource = async (source: GeneratedSourceSummary) => {
    setGenSourcesBusyId(source.id);
    try {
      const pngBase64 = await fetchGeneratedSourceFull(source.id);
      if (!pngBase64) return;
      downloadBlob(`generated-${source.id.slice(0, 8)}.png`, Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0)), 'image/png');
    } finally {
      setGenSourcesBusyId(null);
    }
  };

  const deleteLibrarySource = async (source: GeneratedSourceSummary) => {
    setGenSourcesBusyId(source.id);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/generated-sources/${source.id}`, {
        method: 'DELETE', headers: { ...authHeaders() },
      });
      const body = await parseJsonResponse<{ ok: boolean; error?: string }>(r);
      if (!r.ok || !body.ok) {
        setGenSourcesError(body.error ?? `Delete failed — HTTP ${r.status}.`);
        return;
      }
      setGenSources(prev => prev.filter(s => s.id !== source.id));
    } catch (e) {
      setGenSourcesError((e as Error).message);
    } finally {
      setGenSourcesBusyId(null);
    }
  };

  /** Selecting a different variant invalidates any split preview computed
   *  against the previously-selected one — clearing it here (rather than
   *  only on next Preview Split click) avoids a stale layer breakdown
   *  sitting next to a now-different thumbnail. */
  const selectRasterVariant = useCallback((variantId: string) => {
    setRasterSelectedVariantId(variantId);
    setRasterSplitError(null);
    setRasterSplitResult(null);
    setRasterSplitLayerSelection({});
    setRasterImportSplitError(null);
    setRasterImportSplitResult(null);
    // collectionFitProfile is NOT cleared here — it's the reference DNA,
    // meant to be checked against whichever variant is selected next.
    setCollectionFitResult(null);
    setCollectionFitCheckError(null);
  }, []);

  /** POST /collection-fit/profile-from-variant — builds a CollectionFitProfile
   *  from the currently-selected variant's own metrics. Never mutates a
   *  TraitAsset; the profile lives only in `collectionFitProfile` state
   *  until the user runs "Check collection fit" against it. */
  const createCollectionFitProfile = async () => {
    if (collectionFitProfileBusy || !rasterExperimentId || !rasterSelectedVariantId) return;
    playUiConfirm();
    setCollectionFitProfileBusy(true);
    setCollectionFitProfileError(null);
    try {
      const name = collectionFitProfileName.trim() || `profile-${rasterSelectedVariantId}`;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/collection-fit/profile-from-variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ experimentId: rasterExperimentId, variantId: rasterSelectedVariantId, name }),
      });
      if (r.status === 429) { setCollectionFitProfileError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{ ok: boolean; profile?: CollectionFitProfile; error?: string }>(r);
      if (!r.ok || !body.ok || !body.profile) {
        setCollectionFitProfileError(body.error ?? `Profile creation failed — HTTP ${r.status}.`);
        return;
      }
      setCollectionFitProfile(body.profile);
      setCollectionFitResult(null);
    } catch (e) {
      setCollectionFitProfileError((e as Error).message);
    } finally {
      setCollectionFitProfileBusy(false);
    }
  };

  /** POST /collection-fit/check — scores the currently-selected variant
   *  against `collectionFitProfile`. Advisory only: this never blocks or
   *  auto-rejects the import flow, it just displays a score/verdict/
   *  issues list for a human to act on. */
  const checkCollectionFitForSelectedVariant = async () => {
    if (collectionFitCheckBusy || !rasterExperimentId || !rasterSelectedVariantId || !collectionFitProfile) return;
    playUiConfirm();
    setCollectionFitCheckBusy(true);
    setCollectionFitCheckError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/collection-fit/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ experimentId: rasterExperimentId, variantId: rasterSelectedVariantId, profile: collectionFitProfile }),
      });
      if (r.status === 429) { setCollectionFitCheckError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{
        ok: boolean; score?: number; verdict?: 'pass' | 'warn' | 'fail';
        metrics?: CollectionFitMetrics; issues?: CollectionFitIssue[]; error?: string;
      }>(r);
      if (!r.ok || !body.ok || body.score === undefined || !body.verdict || !body.metrics || !body.issues) {
        setCollectionFitCheckError(body.error ?? `Fit check failed — HTTP ${r.status}.`);
        return;
      }
      setCollectionFitResult({ score: body.score, verdict: body.verdict, metrics: body.metrics, issues: body.issues });
    } catch (e) {
      setCollectionFitCheckError((e as Error).message);
    } finally {
      setCollectionFitCheckBusy(false);
    }
  };

  const onRasterFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    if (!RASTER_ALLOWED_MIME_TYPES.has(file.type)) {
      setRasterError('Image must be PNG or JPEG.');
      return;
    }
    if (file.size > RASTER_MAX_BYTES) {
      setRasterError('Image is too large (max 10 MB).');
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      clearRasterUpload();
      setRasterFile(file);
      setRasterBase64(base64);
      setRasterMimeType(file.type as 'image/png' | 'image/jpeg');
      setRasterPreviewUrl(URL.createObjectURL(file));
      setRasterName(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setRasterError((err as Error).message);
    }
  };

  const normalizeRaster = async () => {
    if (rasterBusy || !rasterBase64 || !rasterMimeType) return;
    playUiConfirm();
    setRasterBusy(true);
    setRasterError(null);
    setRasterVariants([]);
    setRasterSelectedVariantId(null);
    setRasterImportedTrait(null);
    setRasterSplitError(null);
    setRasterSplitResult(null);
    setRasterSplitLayerSelection({});
    setRasterImportSplitError(null);
    setRasterImportSplitResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/normalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          imageBase64: rasterBase64, mimeType: rasterMimeType, targetSize: rasterTargetSize,
          ...(rasterCleanup ? { cleanup: true, minComponentSize: rasterMinComponentSize } : {}),
          ...(rasterRepair ? { repair: true, repairStrength: rasterRepairStrength } : {}),
        }),
      });
      if (r.status === 401) { clearAuth(); setRasterError(SESSION_EXPIRED_MESSAGE); return; }
      if (r.status === 429) { setRasterError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{ ok: boolean; experimentId?: string; variants?: RasterVariant[]; error?: string }>(r);
      if (!r.ok || !body.ok || !body.experimentId || !body.variants) {
        setRasterError(body.error ?? `Normalize failed — HTTP ${r.status}.`);
        return;
      }
      setRasterExperimentId(body.experimentId);
      setRasterVariants(body.variants);
      setRasterSelectedVariantId(body.variants[0]?.variantId ?? null);
    } catch (e) {
      setRasterError((e as Error).message);
    } finally {
      setRasterBusy(false);
    }
  };

  // ── Image-to-Traits Stage 7 (48x48 -> 384x384 upscaled export) — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md and
  // src/pixel-agent/raster-upscale.ts. "Download 48x48" needs no backend
  // call at all — a variant's own `pngBase64` already IS the raw grid.
  // "Download 384x384" calls the new export route (the server is the
  // single source of truth for the upscale, same as every other pixel
  // operation in this pipeline) and downloads the result client-side.
  const downloadVariantRaw = (variant: RasterVariant) => {
    downloadBlob(`${variant.variantId}-48x48.png`, Uint8Array.from(atob(variant.pngBase64), c => c.charCodeAt(0)), 'image/png');
  };

  const downloadVariantUpscaled = async (variantId: string) => {
    if (!rasterExperimentId) return;
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/export-upscaled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ experimentId: rasterExperimentId, variantId }),
      });
      const body = await parseJsonResponse<{ ok: boolean; upscaledPngBase64?: string; error?: string }>(r);
      if (!r.ok || !body.ok || !body.upscaledPngBase64) {
        setRasterError(body.error ?? `Export failed — HTTP ${r.status}.`);
        return;
      }
      downloadBlob(`${variantId}-384x384.png`, Uint8Array.from(atob(body.upscaledPngBase64), c => c.charCodeAt(0)), 'image/png');
    } catch (e) {
      setRasterError((e as Error).message);
    }
  };

  const importRasterVariant = async () => {
    const trimmedName = rasterName.trim();
    if (rasterImporting || !rasterExperimentId || !rasterSelectedVariantId || trimmedName.length === 0) return;
    playUiConfirm();
    setRasterImporting(true);
    setRasterImportError(null);
    try {
      const tags = rasterTagsText.trim().length > 0
        ? rasterTagsText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          experimentId: rasterExperimentId, variantId: rasterSelectedVariantId,
          name: trimmedName, layerType: rasterLayerType, tags, notes: rasterNotes.trim() || undefined,
          ...(selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
        }),
      });
      if (r.status === 401) { clearAuth(); setRasterImportError(SESSION_EXPIRED_MESSAGE); return; }
      const body = await parseJsonResponse<{ ok: boolean; trait?: { id: string; name: string }; error?: string }>(r);
      if (!r.ok || !body.ok || !body.trait) {
        setRasterImportError(body.error ?? `Import failed — HTTP ${r.status}.`);
        return;
      }
      setRasterImportedTrait({ id: body.trait.id, name: body.trait.name });
      void loadTraits();
    } catch (e) {
      setRasterImportError((e as Error).message);
    } finally {
      setRasterImporting(false);
    }
  };

  // ── Image-to-Traits Stage 3 (Split preview) — preview only, never calls
  // saveTraitAsset; see docs/pixel-forge-image-to-traits-pipeline-mvp.md
  // and src/pixel-agent/raster-split.ts for the deterministic heuristic
  // this renders the output of.
  const previewSplit = async () => {
    if (rasterSplitBusy || !rasterExperimentId || !rasterSelectedVariantId) return;
    playUiConfirm();
    setRasterSplitBusy(true);
    setRasterSplitError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ experimentId: rasterExperimentId, variantId: rasterSelectedVariantId }),
      });
      if (r.status === 401) { clearAuth(); setRasterSplitError(SESSION_EXPIRED_MESSAGE); return; }
      if (r.status === 429) { setRasterSplitError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{ ok: boolean; layers?: SplitLayer[]; composite?: string; warnings?: string[]; error?: string }>(r);
      if (!r.ok || !body.ok || !body.layers || !body.composite) {
        setRasterSplitError(body.error ?? `Split preview failed — HTTP ${r.status}.`);
        return;
      }
      setRasterSplitResult({ layers: body.layers, composite: body.composite, warnings: body.warnings ?? [] });
      // Default selection: high/medium confidence layers with actual
      // content checked, low confidence (and empty) layers unchecked —
      // matches the backend's own default when selectedLayerIds is omitted.
      const defaultSelection: Partial<Record<SplitLayerId, boolean>> = {};
      for (const layer of body.layers) {
        defaultSelection[layer.layerId] = layer.pixelCount > 0 && (layer.confidence === 'high' || layer.confidence === 'medium');
      }
      setRasterSplitLayerSelection(defaultSelection);
      setRasterImportSplitError(null);
      setRasterImportSplitResult(null);
    } catch (e) {
      setRasterSplitError((e as Error).message);
    } finally {
      setRasterSplitBusy(false);
    }
  };

  // ── Image-to-Traits Stage 5 (Split import) — turns SELECTED split
  // layers into real candidate TraitAssets. Reuses this tab's own
  // NAME/TAGS/NOTES fields (rasterName/rasterTagsText/rasterNotes) and the
  // shared collection selector, same as the single-variant import above.
  const importSelectedSplitLayers = async () => {
    const selectedLayerIds = (Object.keys(rasterSplitLayerSelection) as SplitLayerId[]).filter(id => rasterSplitLayerSelection[id]);
    if (rasterImportSplitBusy || !rasterExperimentId || !rasterSelectedVariantId || selectedLayerIds.length === 0) return;
    playUiConfirm();
    setRasterImportSplitBusy(true);
    setRasterImportSplitError(null);
    try {
      const tags = rasterTagsText.trim().length > 0
        ? rasterTagsText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/import-split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          experimentId: rasterExperimentId, variantId: rasterSelectedVariantId, selectedLayerIds,
          baseName: rasterName.trim() || undefined, tags, notes: rasterNotes.trim() || undefined,
          ...(selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
        }),
      });
      if (r.status === 429) { setRasterImportSplitError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{
        ok: boolean; created?: { id: string; name: string; layerId: SplitLayerId }[];
        skipped?: { layerId: SplitLayerId; reason: string }[]; error?: string;
      }>(r);
      if (!r.ok || !body.ok || !body.created) {
        setRasterImportSplitError(body.error ?? `Import failed — HTTP ${r.status}.`);
        return;
      }
      setRasterImportSplitResult({ created: body.created, skippedCount: body.skipped?.length ?? 0 });
      void loadTraits();
    } catch (e) {
      setRasterImportSplitError((e as Error).message);
    } finally {
      setRasterImportSplitBusy(false);
    }
  };

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

  const loadCollections = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/collections`, { headers: { ...authHeaders() } });
      if (r.status === 401) { clearAuth(); setCollectionsError(SESSION_EXPIRED_MESSAGE); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; collections?: Collection[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Failed to load collections.');
      setCollections(body.collections ?? []);
      setCollectionsError(null);
    } catch (e) {
      setCollectionsError((e as Error).message);
    }
  }, []);

  /** GET /raster/generated-sources — list summaries (thumbnail-sized
   *  pngBase64, not the full source) from
   *  data/pixel-forge/generated-sources/. Read-only, no OpenAI call. */
  const loadGeneratedSources = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/generated-sources`, { headers: { ...authHeaders() } });
      if (r.status === 401) { clearAuth(); setGenSourcesError(SESSION_EXPIRED_MESSAGE); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { ok: boolean; sources?: GeneratedSourceSummary[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Failed to load generated sources.');
      setGenSources(body.sources ?? []);
      setGenSourcesError(null);
    } catch (e) {
      setGenSourcesError((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadTraits(); }, [loadTraits]);
  useEffect(() => { void loadValidationPreviews(); }, [loadValidationPreviews]);
  useEffect(() => { void loadCollections(); }, [loadCollections]);
  useEffect(() => { void loadGeneratedSources(); }, [loadGeneratedSources]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollJob = (id: string) => {
    // Claude drawing/revision generation has been removed — GET
    // /jobs/:id no longer exists server-side. Already unreachable in
    // practice (generate/reviseTrait both return before ever calling
    // pollJob — see their own guards above), but guarded explicitly too so
    // this function can never start a polling interval regardless of
    // caller.
    if (GENERATION_REMOVED) return;
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

  // Layer Workflow MVP — presets LAYER TYPE and scrolls to the generation
  // form. Used by the Layer Stack Preview's empty-state suggested
  // workflow steps ("1. Generate Body" etc.) so the layer-first mental
  // model has a one-click on-ramp instead of just descriptive text.
  const jumpToLayerType = useCallback((lt: LayerType) => {
    setLayerType(lt);
    drawFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const createCollection = async () => {
    const trimmedName = newCollectionName.trim();
    if (!trimmedName || collectionsBusy) return;
    playUiConfirm();
    setCollectionsBusy(true);
    setCollectionsError(null);
    try {
      const paletteOverride = newCollectionPaletteText.trim().length > 0
        ? newCollectionPaletteText.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: trimmedName, presetId: newCollectionPresetId, paletteOverride }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Create failed — HTTP ${r.status}.`);
      }
      const body = await r.json() as { ok: boolean; collection?: Collection; error?: string };
      if (!body.ok || !body.collection) throw new Error(body.error ?? 'Create failed.');
      setCollections(prev => [body.collection as Collection, ...prev]);
      setSelectedCollectionId(body.collection.id);
      setNewCollectionName('');
      setNewCollectionPaletteText('');
    } catch (e) {
      setCollectionsError((e as Error).message);
    } finally {
      setCollectionsBusy(false);
    }
  };

  const generate = async () => {
    // Claude drawing generation has been removed — POST /jobs no longer
    // exists server-side. Unconditional guard, same rationale as
    // reviseTrait's own guard below: the button is already disabled, this
    // just makes it impossible for the fetch to fire regardless of caller.
    if (GENERATION_REMOVED) { setJobError(GENERATION_REMOVED_NOTICE); return; }
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
          ...(selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
          ...(usingReference ? {
            referenceImage: { base64: referenceBase64, mimeType: referenceMimeType },
            referenceRightsConfirmed: true,
            ...(directReferenceImageAllowed ? { directReferenceImage: true } : {}),
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
    // Claude revision has been removed — POST /traits/:id/revise no longer
    // exists server-side (see the file header comment). This guard makes
    // the removal unconditional: even if some future code path calls
    // reviseTrait directly (bypassing the disabled UI below), the fetch
    // below can never fire.
    if (REVISION_REMOVED) { setJobError(REVISION_REMOVED_NOTICE); return; }
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
    // Claude drawing/revision generation has been removed — POST
    // /jobs/:id/stop no longer exists server-side, and `jobId` can no
    // longer ever be set (generate/reviseTrait both return before calling
    // setJobId — see their own guards above), so `if (!jobId) return`
    // already made this unreachable in practice. Explicit guard added
    // anyway so that invariant doesn't have to be traced through to be
    // trusted.
    if (GENERATION_REMOVED || !jobId) return;
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

  // "Download 48x48" — no backend call needed, `t.pngBase64` already IS
  // the raw stored grid. "Download 384x384" (below) calls the Stage 7
  // export-upscaled route — see src/pixel-agent/raster-upscale.ts.
  const downloadPng = (t: TraitAssetSummary) => {
    downloadBlob(`${t.slug}-48x48.png`, Uint8Array.from(atob(t.pngBase64), c => c.charCodeAt(0)), 'image/png');
  };

  const downloadTraitUpscaled = async (t: TraitAssetSummary) => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/export-upscaled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ traitId: t.id }),
      });
      const body = await parseJsonResponse<{ ok: boolean; upscaledPngBase64?: string; error?: string }>(r);
      if (!r.ok || !body.ok || !body.upscaledPngBase64) {
        setTraitsError(body.error ?? `Export failed — HTTP ${r.status}.`);
        return;
      }
      downloadBlob(`${t.slug}-384x384.png`, Uint8Array.from(atob(body.upscaledPngBase64), c => c.charCodeAt(0)), 'image/png');
    } catch (e) {
      setTraitsError((e as Error).message);
    }
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

  const selectedCollection = useMemo(
    () => collections.find(c => c.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  );
  const collectionNameById = useMemo(() => {
    const m = new Map<string, string>();
    collections.forEach(c => m.set(c.id, c.name));
    return m;
  }, [collections]);

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

  // ── Layer Stack Preview derived state (Stage 4.2) — pure functions from
  // layer-stack.ts over data already loaded above; no new fetch. `traits`
  // already excludes validation previews structurally (that's a wholly
  // separate array, `validationPreviews`, never merged in), and
  // `groupTraitsForStack` further keeps only `approved` traits, so neither
  // needs to be filtered again here.
  const traitById = useMemo(() => {
    const m = new Map<string, TraitAssetSummary>();
    traits.forEach(t => m.set(t.id, t));
    return m;
  }, [traits]);
  const stackGroups = useMemo(
    () => groupTraitsForStack(traits, selectedCollectionId || null),
    [traits, selectedCollectionId],
  );
  // Switching the active collection invalidates any in-progress stack —
  // slots reference trait ids that may not even belong to the newly
  // selected collection's group list anymore, so start clean rather than
  // silently mixing traits across collections.
  useEffect(() => { setStackSelection({}); }, [selectedCollectionId]);
  // A composed result is only valid for the exact stack it was computed
  // from — any slot change invalidates it rather than leaving a stale
  // composite sitting next to a now-different stack.
  useEffect(() => { setComposeResult(null); setComposeError(null); }, [stackSelection]);
  const setStackSlot = useCallback((slotLayerType: string, traitId: string) => {
    setStackSelection(prev => {
      if (traitId === '') {
        if (!(slotLayerType in prev)) return prev;
        const next = { ...prev };
        delete next[slotLayerType];
        return next;
      }
      return { ...prev, [slotLayerType]: traitId };
    });
  }, []);
  // Order here is slot-fill order (object key insertion order), not
  // zIndex or group order — `getStackCanvasSize` below relies on that to
  // mean "whichever slot was picked first."
  const selectedStackTraits = useMemo(() => {
    const out: TraitAssetSummary[] = [];
    for (const traitId of Object.values(stackSelection)) {
      const t = traitById.get(traitId);
      if (t) out.push(t);
    }
    return out;
  }, [stackSelection, traitById]);
  const stackCanvasSize = getStackCanvasSize(selectedStackTraits);
  const sortedStackTraits = useMemo(
    () => sortSelectedLayersForPreview(selectedStackTraits),
    [selectedStackTraits],
  );
  // `missing-core-layer` is reported honestly by detectStackWarnings even
  // for an empty selection (see layer-stack.ts's own docstring) — that's
  // correct for the pure function, but showing 3 red warnings before the
  // user has picked anything reads as broken, not helpful. Gate that one
  // warning behind "at least one slot filled"; every other warning type
  // stays exactly as reported.
  const stackWarnings = useMemo(() => {
    const all = detectStackWarnings(selectedStackTraits);
    return selectedStackTraits.length === 0 ? all.filter(w => w.code !== 'missing-core-layer') : all;
  }, [selectedStackTraits]);

  /** POST /raster/compose-traits — the real, backend-composited PNG for
   *  whatever's currently in the Layer Stack. No mutation, no TraitAsset
   *  creation, no AI call. */
  const composeSelectedStack = async () => {
    if (composeBusy || selectedStackTraits.length === 0) return;
    playUiConfirm();
    setComposeBusy(true);
    setComposeError(null);
    setComposeResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/pixel-forge/raster/compose-traits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ traitIds: selectedStackTraits.map(t => t.id), includeRaw: true, includeUpscaled384: true }),
      });
      if (r.status === 429) { setComposeError('Rate limit hit — wait a moment and try again.'); return; }
      const body = await parseJsonResponse<{
        ok: boolean; rawPngBase64?: string; upscaled384PngBase64?: string;
        layersUsed?: { id: string; name: string; zIndex: number; layerType: LayerType }[];
        outputSize?: number; scale?: number; error?: string;
      }>(r);
      if (!r.ok || !body.ok || !body.layersUsed || body.outputSize === undefined || body.scale === undefined) {
        setComposeError(body.error ?? `Compose failed — HTTP ${r.status}.`);
        return;
      }
      setComposeResult({
        rawPngBase64: body.rawPngBase64 ?? null, upscaled384PngBase64: body.upscaled384PngBase64 ?? null,
        layersUsed: body.layersUsed, outputSize: body.outputSize, scale: body.scale,
      });
    } catch (e) {
      setComposeError((e as Error).message);
    } finally {
      setComposeBusy(false);
    }
  };

  const downloadComposedRaw = () => {
    if (!composeResult?.rawPngBase64) return;
    downloadBlob(`layer-stack-${composeResult.outputSize}x${composeResult.outputSize}.png`, Uint8Array.from(atob(composeResult.rawPngBase64), c => c.charCodeAt(0)), 'image/png');
  };
  const downloadComposedUpscaled = () => {
    if (!composeResult?.upscaled384PngBase64) return;
    const size = composeResult.outputSize * composeResult.scale;
    downloadBlob(`layer-stack-${size}x${size}.png`, Uint8Array.from(atob(composeResult.upscaled384PngBase64), c => c.charCodeAt(0)), 'image/png');
  };

  const latestPreview = iterations.length > 0 ? iterations[iterations.length - 1].pngBase64 : null;
  // Claude drawing generation has been removed — see
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md. The backend routes
  // this tab called (POST /jobs, /traits/:id/revise, /jobs/:id/stop,
  // GET /jobs/:id) no longer exist. Left in place, disabled, rather than
  // torn out, to keep this a minimal change — see GENERATION_REMOVED_NOTICE
  // below for the user-facing explanation. Use the Import Image tab
  // (upload → Normalize → Cleanup/Repair → Split → Import Split Layers)
  // instead.
  const GENERATION_REMOVED = true;
  const GENERATION_REMOVED_NOTICE = 'Claude drawing generation has been removed. Use the Import Image tab instead.';
  const generateDisabled = GENERATION_REMOVED || busy || prompt.trim().length === 0 || !layerType
    || (referenceFile !== null && !referenceRightsConfirmed);
  // Same removal, applied to the Trait Library's Revise affordance (its
  // backend route, POST /traits/:id/revise, is also gone) — see the same
  // docs/pixel-forge-image-to-traits-pipeline-mvp.md note above.
  const REVISION_REMOVED = true;
  const REVISION_REMOVED_NOTICE = 'Claude revision has been removed. Use Import Image workflow instead.';

  // ── "Add to Layer Stack" (Layer Workflow MVP) — one-click bridge from a
  // just-generated result straight into the Layer Stack Preview panel
  // below. No backend work: it reuses the existing PATCH .../traits/:id
  // approve path (same as the "Approve" button) and the existing
  // `setStackSlot` from the Compositor MVP — it does not add any new
  // network call. `groupTraitsForStack` (layer-stack.ts) only ever offers
  // `approved` traits, so pre-selecting a still-`candidate` result would
  // silently not show up as a real option in its own slot's dropdown;
  // approving first (only if not already approved) keeps this button's
  // behavior consistent with that existing contract rather than adding a
  // second, looser one.
  const resultTrait = result ? traitById.get(result.variantId) ?? null : null;
  const resultAlreadyInStack = resultTrait !== null && stackSelection[resultTrait.layerType] === resultTrait.id;
  const addResultToLayerStack = () => {
    if (!result || !resultTrait) return;
    playUiConfirm();
    if (resultTrait.status !== 'approved') void patchTraitMeta(result.variantId, { status: 'approved' });
    setStackSlot(resultTrait.layerType, resultTrait.id);
  };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
            PIXEL FORGE
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
            <LiveDot />
            <span>trait-library builder — OpenAI generates reusable trait sheets; a compositor assembles the collection itself</span>
          </div>

          {/* Collections (Stage 3 UI) — optional; picking one here also
              becomes the "Use collection" value in the generation form
              below (shared state, see selectedCollectionId). */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Collections (optional)</div>
            {collectionsError && <div style={{ fontSize: 11, color: 'var(--vl-red-primary)', marginBottom: 8 }}>{collectionsError}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, maxHeight: 150, overflowY: 'auto' }} className="scroll-area">
              {!collectionsError && collections.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--vl-text-muted)' }}>No collections yet — create one below, or generate with none selected.</div>
              ) : collections.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCollectionId(prev => (prev === c.id ? '' : c.id))}
                  data-uisnd="skip"
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                    padding: '5px 8px', fontSize: 10.5, borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                    fontFamily: MONO, color: 'var(--vl-text-primary)',
                    border: selectedCollectionId === c.id ? '1px solid rgb(var(--vl-purple-tint) / 0.65)' : '1px solid rgb(var(--vl-purple-tint) / 0.22)',
                    background: selectedCollectionId === c.id ? 'rgb(var(--vl-purple-tint) / 0.14)' : 'rgb(var(--vl-purple-tint) / 0.03)',
                  }}
                >
                  <span>{selectedCollectionId === c.id ? '✓ ' : ''}{c.name}</span>
                  <span style={{ color: 'var(--vl-text-muted)' }}>
                    {c.presetId}{c.paletteOverride && c.paletteOverride.length > 0 ? ' · custom palette' : ''}
                  </span>
                </button>
              ))}
            </div>
            {selectedCollection && (
              <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)', marginBottom: 10, fontFamily: MONO }}>
                Active: <span style={{ color: 'var(--vl-text-primary)', fontWeight: 700 }}>{selectedCollection.name}</span>
                {' · id '}<span style={{ color: '#c8c8dc' }}>{selectedCollection.id}</span>
                {' · preset '}<span style={{ color: '#c8c8dc' }}>{selectedCollection.presetId}</span>
                {selectedCollection.paletteOverride && selectedCollection.paletteOverride.length > 0 && (
                  <> {' · palette override '}<span style={{ color: '#c8c8dc' }}>{selectedCollection.paletteOverride.join(', ')}</span></>
                )}
              </div>
            )}
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
              Create new
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 180 }}>
                NAME
                <input
                  type="text" value={newCollectionName} disabled={collectionsBusy}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="e.g. SMB Animals v1"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                PRESET
                <select
                  value={newCollectionPresetId} disabled={collectionsBusy}
                  onChange={(e) => setNewCollectionPresetId(e.target.value)}
                  style={FIELD}
                >
                  {COLLECTION_PRESET_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 200 }}>
                PALETTE OVERRIDE (optional, hex comma-separated)
                <input
                  type="text" value={newCollectionPaletteText} disabled={collectionsBusy}
                  onChange={(e) => setNewCollectionPaletteText(e.target.value)}
                  placeholder="blank = use preset's own palette"
                  style={FIELD}
                />
              </label>
              <button
                type="button"
                onClick={createCollection}
                disabled={collectionsBusy || !newCollectionName.trim()}
                data-uisnd="skip"
                style={{
                  padding: '7px 16px', fontSize: 11, fontWeight: 700, letterSpacing: '0.4px',
                  textTransform: 'uppercase', borderRadius: 5,
                  cursor: (collectionsBusy || !newCollectionName.trim()) ? 'not-allowed' : 'pointer',
                  border: '1px solid rgba(126,217,168,0.45)',
                  background: (collectionsBusy || !newCollectionName.trim()) ? 'rgba(126,217,168,0.06)' : 'rgba(126,217,168,0.12)',
                  color: 'var(--vl-green-primary)',
                }}
              >{collectionsBusy ? 'Creating…' : 'Create'}</button>
            </div>
          </div>

          {/* Tab switcher — Draw (Claude) vs. Import Image (Stage 1 raster
              pipeline, see docs/pixel-forge-image-to-traits-pipeline-mvp.md).
              Deliberately separate flows; this is the only thing that
              decides which one renders below. Stage 10.1: hidden entirely
              when SHOW_LEGACY_UI is false — Draw is superseded, so this
              becomes a single linear flow with no switcher to show. */}
          {SHOW_LEGACY_UI && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setActiveTab('draw')}
              data-uisnd="skip"
              style={{
                padding: '6px 14px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.3px',
                textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                border: activeTab === 'draw' ? '1px solid rgb(var(--vl-purple-tint) / 0.65)' : '1px solid rgb(var(--vl-purple-tint) / 0.22)',
                background: activeTab === 'draw' ? 'rgb(var(--vl-purple-tint) / 0.14)' : 'rgb(var(--vl-purple-tint) / 0.03)',
                color: activeTab === 'draw' ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)',
              }}
            >Draw a new trait</button>
            <button
              type="button"
              onClick={() => setActiveTab('import')}
              data-uisnd="skip"
              style={{
                padding: '6px 14px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.3px',
                textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                border: activeTab === 'import' ? '1px solid rgb(var(--vl-purple-tint) / 0.65)' : '1px solid rgb(var(--vl-purple-tint) / 0.22)',
                background: activeTab === 'import' ? 'rgb(var(--vl-purple-tint) / 0.14)' : 'rgb(var(--vl-purple-tint) / 0.03)',
                color: activeTab === 'import' ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)',
              }}
            >Import Image</button>
          </div>
          )}

          {SHOW_LEGACY_UI && activeTab === 'draw' && (
          <>
          {/* Controls */}
          <div style={PANEL} ref={drawFormRef}>
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                CANVAS
                <select value={canvasSize} onChange={(e) => setCanvasSize(Number(e.target.value))} disabled={busy} style={FIELD}>
                  {CANVAS_SIZES.map(n => <option key={n} value={n}>{n}×{n}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                MAX TURNS
                <select value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} disabled={busy} style={FIELD}>
                  {MAX_TURNS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', minWidth: 200 }}>
                USE COLLECTION (optional)
                <select
                  value={selectedCollectionId}
                  onChange={(e) => setSelectedCollectionId(e.target.value)}
                  disabled={busy}
                  style={FIELD}
                >
                  <option value="">none</option>
                  {collections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.presetId})</option>)}
                </select>
              </label>
            </div>

            {/* Layer-first workflow guidance (Layer Workflow MVP) — UI hint
                only, reactive to the current LAYER TYPE selection. Does not
                change what's sent to the backend or any system prompt. */}
            {layerType && LAYER_TYPE_GUIDANCE[layerType] && (
              <div style={{
                marginTop: 8, fontSize: 11, color: '#c8c8dc', whiteSpace: 'pre-line', lineHeight: 1.5,
                padding: '6px 9px', borderRadius: 4,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.22)', background: 'rgb(var(--vl-purple-tint) / 0.05)',
              }}>
                <span style={{ fontWeight: 700, color: 'var(--vl-purple-tint)' }}>{LAYER_TYPE_LABELS[layerType] ?? layerType} layer: </span>
                {LAYER_TYPE_GUIDANCE[layerType]}
              </div>
            )}
            {selectedCollection && (
              <div style={{
                marginTop: 8, fontSize: 11, color: 'var(--vl-purple-tint)', padding: '5px 9px', borderRadius: 4,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.28)', background: 'rgb(var(--vl-purple-tint) / 0.06)',
              }}>
                This trait will inherit Collection DNA from <strong>{selectedCollection.name}</strong>.
              </div>
            )}
            {referencePreviewUrl && (
              <div style={{
                marginTop: 8, fontSize: 11, color: 'var(--vl-purple-tint)', padding: '5px 9px', borderRadius: 4,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.28)', background: 'rgb(var(--vl-purple-tint) / 0.06)',
              }}>
                Reference image will be used as style guidance.
              </div>
            )}

            {quality === 'premium' && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--vl-gold-primary)' }}>
                Uses the most expensive model. Use only for hard traits or final polish.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 220 }}>
                ANCHOR / ALIGNMENT HINT (optional — keeps traits of the same layer consistent)
                <input
                  type="text" value={anchor} disabled={busy}
                  onChange={(e) => setAnchor(e.target.value)}
                  placeholder="e.g. head center at x=16, y=15"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 220 }}>
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
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: '1px solid rgb(var(--vl-purple-tint) / 0.22)', background: 'rgb(var(--vl-purple-tint) / 0.04)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)', marginBottom: 6 }}>
                STYLE REFERENCE (optional, image)
              </div>
              <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
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
                        style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 5, border: '1px solid rgb(var(--vl-purple-tint) / 0.35)' }}
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
                          border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: 'var(--vl-red-primary)',
                        }}
                      >×</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5, color: 'var(--vl-text-muted)', paddingTop: 2 }}>
                      <span style={{ color: 'var(--vl-green-primary)', fontWeight: 700 }}>reference loaded</span>
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
                    style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}
                  />
                )}
                {referenceFile && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#c8c8dc', maxWidth: 380 }}>
                    <input
                      type="checkbox"
                      checked={referenceRightsConfirmed}
                      disabled={busy}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setReferenceRightsConfirmed(checked);
                        if (!checked) setDirectReferenceImageAllowed(false);
                      }}
                    />
                    I have the right to use this image as a style reference.
                  </label>
                )}
                {referenceFile && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#c8c8dc', maxWidth: 380 }}>
                    <input
                      type="checkbox"
                      checked={directReferenceImageAllowed}
                      disabled={busy || !referenceRightsConfirmed}
                      onChange={(e) => setDirectReferenceImageAllowed(e.target.checked)}
                    />
                    Allow drawing model to view this reference image once for stronger style guidance.
                  </label>
                )}
              </div>
              {referenceError && (
                <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginTop: 6 }}>{referenceError}</div>
              )}
              {referenceFile && !referenceRightsConfirmed && (
                <div style={{ fontSize: 10, color: 'var(--vl-gold-primary)', marginTop: 6 }}>
                  Confirm the checkbox above to enable Generate with this reference attached.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 220 }}>
                NAME (optional — blank = auto from prompt)
                <input
                  type="text" value={name} disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Red Heart Icon"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 220 }}>
                TAGS (optional, comma-separated)
                <input
                  type="text" value={tagsText} disabled={busy}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="e.g. winter, rare, blue"
                  style={FIELD}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 220 }}>
                NOTES (optional)
                <input
                  type="text" value={notes} disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="your own notes about this trait"
                  style={FIELD}
                />
              </label>
            </div>
            <div style={{
              marginTop: 12, fontSize: 11, color: 'var(--vl-gold-primary)', padding: '8px 10px', borderRadius: 5,
              border: '1px solid rgb(var(--vl-gold) / 0.35)', background: 'rgb(var(--vl-gold) / 0.08)',
            }}>
              {GENERATION_REMOVED_NOTICE}
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
                  border: '1px solid rgb(var(--vl-purple-tint) / 0.55)',
                  background: generateDisabled ? 'rgb(var(--vl-purple-deep) / 0.15)' : 'linear-gradient(180deg, rgb(var(--vl-purple-deep) / 0.28) 0%, rgb(var(--vl-purple-deep) / 0.14) 100%)',
                  color: generateDisabled ? 'var(--vl-text-muted)' : 'var(--vl-text-primary)',
                  boxShadow: generateDisabled ? 'none' : '0 0 12px rgb(var(--vl-purple-deep) / 0.18)',
                  transition: 'all 0.15s',
                }}
              >
                {busy && !revisingTraitId ? 'Drawing…' : 'Generate'}
              </button>
              {/* Already unreachable (busy can no longer become true — see
                  generate/reviseTrait's own guards), but gated explicitly
                  on !GENERATION_REMOVED too so that's self-evident here
                  rather than something a reader has to trace through. */}
              {!GENERATION_REMOVED && busy && (
                <button
                  type="button"
                  onClick={stopJob}
                  data-uisnd="skip"
                  style={{
                    padding: '7px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.5px',
                    textTransform: 'uppercase', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(217,124,124,0.55)', background: 'rgba(217,104,104,0.14)', color: 'var(--vl-red-primary)',
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
                  color: 'var(--vl-text-muted)', marginLeft: 'auto',
                }}
              >Reset form</button>
            </div>
          </div>

          {jobError && (
            <div style={{
              padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
              background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)',
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
                    <LiveDot color="var(--vl-purple-tint)" />
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
                        <span style={{ color: 'var(--vl-purple-tint)', fontWeight: 700 }}>{it.phase}{it.phase === 'refine' ? ` #${it.turn}` : ''}</span>
                        <span style={{ color: 'var(--vl-text-muted)' }}> — {it.note}</span>
                      </div>
                    ))}
                    {busy && <div style={{ color: 'var(--vl-text-muted)' }}>waiting for next turn…</div>}
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
                            border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                          }}
                        >Approve</button>
                        <button
                          type="button"
                          onClick={() => setTraitStatus(result.variantId, 'rejected')}
                          data-uisnd="skip"
                          style={{
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid rgba(217,124,124,0.45)', background: 'rgba(217,104,104,0.10)', color: 'var(--vl-red-primary)',
                          }}
                        >Reject</button>
                        <button
                          type="button"
                          onClick={addResultToLayerStack}
                          disabled={!resultTrait || resultAlreadyInStack}
                          data-uisnd="skip"
                          title={!resultTrait
                            ? 'Syncing trait library…'
                            : 'Approves this trait (if needed) and pre-selects it in the Layer Stack Preview below'}
                          style={{
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                            cursor: (!resultTrait || resultAlreadyInStack) ? 'default' : 'pointer',
                            border: '1px solid rgb(var(--vl-purple-tint) / 0.45)',
                            background: resultAlreadyInStack ? 'rgb(var(--vl-purple-tint) / 0.04)' : 'rgb(var(--vl-purple-tint) / 0.10)',
                            color: resultAlreadyInStack ? 'var(--vl-text-muted)' : 'var(--vl-purple-tint)',
                            opacity: !resultTrait ? 0.6 : 1,
                          }}
                        >{resultAlreadyInStack ? '✓ In Layer Stack' : 'Add to Layer Stack'}</button>
                        {!revisingTraitId && (
                          <button
                            type="button"
                            onClick={discardResult}
                            data-uisnd="skip"
                            style={{
                              padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                              border: '1px solid rgba(122,122,148,0.35)', background: 'rgba(122,122,148,0.08)', color: 'var(--vl-text-muted)',
                            }}
                          >Delete</button>
                        )}
                        <span style={{ fontSize: 10.5, color: 'var(--vl-text-muted)', fontFamily: MONO }}>
                          {usageLine(result.tokenUsage, result.estimatedCostUsd)}
                        </span>
                      </div>
                      {result.referenceGuidanceNote && (
                        <div style={{
                          marginTop: 8, fontSize: 10, color: 'var(--vl-text-muted)', padding: '5px 8px', borderRadius: 4,
                          border: '1px solid rgb(var(--vl-purple-tint) / 0.22)', background: 'rgb(var(--vl-purple-tint) / 0.04)',
                        }}>
                          <span style={{ fontWeight: 700, color: 'var(--vl-purple-tint)' }}>Reference guidance used: </span>
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
          </>
          )}

          {activeTab === 'import' && (
          <>
          {/* Image-to-Traits Stage 6 — OpenAI Image Source (optional,
              additive). Reference image + prompt -> gpt-image-1 edit call
              -> generated PNG -> "Use for Normalize" feeds it into the
              EXACT same rasterBase64/rasterMimeType state the manual
              upload below already populates. See
              docs/pixel-forge-image-to-traits-pipeline-mvp.md. No
              auto-normalize, no auto-split, no auto-import — every step
              past this panel still requires its own explicit click. */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Generate Source (OpenAI)</div>
            <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              Upload a reference NFT image and describe the change — OpenAI generates a new full source
              image from it (not a redraw from a blank canvas). The result is preview-only until you click
              &ldquo;Use for Normalize&rdquo;; nothing is imported automatically. This spends real OpenAI
              credits per click — Manual upload below stays free and needs no reference image.
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
              {genRefPreviewUrl ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ position: 'relative' }}>
                    <img
                      src={genRefPreviewUrl}
                      alt="reference"
                      style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 5, border: '1px solid rgb(var(--vl-purple-tint) / 0.35)' }}
                    />
                    <button
                      type="button"
                      onClick={clearGenRef}
                      disabled={genBusy}
                      data-uisnd="skip"
                      title="Remove reference image"
                      style={{
                        position: 'absolute', top: -6, right: -6, width: 18, height: 18, lineHeight: '16px',
                        borderRadius: '50%', fontSize: 11, fontWeight: 700, cursor: genBusy ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: 'var(--vl-red-primary)',
                      }}
                    >×</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5, color: 'var(--vl-text-muted)', paddingTop: 2 }}>
                    <span style={{ color: 'var(--vl-green-primary)', fontWeight: 700 }}>reference loaded</span>
                    {genRefFile && <span>{referenceMimeTypeLabel(genRefFile.type)}</span>}
                  </div>
                </div>
              ) : (
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={genBusy}
                  onChange={(e) => { void onGenRefFileChange(e); }}
                  style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}
                />
              )}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 280 }}>
                PROMPT
                <textarea
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value.slice(0, GEN_PROMPT_MAX_LEN))}
                  disabled={genBusy}
                  placeholder={GEN_PROMPT_PLACEHOLDER}
                  rows={3}
                  style={{ ...FIELD, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                />
              </label>
              {/* Stage 10.5 — the mode selector is back, but
                  GEN_SOURCE_MODE_OPTIONS now only offers the two
                  Stage-10-safe choices (Single Image / Trait Family Sheet
                  10×8) — the old 2/4/8-cell modes are never re-exposed
                  here (see project memory
                  project_pixel_forge_stage10_pivot), even though the
                  backend and GenSourceMode type still accept them. */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', minWidth: 220 }}>
                MODE
                <select
                  value={genSourceMode}
                  onChange={(e) => setGenSourceMode(e.target.value as GenSourceMode)}
                  disabled={genBusy}
                  style={FIELD}
                >
                  {GEN_SOURCE_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: 9.5, color: 'var(--vl-text-muted)', maxWidth: 220 }}>
                Reference image is style-only — subject/identity are not copied.
              </div>
            </div>
            {genSourceMode === 'trait-family-sheet-10x8' && (
              <div style={{
                fontSize: 10, color: 'var(--vl-purple-tint)', lineHeight: 1.4, marginBottom: 10,
                padding: '6px 10px', borderRadius: 5, border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgb(var(--vl-purple-tint) / 0.08)',
              }}>
                Generates 80 reusable traits: 8 rows × 10 columns. One transparent PNG sheet — no full character,
                no preview cell. Each row is one trait category (hats, hoodies/bodies, eyes, mouths/noses, face
                masks/fur markings, accessories, head/fur variants, backgrounds/misc).
              </div>
            )}
            <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', lineHeight: 1.4, marginTop: -6, marginBottom: 10 }}>
              Describe the change — don&rsquo;t ask for an exact copy. A fixed instruction is also appended
              server-side asking for a transformation, not a reproduction.
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 10.5, color: 'var(--vl-text-muted)', marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={genRightsConfirmed}
                disabled={genBusy || !genRefBase64}
                onChange={(e) => setGenRightsConfirmed(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              I have rights to use this reference image.
            </label>
            <button
              type="button"
              onClick={() => { void generateSource(); }}
              disabled={genBusy || !genRefBase64 || genPrompt.trim().length === 0 || !genRightsConfirmed}
              data-uisnd="skip"
              style={{
                padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                cursor: (genBusy || !genRefBase64 || genPrompt.trim().length === 0 || !genRightsConfirmed) ? 'not-allowed' : 'pointer',
                border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                opacity: (genBusy || !genRefBase64 || genPrompt.trim().length === 0 || !genRightsConfirmed) ? 0.6 : 1,
              }}
            >{genBusy ? 'Generating…' : 'Generate'}</button>
            {genError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginTop: 10 }}>{genError}</div>}
            {genResult && (
              <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <PixelImg src={`data:image/png;base64,${genResult.pngBase64}`} size={112} alt="generated source" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--vl-green-primary)', fontWeight: 700 }}>✓ Generated</span>
                  {genResult.estimatedCostUsd != null && (
                    <span style={{ fontSize: 9.5, color: 'var(--vl-text-muted)' }}>~${genResult.estimatedCostUsd.toFixed(4)}
                      {genResult.tokenUsage && ` · ${genResult.tokenUsage.inputTokens.toLocaleString()} in / ${genResult.tokenUsage.outputTokens.toLocaleString()} out`}
                    </span>
                  )}
                  <span style={{ fontSize: 9, color: 'var(--vl-text-muted)' }}>Not a trait yet — preview only until normalized/imported.</span>
                  {/* Stage 10.5 — next action for a freshly generated
                      10×8 sheet: import all 80 cells directly, no
                      Normalize/Split detour (unlike the manual-upload
                      path below). Keyed by sourceId so busy/result/error
                      state is shared with the identical action on a
                      Generated Sources Library card (see
                      importTraitFamilySheet). */}
                  {genResult.sourceMode === 'trait-family-sheet-10x8' && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ fontSize: 9.5, color: 'var(--vl-purple-tint)', fontWeight: 700 }}>Import this as Trait Family Sheet.</span>
                      <div>
                        <button
                          type="button"
                          onClick={() => { void importTraitFamilySheet(genResult.sourceId, genResult.pngBase64); }}
                          disabled={familySheetImportBusyId === genResult.sourceId}
                          data-uisnd="skip"
                          style={{
                            marginTop: 4, padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                            cursor: familySheetImportBusyId === genResult.sourceId ? 'not-allowed' : 'pointer',
                            opacity: familySheetImportBusyId === genResult.sourceId ? 0.6 : 1,
                            border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                          }}
                        >{familySheetImportBusyId === genResult.sourceId ? 'Importing…' : 'Import Trait Family Sheet (80 cells)'}</button>
                      </div>
                      {familySheetImportErrors[genResult.sourceId] && (
                        <div style={{ fontSize: 9.5, color: 'var(--vl-red-primary)', marginTop: 4 }}>{familySheetImportErrors[genResult.sourceId]}</div>
                      )}
                      {familySheetImportResults[genResult.sourceId] && (
                        <div style={{ fontSize: 9.5, color: '#7ed9a8', marginTop: 4 }}>
                          ✓ Imported {familySheetImportResults[genResult.sourceId].created.length} trait{familySheetImportResults[genResult.sourceId].created.length === 1 ? '' : 's'}
                          {familySheetImportResults[genResult.sourceId].skipped.length > 0 && ` (${familySheetImportResults[genResult.sourceId].skipped.length} skipped)`} — see the Trait library below.
                        </div>
                      )}
                    </div>
                  )}
                  {SHOW_LEGACY_UI && genResult.sourceMode === 'trait-sheet-8-cell' && (
                    <span style={{ fontSize: 9, color: '#d9a867' }}>Use this image in Import Trait Sheet → 2×4 Layer Sheet.</span>
                  )}
                  {SHOW_LEGACY_UI && (genResult.sourceMode === 'trait-sheet-2-cell' || genResult.sourceMode === 'trait-sheet-4-cell') && (
                    <span style={{ fontSize: 9, color: '#d9a867' }}>For validation only; crop/import support may be manual or later.</span>
                  )}
                  {SHOW_LEGACY_UI && genResult.sourceMode !== 'single-image' && (
                    <div>
                      <button
                        type="button"
                        onClick={() => { void validateGenResult(); }}
                        disabled={genValidateBusy}
                        data-uisnd="skip"
                        style={{
                          marginTop: 4, padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                          cursor: genValidateBusy ? 'not-allowed' : 'pointer', opacity: genValidateBusy ? 0.6 : 1,
                          border: '1px solid rgba(217,168,103,0.45)', background: 'rgba(217,168,103,0.10)', color: '#d9a867',
                        }}
                      >{genValidateBusy ? 'Validating…' : 'Validate Sheet'}</button>
                      {genValidateError && <div style={{ fontSize: 9.5, color: 'var(--vl-red-primary)', marginTop: 4 }}>{genValidateError}</div>}
                      {genValidateResult && renderValidationSummary(genValidateResult)}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={useGeneratedSourceForNormalize}
                    data-uisnd="skip"
                    style={{
                      marginTop: 4, padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                      border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                      alignSelf: 'flex-start',
                    }}
                  >Use for Normalize</button>
                </div>
              </div>
            )}
          </div>

          {/* Generated Sources Library — read-only view over the storage
              Stage 6 already writes on every successful generation (see
              tools-pixel-forge-generated-sources.ts). Lets a previously
              generated OpenAI image survive a page refresh and be reused
              via "Use for Normalize" without paying OpenAI again. Purely
              additive: no auto-normalize/split/import, manual upload below
              is untouched. */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Generated Sources</div>
            <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              Every OpenAI generation above is saved here — reuse a past one for free instead of generating again.
            </div>
            {genSourcesError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginBottom: 10 }}>{genSourcesError}</div>}
            {!genSourcesError && genSources.length === 0 ? (
              <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}>No generated sources yet.</div>
            ) : (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {genSources.map(s => {
                  const busy = genSourcesBusyId === s.id;
                  const validateBusy = libraryValidateBusyId === s.id;
                  const validateResult = libraryValidateResults[s.id];
                  const validateError = libraryValidateErrors[s.id];
                  return (
                    <div key={s.id} style={{
                      display: 'flex', flexDirection: 'column', gap: 4, padding: 8, width: s.sourceMode !== 'single-image' ? 220 : 132,
                      borderRadius: 6, border: '1px solid rgb(var(--vl-purple-tint) / 0.22)', background: 'rgb(var(--vl-purple-tint) / 0.03)',
                    }}>
                      <PixelImg src={`data:image/png;base64,${s.pngBase64}`} size={112} alt={s.prompt} />
                      <span style={{ fontSize: 9, color: 'var(--vl-text-muted)' }}>{new Date(s.createdAt).toLocaleString()}</span>
                      <span style={{ fontSize: 9, color: '#c8c8dc', maxHeight: 28, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.prompt}>
                        {s.prompt}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--vl-text-muted)' }}>
                        {s.model} · {s.size} · {s.quality}
                        {s.estimatedCostUsd != null && ` · ~$${s.estimatedCostUsd.toFixed(4)}`}
                      </span>
                      {s.sourceMode !== 'single-image' && (
                        <span style={{ fontSize: 9, color: '#d9a867' }}>{GEN_SOURCE_MODE_OPTIONS.find(o => o.value === s.sourceMode)?.label ?? s.sourceMode}</span>
                      )}
                      {/* Stage 10.5 — same "Import Trait Family Sheet"
                          action as the immediate genResult preview above,
                          reused for any already-generated 10×8 sheet
                          still sitting in this library. Fetches the
                          full-size PNG first (this card only holds a
                          thumbnail — see GeneratedSourceSummary's own doc
                          comment), same as useLibrarySourceForNormalize. */}
                      {s.sourceMode === 'trait-family-sheet-10x8' && (
                        <div>
                          <button
                            type="button"
                            onClick={() => { void (async () => {
                              const full = await fetchGeneratedSourceFull(s.id);
                              if (full) await importTraitFamilySheet(s.id, full);
                            })(); }}
                            disabled={familySheetImportBusyId === s.id}
                            data-uisnd="skip"
                            style={{
                              width: '100%', padding: '4px 8px', fontSize: 9.5, fontWeight: 700, borderRadius: 4,
                              cursor: familySheetImportBusyId === s.id ? 'not-allowed' : 'pointer',
                              opacity: familySheetImportBusyId === s.id ? 0.6 : 1,
                              border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                            }}
                          >{familySheetImportBusyId === s.id ? 'Importing…' : 'Import Trait Family Sheet'}</button>
                          {familySheetImportErrors[s.id] && (
                            <div style={{ fontSize: 9, color: 'var(--vl-red-primary)', marginTop: 4 }}>{familySheetImportErrors[s.id]}</div>
                          )}
                          {familySheetImportResults[s.id] && (
                            <div style={{ fontSize: 9, color: '#7ed9a8', marginTop: 4 }}>
                              ✓ {familySheetImportResults[s.id].created.length} created
                              {familySheetImportResults[s.id].skipped.length > 0 && `, ${familySheetImportResults[s.id].skipped.length} skipped`}
                            </div>
                          )}
                        </div>
                      )}
                      {SHOW_LEGACY_UI && s.sourceMode !== 'single-image' && (
                        <div>
                          <button
                            type="button"
                            onClick={() => { void validateLibrarySource(s); }}
                            disabled={validateBusy}
                            data-uisnd="skip"
                            style={{
                              width: '100%', padding: '4px 8px', fontSize: 9.5, fontWeight: 700, borderRadius: 4,
                              cursor: validateBusy ? 'not-allowed' : 'pointer', opacity: validateBusy ? 0.6 : 1,
                              border: '1px solid rgba(217,168,103,0.45)', background: 'rgba(217,168,103,0.10)', color: '#d9a867',
                            }}
                          >{validateBusy ? 'Validating…' : 'Validate Sheet'}</button>
                          {validateError && <div style={{ fontSize: 9, color: 'var(--vl-red-primary)', marginTop: 4 }}>{validateError}</div>}
                          {validateResult && renderValidationSummary(validateResult)}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => { void useLibrarySourceForNormalize(s); }}
                        disabled={busy}
                        data-uisnd="skip"
                        style={{
                          padding: '4px 8px', fontSize: 9.5, fontWeight: 700, borderRadius: 4,
                          cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
                          border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                        }}
                      >Use for Normalize</button>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          onClick={() => { void downloadLibrarySource(s); }}
                          disabled={busy}
                          data-uisnd="skip"
                          style={{
                            flex: 1, padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 4,
                            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
                            border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                          }}
                        >PNG</button>
                        <button
                          type="button"
                          onClick={() => { if (window.confirm('Delete this generated source? This cannot be undone.')) void deleteLibrarySource(s); }}
                          disabled={busy}
                          data-uisnd="skip"
                          style={{
                            flex: 1, padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 4,
                            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
                            border: '1px solid rgba(217,124,124,0.40)', background: 'rgba(217,124,124,0.06)', color: 'var(--vl-red-primary)',
                          }}
                        >Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Stage 9.2 — Trait Sheet import. See
              docs/pixel-forge-trait-sheet-stage9-design.md and
              src/pixel-agent/trait-sheet.ts. Entirely independent of the
              Normalize/Split workflow below — a trait sheet is cropped
              directly into per-cell candidate TraitAssets in one call, no
              variant grid, no separate split-preview step. No AI call;
              this panel's own upload can be any already-generated image
              (e.g. a trait sheet produced elsewhere), not just an OpenAI
              Generated Source. Stage 10.1: hidden — this crop tool targets
              the old 2x4/4x4 layouts being superseded by the Stage 10
              Trait Family Sheet importer. */}
          {SHOW_LEGACY_UI && (
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Import Trait Sheet</div>
            <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              Upload one image containing a fixed grid of separate layers (or whole-character
              thumbnails) — purely algorithmic (crop + resize + background removal), no AI call. Each
              checked cell is cropped, normalized to 48×48, and imported as its own candidate trait.
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
              {sheetPreviewUrl ? (
                <div style={{ position: 'relative' }}>
                  <img
                    src={sheetPreviewUrl}
                    alt="trait sheet"
                    style={{ width: 112, height: 112, objectFit: 'contain', borderRadius: 5, border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 12px 12px' }}
                  />
                  <button
                    type="button"
                    onClick={clearSheetUpload}
                    disabled={sheetBusy}
                    data-uisnd="skip"
                    title="Remove sheet"
                    style={{
                      position: 'absolute', top: -6, right: -6, width: 18, height: 18, lineHeight: '16px',
                      borderRadius: '50%', fontSize: 11, fontWeight: 700, cursor: sheetBusy ? 'not-allowed' : 'pointer',
                      border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: 'var(--vl-red-primary)',
                    }}
                  >×</button>
                </div>
              ) : (
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={sheetBusy}
                  onChange={(e) => { void onSheetFileChange(e); }}
                  style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}
                />
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 260 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                  LAYOUT
                  <select
                    value={sheetLayoutId}
                    onChange={(e) => setSheetLayoutId(e.target.value as '2x4-layer-sheet' | '4x4-family-sheet')}
                    disabled={sheetBusy}
                    style={FIELD}
                  >
                    <option value="2x4-layer-sheet">2×4 Layer Sheet (preview + 7 layers)</option>
                    <option value="4x4-family-sheet">4×4 Family Sheet (16 whole-character thumbnails)</option>
                  </select>
                </label>
                {sheetLayoutId === '4x4-family-sheet' && (
                  <div style={{ fontSize: 9, color: 'var(--vl-gold-primary)', lineHeight: 1.4 }}>
                    No cell in this layout has a layer type yet — every cell will be skipped
                    (reason &ldquo;no_layer_type&rdquo;). Reserved for a future workflow, not layer import.
                  </div>
                )}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                  BASE NAME
                  <input
                    type="text"
                    value={sheetBaseName}
                    onChange={(e) => setSheetBaseName(e.target.value.slice(0, 80))}
                    disabled={sheetBusy}
                    placeholder="e.g. raccoon-v1"
                    style={FIELD}
                  />
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                BACKGROUND
                <select
                  value={sheetBackgroundMode}
                  onChange={(e) => setSheetBackgroundMode(e.target.value as 'keep' | 'remove' | 'key-color')}
                  disabled={sheetBusy}
                  style={FIELD}
                >
                  <option value="keep">Keep as-is (already transparent)</option>
                  <option value="remove">Auto-detect background color</option>
                  <option value="key-color">Fixed key color</option>
                </select>
              </label>
              {sheetBackgroundMode === 'key-color' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                  KEY COLOR
                  <input
                    type="text"
                    value={sheetKeyColorHex}
                    onChange={(e) => setSheetKeyColorHex(e.target.value.slice(0, 7))}
                    disabled={sheetBusy}
                    placeholder="#FF00FF"
                    style={{ ...FIELD, width: 100, fontFamily: MONO }}
                  />
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--vl-text-muted)', marginTop: 18 }}>
                <input type="checkbox" checked={sheetRepair} onChange={(e) => setSheetRepair(e.target.checked)} disabled={sheetBusy} />
                Repair each cell (safe strength)
              </label>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 200 }}>
                TAGS (comma-separated)
                <input type="text" value={sheetTagsText} onChange={(e) => setSheetTagsText(e.target.value)} disabled={sheetBusy} style={FIELD} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 200 }}>
                NOTES
                <input type="text" value={sheetNotes} onChange={(e) => setSheetNotes(e.target.value.slice(0, 2000))} disabled={sheetBusy} style={FIELD} />
              </label>
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
              Cells to import
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {TRAIT_SHEET_LAYOUT_CELLS[sheetLayoutId].map(cell => (
                <label
                  key={cell.cellId}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, padding: '4px 8px', borderRadius: 4,
                    border: '1px solid rgb(var(--vl-purple-tint) / 0.22)',
                    background: sheetCellSelection[cell.cellId] ? 'rgba(126,217,168,0.08)' : 'rgb(var(--vl-purple-tint) / 0.03)',
                    color: cell.layerType ? '#c8c8dc' : '#6d6d88',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!sheetCellSelection[cell.cellId]}
                    onChange={() => toggleSheetCell(cell.cellId)}
                    disabled={sheetBusy}
                  />
                  {cell.label}{!cell.layerType && ' (not a layer)'}
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={() => { void importTraitSheet(); }}
              disabled={sheetBusy || !sheetBase64}
              data-uisnd="skip"
              style={{
                padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                cursor: (sheetBusy || !sheetBase64) ? 'not-allowed' : 'pointer',
                border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                opacity: (sheetBusy || !sheetBase64) ? 0.6 : 1,
              }}
            >{sheetBusy ? 'Importing…' : 'Import Selected Sheet Cells'}</button>
            {sheetError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginTop: 10 }}>{sheetError}</div>}
            {sheetImportResult && (
              <div style={{ marginTop: 10, fontSize: 10.5 }}>
                <div style={{ color: '#7ed9a8', marginBottom: 4 }}>
                  ✓ Imported {sheetImportResult.created.length} cell{sheetImportResult.created.length === 1 ? '' : 's'} as candidate traits
                  {sheetImportResult.skipped.length > 0 && ` (${sheetImportResult.skipped.length} skipped)`} — see the Trait library below.
                </div>
                {sheetImportResult.created.length > 0 && (
                  <ul style={{ margin: '0 0 6px', paddingLeft: 16, color: 'var(--vl-text-muted)' }}>
                    {sheetImportResult.created.map(c => (
                      <li key={c.id}>{c.name} · {LAYER_TYPE_LABELS[c.layerType] ?? c.layerType} · z{c.zIndex} · <span style={{ fontFamily: MONO, fontSize: 9.5 }}>{c.id}</span></li>
                    ))}
                  </ul>
                )}
                {sheetImportResult.skipped.length > 0 && (
                  <div style={{ color: 'var(--vl-gold-primary)' }}>
                    Skipped: {sheetImportResult.skipped.map(s => `${s.cellId} (${s.reason})`).join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Image-to-Traits Stage 1 — manual upload → normalize → preview
              variants → import as candidate. See
              docs/pixel-forge-image-to-traits-pipeline-mvp.md. Manual
              upload is the fallback/default path — fully independent of
              the Generate Source panel above, which only ever populates
              the exact same rasterBase64/rasterMimeType/rasterPreviewUrl
              state this panel's own dropzone does. */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Import Image</div>
            <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              Upload an already-generated image (e.g. from an external image model) and convert it
              into clean, fixed-grid pixel art — purely algorithmic (resize + source-derived palette +
              background removal), no AI call. Choose the variant that looks best, then import it as
              a candidate trait, same as a drawn one.
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
              {rasterPreviewUrl ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ position: 'relative' }}>
                    <img
                      src={rasterPreviewUrl}
                      alt="uploaded source"
                      style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 5, border: '1px solid rgb(var(--vl-purple-tint) / 0.35)' }}
                    />
                    <button
                      type="button"
                      onClick={clearRasterUpload}
                      disabled={rasterBusy}
                      data-uisnd="skip"
                      title="Remove uploaded image"
                      style={{
                        position: 'absolute', top: -6, right: -6, width: 18, height: 18, lineHeight: '16px',
                        borderRadius: '50%', fontSize: 11, fontWeight: 700, cursor: rasterBusy ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: 'var(--vl-red-primary)',
                      }}
                    >×</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5, color: 'var(--vl-text-muted)', paddingTop: 2 }}>
                    <span style={{ color: 'var(--vl-green-primary)', fontWeight: 700 }}>image loaded</span>
                    {rasterFile && <span>{referenceMimeTypeLabel(rasterFile.type)}</span>}
                  </div>
                </div>
              ) : (
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={rasterBusy}
                  onChange={(e) => { void onRasterFileChange(e); }}
                  style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}
                />
              )}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                TARGET SIZE
                <select
                  value={rasterTargetSize}
                  onChange={(e) => setRasterTargetSize(Number(e.target.value))}
                  disabled={rasterBusy}
                  style={FIELD}
                >
                  {RASTER_TARGET_SIZES.map(s => <option key={s} value={s}>{s}×{s}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--vl-text-muted)', paddingBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={rasterCleanup}
                  disabled={rasterBusy}
                  onChange={(e) => setRasterCleanup(e.target.checked)}
                />
                Clean isolated artifacts
              </label>
              {rasterCleanup && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                  MIN COMPONENT SIZE
                  <select
                    value={rasterMinComponentSize}
                    onChange={(e) => setRasterMinComponentSize(Number(e.target.value))}
                    disabled={rasterBusy}
                    style={FIELD}
                  >
                    {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}px</option>)}
                  </select>
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--vl-text-muted)', paddingBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={rasterRepair}
                  disabled={rasterBusy}
                  onChange={(e) => setRasterRepair(e.target.checked)}
                />
                Repair pixel artifacts
              </label>
              {rasterRepair && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                  REPAIR STRENGTH
                  <select
                    value={rasterRepairStrength}
                    onChange={(e) => setRasterRepairStrength(e.target.value as 'safe' | 'medium')}
                    disabled={rasterBusy}
                    style={FIELD}
                  >
                    <option value="safe">Safe</option>
                    <option value="medium">Medium</option>
                  </select>
                </label>
              )}
              <button
                type="button"
                onClick={() => { void normalizeRaster(); }}
                disabled={rasterBusy || !rasterBase64}
                data-uisnd="skip"
                style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                  cursor: (rasterBusy || !rasterBase64) ? 'not-allowed' : 'pointer',
                  border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                  opacity: (rasterBusy || !rasterBase64) ? 0.6 : 1,
                }}
              >{rasterBusy ? 'Normalizing…' : 'Normalize'}</button>
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginTop: -6, marginBottom: 10 }}>
              Off by default — this is a new, purely algorithmic pass (no AI) that removes isolated background
              specks and fills tiny holes; it never touches a detail connected to the main character (eye
              highlights, badge glyphs, mouth lines are structurally protected). Turn it on to also generate a
              &ldquo;— cleaned&rdquo; variant of each option below, and compare before trusting it by default.
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginTop: -6, marginBottom: 10 }}>
              Off by default — a broader repair pass (no AI): fixes faint transparent fringing, tiny noisy
              specks/holes, and (Medium only) inconsistent 1px outlines and near-duplicate color noise within
              one region. Same detail protections as cleanup. Turn it on to also generate a &ldquo;—
              repaired&rdquo; variant of each option below — independent of Clean isolated artifacts, not
              chained after it, so you can compare both separately.
            </div>
            {rasterError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginBottom: 10 }}>{rasterError}</div>}

            {rasterVariants.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
                  Choose a variant
                </div>
                <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', marginBottom: 8 }}>
                  48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export.
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                  {rasterVariants.map(v => (
                    <div key={v.variantId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <button
                        type="button"
                        onClick={() => selectRasterVariant(v.variantId)}
                        data-uisnd="skip"
                        style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 8,
                          borderRadius: 6, cursor: 'pointer',
                          border: rasterSelectedVariantId === v.variantId ? '1px solid rgba(126,217,168,0.65)' : '1px solid rgb(var(--vl-purple-tint) / 0.22)',
                          background: rasterSelectedVariantId === v.variantId ? 'rgba(126,217,168,0.10)' : 'rgb(var(--vl-purple-tint) / 0.03)',
                        }}
                      >
                        <PixelImg src={`data:image/png;base64,${v.pngBase64}`} size={112} alt={v.label} />
                        <span style={{ fontSize: 9.5, color: '#c8c8dc', textAlign: 'center', maxWidth: 112 }}>{v.label}</span>
                        {v.cleanupApplied && (
                          <span style={{ fontSize: 9, color: 'var(--vl-purple-tint)', textAlign: 'center' }}>
                            {v.pixelsChanged} px changed · {v.componentsRemoved} component{v.componentsRemoved === 1 ? '' : 's'}
                          </span>
                        )}
                        {v.repairApplied && (
                          <span style={{ fontSize: 9, color: '#7ed9a8', textAlign: 'center' }}>
                            {v.pixelsChanged} px · {v.componentsRemoved} speck{v.componentsRemoved === 1 ? '' : 's'} ·{' '}
                            {v.holesFilled} hole{v.holesFilled === 1 ? '' : 's'}
                            {v.outlinePixelsAdjusted > 0 && ` · ${v.outlinePixelsAdjusted} outline`}
                            {' '}({v.repairStrength})
                          </span>
                        )}
                        {rasterSelectedVariantId === v.variantId && (
                          <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--vl-green-primary)' }}>✓ selected</span>
                        )}
                      </button>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <button
                          type="button"
                          onClick={() => downloadVariantRaw(v)}
                          data-uisnd="skip"
                          title="48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export."
                          style={{
                            padding: '2px 6px', fontSize: 8.5, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                            border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                          }}
                        >Download 48×48</button>
                        <button
                          type="button"
                          onClick={() => { void downloadVariantUpscaled(v.variantId); }}
                          data-uisnd="skip"
                          title="48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export."
                          style={{
                            padding: '2px 6px', fontSize: 8.5, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                            border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                          }}
                        >Download 384×384</button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Stage 8 — Collection DNA Lock / Fit Check. Purely
                    deterministic (see src/pixel-agent/collection-fit.ts),
                    no AI. Advisory only — does not block Preview
                    Split / Import below it. The profile is never
                    persisted server-side; it lives only in this page's
                    own state between the two calls. */}
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
                  Collection DNA / Fit Check
                </div>
                <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
                  Purely algorithmic (no AI), advisory only — never blocks import. Build a reference
                  profile from one variant, then check the selected variant above against it for
                  bbox/center drift, coverage, palette, and outline-ratio consistency.
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <input
                    type="text"
                    value={collectionFitProfileName}
                    onChange={(e) => setCollectionFitProfileName(e.target.value.slice(0, 200))}
                    placeholder="Profile name (e.g. collection-v1)"
                    style={{ ...FIELD, width: 220 }}
                  />
                  <button
                    type="button"
                    onClick={() => { void createCollectionFitProfile(); }}
                    disabled={collectionFitProfileBusy || !rasterSelectedVariantId}
                    data-uisnd="skip"
                    style={{
                      padding: '7px 14px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                      cursor: (collectionFitProfileBusy || !rasterSelectedVariantId) ? 'not-allowed' : 'pointer',
                      border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                      opacity: (collectionFitProfileBusy || !rasterSelectedVariantId) ? 0.6 : 1,
                    }}
                  >{collectionFitProfileBusy ? 'Creating…' : 'Create DNA profile from selected variant'}</button>
                  <button
                    type="button"
                    onClick={() => { void checkCollectionFitForSelectedVariant(); }}
                    disabled={collectionFitCheckBusy || !rasterSelectedVariantId || !collectionFitProfile}
                    data-uisnd="skip"
                    style={{
                      padding: '7px 14px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                      cursor: (collectionFitCheckBusy || !rasterSelectedVariantId || !collectionFitProfile) ? 'not-allowed' : 'pointer',
                      border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                      opacity: (collectionFitCheckBusy || !rasterSelectedVariantId || !collectionFitProfile) ? 0.6 : 1,
                    }}
                  >{collectionFitCheckBusy ? 'Checking…' : 'Check collection fit'}</button>
                </div>
                {collectionFitProfileError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginBottom: 8 }}>{collectionFitProfileError}</div>}
                {collectionFitProfile && (
                  <div style={{ fontSize: 10, color: '#7ed9a8', marginBottom: 8 }}>
                    ✓ DNA profile loaded: &ldquo;{collectionFitProfile.name}&rdquo; — check any selected variant above against it.
                  </div>
                )}
                {collectionFitCheckError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginBottom: 8 }}>{collectionFitCheckError}</div>}
                {collectionFitResult && (() => {
                  const verdictColor = collectionFitResult.verdict === 'pass' ? '#43b984' : collectionFitResult.verdict === 'warn' ? '#e0b84a' : '#d96867';
                  const m = collectionFitResult.metrics;
                  return (
                    <div style={{
                      padding: 10, borderRadius: 6, marginBottom: 14,
                      border: `1px solid ${verdictColor}55`, background: 'rgb(var(--vl-purple-tint) / 0.03)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: verdictColor }}>{collectionFitResult.score}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: verdictColor }}>
                          {collectionFitResult.verdict}
                        </span>
                      </div>
                      {collectionFitResult.issues.length === 0 ? (
                        <div style={{ fontSize: 10.5, color: '#7ed9a8', marginBottom: 8 }}>No issues — matches the DNA profile.</div>
                      ) : (
                        <ul style={{ margin: '0 0 8px', paddingLeft: 16 }}>
                          {collectionFitResult.issues.map((iss, idx) => (
                            <li key={idx} style={{ fontSize: 10, color: iss.severity === 'fail' ? 'var(--vl-red-primary)' : '#e0b84a', marginBottom: 4 }}>
                              <strong>{iss.code}</strong> ({iss.severity}): {iss.message}
                              <div style={{ fontSize: 9, color: 'var(--vl-text-muted)' }}>expected {iss.expected} · actual {iss.actual}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                        <span>bbox: {m.foregroundBBox ? `x=${m.foregroundBBox.x} y=${m.foregroundBBox.y} w=${m.foregroundBBox.w} h=${m.foregroundBBox.h}` : 'n/a'}</span>
                        <span>center: {m.subjectCenter ? `(${m.subjectCenter.x.toFixed(1)}, ${m.subjectCenter.y.toFixed(1)})` : 'n/a'}</span>
                        <span>coverage: {m.foregroundCoveragePct.toFixed(1)}%</span>
                        <span>outline ratio: {(m.darkOutlineRatio * 100).toFixed(1)}%</span>
                      </div>
                      {m.warnings.length > 0 && (
                        <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', marginTop: 6 }}>{m.warnings.join(' ')}</div>
                      )}
                    </div>
                  );
                })()}

                {/* Stage 10.1: hidden — this heuristic color/band decomposer
                    of an already-composed character is exactly the "split a
                    completed character" approach the Stage 10 Trait Family
                    Sheet pivot retires (see project memory
                    project_pixel_forge_stage10_pivot). Not deleted. */}
                {SHOW_LEGACY_UI && (
                <>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
                  Preview split (experimental)
                </div>
                <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
                  Proposes a background / hat / body / head-fur / face-mask / eyes / mouth breakdown of the
                  selected variant above — purely algorithmic (no AI), preview only. Eyes and mouth are
                  genuinely hard to isolate by color alone and often come back low-confidence or empty —
                  that is expected, not a bug. This does not create any traits yet.
                </div>
                <button
                  type="button"
                  onClick={() => { void previewSplit(); }}
                  disabled={rasterSplitBusy || !rasterSelectedVariantId}
                  data-uisnd="skip"
                  style={{
                    marginBottom: 10, padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                    cursor: (rasterSplitBusy || !rasterSelectedVariantId) ? 'not-allowed' : 'pointer',
                    border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                    opacity: (rasterSplitBusy || !rasterSelectedVariantId) ? 0.6 : 1,
                  }}
                >{rasterSplitBusy ? 'Splitting…' : 'Preview Split'}</button>
                {rasterSplitError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginBottom: 10 }}>{rasterSplitError}</div>}

                {rasterSplitResult && (
                  <div style={{ marginBottom: 14 }}>
                    {rasterSplitResult.warnings.length > 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--vl-gold-primary)', marginBottom: 8 }}>
                        {rasterSplitResult.warnings.join(' ')}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <PixelImg src={`data:image/png;base64,${rasterSplitResult.composite}`} size={112} alt="Composite (all layers stacked)" />
                        <span style={{ fontSize: 9.5, color: '#c8c8dc', fontWeight: 700 }}>Composite</span>
                        <span style={{ fontSize: 9, color: 'var(--vl-text-muted)', textAlign: 'center', maxWidth: 112 }}>
                          Union of every layer below — should look identical to the selected variant.
                        </span>
                      </div>
                      {rasterSplitResult.layers.map(layer => (
                        <div key={layer.layerId} style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 8,
                          borderRadius: 6, border: '1px solid rgb(var(--vl-purple-tint) / 0.22)', background: 'rgb(var(--vl-purple-tint) / 0.03)',
                          width: 128,
                        }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, color: '#c8c8dc', cursor: layer.pixelCount > 0 ? 'pointer' : 'not-allowed' }}>
                            <input
                              type="checkbox"
                              checked={!!rasterSplitLayerSelection[layer.layerId]}
                              disabled={layer.pixelCount === 0 || rasterImportSplitBusy}
                              onChange={(e) => setRasterSplitLayerSelection(prev => ({ ...prev, [layer.layerId]: e.target.checked }))}
                            />
                            Import
                          </label>
                          <PixelImg src={`data:image/png;base64,${layer.pngBase64}`} size={112} alt={layer.label} />
                          <span style={{ fontSize: 9.5, color: '#c8c8dc', fontWeight: 700, textAlign: 'center' }}>{layer.label}</span>
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                            color: SPLIT_CONFIDENCE_META[layer.confidence].color,
                            background: `${SPLIT_CONFIDENCE_META[layer.confidence].color}14`,
                            border: `1px solid ${SPLIT_CONFIDENCE_META[layer.confidence].color}3a`,
                          }}>{layer.confidence} confidence</span>
                          <span style={{ fontSize: 9, color: 'var(--vl-text-muted)', textAlign: 'center' }}>
                            {layer.pixelCount}px · {layer.method} · suggests &ldquo;{layer.suggestedLayerType}&rdquo;
                          </span>
                          {layer.pixelCount === 0 && (
                            <span style={{ fontSize: 8.5, color: 'var(--vl-text-muted)', textAlign: 'center' }}>nothing to import</span>
                          )}
                          {layer.warnings.length > 0 && (
                            <span style={{ fontSize: 8.5, color: 'var(--vl-red-primary)', textAlign: 'center' }}>{layer.warnings.join(' ')}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
                      High/medium confidence layers are checked by default; low-confidence layers (often eyes/mouth)
                      start unchecked — review before including them. Uses the NAME/TAGS/NOTES fields and collection
                      selection below as the base name/tags/notes for every imported layer.
                    </div>
                    <button
                      type="button"
                      onClick={() => { void importSelectedSplitLayers(); }}
                      disabled={rasterImportSplitBusy || Object.values(rasterSplitLayerSelection).every(v => !v)}
                      data-uisnd="skip"
                      style={{
                        padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                        cursor: (rasterImportSplitBusy || Object.values(rasterSplitLayerSelection).every(v => !v)) ? 'not-allowed' : 'pointer',
                        border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                        opacity: (rasterImportSplitBusy || Object.values(rasterSplitLayerSelection).every(v => !v)) ? 0.6 : 1,
                      }}
                    >{rasterImportSplitBusy ? 'Importing…' : 'Import Selected Split Layers'}</button>
                    {rasterImportSplitError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginTop: 8 }}>{rasterImportSplitError}</div>}
                    {rasterImportSplitResult && (
                      <div style={{
                        marginTop: 10, fontSize: 11, color: 'var(--vl-green-primary)', padding: '8px 10px', borderRadius: 5,
                        border: '1px solid rgba(126,217,168,0.35)', background: 'rgba(126,217,168,0.08)',
                      }}>
                        ✓ Imported {rasterImportSplitResult.created.length} layer{rasterImportSplitResult.created.length === 1 ? '' : 's'} as candidate traits
                        {rasterImportSplitResult.skippedCount > 0 && ` (${rasterImportSplitResult.skippedCount} skipped — empty)`} — see the Trait library below.
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {rasterImportSplitResult.created.map(c => (
                            <li key={c.id} style={{ fontSize: 10 }}>{c.name} <span style={{ color: 'var(--vl-text-muted)' }}>({c.id.slice(0, 8)}…)</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                </>
                )}

                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--vl-text-muted)', marginBottom: 6 }}>
                  Import as candidate
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                    NAME
                    <input type="text" value={rasterName} onChange={(e) => setRasterName(e.target.value)} style={FIELD} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                    LAYER TYPE
                    <select value={rasterLayerType} onChange={(e) => setRasterLayerType(e.target.value as LayerType)} style={FIELD}>
                      {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1, minWidth: 160 }}>
                    TAGS (comma-separated)
                    <input type="text" value={rasterTagsText} onChange={(e) => setRasterTagsText(e.target.value)} placeholder="raster, openai-test, …" style={FIELD} />
                  </label>
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', marginTop: 10 }}>
                  NOTES
                  <textarea
                    value={rasterNotes}
                    onChange={(e) => setRasterNotes(e.target.value)}
                    rows={2}
                    placeholder={`Imported from raster experiment ${rasterExperimentId ?? ''}/${rasterSelectedVariantId ?? ''}-raw.png`}
                    style={{ ...FIELD, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                  />
                </label>
                {selectedCollection && (
                  <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', marginTop: 8 }}>
                    Will be filed under collection <span style={{ color: 'var(--vl-text-primary)', fontWeight: 700 }}>{selectedCollection.name}</span> (from the Collections panel above).
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { void importRasterVariant(); }}
                  disabled={rasterImporting || !rasterSelectedVariantId || rasterName.trim().length === 0}
                  data-uisnd="skip"
                  style={{
                    marginTop: 10, padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 5,
                    cursor: (rasterImporting || !rasterSelectedVariantId || rasterName.trim().length === 0) ? 'not-allowed' : 'pointer',
                    border: '1px solid rgb(var(--vl-purple-tint) / 0.45)', background: 'rgb(var(--vl-purple-tint) / 0.10)', color: 'var(--vl-purple-tint)',
                    opacity: (rasterImporting || !rasterSelectedVariantId || rasterName.trim().length === 0) ? 0.6 : 1,
                  }}
                >{rasterImporting ? 'Importing…' : 'Import as candidate'}</button>
                {rasterImportError && <div style={{ fontSize: 10.5, color: 'var(--vl-red-primary)', marginTop: 8 }}>{rasterImportError}</div>}
                {rasterImportedTrait && (
                  <div style={{
                    marginTop: 10, fontSize: 11, color: 'var(--vl-green-primary)', padding: '8px 10px', borderRadius: 5,
                    border: '1px solid rgba(126,217,168,0.35)', background: 'rgba(126,217,168,0.08)',
                  }}>
                    ✓ Imported <span style={{ fontWeight: 700 }}>{rasterImportedTrait.name}</span> as a candidate trait —
                    see it in the Trait library below.
                  </div>
                )}
              </>
            )}
          </div>
          </>
          )}

          {/* Trait library */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Trait library ({visibleTraits.length} / {traits.length})</div>
            {SHOW_LEGACY_UI && REVISION_REMOVED && (
              <div style={{
                fontSize: 11, color: 'var(--vl-gold-primary)', padding: '8px 10px', borderRadius: 5, marginBottom: 10,
                border: '1px solid rgb(var(--vl-gold) / 0.35)', background: 'rgb(var(--vl-gold) / 0.08)',
              }}>
                {REVISION_REMOVED_NOTICE}
              </div>
            )}
            {traitsError && <div style={{ fontSize: 11, color: 'var(--vl-red-primary)', marginBottom: 8 }}>{traitsError}</div>}
            <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', marginBottom: 8 }}>
              48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                FILTER: LAYER TYPE
                <select value={filterLayerType} onChange={(e) => setFilterLayerType(e.target.value as LayerType | '')} style={FIELD}>
                  <option value="">all</option>
                  {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                FILTER: STATUS
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TraitStatus | '')} style={FIELD}>
                  <option value="">all</option>
                  <option value="candidate">candidate</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--vl-text-muted)', paddingBottom: 8 }}>
                <input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} />
                Approved only
              </label>
            </div>
            {!traitsError && visibleTraits.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--vl-text-muted)' }}>{traits.length === 0 ? 'Nothing saved yet.' : 'No traits match these filters.'}</div>
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
                            : (legacyEvalAllPass(t.evaluation) ? 'var(--vl-green-primary)' : 'var(--vl-red-primary)'),
                          boxShadow: '0 0 0 2px rgba(20,14,34,0.85)',
                        }}
                      />
                    </div>
                    {/* Auto-open "N open issues"/"N missing features" badges —
                        historically an entry point into Revise. Revision is
                        removed (see REVISION_REMOVED above), so these are
                        disabled rather than hidden: the issue-count/tooltip
                        is still legitimate diagnostic info about the trait,
                        it just can no longer be acted on via Revise. Stage
                        10.1: gated behind SHOW_LEGACY_UI too, since they're
                        now a dead entry point into a removed control. */}
                    {SHOW_LEGACY_UI && (isV2Evaluation(t.evaluation) ? (
                      openIssueCount(t) > 0 && (
                        <button
                          type="button"
                          onClick={() => { setReviseDraftId(t.id); setReviseDraftText(''); }}
                          disabled={busy || REVISION_REMOVED}
                          data-uisnd="skip"
                          title={REVISION_REMOVED ? REVISION_REMOVED_NOTICE : safeIssues(t.repairPlan).map(i => `[${getSeverityMeta(i.severity).label}] ${i.location || '?'}: ${i.problem || '?'}`).join('\n')}
                          style={{
                            display: 'block', width: '100%', marginTop: 3, padding: '2px 5px', fontSize: 9,
                            fontWeight: 700, borderRadius: 3, textAlign: 'left', cursor: (busy || REVISION_REMOVED) ? 'not-allowed' : 'pointer',
                            border: '1px solid rgb(var(--vl-gold) / 0.35)', background: 'rgb(var(--vl-gold) / 0.08)', color: 'var(--vl-gold-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            opacity: REVISION_REMOVED ? 0.6 : 1,
                          }}
                        >⚠ {openIssueCount(t)} open issue{openIssueCount(t) > 1 ? 's' : ''}{REVISION_REMOVED ? '' : ' — Revise applies plan automatically'}</button>
                      )
                    ) : (
                      legacyMissingFeaturesOf(t.evaluation).length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setReviseDraftId(t.id);
                            setReviseDraftText(legacyMissingFeaturesRevisionText(legacyMissingFeaturesOf(t.evaluation)));
                          }}
                          disabled={busy || REVISION_REMOVED}
                          data-uisnd="skip"
                          title={REVISION_REMOVED ? REVISION_REMOVED_NOTICE : legacyMissingFeaturesOf(t.evaluation).join('; ')}
                          style={{
                            display: 'block', width: '100%', marginTop: 3, padding: '2px 5px', fontSize: 9,
                            fontWeight: 700, borderRadius: 3, textAlign: 'left', cursor: (busy || REVISION_REMOVED) ? 'not-allowed' : 'pointer',
                            border: '1px solid rgb(var(--vl-gold) / 0.35)', background: 'rgb(var(--vl-gold) / 0.08)', color: 'var(--vl-gold-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            opacity: REVISION_REMOVED ? 0.6 : 1,
                          }}
                        >⚠ {legacyMissingFeaturesOf(t.evaluation).length} missing feature{legacyMissingFeaturesOf(t.evaluation).length > 1 ? 's' : ''}</button>
                      )
                    ))}
                    <input
                      type="text"
                      defaultValue={t.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) void patchTraitMeta(t.id, { name: e.target.value.trim() }); }}
                      style={{ ...FIELD, width: '100%', boxSizing: 'border-box', fontSize: 10.5, fontWeight: 700, padding: '3px 6px', marginTop: 4 }}
                    />
                    <div title={t.prompt} style={{
                      fontSize: 9.5, color: 'var(--vl-text-muted)', marginTop: 3, whiteSpace: 'nowrap',
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
                            fontSize: 9, padding: '1px 5px', borderRadius: 3, color: 'var(--vl-purple-tint)',
                            background: 'rgb(var(--vl-purple-tint) / 0.10)', border: '1px solid rgb(var(--vl-purple-tint) / 0.28)',
                          }}>{tag}</span>
                        ))}
                      </div>
                    )}
                    {t.referenceGuidanceNote && (
                      <div
                        title={t.referenceGuidanceNote}
                        style={{
                          fontSize: 8.5, color: 'var(--vl-text-muted)', marginTop: 3, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--vl-purple-tint)' }}>ref: </span>{t.referenceGuidanceNote}
                      </div>
                    )}
                    {(t.collectionId || t.collectionPresetId) && (
                      <div
                        title={`collectionId: ${t.collectionId ?? '—'} · presetId: ${t.collectionPresetId ?? '—'}`}
                        style={{
                          fontSize: 8.5, color: 'var(--vl-text-muted)', marginTop: 3, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--vl-purple-tint)' }}>collection: </span>
                        {t.collectionId ? (collectionNameById.get(t.collectionId) ?? t.collectionId) : '—'}
                        {t.collectionPresetId ? ` [${t.collectionPresetId}]` : ''}
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
                          border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: 'var(--vl-green-primary)',
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
                          border: '1px solid rgba(217,124,124,0.40)', background: 'rgba(217,104,104,0.08)', color: 'var(--vl-red-primary)',
                        }}
                      >Reject</button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {/* Claude revision removed — see REVISION_REMOVED
                          above and the file header comment. Disabled
                          rather than hidden, with the notice as a tooltip
                          (consistent with the auto-open badges above, and
                          with this card grid's existing dense-tooltip
                          convention). Stage 10.1: also gated behind
                          SHOW_LEGACY_UI — a dead control, not just disabled. */}
                      {SHOW_LEGACY_UI && (
                      <button
                        type="button"
                        onClick={() => { setReviseDraftId(reviseDraftId === t.id ? null : t.id); setReviseDraftText(''); }}
                        disabled={busy || REVISION_REMOVED}
                        data-uisnd="skip"
                        title={REVISION_REMOVED ? REVISION_REMOVED_NOTICE : undefined}
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                          cursor: (busy || REVISION_REMOVED) ? 'not-allowed' : 'pointer',
                          border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.08)', color: 'var(--vl-purple-tint)',
                          opacity: REVISION_REMOVED ? 0.6 : 1,
                        }}
                      >Revise</button>
                      )}
                      <button
                        type="button"
                        onClick={() => deleteTrait(t.id)}
                        data-uisnd="skip"
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgba(122,122,148,0.35)', background: 'rgba(122,122,148,0.08)', color: 'var(--vl-text-muted)',
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
                          border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                        }}
                      >JSON</button>
                    </div>
                    {/* "48×48 is the raw grid. 384×384 is a clean ×8
                        pixel-art export." — full-width, stacked rows since
                        this card is only 132px wide; the longer labels
                        don't fit paired with flex:1 siblings. */}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => downloadPng(t)}
                        data-uisnd="skip"
                        title="48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export."
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 9.5, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >Download 48×48</button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => { void downloadTraitUpscaled(t); }}
                        data-uisnd="skip"
                        title="48×48 is the raw grid. 384×384 is a clean ×8 pixel-art export."
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 9.5, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: 'var(--vl-green-primary)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >Download 384×384</button>
                    </div>
                    {/* Already unreachable — reviseDraftId can no longer be
                        set (its only setters, above, are disabled) — but
                        also explicitly gated on !REVISION_REMOVED so this
                        whole textarea/Submit-revision control can never
                        render regardless of how reviseDraftId got set. */}
                    {!REVISION_REMOVED && reviseDraftId === t.id && (() => {
                      const hasRepairWork = openIssueCount(t) > 0;
                      const canSubmit = reviseDraftText.trim().length > 0 || hasRepairWork;
                      return (
                        <div style={{ marginTop: 6 }}>
                          {hasRepairWork && (
                            <div style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', marginBottom: 4 }}>
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
                            disabled={busy || !canSubmit || REVISION_REMOVED}
                            data-uisnd="skip"
                            style={{
                              marginTop: 4, width: '100%', padding: '3px 6px', fontSize: 10, fontWeight: 700,
                              borderRadius: 4, cursor: (busy || !canSubmit || REVISION_REMOVED) ? 'not-allowed' : 'pointer',
                              border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: 'var(--vl-green-primary)',
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

          {/* Layer Stack Preview (Stage 4.2) — client-side compositor over
              already-approved traits. No AI call, no generation, no new
              fetch: pure derived state (see layer-stack.ts) over `traits`/
              `selectedCollectionId`, already loaded above. See
              docs/pixel-forge-layer-stack-compositor-mvp.md. */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Layer Stack Preview</div>
            {selectedCollection ? (
              <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginBottom: 10 }}>
                Scoped to collection <span style={{ color: 'var(--vl-text-primary)', fontWeight: 700 }}>{selectedCollection.name}</span>.
                Change the active collection above to switch — it clears the current stack.
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--vl-gold-primary)', marginBottom: 10 }}>
                No collection selected — showing approved traits from every collection.
                Select a collection above to scope this stack to just one.
              </div>
            )}

            {stackGroups.length === 0 ? (
              SHOW_LEGACY_UI ? (
              // Layer Workflow MVP — a suggested, layer-first workflow
              // instead of a generic "nothing here" message. Steps 1-4
              // jump straight to the generation form with LAYER TYPE
              // preset (see jumpToLayerType); step 5 has no separate
              // action — the Assemble Preview IS this panel, once
              // something's approved.
              <div>
                <div style={{ fontSize: 12, color: 'var(--vl-text-muted)', marginBottom: 8 }}>
                  No approved traits{selectedCollection ? ' in this collection' : ''} yet. Suggested workflow:
                </div>
                <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {([
                    ['body', 'Generate Body'],
                    ['eyes', 'Generate Eyes'],
                    ['mouth', 'Generate Mouth'],
                    ['accessory', 'Generate Accessory'],
                  ] as Array<[LayerType, string]>).map(([lt, label], i) => (
                    <li key={lt}>
                      <button
                        type="button"
                        onClick={() => jumpToLayerType(lt)}
                        data-uisnd="skip"
                        style={{
                          fontSize: 11.5, color: 'var(--vl-purple-tint)', background: 'none', border: 'none',
                          padding: 0, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
                          textDecorationColor: 'rgb(var(--vl-purple-tint) / 0.35)',
                        }}
                      >{i + 1}. {label}</button>
                    </li>
                  ))}
                  <li style={{ fontSize: 11.5, color: 'var(--vl-text-muted)' }}>5. Assemble Preview</li>
                </ol>
              </div>
              ) : (
                // Stage 10.1 — the suggested-workflow jump list above points
                // at the now-hidden Draw tab's generation form
                // (jumpToLayerType scrolls to drawFormRef), so it's replaced
                // with a plain message pointing at the still-live path.
                <div style={{ fontSize: 12, color: 'var(--vl-text-muted)' }}>
                  No approved traits{selectedCollection ? ' in this collection' : ''} yet. Generate a trait
                  sheet above, import cells via Import Image, then approve them in the Trait Library below.
                </div>
              )
            ) : (
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 300px', minWidth: 260 }}>
                  {stackGroups.map(group => {
                    const selectedId = stackSelection[group.layerType] ?? '';
                    const selectedFull = selectedId ? traitById.get(selectedId) ?? null : null;
                    return (
                      <div key={group.layerType} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          {selectedFull ? (
                            <>
                              <PixelImg src={`data:image/png;base64,${selectedFull.pngBase64}`} size={52} alt={selectedFull.name} />
                              <button
                                type="button"
                                onClick={() => setStackSlot(group.layerType, '')}
                                data-uisnd="skip"
                                title="Clear this slot"
                                style={{
                                  position: 'absolute', top: -6, right: -6, width: 16, height: 16, lineHeight: '14px',
                                  borderRadius: '50%', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                                  border: '1px solid rgba(217,124,124,0.55)', background: '#241a38', color: 'var(--vl-red-primary)',
                                }}
                              >×</button>
                            </>
                          ) : (
                            <div style={{
                              width: 52, height: 52, borderRadius: 6, border: '1px dashed rgb(var(--vl-purple-tint) / 0.30)',
                              background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 12px 12px',
                            }} />
                          )}
                        </div>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', flex: 1 }}>
                          {LAYER_TYPE_LABELS[group.layerType] ?? group.layerType}
                          <select
                            value={selectedId}
                            onChange={(e) => setStackSlot(group.layerType, e.target.value)}
                            style={FIELD}
                          >
                            <option value="">— none —</option>
                            {group.options.map(o => {
                              const compatible = isTraitCanvasCompatible(o, stackCanvasSize);
                              return (
                                <option key={o.id} value={o.id} disabled={!compatible}>
                                  {o.name} · {o.size}×{o.size} · z{o.zIndex}{compatible ? '' : ' (size mismatch)'}
                                </option>
                              );
                            })}
                          </select>
                        </label>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 0 auto' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)' }}>
                    PREVIEW{stackCanvasSize ? ` — ${stackCanvasSize}×${stackCanvasSize} grid` : ''}
                  </div>
                  {sortedStackTraits.length === 0 ? (
                    <div style={{
                      width: 220, height: 220, borderRadius: 8, border: '1px dashed rgb(var(--vl-purple-tint) / 0.30)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
                      fontSize: 11, color: '#6d6d88', padding: 10, boxSizing: 'border-box',
                    }}>
                      Pick at least one layer to see a preview.
                    </div>
                  ) : (
                    <div style={{
                      position: 'relative', width: 220, height: 220, borderRadius: 8, overflow: 'hidden',
                      border: '1px solid rgb(var(--vl-purple-tint) / 0.30)',
                      background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 16px 16px',
                    }}>
                      {sortedStackTraits.map(t => {
                        const full = traitById.get(t.id);
                        if (!full) return null;
                        return (
                          <img
                            key={t.id}
                            src={`data:image/png;base64,${full.pngBase64}`}
                            alt={`${LAYER_TYPE_LABELS[t.layerType] ?? t.layerType}: ${t.name}`}
                            style={{ ...PIXELATED, position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                          />
                        );
                      })}
                    </div>
                  )}
                  {sortedStackTraits.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5, color: 'var(--vl-text-muted)', width: 220 }}>
                      {sortedStackTraits.map((t, i) => (
                        <div key={t.id} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          #{i + 1} · z{t.zIndex} · {LAYER_TYPE_LABELS[t.layerType] ?? t.layerType} · {t.name}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Stage 9.2 — real backend PNG compose. The stack
                      preview above is CSS-only (fast, free, display-only);
                      this button is the one thing that ever produces a
                      downloadable PNG — never the CSS stack itself. */}
                  {sortedStackTraits.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 220, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => { void composeSelectedStack(); }}
                        disabled={composeBusy}
                        data-uisnd="skip"
                        style={{
                          padding: '7px 12px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                          cursor: composeBusy ? 'not-allowed' : 'pointer', opacity: composeBusy ? 0.6 : 1,
                          border: '1px solid rgba(126,217,168,0.45)', background: 'rgba(126,217,168,0.10)', color: 'var(--vl-green-primary)',
                        }}
                      >{composeBusy ? 'Composing…' : 'Compose / Download'}</button>
                      {composeError && <div style={{ fontSize: 10, color: 'var(--vl-red-primary)' }}>{composeError}</div>}
                      {composeResult && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontSize: 9.5, color: '#7ed9a8' }}>
                            ✓ Composed server-side — {composeResult.outputSize}×{composeResult.outputSize} raw, real PNG (not CSS).
                          </div>
                          {composeResult.rawPngBase64 && (
                            <div style={{
                              position: 'relative', width: 96, height: 96, borderRadius: 6, overflow: 'hidden',
                              border: '1px solid rgba(126,217,168,0.35)',
                              background: 'repeating-conic-gradient(#2a2440 0% 25%, #1e1a30 0% 50%) 50% / 12px 12px',
                            }}>
                              <img
                                src={`data:image/png;base64,${composeResult.rawPngBase64}`}
                                alt="composed result"
                                style={{ ...PIXELATED, position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                              />
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              onClick={downloadComposedRaw}
                              disabled={!composeResult.rawPngBase64}
                              data-uisnd="skip"
                              style={{
                                flex: 1, padding: '4px 8px', fontSize: 9.5, fontWeight: 700, borderRadius: 4,
                                cursor: composeResult.rawPngBase64 ? 'pointer' : 'not-allowed',
                                border: '1px solid rgb(var(--vl-purple-tint) / 0.40)', background: 'rgb(var(--vl-purple-tint) / 0.06)', color: 'var(--vl-text-muted)',
                              }}
                            >Download {composeResult.outputSize}×{composeResult.outputSize}</button>
                            <button
                              type="button"
                              onClick={downloadComposedUpscaled}
                              disabled={!composeResult.upscaled384PngBase64}
                              data-uisnd="skip"
                              style={{
                                flex: 1, padding: '4px 8px', fontSize: 9.5, fontWeight: 700, borderRadius: 4,
                                cursor: composeResult.upscaled384PngBase64 ? 'pointer' : 'not-allowed',
                                border: '1px solid rgba(126,217,168,0.40)', background: 'rgba(126,217,168,0.08)', color: 'var(--vl-green-primary)',
                              }}
                            >Download {composeResult.outputSize * composeResult.scale}×{composeResult.outputSize * composeResult.scale}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {stackWarnings.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {stackWarnings.map((w, i) => (
                  <div
                    key={`${w.code}-${w.layerType ?? i}`}
                    style={{
                      fontSize: 10.5, padding: '4px 8px', borderRadius: 4,
                      border: '1px solid rgba(217,124,124,0.35)', background: 'rgba(217,124,124,0.08)', color: 'var(--vl-red-primary)',
                    }}
                  >⚠ {w.message}</div>
                ))}
              </div>
            )}
          </div>

          {/* Validation runs (read-only, never editable/deletable). Stage
              10.1: hidden — dev/QA benchmark-gallery clutter, not part of
              the trait library or the live workflow. */}
          {SHOW_LEGACY_UI && (
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
                  background: 'rgba(122,122,148,0.08)', color: 'var(--vl-text-muted)',
                }}
              >{showValidationPreviews ? 'Hide' : 'Show'}</button>
            </div>
            {showValidationPreviews && (
              <>
                <div style={{ fontSize: 10.5, color: 'var(--vl-text-muted)', marginBottom: 8 }}>
                  Previews from paid smoke/benchmark runs under <code style={{ fontFamily: MONO }}>data/pixel-forge/validation-runs/</code> — read-only, not part of the trait library, numbered oldest → newest.
                </div>
                {validationPreviewsError && <div style={{ fontSize: 11, color: 'var(--vl-red-primary)', marginBottom: 8 }}>{validationPreviewsError}</div>}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, color: 'var(--vl-text-muted)', maxWidth: 260 }}>
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
                  <div style={{ fontSize: 12, color: 'var(--vl-text-muted)' }}>
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
                            borderRadius: 3, fontFamily: MONO, color: 'var(--vl-text-primary)', background: 'rgba(20,14,34,0.78)',
                          }}>#{String(p.seq).padStart(3, '0')}</span>
                          <span
                            title="Read-only — imported from a validation run, not a real trait"
                            style={{
                              position: 'absolute', top: 4, right: 4, padding: '1px 5px', fontSize: 8, fontWeight: 700,
                              letterSpacing: '0.3px', borderRadius: 3, color: 'var(--vl-text-muted)',
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
                        <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', marginTop: 2, fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.runId}{p.roundNumber !== null ? ` · round ${p.roundNumber}` : ''}{p.jobType ? ` · ${p.jobType}` : ''}
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--vl-text-muted)', marginTop: 2, fontFamily: MONO }}>
                          {p.model ?? 'model n/a'}{p.costUsd !== null ? ` · $${p.costUsd.toFixed(4)}` : ''}
                        </div>
                        <div style={{ fontSize: 9, marginTop: 2, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--vl-text-muted)' }}>
                          <span style={{ color: p.recognizableAsSubject === null ? 'var(--vl-text-muted)' : (p.recognizableAsSubject ? 'var(--vl-green-primary)' : 'var(--vl-red-primary)') }}>
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
          )}
        </div>
      </div>
    </div>
  );
}
