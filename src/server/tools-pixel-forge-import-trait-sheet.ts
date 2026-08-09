/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 9.2 (Trait Sheet import
 * route). Wraps the offline Stage 9.1 crop/normalize foundation
 * (src/pixel-agent/trait-sheet.ts) with an HTTP route that actually
 * creates candidate TraitAssets — no OpenAI call, no Anthropic call, no
 * generation of any kind. This route only crops/normalizes/optionally
 * repairs an ALREADY-SUPPLIED sheet image (manually uploaded, or a
 * previously-generated one the caller already has bytes for) and saves
 * the result via the existing, unmodified `saveTraitAsset`.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts — that file's normalize/cleanup/repair/
 * split/import-split logic must stay untouched. This route calls INTO
 * its already-exported `repairRasterImage` (unmodified) for its own
 * optional repair pass, the exact same way `/raster/import-split`
 * already does — reuse, not a second implementation.
 *
 *   POST /api/tools/pixel-forge/raster/import-trait-sheet
 */

import { Router, Request, Response } from 'express';
import sharp from 'sharp';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  getTraitSheetLayout, cropTraitSheetCells, tightenTraitSheetCellBBox, normalizeTraitSheetCell, CroppedTraitSheetCell,
  getTraitFamilyCategoryForCell, TraitFamilyCategory,
} from '../pixel-agent/trait-sheet';
import { repairRasterImage } from '../pixel-agent/raster-repair';
import { loadRawRgba, deriveSourcePalette, quantizeToPalette, rgbaToPngBase64, RgbaImage } from '../pixel-agent/raster-convert';
import { saveTraitAsset } from '../pixel-agent/store';
import { getCollection } from '../pixel-agent/collections-store';
import { LayerType } from '../pixel-agent/agent-loop';
import { EVALUATION_SCHEMA_VERSION, Evaluation } from '../pixel-agent/tools';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
// Stage 9 diagnosis tooling ONLY — read-only shadow capture, calls into
// the same unmodified trait-sheet.ts/raster-convert.ts primitives this
// route already uses. See trait-sheet-debug.ts's own header comment.
import { captureDebugCellStages, DebugCellResult } from '../pixel-agent/trait-sheet-debug';

// Wider than tools-pixel-forge-raster.ts's own ALLOWED_MIME_TYPES
// (png/jpeg only) — a trait sheet can reasonably arrive as webp too,
// matching tools-pixel-forge-generate-source.ts's own
// ALLOWED_REFERENCE_MIME_TYPES precedent.
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Same convention/values as tools-pixel-forge-raster.ts's own constants —
// duplicated locally rather than imported, matching this codebase's own
// established per-file convention (see raster-split.ts's/collection-fit.ts's
// own comments on the same choice).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LEN = 80;
const MAX_NOTES_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const PALETTE_MAX_COLORS = 16;
const DEFAULT_BG_THRESHOLD = 24;
const COLLECTION_ID_RE = /^[a-z0-9-]{1,64}$/;
const SHEET_IMPORT_TAG = 'trait-sheet';
const ALLOWED_BACKGROUND_MODES = new Set(['keep', 'remove', 'key-color']);
const KEY_COLOR_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * "Sensible layer order" per this stage's own task spec: background <
 * body < head/fur < face/mask < eyes < nose/mouth < hat/accessory.
 * Deliberately NOT store.ts's `DEFAULT_Z_INDEX` (which has only one slot
 * per `LayerType` — `body_hoodie` and `head_fur` both map to LayerType
 * `'body'` and would collide at the same default zIndex 10, and the
 * `'other'`-typed `face_mask` cell would default to 50, sorting AFTER
 * eyes/mouth instead of before them as this task explicitly requires).
 * Keyed by cellId, specific to `LAYER_SHEET_2X4`'s own 7 real-layer
 * cells; any cell without an entry here (e.g. a future layout) falls
 * back to 50, same "unrecognized sorts last" convention used elsewhere
 * in this codebase (e.g. collection-fit.ts's/layer-stack.ts's own
 * "unknown sorts after every known value" tiebreaks).
 */
const SHEET_CELL_Z_INDEX: Record<string, number> = {
  background: 0,
  body_hoodie: 10,
  head_fur: 15,
  face_mask: 20,
  eyes: 25,
  nose_mouth: 30,
  hat_accessory: 35,
};
// Stage 10.5 — `TRAIT_FAMILY_SHEET_10X8`'s 80 cellIds (hat_00..09,
// hoodie_00..09, ...) have no entry above and intentionally aren't given
// one: every cell of that layout already falls back to the generic `?? 50`
// below, same as any other unrecognized cellId. A per-category z-index
// table wasn't part of this stage's scope — the existing fallback is a
// safe, uniform default, not a regression for the new layout.

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
 *  Same shape as tools-pixel-forge-raster.ts's own (private)
 *  importPlaceholderEvaluation, duplicated per this codebase's own
 *  per-file convention. */
function importPlaceholderEvaluation(): Evaluation {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    blindDescription: '',
    recognizableAsSubject: false,
    issues: [],
    preserve: [],
    doNotModify: [],
    intentionalChoices: [],
    notes: 'Not evaluated — imported from a trait sheet crop; no self-grading was performed.',
  };
}

export function createPixelForgeImportTraitSheetRouter(): Router {
  const router = Router();
  // Local image processing only, no AI, no external call — same generous
  // free bucket every other raster route in this codebase uses.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-import-trait-sheet' });

  router.post('/tools/pixel-forge/raster/import-trait-sheet', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      imageBase64?: unknown; mimeType?: unknown; layoutId?: unknown; selectedCellIds?: unknown;
      collectionId?: unknown; baseName?: unknown; tags?: unknown; notes?: unknown;
      backgroundMode?: unknown; keyColorHex?: unknown; repair?: unknown;
      // Stage 9 diagnosis tooling only — see this route's own debug block
      // below and trait-sheet-debug.ts. Never affects the real import.
      debug?: unknown;
    };
    const debugRequested = body.debug === true;

    if (typeof body.imageBase64 !== 'string' || body.imageBase64.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_image' });
    }
    if (typeof body.mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(body.mimeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_mime_type' });
    }
    if (typeof body.layoutId !== 'string') {
      return res.status(400).json({ ok: false, error: 'invalid_layout_id' });
    }
    const layout = getTraitSheetLayout(body.layoutId);
    if (!layout) return res.status(400).json({ ok: false, error: 'unknown_layout_id' });

    let selectedCellIds: string[] | null = null;
    if (body.selectedCellIds !== undefined) {
      if (!Array.isArray(body.selectedCellIds) || !body.selectedCellIds.every(v => typeof v === 'string')) {
        return res.status(400).json({ ok: false, error: 'invalid_selected_cell_ids' });
      }
      selectedCellIds = body.selectedCellIds as string[];
    }

    const backgroundModeInput = body.backgroundMode !== undefined ? body.backgroundMode : 'keep';
    if (typeof backgroundModeInput !== 'string' || !ALLOWED_BACKGROUND_MODES.has(backgroundModeInput)) {
      return res.status(400).json({ ok: false, error: 'invalid_background_mode' });
    }
    const backgroundMode = backgroundModeInput as 'keep' | 'remove' | 'key-color';
    if (backgroundMode === 'key-color') {
      if (typeof body.keyColorHex !== 'string' || !KEY_COLOR_HEX_RE.test(body.keyColorHex)) {
        return res.status(400).json({ ok: false, error: 'invalid_key_color_hex' });
      }
    }
    const repair = body.repair === true;

    let baseName = 'trait-sheet';
    if (body.baseName !== undefined) {
      if (typeof body.baseName !== 'string' || body.baseName.length > MAX_NAME_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_base_name' });
      }
      const trimmed = body.baseName.trim();
      if (trimmed) baseName = trimmed;
    }

    const tags = normalizeTags(body.tags);
    if (tags === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });
    if (!tags.includes(SHEET_IMPORT_TAG)) tags.push(SHEET_IMPORT_TAG);
    if (!tags.includes(layout.id)) tags.push(layout.id);

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

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(body.imageBase64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
    }
    if (imageBuffer.length === 0) return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
    if (imageBuffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: 'image_too_large' });

    try {
      let cropped: CroppedTraitSheetCell[];
      try {
        cropped = await cropTraitSheetCells(imageBuffer, layout);
      } catch {
        return res.status(400).json({ ok: false, error: 'sheet_crop_failed' });
      }

      const selectedSet = selectedCellIds ? new Set(selectedCellIds) : null;
      const created: {
        id: string; name: string; cellId: string; layerType: LayerType; zIndex: number;
        row: number; col: number; familyCategory?: TraitFamilyCategory;
      }[] = [];
      const skipped: { cellId: string; reason: string }[] = [];

      for (const cell of cropped) {
        // Default (no selectedCellIds): every cell that IS a real layer.
        // A caller may still explicitly request the non-layer 'preview'
        // cell (or a whole-character 4x4-family-sheet cell) — it is
        // always skipped with an honest reason rather than silently
        // imported as a meaningless "layer", per the design doc's own
        // "cell 0 is never imported as a trait by default" rule
        // (docs/pixel-forge-trait-sheet-stage9-design.md Part B2 step 11).
        const isSelected = selectedSet ? selectedSet.has(cell.cellId) : cell.suggestedLayerType !== null;
        if (!isSelected) continue;
        if (cell.suggestedLayerType === null) {
          skipped.push({ cellId: cell.cellId, reason: 'no_layer_type' });
          continue;
        }

        const cellBackgroundMode = backgroundMode === 'key-color' ? 'keyColor' : backgroundMode === 'remove' ? 'autoDetect' : 'none';
        const tightened = await tightenTraitSheetCellBBox(cell, {
          backgroundMode: cellBackgroundMode,
          keyColorHex: backgroundMode === 'key-color' ? (body.keyColorHex as string) : undefined,
          bgThreshold: DEFAULT_BG_THRESHOLD,
        });
        const normalized = await normalizeTraitSheetCell(tightened, {
          outputSize: 48,
          backgroundMode: cellBackgroundMode,
          keyColorHex: backgroundMode === 'key-color' ? (body.keyColorHex as string) : undefined,
          bgThreshold: DEFAULT_BG_THRESHOLD,
        });

        if (normalized.warnings.includes('empty layer — no foreground pixels remain after normalize')) {
          skipped.push({ cellId: cell.cellId, reason: 'empty_layer' });
          continue;
        }

        const img: RgbaImage = await loadRawRgba(sharp(normalized.pngBuffer).ensureAlpha());
        if (repair) {
          // Same, unmodified repairRasterImage every other raster import
          // path already uses — 'safe' strength only (this route exposes
          // a plain boolean, not a strength choice, per the task spec).
          repairRasterImage(img, { strength: 'safe' });
        }

        // Self-consistent storage palette/pixels — same approach
        // /raster/import-split already uses for its own layer crops
        // (tools-pixel-forge-raster.ts's own comment: "a split layer's
        // color population is already a bounded subset of the source
        // image's, so this quantization is near-lossless in practice").
        const layerPalette = deriveSourcePalette(img, PALETTE_MAX_COLORS);
        const { pixelPaletteIndex } = quantizeToPalette(img, layerPalette);
        const pngBase64 = await rgbaToPngBase64(img);

        const zIndex = SHEET_CELL_Z_INDEX[cell.cellId] ?? 50;
        // Stage 10.5 — only meaningful for TRAIT_FAMILY_SHEET_10X8 cells;
        // undefined for every other layout's cellIds (2x4/4x4), same as
        // getTraitFamilyCategoryForCell's own documented "not found"
        // contract. `col` IS the variant index within its row's category
        // — TRAIT_FAMILY_SHEET_10X8 (trait-sheet.ts) assigns no further
        // meaning to column position, so no separate field is needed.
        const familyCategory = getTraitFamilyCategoryForCell(cell.cellId, layout);
        const variantIndex = cell.col;
        const cellTags = [...tags, cell.cellId, ...(familyCategory ? [familyCategory] : [])]
          .filter((t, i, arr) => arr.indexOf(t) === i);
        const provenanceNote = `Imported from trait sheet — layout ${layout.id}, cell "${cell.cellId}" `
          + `(row ${cell.row}, col ${cell.col}), crop bbox x=${cell.cropBBoxPx.x} y=${cell.cropBBoxPx.y} `
          + `w=${cell.cropBBoxPx.w} h=${cell.cropBBoxPx.h}`
          + (familyCategory ? `; familyCategory=${familyCategory}, variantIndex=${variantIndex}` : '')
          + (normalized.warnings.length > 0 ? `; warnings: ${normalized.warnings.join('; ')}` : '');
        const notes = userNotes ? `${userNotes}\n\n${provenanceNote}` : provenanceNote;

        // saveTraitAsset always generates a fresh randomUUID id — this
        // can never overwrite an existing trait, and always lands as
        // `candidate` (see store.ts) — never auto-approved.
        const trait = await saveTraitAsset({
          prompt: 'N/A — imported from a trait sheet crop, not generated by Claude. See notes.',
          layerType: cell.suggestedLayerType,
          size: normalized.outputSize,
          palette: ['transparent', ...layerPalette],
          pixels: pixelPaletteIndex,
          modelPreset: 'fast',
          actualModel: 'none (trait sheet import — no AI call)',
          maxTurns: 0,
          anchor: null,
          tokenUsage: null,
          estimatedCostUsd: 0,
          evaluation: importPlaceholderEvaluation(),
          repairPlan: null,
          tags: cellTags,
          notes,
          pngBase64,
          name: `${baseName} - ${cell.label}`,
          zIndex,
          referenceGuidanceNote: null,
          collectionPresetId,
          collectionId,
        });
        created.push({
          id: trait.id, name: trait.name, cellId: cell.cellId, layerType: trait.layerType, zIndex: trait.zIndex,
          row: cell.row, col: cell.col, familyCategory,
        });
      }

      console.log('[tools/pixel-forge-import-trait-sheet] import', {
        layoutId: layout.id, collectionId, createdCount: created.length, skippedCount: skipped.length,
      });

      // ── Stage 9 diagnosis tooling — debug capture (opt-in, additive
      //    only, see trait-sheet-debug.ts's own header comment). Runs
      //    AFTER the real import loop above so it can never affect
      //    `created`/`skipped` or any TraitAsset — it only reads the
      //    already-computed `cropped` array a second time. Captures
      //    EVERY cropped cell, including 'preview' (which the real loop
      //    above always skips, per its own "cell 0 is never imported by
      //    default" comment), since the whole point of this mode is
      //    comparing what's actually IN the sheet against what made it
      //    into the final imported traits.
      let debugInfo: {
        enabled: boolean; runId?: string; directory?: string;
        cells?: {
          cellId: string; cropSize: { width: number; height: number };
          stages: { stage: string; filename: string; foregroundPixels: number }[];
          warnings: string[];
        }[];
      } = { enabled: false };

      if (debugRequested) {
        const runId = randomUUID();
        const debugRootDir = path.join(process.cwd(), 'data', 'pixel-forge', 'debug-imports', runId);
        // Same ternary the real loop above uses inline, per-iteration —
        // reused here unchanged, not a new mapping.
        const normalizeBackgroundMode = backgroundMode === 'key-color' ? 'keyColor' : backgroundMode === 'remove' ? 'autoDetect' : 'none';
        const debugCells: NonNullable<typeof debugInfo.cells> = [];

        for (const cell of cropped) {
          const capture: DebugCellResult = await captureDebugCellStages(cell, {
            outputSize: 48,
            backgroundMode: normalizeBackgroundMode,
            keyColorHex: normalizeBackgroundMode === 'keyColor' ? (body.keyColorHex as string) : undefined,
            bgThreshold: DEFAULT_BG_THRESHOLD,
          }, path.join(debugRootDir, cell.cellId));

          const fgLine = capture.stages.map(s => `fg ${s.stage}: ${s.foregroundPixels}`).join(' | ');
          console.log(
            `[tools/pixel-forge-import-trait-sheet][debug] ${capture.cellId}\n`
            + `  crop: ${capture.cropWidth}x${capture.cropHeight}\n`
            + `  ${fgLine}`
            + (capture.warnings.length > 0 ? `\n  WARNING: ${capture.warnings.join(' | ')}` : ''),
          );

          debugCells.push({
            cellId: capture.cellId, cropSize: { width: capture.cropWidth, height: capture.cropHeight },
            stages: capture.stages.map(s => ({ stage: s.stage, filename: s.filename, foregroundPixels: s.foregroundPixels })),
            warnings: capture.warnings,
          });
        }

        debugInfo = { enabled: true, runId, directory: path.relative(process.cwd(), debugRootDir), cells: debugCells };
      }

      return res.json({ ok: true, layoutId: layout.id, created, skipped, debug: debugInfo });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-import-trait-sheet] import failed', msg);
      return res.status(502).json({ ok: false, error: 'import_trait_sheet_failed' });
    }
  });

  return router;
}
