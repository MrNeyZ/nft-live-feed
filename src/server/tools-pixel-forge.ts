/**
 * Pixel-forge trait-library tool — personal use only, not a public feature.
 *
 * Claude expands a permanent trait library by drawing pixel-art layers via
 * tool calls (see src/pixel-agent/) — it never generates a final NFT
 * collection; a future, AI-free compositor reads the stored JSON grids
 * directly. Every route requires `requireAuth` (site-wide SIWS +
 * UI_ALLOWED_WALLETS gate), same as tools-dotland.ts, since this burns real
 * Anthropic credits per run.
 *
 * Cost control (operator is on a $5 starting budget):
 *   - Frontend never sends a raw model string, only a preset id
 *     (fast|normal|premium) mapped server-side to an actual model.
 *   - "premium" (Opus) requires PIXEL_FORGE_ALLOW_OPUS=true in env — off by
 *     default, rejected with `opus_disabled` otherwise. Never the default
 *     preset regardless.
 *   - maxTurns defaults scale with preset (4/8/12), hard cap 15 globally
 *     (src/pixel-agent/agent-loop.ts HARD_MAX_TURNS).
 *   - A rough pre-job cost estimate is logged before any API call; actual
 *     token usage + estimated cost is logged after completion.
 *   - A running job can be stopped mid-run (POST .../jobs/:id/stop) — the
 *     refine loop checks a cancel flag before every model call, including
 *     the evaluate call, so Stop actually saves the remaining spend.
 *
 *   POST   /api/tools/pixel-forge/jobs                — start a fresh-trait job
 *   POST   /api/tools/pixel-forge/jobs/:id/stop        — stop a running job early
 *   GET    /api/tools/pixel-forge/jobs/:id             — poll job status/progress
 *   POST   /api/tools/pixel-forge/traits/:id/revise    — revise an existing trait
 *   GET    /api/tools/pixel-forge/traits               — list saved traits
 *   GET    /api/tools/pixel-forge/traits/:id           — full trait record
 *   PATCH  /api/tools/pixel-forge/traits/:id           — edit tags/notes/status (no AI)
 *   DELETE /api/tools/pixel-forge/traits/:id           — discard a saved trait
 *   GET    /api/tools/pixel-forge/validation-previews  — read-only list of
 *     already-generated validation-run preview PNGs (no AI call, no write —
 *     see src/pixel-agent/validation-previews.ts; never touches the real
 *     trait store above)
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  runDrawingJob, runRevisionJob, anthropicApiKey, DEFAULT_PALETTE, DEFAULT_CANVAS_SIZE,
  HARD_MAX_TURNS, DrawingIteration, LAYER_TYPES, LayerType, ModelPreset, MODEL_PRESETS,
  PRESET_DEFAULT_MAX_TURNS, allowOpus, estimateJobCostUsd, TokenUsage, classifyAnthropicError,
} from '../pixel-agent/agent-loop';
import { Evaluation } from '../pixel-agent/tools';
import { buildRepairPlan, RepairPlan } from '../pixel-agent/repair-plan';
import {
  saveTraitAsset, getTraitAsset, updateTraitAsset, patchTraitAssetMeta,
  listTraitAssets, deleteTraitAsset, TraitStatus,
} from '../pixel-agent/store';
import { listValidationPreviews } from '../pixel-agent/validation-previews';
import {
  validateReferenceImage, analyzeReferenceImage, renderReferenceGuidanceText,
  ALLOWED_REFERENCE_MIME_TYPES, ReferenceMimeType,
} from '../pixel-agent/reference-analysis';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_PRESETS = new Set<string>(['fast', 'normal', 'premium']);
const ALLOWED_LAYER_TYPES = new Set<string>(LAYER_TYPES);
const ALLOWED_STATUSES = new Set<string>(['candidate', 'approved', 'rejected']);
const MIN_CANVAS = 8;
const MAX_CANVAS = 48;
const MAX_ANCHOR_LEN = 200;
const MAX_PROMPT_LEN = 2000;
const MAX_NOTES_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_NAME_LEN = 80;
const MIN_Z_INDEX = -1000;
const MAX_Z_INDEX = 1000;
const MAX_JOBS_TRACKED = 50;

function parseZIndex(raw: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_Z_INDEX || n > MAX_Z_INDEX) return { ok: false };
  return { ok: true, value: n };
}

function parseName(raw: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.length > MAX_NAME_LEN) return { ok: false };
  return { ok: true, value: raw };
}

/** Structural-only parse of the optional `referenceImage` body field —
 *  shape and mime-type allow-list only. The actual decode/size/dimension
 *  check (`validateReferenceImage`, async, uses sharp) happens separately
 *  in the route handler, since it needs to be awaited. */
function parseReferenceImageInput(raw: unknown): { ok: true; value: { base64: string; mimeType: ReferenceMimeType } | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const r = raw as Record<string, unknown>;
  if (typeof r.base64 !== 'string' || r.base64.length === 0) return { ok: false };
  if (typeof r.mimeType !== 'string' || !ALLOWED_REFERENCE_MIME_TYPES.has(r.mimeType)) return { ok: false };
  return { ok: true, value: { base64: r.base64, mimeType: r.mimeType as ReferenceMimeType } };
}

type JobStatus = 'running' | 'done' | 'error';
type JobResult = {
  variantId: string; pngBase64: string; evaluation: Evaluation; repairPlan: RepairPlan | null;
  tokenUsage: TokenUsage; estimatedCostUsd: number | null;
  referenceGuidanceNote: string | null;
};

interface JobState {
  status: JobStatus;
  iterations: DrawingIteration[];
  result?: JobResult;
  /** Safe machine-readable code for the UI to map to copy — never the raw
   *  provider error (see classifyAnthropicError). */
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  cancelRequested: boolean;
}

const jobs = new Map<string, JobState>();

function pruneOldJobs(): void {
  if (jobs.size <= MAX_JOBS_TRACKED) return;
  const oldest = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [id] of oldest.slice(0, jobs.size - MAX_JOBS_TRACKED)) jobs.delete(id);
}

function normalizePalette(input: unknown): string[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') return null;
    const hex = v.startsWith('#') ? v : `#${v}`;
    if (!HEX_COLOR_RE.test(hex)) return null;
    out.push(hex);
  }
  return out;
}

function normalizeTags(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_TAGS) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TAG_LEN) return null;
    out.push(v.trim());
  }
  return out;
}

/** Strip the "transparent" sentinel back to the hex-only list agent-loop expects. */
function unwrapPalette(palette: string[]): string[] {
  return palette[0] === 'transparent' ? palette.slice(1) : palette;
}

export function createPixelForgeRouter(): Router {
  const router = Router();
  // Separate buckets: a run-starting job costs real credits and stays tight
  // (10/min); everything else — polling GET /jobs/:id every ~1.5s while a
  // job runs, gallery reads, tag/status edits — must NOT share that budget.
  // A single shared bucket here previously meant polling alone exhausted it
  // in ~15-20s and 429'd the UI mid-generation, with Anthropic never even
  // being the cause.
  const startLimit = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/pixel-forge:start' });
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge:rw' });

  router.post('/tools/pixel-forge/jobs', startLimit, requireAuth, async (req: Request, res: Response) => {
    if (!anthropicApiKey()) {
      return res.status(503).json({ ok: false, error: 'anthropic_api_key_not_configured' });
    }

    const body = req.body as {
      prompt?: unknown; layerType?: unknown; canvasSize?: unknown; palette?: unknown;
      modelPreset?: unknown; maxTurns?: unknown; anchor?: unknown; tags?: unknown; notes?: unknown;
      name?: unknown; zIndex?: unknown; referenceImage?: unknown; referenceRightsConfirmed?: unknown;
    };

    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0 || body.prompt.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ ok: false, error: 'invalid_prompt' });
    }

    if (typeof body.layerType !== 'string' || !ALLOWED_LAYER_TYPES.has(body.layerType)) {
      return res.status(400).json({ ok: false, error: 'invalid_layer_type' });
    }
    const layerType = body.layerType as LayerType;

    let canvasSize = DEFAULT_CANVAS_SIZE;
    if (body.canvasSize !== undefined) {
      const n = Number(body.canvasSize);
      if (!Number.isInteger(n) || n < MIN_CANVAS || n > MAX_CANVAS) {
        return res.status(400).json({ ok: false, error: 'invalid_canvas_size' });
      }
      canvasSize = n;
    }

    const palette = normalizePalette(body.palette);
    if (body.palette !== undefined && palette === null) {
      return res.status(400).json({ ok: false, error: 'invalid_palette' });
    }

    let modelPreset: ModelPreset = 'normal';
    if (body.modelPreset !== undefined) {
      if (typeof body.modelPreset !== 'string' || !ALLOWED_PRESETS.has(body.modelPreset)) {
        return res.status(400).json({ ok: false, error: 'invalid_model_preset' });
      }
      modelPreset = body.modelPreset as ModelPreset;
    }
    if (modelPreset === 'premium' && !allowOpus()) {
      return res.status(403).json({ ok: false, error: 'opus_disabled' });
    }
    const actualModel = MODEL_PRESETS[modelPreset];

    let maxTurns = PRESET_DEFAULT_MAX_TURNS[modelPreset];
    if (body.maxTurns !== undefined) {
      const n = Number(body.maxTurns);
      if (!Number.isInteger(n) || n < 1 || n > HARD_MAX_TURNS) {
        return res.status(400).json({ ok: false, error: 'invalid_max_turns' });
      }
      maxTurns = n;
    }

    let anchor: string | undefined;
    if (body.anchor !== undefined) {
      if (typeof body.anchor !== 'string' || body.anchor.length > MAX_ANCHOR_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_anchor' });
      }
      anchor = body.anchor.trim() || undefined;
    }

    const tags = normalizeTags(body.tags);
    if (tags === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });

    let notes: string | null = null;
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_notes' });
      }
      notes = body.notes.trim() || null;
    }

    const nameResult = parseName(body.name);
    if (!nameResult.ok) return res.status(400).json({ ok: false, error: 'invalid_name' });
    const zIndexResult = parseZIndex(body.zIndex);
    if (!zIndexResult.ok) return res.status(400).json({ ok: false, error: 'invalid_z_index' });

    // Reference Mode MVP — see docs/pixel-forge-reference-mode-mvp.md.
    // Structural parse, then (if present) the real decode/size/dimension
    // check. `referenceBuffer` below is a local variable only — it is
    // never written to disk, never attached to `runDrawingJob`, and is
    // dropped once `analyzeReferenceImage` (currently a mock) resolves.
    const referenceImageResult = parseReferenceImageInput(body.referenceImage);
    if (!referenceImageResult.ok) return res.status(400).json({ ok: false, error: 'invalid_reference_image' });
    let referenceBuffer: Buffer | undefined;
    let referenceMimeType: ReferenceMimeType | undefined;
    if (referenceImageResult.value) {
      if (body.referenceRightsConfirmed !== true) {
        return res.status(400).json({ ok: false, error: 'reference_rights_not_confirmed' });
      }
      const validated = await validateReferenceImage(referenceImageResult.value);
      if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });
      referenceBuffer = validated.buffer;
      referenceMimeType = validated.mimeType;
    }

    const jobId = randomUUID();
    const job: JobState = { status: 'running', iterations: [], createdAt: Date.now(), cancelRequested: false };
    jobs.set(jobId, job);
    pruneOldJobs();

    const estimatedCostUsd = estimateJobCostUsd(actualModel, canvasSize, maxTurns, false);
    console.log('[tools/pixel-forge] starting job', {
      jobId, modelPreset, actualModel, canvasSize, maxTurns, layerType, estimatedCostUsd,
    });

    const prompt = body.prompt.trim();
    const finalPalette = palette ?? [...DEFAULT_PALETTE];
    void (async () => {
      // Reference Mode MVP: analysis (currently mocked, no Anthropic call —
      // see reference-analysis.ts) happens here, before runDrawingJob, and
      // its result is TEXT ONLY. `referenceBuffer` is not read again after
      // this call and is never passed to runDrawingJob — see design doc §5.
      let referenceGuidanceText: string | undefined;
      let referenceGuidanceNote: string | null = null;
      if (referenceBuffer && referenceMimeType) {
        const guidance = await analyzeReferenceImage({ buffer: referenceBuffer, mimeType: referenceMimeType });
        referenceGuidanceText = renderReferenceGuidanceText(guidance) || undefined;
        referenceGuidanceNote = guidance.note;
      }

      const result = await runDrawingJob(
        {
          prompt, canvasSize, palette: finalPalette, model: actualModel, maxTurns, layerType, anchor,
          referenceGuidance: referenceGuidanceText,
          shouldStop: () => job.cancelRequested,
        },
        (iter) => { job.iterations.push(iter); },
      );

      // Only build a RepairPlan from a genuine grade — a job stopped before
      // the evaluate step has an empty, ungraded `evaluation.issues`, which
      // would otherwise misread as "nothing wrong." See repair-plan.ts.
      const repairPlan: RepairPlan | null = result.graded
        ? buildRepairPlan({
            sourceRevision: 0, subject: prompt, evaluation: result.evaluation,
            previousPlan: null, now: Date.now(),
          })
        : null;
      const variant = await saveTraitAsset({
        prompt, layerType, size: result.size, palette: result.palette, pixels: result.pixels,
        modelPreset, actualModel, maxTurns, anchor: result.anchor, tokenUsage: result.tokenUsage,
        estimatedCostUsd: result.estimatedCostUsd, evaluation: result.evaluation, repairPlan, tags, notes,
        name: nameResult.value, zIndex: zIndexResult.value, pngBase64: result.pngBase64,
        referenceGuidanceNote,
      });
      job.status = 'done';
      job.result = {
        variantId: variant.id, pngBase64: result.pngBase64, evaluation: result.evaluation, repairPlan,
        tokenUsage: result.tokenUsage, estimatedCostUsd: result.estimatedCostUsd, referenceGuidanceNote,
      };
    })().catch((err) => {
      const { code, safeMessage } = classifyAnthropicError(err);
      job.status = 'error';
      job.errorCode = code;
      job.errorMessage = safeMessage;
      console.error('[tools/pixel-forge] job error', code, err instanceof Error ? err.message : String(err));
    });

    return res.json({ ok: true, jobId });
  });

  router.post('/tools/pixel-forge/traits/:id/revise', startLimit, requireAuth, async (req: Request, res: Response) => {
    if (!anthropicApiKey()) {
      return res.status(503).json({ ok: false, error: 'anthropic_api_key_not_configured' });
    }
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });

    const asset = await getTraitAsset(id).catch(() => null);
    if (!asset) return res.status(404).json({ ok: false, error: 'trait_not_found' });

    const body = req.body as { prompt?: unknown; modelPreset?: unknown; maxTurns?: unknown };
    // `prompt` (free-text human instructions) is now optional: a revision
    // can be driven entirely by the trait's stored repairPlan (see
    // docs/pixel-forge-revision-v3.md §8.3) — the UI no longer requires a
    // human to manually retype/copy missingFeatures. Still require SOME
    // direction: either non-empty text, or a repair plan with open issues.
    if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.length > MAX_PROMPT_LEN)) {
      return res.status(400).json({ ok: false, error: 'invalid_prompt' });
    }
    const revisionPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const hasRepairWork = (asset.repairPlan?.issues.length ?? 0) > 0;
    if (revisionPrompt.length === 0 && !hasRepairWork) {
      return res.status(400).json({ ok: false, error: 'invalid_prompt' });
    }

    let modelPreset: ModelPreset = asset.modelPreset;
    if (body.modelPreset !== undefined) {
      if (typeof body.modelPreset !== 'string' || !ALLOWED_PRESETS.has(body.modelPreset)) {
        return res.status(400).json({ ok: false, error: 'invalid_model_preset' });
      }
      modelPreset = body.modelPreset as ModelPreset;
    }
    if (modelPreset === 'premium' && !allowOpus()) {
      return res.status(403).json({ ok: false, error: 'opus_disabled' });
    }
    const actualModel = MODEL_PRESETS[modelPreset];

    let maxTurns = PRESET_DEFAULT_MAX_TURNS[modelPreset];
    if (body.maxTurns !== undefined) {
      const n = Number(body.maxTurns);
      if (!Number.isInteger(n) || n < 1 || n > HARD_MAX_TURNS) {
        return res.status(400).json({ ok: false, error: 'invalid_max_turns' });
      }
      maxTurns = n;
    }

    const jobId = randomUUID();
    const job: JobState = { status: 'running', iterations: [], createdAt: Date.now(), cancelRequested: false };
    jobs.set(jobId, job);
    pruneOldJobs();

    const estimatedCostUsd = estimateJobCostUsd(actualModel, asset.size, maxTurns, true);
    console.log('[tools/pixel-forge] starting revision', {
      jobId, traitId: id, modelPreset, actualModel, maxTurns, estimatedCostUsd,
    });

    void runRevisionJob(
      {
        existingPixels: asset.pixels, size: asset.size, palette: unwrapPalette(asset.palette),
        layerType: asset.layerType, anchor: asset.anchor ?? undefined, revisionPrompt,
        repairPlan: asset.repairPlan ?? null,
        model: actualModel, maxTurns, shouldStop: () => job.cancelRequested,
      },
      (iter) => { job.iterations.push(iter); },
    ).then(async (result) => {
      // Same rule as the fresh-draft path: only recompute the plan from a
      // genuine grade. If this round was stopped before evaluating, the
      // trait's repair plan is unchanged from before this revision ran.
      const repairPlan: RepairPlan | null = result.graded
        ? buildRepairPlan({
            sourceRevision: asset.revision + 1, subject: asset.prompt, evaluation: result.evaluation,
            previousPlan: asset.repairPlan ?? null, now: Date.now(),
          })
        : (asset.repairPlan ?? null);
      const variant = await updateTraitAsset(id, {
        size: result.size, palette: result.palette, pixels: result.pixels, modelPreset, actualModel,
        maxTurns, anchor: result.anchor, revisionPrompt, tokenUsage: result.tokenUsage,
        estimatedCostUsd: result.estimatedCostUsd, evaluation: result.evaluation, repairPlan, pngBase64: result.pngBase64,
      });
      job.status = 'done';
      job.result = {
        variantId: variant.id, pngBase64: result.pngBase64, evaluation: result.evaluation, repairPlan,
        tokenUsage: result.tokenUsage, estimatedCostUsd: result.estimatedCostUsd,
        // Reference Mode is generation-only (design doc §6) — revision never
        // touches it; `updateTraitAsset` also leaves any existing trait's
        // `referenceGuidanceNote` untouched via its `...existing` spread.
        referenceGuidanceNote: null,
      };
    }).catch((err) => {
      const { code, safeMessage } = classifyAnthropicError(err);
      job.status = 'error';
      job.errorCode = code;
      job.errorMessage = safeMessage;
      console.error('[tools/pixel-forge] revision error', code, err instanceof Error ? err.message : String(err));
    });

    return res.json({ ok: true, jobId });
  });

  router.post('/tools/pixel-forge/jobs/:id/stop', limit, requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    if (job.status !== 'running') return res.status(409).json({ ok: false, error: 'job_not_running' });
    job.cancelRequested = true;
    return res.json({ ok: true });
  });

  router.get('/tools/pixel-forge/jobs/:id', limit, requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    return res.json({
      ok: true,
      status: job.status,
      iterations: job.iterations,
      result: job.result,
      errorCode: job.errorCode,
      error: job.errorMessage,
    });
  });

  router.get('/tools/pixel-forge/traits', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const traits = await listTraitAssets();
      return res.json({ ok: true, traits });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });
    try {
      const trait = await getTraitAsset(id);
      if (!trait) return res.status(404).json({ ok: false, error: 'trait_not_found' });
      return res.json({ ok: true, trait });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.patch('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });

    const body = req.body as {
      tags?: unknown; notes?: unknown; status?: unknown; name?: unknown; zIndex?: unknown;
    };
    let tags: string[] | undefined;
    if (body.tags !== undefined) {
      const normalized = normalizeTags(body.tags);
      if (normalized === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });
      tags = normalized;
    }
    let notes: string | null | undefined;
    if (body.notes !== undefined) {
      if (body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LEN)) {
        return res.status(400).json({ ok: false, error: 'invalid_notes' });
      }
      notes = body.notes === null ? null : body.notes.trim() || null;
    }
    let status: TraitStatus | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status)) {
        return res.status(400).json({ ok: false, error: 'invalid_status' });
      }
      status = body.status as TraitStatus;
    }
    const nameResult = parseName(body.name);
    if (!nameResult.ok) return res.status(400).json({ ok: false, error: 'invalid_name' });
    const zIndexResult = parseZIndex(body.zIndex);
    if (!zIndexResult.ok) return res.status(400).json({ ok: false, error: 'invalid_z_index' });

    try {
      const trait = await patchTraitAssetMeta(id, {
        tags, notes, status, name: nameResult.value, zIndex: zIndexResult.value,
      });
      return res.json({ ok: true, trait });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'trait_not_found') return res.status(404).json({ ok: false, error: msg });
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.delete('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });
    try {
      const deleted = await deleteTraitAsset(id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'trait_not_found' });
      return res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  // Read-only, no AI call — see src/pixel-agent/validation-previews.ts.
  // Deliberately no PATCH/DELETE counterpart: validation previews are not
  // editable/deletable trait records, just a display of files already on
  // disk under data/pixel-forge/validation-runs/.
  router.get('/tools/pixel-forge/validation-previews', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const previews = await listValidationPreviews();
      return res.json({ ok: true, previews });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
