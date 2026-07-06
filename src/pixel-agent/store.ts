/**
 * Persisted pixel-forge trait library. The canonical stored object is the
 * pixel-grid JSON — `{ size, palette, pixels, layerType, ... }` — matching
 * the schema `runDrawingJob`/`runRevisionJob` return; the PNG is only a
 * derived preview (sharp's one job) so the gallery doesn't need a separate
 * binary-serving route — this repo has no precedent for streaming generated
 * image bytes, only image *URLs* (collection-icon.ts / collection-meta.ts),
 * so returning base64 inline in JSON responses is the simplest fit for a
 * personal-scale tool.
 *
 * A trait's `id` is stable for life: creation writes it once (revision 0),
 * and the only thing that ever mutates its pixels afterward is an explicit
 * revision (`updateTraitAsset`), which overwrites the SAME id in place and
 * bumps `revision`/`updatedAt`. Tags/notes are separately user-curated at
 * any time via `patchTraitAssetMeta`, with no AI call and no pixel change.
 *
 * Generation is never automatically "accepted": every new or revised trait
 * lands in `status: 'candidate'` — a self-graded evaluation is not human
 * approval. Only a human explicitly moving a trait to `'approved'` (also
 * via `patchTraitAssetMeta`, no AI call) makes it eligible for a future,
 * AI-free collection builder to use; a revision resets an approved trait
 * back to `'candidate'` since its pixels changed and the prior approval no
 * longer applies to what's now stored.
 *
 * File layout: data/pixel-forge/traits/<id>.json (+ .png), atomic write via
 * temp-file rename — same convention as src/mints/counted-ledger.ts.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  LayerType, LAYER_TYPES, ModelPreset, MODEL_PRESETS, PRESET_DEFAULT_MAX_TURNS, TokenUsage,
} from './agent-loop';
import { Evaluation, parseEvaluation } from './tools';
import { RepairPlan } from './repair-plan';

const TRAITS_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'traits');

export type GenerationMode = 'fresh' | 'revision';
export type TraitStatus = 'candidate' | 'approved' | 'rejected';

/** Sensible default compositing order per layer type — purely a starting
 *  point for the future (not-yet-built) collection builder; always
 *  overridable per trait via `zIndex` in save/patch input. */
const DEFAULT_Z_INDEX: Record<LayerType, number> = {
  background: 0,
  body: 10,
  eyes: 20,
  mouth: 30,
  accessory: 40,
  icon: 40,
  other: 50,
};

function slugify(s: string): string {
  const base = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'trait';
}

/** Slug is always `<slugified-name>-<id prefix>` — the id suffix makes it
 *  unique for free with no directory scan needed (ids are UUIDs). */
function makeSlug(name: string, id: string): string {
  return `${slugify(name)}-${id.slice(0, 6)}`;
}

function defaultName(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 40 ? `${trimmed.slice(0, 40).trim()}…` : trimmed;
}

export interface TraitAsset {
  id: string;
  name: string;
  slug: string;
  zIndex: number;
  layerType: LayerType;
  size: number;
  /** Index 0 is the literal string "transparent"; 1..N are hex colors. */
  palette: string[];
  /** Flat, row-major palette-index array. */
  pixels: number[];
  prompt: string;
  modelPreset: ModelPreset;
  actualModel: string;
  maxTurns: number;
  generationMode: GenerationMode;
  anchor: string | null;
  lastRevisionPrompt: string | null;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  evaluation: Evaluation;
  /** Latest computed repair plan — null for a trait that has never been
   *  evaluated by the v2 schema (legacy record) or whose only evaluation
   *  was stopped before grading. See docs/pixel-forge-revision-v3.md. */
  repairPlan: RepairPlan | null;
  /** Short, text-only provenance note from an optional reference image
   *  used at generation time — never the image itself (never stored),
   *  see docs/pixel-forge-reference-mode-mvp.md §8.7. Null when no
   *  reference was used, and always null for a legacy record. */
  referenceGuidanceNote: string | null;
  /** Human review gate — never set to 'approved' automatically. */
  status: TraitStatus;
  tags: string[];
  notes: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TraitAssetSummary {
  id: string;
  name: string;
  slug: string;
  zIndex: number;
  layerType: LayerType;
  size: number;
  prompt: string;
  modelPreset: ModelPreset;
  actualModel: string;
  status: TraitStatus;
  tags: string[];
  notes: string | null;
  evaluation: Evaluation;
  repairPlan: RepairPlan | null;
  referenceGuidanceNote: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  pngBase64: string;
}

async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

function jsonPath(id: string): string {
  return path.join(TRAITS_DIR, `${id}.json`);
}
function pngPath(id: string): string {
  return path.join(TRAITS_DIR, `${id}.png`);
}

// ── Storage-boundary normalization ──────────────────────────────────────
// `normalizeTraitAsset` is the ONLY place raw on-disk JSON is trusted as a
// TraitAsset. Never write `JSON.parse(...) as TraitAsset` anywhere else in
// this file (or its callers) — always route through here first. This
// exists because the trait library is a hand-edited-adjacent JSON file
// store with no migration step: a field added/renamed/retyped after some
// traits were already written means those older files are read forever
// after with whatever shape they were saved in, and a bare type assertion
// would let that reach a route handler (or the frontend gallery) as an
// object TypeScript believes is fully valid but isn't.

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}
function isPixelArray(v: unknown, expectedLength: number): v is number[] {
  return Array.isArray(v) && v.length === expectedLength
    && v.every(x => typeof x === 'number' && Number.isInteger(x) && x >= 0);
}
function isLayerType(v: unknown): v is LayerType {
  return typeof v === 'string' && (LAYER_TYPES as readonly string[]).includes(v);
}
function isModelPreset(v: unknown): v is ModelPreset {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODEL_PRESETS, v);
}
function isGenerationMode(v: unknown): v is GenerationMode {
  return v === 'fresh' || v === 'revision';
}
function isTraitStatus(v: unknown): v is TraitStatus {
  return v === 'candidate' || v === 'approved' || v === 'rejected';
}
function asNullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Shallow structural check only — unlike `evaluation` (always routed
 *  through `parseEvaluation`, built for tolerating a model's raw output),
 *  a `repairPlan` is always internally computed by `buildRepairPlan`, never
 *  model- or user-authored, so a corrupt one on disk means schema drift or
 *  a partial write, not "close enough to salvage." Null it out — same as a
 *  trait that predates `repairPlan` existing at all — rather than guess-
 *  repair a plan that drives the next revision job's actual instructions. */
function isPlausibleRepairPlan(v: unknown): v is RepairPlan {
  if (!isNonNullObject(v)) return false;
  return Array.isArray(v.issues) && Array.isArray(v.deferred) && Array.isArray(v.sequence)
    && Array.isArray(v.preserve) && isStringArray(v.doNotModify) && isStringArray(v.intentionalChoices)
    && typeof v.subject === 'string' && typeof v.currentDescription === 'string'
    && isFiniteNumber(v.sourceRevision) && isFiniteNumber(v.createdAt);
}

/** Normalizes an already-`JSON.parse`d value into a safe `TraitAsset`, or
 *  `null` if it's unrecoverable. `pixels`/`palette`/`size` are the only
 *  fields with no sensible default — you can't invent missing artwork —
 *  so a record malformed on one of those returns `null` (callers already
 *  treat that identically to "file not found": 404 from a route, skipped
 *  entry in `listTraitAssets`, `trait_not_found` from a revision/patch).
 *  Every other field degrades to a safe default instead, so an old/legacy
 *  record loads instead of crashing whatever reads it next. `id` always
 *  comes from the caller (the filename the record was read from), never
 *  from the JSON body itself, so a missing/mismatched id in the file can
 *  never matter. */
export function normalizeTraitAsset(raw: unknown, id: string): TraitAsset | null {
  if (!isNonNullObject(raw)) return null;

  const size = raw.size;
  if (!isFiniteNumber(size) || !Number.isInteger(size) || size <= 0) return null;

  const pixels = raw.pixels;
  if (!isPixelArray(pixels, size * size)) return null;

  const palette = raw.palette;
  if (!isStringArray(palette) || palette.length === 0) return null;

  const layerType: LayerType = isLayerType(raw.layerType) ? raw.layerType : 'other';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const modelPreset: ModelPreset = isModelPreset(raw.modelPreset) ? raw.modelPreset : 'fast';
  const actualModel = typeof raw.actualModel === 'string' ? raw.actualModel : MODEL_PRESETS[modelPreset];
  const maxTurns = isFiniteNumber(raw.maxTurns) && raw.maxTurns > 0
    ? raw.maxTurns
    : PRESET_DEFAULT_MAX_TURNS[modelPreset];
  const generationMode: GenerationMode = isGenerationMode(raw.generationMode) ? raw.generationMode : 'fresh';

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : defaultName(prompt);
  const zIndex = isFiniteNumber(raw.zIndex) ? raw.zIndex : DEFAULT_Z_INDEX[layerType];
  const slug = typeof raw.slug === 'string' && raw.slug.trim() ? raw.slug : makeSlug(name, id);

  const rawTokenUsage = raw.tokenUsage;
  const tokenUsage = isNonNullObject(rawTokenUsage)
    && isFiniteNumber(rawTokenUsage.inputTokens) && isFiniteNumber(rawTokenUsage.outputTokens)
    ? { inputTokens: rawTokenUsage.inputTokens, outputTokens: rawTokenUsage.outputTokens }
    : null;

  return {
    id,
    name,
    slug,
    zIndex,
    layerType,
    size,
    palette,
    pixels,
    prompt,
    modelPreset,
    actualModel,
    maxTurns,
    generationMode,
    anchor: asNullableString(raw.anchor),
    lastRevisionPrompt: asNullableString(raw.lastRevisionPrompt),
    tokenUsage,
    estimatedCostUsd: isFiniteNumber(raw.estimatedCostUsd) ? raw.estimatedCostUsd : null,
    // Legacy evaluation is PRESERVED, not discarded — parseEvaluation keeps
    // every real field present in the stored JSON and only fills in a safe
    // default for whatever's missing/malformed (same defensive parse the
    // live model-response path already uses; see tools.ts).
    evaluation: parseEvaluation(raw.evaluation),
    repairPlan: isPlausibleRepairPlan(raw.repairPlan) ? raw.repairPlan : null,
    referenceGuidanceNote: asNullableString(raw.referenceGuidanceNote),
    status: isTraitStatus(raw.status) ? raw.status : 'candidate',
    tags: isStringArray(raw.tags) ? raw.tags : [],
    notes: asNullableString(raw.notes),
    revision: isFiniteNumber(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

async function readRecord(id: string): Promise<TraitAsset | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(jsonPath(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt/truncated JSON on disk — treat like "not found" rather than
    // crashing the caller. Genuinely unrecoverable; nothing to normalize.
    console.warn(`[pixel-agent/store] corrupt JSON for trait ${id}, treating as not found`);
    return null;
  }
  return normalizeTraitAsset(parsed, id);
}

async function writeRecord(record: TraitAsset, pngBase64: string): Promise<void> {
  await atomicWrite(jsonPath(record.id), JSON.stringify(record));
  await atomicWrite(pngPath(record.id), Buffer.from(pngBase64, 'base64'));
}

export async function saveTraitAsset(input: {
  prompt: string;
  layerType: LayerType;
  size: number;
  palette: string[];
  pixels: number[];
  modelPreset: ModelPreset;
  actualModel: string;
  maxTurns: number;
  anchor: string | null;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  evaluation: Evaluation;
  repairPlan: RepairPlan | null;
  tags: string[];
  notes: string | null;
  pngBase64: string;
  name?: string;
  zIndex?: number;
  /** See TraitAsset.referenceGuidanceNote — text only, never the image. */
  referenceGuidanceNote?: string | null;
}): Promise<TraitAsset> {
  const now = Date.now();
  const id = randomUUID();
  const name = input.name?.trim() || defaultName(input.prompt);
  const record: TraitAsset = {
    id,
    name,
    slug: makeSlug(name, id),
    zIndex: input.zIndex ?? DEFAULT_Z_INDEX[input.layerType],
    layerType: input.layerType,
    size: input.size,
    palette: input.palette,
    pixels: input.pixels,
    prompt: input.prompt,
    modelPreset: input.modelPreset,
    actualModel: input.actualModel,
    maxTurns: input.maxTurns,
    generationMode: 'fresh',
    anchor: input.anchor,
    lastRevisionPrompt: null,
    tokenUsage: input.tokenUsage,
    estimatedCostUsd: input.estimatedCostUsd,
    evaluation: input.evaluation,
    repairPlan: input.repairPlan,
    referenceGuidanceNote: input.referenceGuidanceNote ?? null,
    status: 'candidate',
    tags: input.tags,
    notes: input.notes,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(record, input.pngBase64);
  return record;
}

export async function getTraitAsset(id: string): Promise<TraitAsset | null> {
  return readRecord(id);
}

/** In-place revision write-back — same id, bumped `revision`/`updatedAt`.
 *  Tags/notes are untouched (that's `patchTraitAssetMeta`'s job). */
export async function updateTraitAsset(id: string, input: {
  size: number;
  palette: string[];
  pixels: number[];
  modelPreset: ModelPreset;
  actualModel: string;
  maxTurns: number;
  anchor: string | null;
  revisionPrompt: string;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  evaluation: Evaluation;
  repairPlan: RepairPlan | null;
  pngBase64: string;
}): Promise<TraitAsset> {
  const existing = await readRecord(id);
  if (!existing) throw new Error('trait_not_found');
  const record: TraitAsset = {
    ...existing,
    size: input.size,
    palette: input.palette,
    pixels: input.pixels,
    modelPreset: input.modelPreset,
    actualModel: input.actualModel,
    maxTurns: input.maxTurns,
    generationMode: 'revision',
    anchor: input.anchor,
    lastRevisionPrompt: input.revisionPrompt,
    tokenUsage: input.tokenUsage,
    estimatedCostUsd: input.estimatedCostUsd,
    evaluation: input.evaluation,
    repairPlan: input.repairPlan,
    // Pixels changed — any prior human approval no longer applies to what's
    // now stored. Back to candidate regardless of what it was before.
    status: 'candidate',
    revision: existing.revision + 1,
    updatedAt: Date.now(),
  };
  await writeRecord(record, input.pngBase64);
  return record;
}

/** User-curated metadata + review status only — no AI call, no pixel
 *  change. This is the only path that ever moves a trait to 'approved'. */
export async function patchTraitAssetMeta(id: string, input: {
  tags?: string[];
  notes?: string | null;
  status?: TraitStatus;
  name?: string;
  zIndex?: number;
}): Promise<TraitAsset> {
  const existing = await readRecord(id);
  if (!existing) throw new Error('trait_not_found');
  const name = input.name !== undefined && input.name.trim() ? input.name.trim() : existing.name;
  const record: TraitAsset = {
    ...existing,
    tags: input.tags !== undefined ? input.tags : existing.tags,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    status: input.status !== undefined ? input.status : existing.status,
    name,
    slug: name !== existing.name ? makeSlug(name, existing.id) : existing.slug,
    zIndex: input.zIndex !== undefined ? input.zIndex : existing.zIndex,
    updatedAt: Date.now(),
  };
  await atomicWrite(jsonPath(record.id), JSON.stringify(record));
  return record;
}

export async function listTraitAssets(): Promise<TraitAssetSummary[]> {
  let files: string[];
  try {
    files = await fsp.readdir(TRAITS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids = files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length));
  const summaries: TraitAssetSummary[] = [];
  for (const id of ids) {
    try {
      const [record, rawPng] = await Promise.all([readRecord(id), fsp.readFile(pngPath(id))]);
      if (!record) continue;
      summaries.push({
        id: record.id,
        name: record.name,
        slug: record.slug,
        zIndex: record.zIndex,
        layerType: record.layerType,
        size: record.size,
        prompt: record.prompt,
        modelPreset: record.modelPreset,
        actualModel: record.actualModel,
        status: record.status,
        tags: record.tags,
        notes: record.notes,
        evaluation: record.evaluation,
        repairPlan: record.repairPlan,
        referenceGuidanceNote: record.referenceGuidanceNote,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        pngBase64: rawPng.toString('base64'),
      });
    } catch {
      // Skip a corrupt/partial entry rather than failing the whole list.
    }
  }
  summaries.sort((a, b) => b.createdAt - a.createdAt);
  return summaries;
}

export async function deleteTraitAsset(id: string): Promise<boolean> {
  let deleted = false;
  for (const p of [jsonPath(id), pngPath(id)]) {
    try {
      await fsp.unlink(p);
      deleted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}
