/**
 * Pixel Forge — Stage 9.4: Trait Sheet validation route. Wraps
 * src/pixel-agent/trait-sheet-validation.ts (pure sharp + arithmetic, no
 * Anthropic call, no OpenAI call, no generation of any kind) with an HTTP
 * route that checks whether an already-generated trait-sheet PNG is
 * usable BEFORE spending money on the next, more expensive sourceMode
 * (2-cell -> 4-cell -> 8-cell) or before importing it.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts, tools-pixel-forge-import-trait-sheet.ts, or
 * tools-pixel-forge-compose-traits.ts — none of those are touched by this
 * stage. This route only READS an already-generated source (either by
 * `generatedSourceId`, the same on-disk storage
 * tools-pixel-forge-generated-sources.ts already reads, or a raw
 * `imageBase64` upload) and computes measurements — it never creates or
 * mutates a TraitAsset, never writes meta.json, never writes anything to
 * disk at all.
 *
 *   POST /api/tools/pixel-forge/raster/validate-trait-sheet
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { validateTraitSheet } from '../pixel-agent/trait-sheet-validation';
import { TraitSheetPromptMode } from '../pixel-agent/openai-trait-sheet-prompts';
import { LAYER_SHEET_2X4 } from '../pixel-agent/trait-sheet';

// Same directory/id-shape convention as
// tools-pixel-forge-generated-sources.ts's own (unexported)
// GENERATED_SOURCES_DIR/SOURCE_ID_RE — duplicated locally rather than
// imported, matching this codebase's established per-file convention for
// small shared constants (see raster-split.ts's/collection-fit.ts's own
// header comments on the same choice).
const GENERATED_SOURCES_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'generated-sources');
const SOURCE_ID_RE = /^[0-9a-f-]{36}$/i;
// Same cap as tools-pixel-forge-generate-source.ts's own
// MAX_REFERENCE_BYTES / tools-pixel-forge-import-trait-sheet.ts's own
// MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const VALID_SHEET_MODES: ReadonlySet<TraitSheetPromptMode> = new Set([
  'trait-sheet-2-cell', 'trait-sheet-4-cell', 'trait-sheet-8-cell',
]);

export function createPixelForgeValidateTraitSheetRouter(): Router {
  const router = Router();
  // Local image processing only, no AI, no external call — same generous
  // free bucket every other raster route in this codebase uses.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-validate-trait-sheet' });

  router.post('/tools/pixel-forge/raster/validate-trait-sheet', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      generatedSourceId?: unknown; imageBase64?: unknown; mimeType?: unknown;
      sourceMode?: unknown; layoutId?: unknown;
    };

    if (typeof body.sourceMode !== 'string' || !VALID_SHEET_MODES.has(body.sourceMode as TraitSheetPromptMode)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_mode' });
    }
    const sourceMode = body.sourceMode as TraitSheetPromptMode;

    const layoutId = body.layoutId !== undefined ? body.layoutId : LAYER_SHEET_2X4.id;
    if (typeof layoutId !== 'string' || layoutId.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_layout_id' });
    }

    const hasGeneratedSourceId = body.generatedSourceId !== undefined;
    const hasInlineImage = body.imageBase64 !== undefined;
    if (hasGeneratedSourceId === hasInlineImage) {
      // Exactly one of the two input shapes must be supplied — neither or
      // both is a client error, not something to silently pick a side on.
      return res.status(400).json({ ok: false, error: 'must_supply_exactly_one_of_generated_source_id_or_image' });
    }

    let sourcePngBuffer: Buffer;
    if (hasGeneratedSourceId) {
      if (typeof body.generatedSourceId !== 'string' || !SOURCE_ID_RE.test(body.generatedSourceId)) {
        return res.status(400).json({ ok: false, error: 'invalid_generated_source_id' });
      }
      try {
        sourcePngBuffer = await fsp.readFile(path.join(GENERATED_SOURCES_DIR, body.generatedSourceId, 'source.png'));
      } catch {
        return res.status(404).json({ ok: false, error: 'generated_source_not_found' });
      }
    } else {
      if (typeof body.imageBase64 !== 'string' || body.imageBase64.length === 0) {
        return res.status(400).json({ ok: false, error: 'invalid_image' });
      }
      if (typeof body.mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(body.mimeType)) {
        return res.status(400).json({ ok: false, error: 'invalid_mime_type' });
      }
      try {
        sourcePngBuffer = Buffer.from(body.imageBase64, 'base64');
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
      }
      if (sourcePngBuffer.length === 0) return res.status(400).json({ ok: false, error: 'invalid_image_encoding' });
      if (sourcePngBuffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: 'image_too_large' });
    }

    try {
      // No mutation, no TraitAsset creation, no meta.json write — this
      // route (and the module it wraps) only reads and measures.
      const result = await validateTraitSheet(sourcePngBuffer, sourceMode, layoutId);

      console.log('[tools/pixel-forge-validate-trait-sheet] validate', {
        sourceMode, layoutId, verdict: result.verdict, score: result.score,
        generatedSourceId: hasGeneratedSourceId ? body.generatedSourceId : undefined,
      });

      return res.json({
        ok: true,
        verdict: result.verdict,
        score: result.score,
        issues: result.issues,
        cellReports: result.cellReports,
        reconstruction: result.reconstruction,
        recommendedNextStep: result.recommendedNextStep,
        sourceMode: result.sourceMode,
        layoutId: result.layoutId,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-validate-trait-sheet] validate failed', msg);
      return res.status(502).json({ ok: false, error: 'validate_trait_sheet_failed' });
    }
  });

  return router;
}
