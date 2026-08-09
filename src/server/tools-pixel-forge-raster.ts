/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 1+2+3+4+5 (Raster Normalize /
 * Cleanup / Split preview / Repair / Import / Split import).
 * See docs/pixel-forge-image-to-traits-pipeline-mvp.md for the full design
 * this implements — this file is Stage 1 (manual upload → normalize to a
 * fixed grid → preview variants → import the chosen one as a normal
 * candidate TraitAsset) plus Stage 2 (optional deterministic despeckle/
 * hole-fill cleanup pass, see raster-convert.ts's cleanupRasterImage, run
 * over the Stage 1 variants before preview/import) plus Stage 3 (deterministic
 * semantic split MVP — see raster-split.ts's splitRasterImage — proposes
 * background/hat/body/head/face-mask/eyes/mouth layer candidates for a
 * normalized variant, preview only) plus Stage 4 (optional deterministic
 * repair pass — see raster-repair.ts's repairRasterImage — a broader,
 * strength-tunable sibling of Stage 2's cleanup: alpha-fringe snapping,
 * tiny-component/hole repair, outline consistency, and in-region palette
 * smoothing, run on the BASE variant independently of Stage 2's cleanup, not
 * chained after it) plus Stage 5 (promotes selected Stage 3 split layers
 * into real per-layer candidate `TraitAsset`s — the one piece Stage 3 was
 * explicitly missing). No Anthropic call, no OpenAI call, no generation —
 * every route here is pure local image processing (sharp) + the existing
 * trait store. Explicitly NOT implemented here (later stages, see the
 * design doc): Claude artifact review, ZIP export, OpenAI image generation.
 *
 * Companion to tools-pixel-forge.ts (kept separate — that file is already
 * large) — same `requireAuth` gate, same style. Conversion primitives live
 * in ../pixel-agent/raster-convert.ts, shared with the offline CLI
 * prototype (src/scripts/pixel-forge-raster-to-pixel.ts).
 *
 *   POST /api/tools/pixel-forge/raster/normalize — upload + convert, writes
 *     temporary variants under data/pixel-forge/raster-experiments/<id>/,
 *     returns them for preview. Creates NO TraitAsset.
 *   POST /api/tools/pixel-forge/raster/import — turns one previously
 *     normalized variant into a real candidate TraitAsset via the same
 *     `saveTraitAsset` every real generation writes through.
 *   POST /api/tools/pixel-forge/raster/split — proposes a semantic layer
 *     split for one previously normalized variant. Preview only — reads
 *     the variant's already-written raw PNG, computes candidate layers,
 *     returns them as base64 PNGs + metadata. Writes nothing to disk,
 *     creates no TraitAsset.
 *   POST /api/tools/pixel-forge/raster/import-split — re-runs that same
 *     split (deterministic, so no separate cache needed) and turns each
 *     selected layer into its own real candidate TraitAsset via
 *     `saveTraitAsset`, exactly like /raster/import does for a whole variant.
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  loadRawRgba, squareFit, estimateBackgroundColor, applyBackgroundRemoval, buildNearestVariant,
  quantizeToPalette, deriveSourcePalette, rgbaToPngBase64, cleanupRasterImage, RgbaImage,
} from '../pixel-agent/raster-convert';
import { splitRasterImage, SPLIT_LAYER_IDS, SplitLayerId } from '../pixel-agent/raster-split';
import { repairRasterImage, RepairStrength } from '../pixel-agent/raster-repair';
import { LayerType, LAYER_TYPES } from '../pixel-agent/agent-loop';
import { EVALUATION_SCHEMA_VERSION, Evaluation } from '../pixel-agent/tools';
import { saveTraitAsset } from '../pixel-agent/store';
import { getCollection } from '../pixel-agent/collections-store';

const RASTER_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'raster-experiments');
const EXPERIMENT_ID_RE = /^[0-9a-f-]{36}$/i; // randomUUID shape only — never trust path input beyond this
const COLLECTION_ID_RE = /^[a-z0-9-]{1,64}$/;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
// Generous vs. reference-analysis.ts's 2MB/1024px caps — this is a full
// source NFT image, not a style hint.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MIN_TARGET_SIZE = 8;
const MAX_TARGET_SIZE = 48; // mirrors tools-pixel-forge.ts's MAX_CANVAS — an imported trait is still a normal TraitAsset
const DEFAULT_TARGET_SIZE = 48;
const DEFAULT_BG_THRESHOLD = 24;
const PALETTE_MAX_COLORS = 16; // curated, small — see raster-convert.ts's deriveSourcePalette doc comment
const PREVIEW_UPSCALE = 8; // matches agent-loop.ts's own PREVIEW_UPSCALE
const MAX_NAME_LEN = 80;
const MAX_NOTES_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const ALLOWED_LAYER_TYPES = new Set<string>(LAYER_TYPES);
const RASTER_IMPORT_TAG = 'raster-import';
// Stage 5 — see the /raster/import-split route below.
const SPLIT_IMPORT_TAG = 'raster-split';
const DEFAULT_SPLIT_BASE_NAME = 'Split';
// Leaves headroom under MAX_NAME_LEN (80) for " - " + the longest layer
// label (e.g. "Nose / Mouth", "Hat / Accessory") once combined.
const MAX_SPLIT_BASE_NAME_LEN = 40;
const DEFAULT_SPLIT_CONFIDENCE_INCLUDE = new Set(['high', 'medium']);
// Stage 2 — see raster-convert.ts's cleanupRasterImage doc comment.
const DEFAULT_MIN_COMPONENT_SIZE = 2;
const MIN_COMPONENT_SIZE_FLOOR = 1;
const MIN_COMPONENT_SIZE_CEIL = 20;
// Stage 4 — see raster-repair.ts's repairRasterImage doc comment.
const DEFAULT_REPAIR_STRENGTH: RepairStrength = 'safe';
const ALLOWED_REPAIR_STRENGTHS = new Set<RepairStrength>(['safe', 'medium']);

type BaseVariantId = 'nearest-keep' | 'nearest-remove' | 'quantized-keep' | 'quantized-remove';
type VariantId = BaseVariantId
  | 'nearest-keep-clean' | 'nearest-remove-clean' | 'quantized-keep-clean' | 'quantized-remove-clean'
  | 'nearest-keep-repair' | 'nearest-remove-repair' | 'quantized-keep-repair' | 'quantized-remove-repair';
const VARIANT_IDS: readonly VariantId[] = [
  'nearest-keep', 'nearest-remove', 'quantized-keep', 'quantized-remove',
  'nearest-keep-clean', 'nearest-remove-clean', 'quantized-keep-clean', 'quantized-remove-clean',
  'nearest-keep-repair', 'nearest-remove-repair', 'quantized-keep-repair', 'quantized-remove-repair',
];

/** One variant's change-tracking fields, shared by the Stage 2 (cleanup)
 *  and Stage 4 (repair) transforms — a given variant is always exactly one
 *  of "plain," "-clean," or "-repair," never more than one at once, so
 *  reusing `pixelsChanged`/`componentsRemoved` across both transforms
 *  (rather than two near-duplicate field pairs) stays unambiguous per
 *  variant while keeping the manifest shape flat. */
interface VariantChangeStats {
  cleanupApplied: boolean;
  pixelsChanged: number;
  componentsRemoved: number;
  repairApplied: boolean;
  repairStrength: RepairStrength | null;
  holesFilled: number;
  outlinePixelsAdjusted: number;
  warnings: string[];
}

interface VariantManifestEntry extends VariantChangeStats {
  variantId: VariantId;
  label: string;
  size: number;
  paletteSize: number;
  backgroundMode: 'keep' | 'remove';
  minComponentSize: number;
}
interface ExperimentManifest {
  experimentId: string;
  size: number;
  bgThreshold: number;
  createdAt: number;
  variants: VariantManifestEntry[];
}

function experimentDir(experimentId: string): string {
  return path.join(RASTER_DIR, experimentId);
}
function variantJsonPath(experimentId: string, variantId: string): string {
  return path.join(experimentDir(experimentId), `${variantId}.json`);
}
function variantRawPngPath(experimentId: string, variantId: string): string {
  return path.join(experimentDir(experimentId), `${variantId}-raw.png`);
}
function variantPreviewPngPath(experimentId: string, variantId: string): string {
  return path.join(experimentDir(experimentId), `${variantId}-preview.png`);
}
function manifestPath(experimentId: string): string {
  return path.join(experimentDir(experimentId), 'manifest.json');
}

async function writeVariant(
  experimentId: string, variantId: VariantId, img: RgbaImage, palette: string[], pixels: number[],
): Promise<void> {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png().toFile(variantRawPngPath(experimentId, variantId));
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(img.width * PREVIEW_UPSCALE, img.height * PREVIEW_UPSCALE, { kernel: 'nearest' })
    .png().toFile(variantPreviewPngPath(experimentId, variantId));
  await fsp.writeFile(
    variantJsonPath(experimentId, variantId),
    JSON.stringify({ size: img.width, palette: ['transparent', ...palette], pixels }),
  );
}

function parsePositiveInt(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
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

/** Honest "not a real generation" placeholder — never invented grading.
 *  Mirrors agent-loop.ts's own STOPPED_EVALUATION shape/spirit for a trait
 *  that never actually ran through the drawing/evaluate loop. */
function importPlaceholderEvaluation(): Evaluation {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    blindDescription: '',
    recognizableAsSubject: false,
    issues: [],
    preserve: [],
    doNotModify: [],
    intentionalChoices: [],
    notes: 'Not evaluated — imported from an external raster conversion; no self-grading was performed.',
  };
}

export function createPixelForgeRasterRouter(): Router {
  const router = Router();
  // Everything here is local image processing or a plain file write — no
  // Anthropic call anywhere in this router — so the generous shared `limit`
  // bucket applies uniformly (matching every non-Anthropic route in
  // tools-pixel-forge.ts); no need for that file's tighter `startLimit`.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-raster' });

  router.post('/tools/pixel-forge/raster/normalize', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      imageBase64?: unknown; mimeType?: unknown; targetSize?: unknown; bgThreshold?: unknown;
      cleanup?: unknown; minComponentSize?: unknown; preserveSmallDarkDetails?: unknown;
      repair?: unknown; repairStrength?: unknown; preserveSmallDetails?: unknown;
    };

    if (typeof body.imageBase64 !== 'string' || body.imageBase64.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_image' });
    }
    if (typeof body.mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(body.mimeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_mime_type' });
    }
    const targetSize = parsePositiveInt(body.targetSize, DEFAULT_TARGET_SIZE, MIN_TARGET_SIZE, MAX_TARGET_SIZE);
    if (targetSize === null) return res.status(400).json({ ok: false, error: 'invalid_target_size' });
    const bgThreshold = parsePositiveInt(body.bgThreshold, DEFAULT_BG_THRESHOLD, 0, 255);
    if (bgThreshold === null) return res.status(400).json({ ok: false, error: 'invalid_bg_threshold' });
    if (body.cleanup !== undefined && typeof body.cleanup !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_cleanup' });
    }
    const cleanup = body.cleanup === true;
    const minComponentSize = parsePositiveInt(
      body.minComponentSize, DEFAULT_MIN_COMPONENT_SIZE, MIN_COMPONENT_SIZE_FLOOR, MIN_COMPONENT_SIZE_CEIL,
    );
    if (minComponentSize === null) return res.status(400).json({ ok: false, error: 'invalid_min_component_size' });
    if (body.preserveSmallDarkDetails !== undefined && typeof body.preserveSmallDarkDetails !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_preserve_small_dark_details' });
    }
    const preserveSmallDarkDetails = body.preserveSmallDarkDetails !== false; // default true

    if (body.repair !== undefined && typeof body.repair !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_repair' });
    }
    const repair = body.repair === true;
    if (body.repairStrength !== undefined && (typeof body.repairStrength !== 'string' || !ALLOWED_REPAIR_STRENGTHS.has(body.repairStrength as RepairStrength))) {
      return res.status(400).json({ ok: false, error: 'invalid_repair_strength' });
    }
    const repairStrength: RepairStrength = (body.repairStrength as RepairStrength | undefined) ?? DEFAULT_REPAIR_STRENGTH;
    if (body.preserveSmallDetails !== undefined && typeof body.preserveSmallDetails !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_preserve_small_details' });
    }
    const preserveSmallDetails = body.preserveSmallDetails !== false; // default true

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.imageBase64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
    }
    if (buffer.length === 0) return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
    if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: 'image_too_large' });

    let width: number | undefined, height: number | undefined;
    try {
      const meta = await sharp(buffer).metadata();
      width = meta.width; height = meta.height;
    } catch {
      return res.status(400).json({ ok: false, error: 'image_unreadable' });
    }
    if (!width || !height) return res.status(400).json({ ok: false, error: 'image_unreadable' });
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return res.status(400).json({ ok: false, error: 'image_dimensions_too_large' });
    }

    const experimentId = randomUUID();
    try {
      await fsp.mkdir(experimentDir(experimentId), { recursive: true });

      // Background color sampled from the ORIGINAL (pre-square-fit) image —
      // see raster-convert.ts's estimateBackgroundColor doc comment for why
      // sampling after padding would be wrong for non-square uploads.
      const originalRaw = await loadRawRgba(sharp(buffer).ensureAlpha());
      const bgColor = estimateBackgroundColor(originalRaw);
      const squareFitImg = await squareFit(buffer);

      const variants: VariantManifestEntry[] = [];
      const responseVariants: (VariantChangeStats & {
        variantId: VariantId; label: string; size: number; pngBase64: string; paletteSize: number;
      })[] = [];

      /** Writes one variant (dirty, cleaned, or repaired) and pushes its
       *  manifest/response entries. `img` must already be in its FINAL
       *  display state — this function only handles storage-palette
       *  derivation (nearest) or reuses a given palette (quantized),
       *  writing, and bookkeeping; it never itself runs cleanup, repair, or
       *  background removal. */
      const emitVariant = async (opts: {
        variantId: VariantId; label: string; backgroundMode: 'keep' | 'remove'; img: RgbaImage;
        /** undefined → derive a fresh top-K palette from `img` (the
         *  "nearest" family's bounded-approximation storage strategy).
         *  Provided → snap `img` against this EXACT palette instead,
         *  keeping `pixels`/`palette` a fully self-consistent
         *  reconstruction of `img` (the "quantized" family). */
        reusePalette?: string[];
        changes: VariantChangeStats;
      }): Promise<void> => {
        const { variantId, label, backgroundMode, img, reusePalette, changes } = opts;
        const palette = reusePalette ?? deriveSourcePalette(img, PALETTE_MAX_COLORS);
        // Quantize a SEPARATE copy for storage only when deriving fresh
        // (nearest family) — never mutate `img`, which is the exact bytes
        // already destined for the display PNG. When reusing a given
        // palette (quantized family), `img` IS already snapped to it (or,
        // for a "-clean"/"-repair" variant, needs re-snapping after the
        // transform may have introduced fill colors not exactly on the
        // palette) — either way quantizing a copy and discarding it is
        // cheap and always correct.
        const storageImg: RgbaImage = { width: img.width, height: img.height, data: Buffer.from(img.data) };
        const { pixelPaletteIndex } = quantizeToPalette(storageImg, palette);
        const displayPngBase64 = await rgbaToPngBase64(img);
        await writeVariant(experimentId, variantId, img, palette, pixelPaletteIndex);
        const paletteSize = palette.length + 1;
        variants.push({ variantId, label, size: targetSize, paletteSize, backgroundMode, minComponentSize, ...changes });
        responseVariants.push({ variantId, label, size: targetSize, pngBase64: displayPngBase64, paletteSize, ...changes });
      };

      const NO_CHANGES: VariantChangeStats = {
        cleanupApplied: false, pixelsChanged: 0, componentsRemoved: 0,
        repairApplied: false, repairStrength: null, holesFilled: 0, outlinePixelsAdjusted: 0, warnings: [],
      };
      const cleanupChanges = (stats: { pixelsChanged: number; componentsRemoved: number }): VariantChangeStats => ({
        cleanupApplied: true, pixelsChanged: stats.pixelsChanged, componentsRemoved: stats.componentsRemoved,
        repairApplied: false, repairStrength: null, holesFilled: 0, outlinePixelsAdjusted: 0, warnings: [],
      });
      const repairChanges = (stats: {
        pixelsChanged: number; componentsRemoved: number; holesFilled: number; outlinePixelsAdjusted: number; warnings: string[];
      }): VariantChangeStats => ({
        cleanupApplied: false, pixelsChanged: stats.pixelsChanged, componentsRemoved: stats.componentsRemoved,
        repairApplied: true, repairStrength, holesFilled: stats.holesFilled,
        outlinePixelsAdjusted: stats.outlinePixelsAdjusted, warnings: stats.warnings,
      });

      // ── nearest: true resize colors, no forced snap for DISPLAY. The
      // stored `palette`/`pixels` (required by store.ts's schema — see
      // normalizeTraitAsset) are still a bounded, source-derived
      // approximation, never "every distinct color" (a real earlier
      // manual import this pipeline was prototyped against produced a
      // 675-entry palette that way — see the design doc's §6 caveat).
      // `pngBase64` for these variants is always the EXACT resize (plus
      // cleanup/repair, when requested); only the internal pixels/palette
      // used if a variant is later imported are approximated.
      for (const [variantId, threshold, label, backgroundMode] of [
        ['nearest-keep', 0, 'Nearest — keep background', 'keep'],
        ['nearest-remove', bgThreshold, 'Nearest — background removed', 'remove'],
      ] as const) {
        const img = await buildNearestVariant(squareFitImg, targetSize, bgColor, threshold);
        await emitVariant({ variantId, label, backgroundMode, img, changes: NO_CHANGES });

        if (cleanup) {
          const cleanImg: RgbaImage = { width: img.width, height: img.height, data: Buffer.from(img.data) };
          const stats = cleanupRasterImage(cleanImg, { minComponentSize, preserveSmallDarkDetails });
          await emitVariant({
            variantId: `${variantId}-clean`, label: `${label} — cleaned`, backgroundMode, img: cleanImg,
            changes: cleanupChanges(stats),
          });
        }

        if (repair) {
          // Repairs the BASE (dirty) image — independent of `cleanup`,
          // never chained after it, per the task's own variant list
          // (repair variants are a parallel family, not "cleanup then
          // repair").
          const repairedImg: RgbaImage = { width: img.width, height: img.height, data: Buffer.from(img.data) };
          const stats = repairRasterImage(repairedImg, { strength: repairStrength, preserveSmallDetails });
          await emitVariant({
            variantId: `${variantId}-repair`, label: `${label} — repaired (${repairStrength})`, backgroundMode, img: repairedImg,
            changes: repairChanges(stats),
          });
        }
      }

      // ── quantized: source-derived palette, fully self-consistent —
      // `pixels`/`palette` exactly reconstruct `pngBase64` here, unlike
      // the nearest variants above. Two SEPARATE derived palettes: "keep"
      // derives from all opaque pixels (so the background itself has a
      // representative palette entry); "remove" derives AFTER stripping
      // background pixels, so every one of the limited palette slots goes
      // to the actual subject instead of one being spent on background.
      // The "-clean"/"-repair" variants reuse the SAME derived palette as
      // their dirty counterpart (rather than re-deriving one from the
      // transformed pixels) so paired keep/keep-clean/keep-repair (or
      // remove/remove-clean/remove-repair) variants stay directly
      // comparable, and re-snap against it afterward so `pixels`/`palette`
      // stay an exact reconstruction of the transformed PNG.
      for (const [variantId, removeBackground, label, backgroundMode] of [
        ['quantized-keep', false, 'Quantized (source palette) — keep background', 'keep'],
        ['quantized-remove', true, 'Quantized (source palette) — background removed', 'remove'],
      ] as const) {
        const resized = squareFitImg.clone().resize(targetSize, targetSize, { fit: 'fill' });
        const img = await loadRawRgba(resized);
        if (removeBackground) applyBackgroundRemoval(img, bgColor, bgThreshold);
        const palette = deriveSourcePalette(img, PALETTE_MAX_COLORS);
        quantizeToPalette(img, palette); // snaps `img` itself in place
        await emitVariant({ variantId, label, backgroundMode, img, reusePalette: palette, changes: NO_CHANGES });

        if (cleanup) {
          const cleanImg: RgbaImage = { width: img.width, height: img.height, data: Buffer.from(img.data) };
          const stats = cleanupRasterImage(cleanImg, { minComponentSize, preserveSmallDarkDetails });
          quantizeToPalette(cleanImg, palette); // re-snap after cleanup's fill colors
          await emitVariant({
            variantId: `${variantId}-clean`, label: `${label} — cleaned`, backgroundMode, img: cleanImg,
            reusePalette: palette, changes: cleanupChanges(stats),
          });
        }

        if (repair) {
          const repairedImg: RgbaImage = { width: img.width, height: img.height, data: Buffer.from(img.data) };
          const stats = repairRasterImage(repairedImg, { strength: repairStrength, preserveSmallDetails });
          quantizeToPalette(repairedImg, palette); // re-snap after repair's fill/smoothing colors
          await emitVariant({
            variantId: `${variantId}-repair`, label: `${label} — repaired (${repairStrength})`, backgroundMode, img: repairedImg,
            reusePalette: palette, changes: repairChanges(stats),
          });
        }
      }

      const manifest: ExperimentManifest = {
        experimentId, size: targetSize, bgThreshold, createdAt: Date.now(), variants,
      };
      await fsp.writeFile(manifestPath(experimentId), JSON.stringify(manifest));

      console.log('[tools/pixel-forge-raster] normalize', {
        experimentId, size: targetSize, bgThreshold, cleanup, minComponentSize,
        repair, repairStrength, preserveSmallDetails, variantCount: variants.length,
      });

      return res.json({ ok: true, experimentId, size: targetSize, variants: responseVariants });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-raster] normalize failed', msg);
      return res.status(502).json({ ok: false, error: 'normalize_failed' });
    }
  });

  router.post('/tools/pixel-forge/raster/import', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      experimentId?: unknown; variantId?: unknown; name?: unknown; layerType?: unknown;
      tags?: unknown; notes?: unknown; collectionId?: unknown;
    };

    if (typeof body.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(body.experimentId)) {
      return res.status(400).json({ ok: false, error: 'invalid_experiment_id' });
    }
    if (typeof body.variantId !== 'string' || !VARIANT_IDS.includes(body.variantId as VariantId)) {
      return res.status(400).json({ ok: false, error: 'invalid_variant_id' });
    }
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > MAX_NAME_LEN) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }
    if (typeof body.layerType !== 'string' || !ALLOWED_LAYER_TYPES.has(body.layerType)) {
      return res.status(400).json({ ok: false, error: 'invalid_layer_type' });
    }
    const layerType = body.layerType as LayerType;
    const tags = normalizeTags(body.tags);
    if (tags === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });
    if (!tags.includes(RASTER_IMPORT_TAG)) tags.push(RASTER_IMPORT_TAG);
    let notes: string | null = null;
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_notes' });
      }
      notes = body.notes.trim() || null;
    }

    let collectionId: string | null = null;
    let collectionPresetId: string | null = null;
    if (body.collectionId !== undefined) {
      if (typeof body.collectionId !== 'string' || !COLLECTION_ID_RE.test(body.collectionId)) {
        return res.status(400).json({ ok: false, error: 'invalid_collection_id' });
      }
      const resolved = await getCollection(body.collectionId);
      if (!resolved) return res.status(400).json({ ok: false, error: 'collection_not_found' });
      collectionId = resolved.id;
      collectionPresetId = resolved.presetId;
    }

    let manifestRaw: string;
    try {
      manifestRaw = await fsp.readFile(manifestPath(body.experimentId), 'utf8');
    } catch {
      return res.status(404).json({ ok: false, error: 'experiment_not_found' });
    }
    let manifest: ExperimentManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      return res.status(502).json({ ok: false, error: 'experiment_corrupt' });
    }
    const variantEntry = manifest.variants.find(v => v.variantId === body.variantId);
    if (!variantEntry) return res.status(404).json({ ok: false, error: 'variant_not_found' });

    let variantJson: { size: number; palette: string[]; pixels: number[] };
    let pngBase64: string;
    try {
      variantJson = JSON.parse(await fsp.readFile(variantJsonPath(body.experimentId, body.variantId), 'utf8'));
      pngBase64 = (await fsp.readFile(variantRawPngPath(body.experimentId, body.variantId))).toString('base64');
    } catch {
      return res.status(404).json({ ok: false, error: 'variant_files_missing' });
    }

    // saveTraitAsset always generates a fresh randomUUID id — this can
    // never overwrite an existing trait, and always lands as `candidate`
    // (see store.ts) — never auto-approved.
    const trait = await saveTraitAsset({
      prompt: 'N/A — imported from an external raster conversion, not generated by Claude. See notes.',
      layerType,
      size: variantJson.size,
      palette: variantJson.palette,
      pixels: variantJson.pixels,
      modelPreset: 'fast',
      actualModel: 'none (raster import — no AI call)',
      maxTurns: 0,
      anchor: null,
      tokenUsage: null,
      estimatedCostUsd: 0,
      evaluation: importPlaceholderEvaluation(),
      repairPlan: null,
      tags,
      notes: notes ?? `Imported from raster experiment data/pixel-forge/raster-experiments/${body.experimentId}/${body.variantId}-raw.png`,
      pngBase64,
      name: body.name,
      referenceGuidanceNote: null,
      collectionPresetId,
      collectionId,
    });

    console.log('[tools/pixel-forge-raster] import', {
      traitId: trait.id, experimentId: body.experimentId, variantId: body.variantId, collectionId,
    });

    return res.json({ ok: true, trait });
  });

  router.post('/tools/pixel-forge/raster/split', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { experimentId?: unknown; variantId?: unknown };

    if (typeof body.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(body.experimentId)) {
      return res.status(400).json({ ok: false, error: 'invalid_experiment_id' });
    }
    if (typeof body.variantId !== 'string' || !VARIANT_IDS.includes(body.variantId as VariantId)) {
      return res.status(400).json({ ok: false, error: 'invalid_variant_id' });
    }

    let manifestRaw: string;
    try {
      manifestRaw = await fsp.readFile(manifestPath(body.experimentId), 'utf8');
    } catch {
      return res.status(404).json({ ok: false, error: 'experiment_not_found' });
    }
    let manifest: ExperimentManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      return res.status(502).json({ ok: false, error: 'experiment_corrupt' });
    }
    const variantEntry = manifest.variants.find(v => v.variantId === body.variantId);
    if (!variantEntry) return res.status(404).json({ ok: false, error: 'variant_not_found' });

    try {
      // Split the variant's own already-written raw PNG (the exact bytes a
      // real import would use) — NOT the palette-quantized pixels/palette
      // JSON, which is only a bounded storage approximation for the
      // "nearest" family (see emitVariant's own doc comment above).
      const img = await loadRawRgba(sharp(variantRawPngPath(body.experimentId, body.variantId)));
      const result = splitRasterImage(img);

      const layers = await Promise.all(result.layers.map(async layer => ({
        layerId: layer.layerId,
        label: layer.label,
        suggestedLayerType: layer.suggestedLayerType,
        confidence: layer.confidence,
        method: layer.method,
        pixelCount: layer.pixelCount,
        bbox: layer.bbox,
        warnings: layer.warnings,
        pngBase64: await rgbaToPngBase64(layer.img),
      })));
      const compositePngBase64 = await rgbaToPngBase64(result.composite);

      console.log('[tools/pixel-forge-raster] split', {
        experimentId: body.experimentId, variantId: body.variantId,
        layerCounts: Object.fromEntries(layers.map(l => [l.layerId, l.pixelCount])),
      });

      return res.json({
        ok: true, experimentId: body.experimentId, variantId: body.variantId,
        layers, composite: compositePngBase64, warnings: result.warnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-raster] split failed', msg);
      return res.status(502).json({ ok: false, error: 'split_failed' });
    }
  });

  router.post('/tools/pixel-forge/raster/import-split', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      experimentId?: unknown; variantId?: unknown; selectedLayerIds?: unknown;
      collectionId?: unknown; baseName?: unknown; tags?: unknown; notes?: unknown;
    };

    if (typeof body.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(body.experimentId)) {
      return res.status(400).json({ ok: false, error: 'invalid_experiment_id' });
    }
    if (typeof body.variantId !== 'string' || !VARIANT_IDS.includes(body.variantId as VariantId)) {
      return res.status(400).json({ ok: false, error: 'invalid_variant_id' });
    }

    let selectedLayerIds: SplitLayerId[] | null = null;
    if (body.selectedLayerIds !== undefined) {
      if (!Array.isArray(body.selectedLayerIds) || body.selectedLayerIds.length > SPLIT_LAYER_IDS.length) {
        return res.status(400).json({ ok: false, error: 'invalid_selected_layer_ids' });
      }
      for (const v of body.selectedLayerIds) {
        if (typeof v !== 'string' || !SPLIT_LAYER_IDS.includes(v as SplitLayerId)) {
          return res.status(400).json({ ok: false, error: 'invalid_selected_layer_ids' });
        }
      }
      selectedLayerIds = body.selectedLayerIds as SplitLayerId[];
    }

    let baseName = DEFAULT_SPLIT_BASE_NAME;
    if (body.baseName !== undefined) {
      if (typeof body.baseName !== 'string' || body.baseName.length > MAX_SPLIT_BASE_NAME_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_base_name' });
      }
      const trimmed = body.baseName.trim();
      if (trimmed) baseName = trimmed;
    }

    const tags = normalizeTags(body.tags);
    if (tags === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });
    if (!tags.includes(RASTER_IMPORT_TAG)) tags.push(RASTER_IMPORT_TAG);
    if (!tags.includes(SPLIT_IMPORT_TAG)) tags.push(SPLIT_IMPORT_TAG);

    let userNotes: string | null = null;
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_notes' });
      }
      userNotes = body.notes.trim() || null;
    }

    let collectionId: string | null = null;
    let collectionPresetId: string | null = null;
    if (body.collectionId !== undefined && body.collectionId !== null) {
      if (typeof body.collectionId !== 'string' || !COLLECTION_ID_RE.test(body.collectionId)) {
        return res.status(400).json({ ok: false, error: 'invalid_collection_id' });
      }
      const resolved = await getCollection(body.collectionId);
      if (!resolved) return res.status(400).json({ ok: false, error: 'collection_not_found' });
      collectionId = resolved.id;
      collectionPresetId = resolved.presetId;
    }

    let manifestRaw: string;
    try {
      manifestRaw = await fsp.readFile(manifestPath(body.experimentId), 'utf8');
    } catch {
      return res.status(404).json({ ok: false, error: 'experiment_not_found' });
    }
    let manifest: ExperimentManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      return res.status(502).json({ ok: false, error: 'experiment_corrupt' });
    }
    const variantEntry = manifest.variants.find(v => v.variantId === body.variantId);
    if (!variantEntry) return res.status(404).json({ ok: false, error: 'variant_not_found' });

    try {
      // Re-run split fresh from the variant's own already-written raw PNG —
      // deterministic (same input always produces the same layers), so this
      // is exactly equivalent to reusing a cached result but needs no new
      // persisted state, matching /raster/split's own "preview is never
      // persisted" spirit right up until the moment of import below.
      const img = await loadRawRgba(sharp(variantRawPngPath(body.experimentId, body.variantId)));
      const result = splitRasterImage(img);

      const created: { id: string; name: string; layerId: SplitLayerId }[] = [];
      const skipped: { layerId: SplitLayerId; reason: string }[] = [];

      for (const layer of result.layers) {
        const isSelected = selectedLayerIds
          ? selectedLayerIds.includes(layer.layerId)
          : DEFAULT_SPLIT_CONFIDENCE_INCLUDE.has(layer.confidence);
        if (!isSelected) continue;
        if (layer.pixelCount === 0) {
          skipped.push({ layerId: layer.layerId, reason: 'empty_layer' });
          continue;
        }

        // Self-consistent storage palette/pixels, same approach as the
        // "quantized" variant family in /raster/normalize — a split layer's
        // color population is already a bounded subset of the source
        // image's, so this quantization is near-lossless in practice, and
        // `pngBase64` below reflects the post-snap pixels exactly.
        const layerPalette = deriveSourcePalette(layer.img, PALETTE_MAX_COLORS);
        const storageImg: RgbaImage = { width: layer.img.width, height: layer.img.height, data: Buffer.from(layer.img.data) };
        const { pixelPaletteIndex } = quantizeToPalette(storageImg, layerPalette);
        const pngBase64 = await rgbaToPngBase64(storageImg);

        const provenanceNote = `Imported from raster split — experiment ${body.experimentId}, variant ${body.variantId}, `
          + `layer ${layer.layerId} (confidence: ${layer.confidence})`
          + (layer.warnings.length > 0 ? `; warnings: ${layer.warnings.join('; ')}` : '');
        const notes = userNotes ? `${userNotes}\n\n${provenanceNote}` : provenanceNote;

        const layerTags = [...tags, layer.layerId].filter((t, i, arr) => arr.indexOf(t) === i);

        // saveTraitAsset always generates a fresh randomUUID id — this can
        // never overwrite an existing trait, and always lands as
        // `candidate` (see store.ts) — never auto-approved.
        const trait = await saveTraitAsset({
          prompt: 'N/A — imported from a deterministic raster split, not generated by Claude. See notes.',
          layerType: layer.suggestedLayerType,
          size: storageImg.width,
          palette: ['transparent', ...layerPalette],
          pixels: pixelPaletteIndex,
          modelPreset: 'fast',
          actualModel: 'none (raster split import — no AI call)',
          maxTurns: 0,
          anchor: null,
          tokenUsage: null,
          estimatedCostUsd: 0,
          evaluation: importPlaceholderEvaluation(),
          repairPlan: null,
          tags: layerTags,
          notes,
          pngBase64,
          name: `${baseName} - ${layer.label}`,
          referenceGuidanceNote: null,
          collectionPresetId,
          collectionId,
        });
        created.push({ id: trait.id, name: trait.name, layerId: layer.layerId });
      }

      console.log('[tools/pixel-forge-raster] import-split', {
        experimentId: body.experimentId, variantId: body.variantId, collectionId,
        createdCount: created.length, skippedCount: skipped.length,
      });

      return res.json({
        ok: true, experimentId: body.experimentId, variantId: body.variantId,
        created, skipped, warnings: result.warnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-raster] import-split failed', msg);
      return res.status(502).json({ ok: false, error: 'import_split_failed' });
    }
  });

  return router;
}
