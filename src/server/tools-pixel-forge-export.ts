/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 7 (upscaled export).
 * See docs/pixel-forge-image-to-traits-pipeline-mvp.md and
 * src/pixel-agent/raster-upscale.ts for the deterministic nearest-neighbor
 * upscale this route wraps. No Anthropic call, no OpenAI call, no
 * generation — pure local image processing (sharp) over an
 * already-normalized variant or an already-saved trait.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts — that file's normalize/cleanup/repair/
 * split/import-split logic must stay untouched. This route only reads
 * already-written files; it never creates a TraitAsset and never mutates
 * anything on disk.
 *
 *   POST /api/tools/pixel-forge/raster/export-upscaled
 *     Input: EITHER { experimentId, variantId } OR { traitId } — exactly
 *     one of the two sources, plus optional `includeRaw`.
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { upscalePixelArtPng } from '../pixel-agent/raster-upscale';
import { getTraitAssetPngBuffer } from '../pixel-agent/store';

const RASTER_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'raster-experiments');
const EXPERIMENT_ID_RE = /^[0-9a-f-]{36}$/i; // randomUUID shape only — never trust path input beyond this
// Deliberately NOT re-declaring the raster router's full VariantId enum
// here (12 ids and growing) — this route only ever READS an already-
// written `<variantId>-raw.png`, so a safe path-charset check plus a
// plain file-not-found -> 404 is sufficient and avoids duplicating that
// list every time a new variant family is added there.
const VARIANT_ID_RE = /^[a-z0-9-]{1,64}$/;
const TRAIT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_SCALE = 8;

function variantRawPngPath(experimentId: string, variantId: string): string {
  return path.join(RASTER_DIR, experimentId, `${variantId}-raw.png`);
}

export function createPixelForgeExportRouter(): Router {
  const router = Router();
  // Local image processing only, no AI, no external call — same generous
  // free bucket every other raster route here uses.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-export' });

  router.post('/tools/pixel-forge/raster/export-upscaled', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as {
      experimentId?: unknown; variantId?: unknown; traitId?: unknown; includeRaw?: unknown;
    };

    const wantsVariant = body.experimentId !== undefined || body.variantId !== undefined;
    const wantsTrait = body.traitId !== undefined;
    if (wantsVariant && wantsTrait) {
      return res.status(400).json({ ok: false, error: 'conflicting_source' });
    }
    if (!wantsVariant && !wantsTrait) {
      return res.status(400).json({ ok: false, error: 'missing_source' });
    }
    if (body.includeRaw !== undefined && typeof body.includeRaw !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_include_raw' });
    }
    const includeRaw = body.includeRaw === true;

    let rawPngBuffer: Buffer;
    try {
      if (wantsVariant) {
        if (typeof body.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(body.experimentId)) {
          return res.status(400).json({ ok: false, error: 'invalid_experiment_id' });
        }
        if (typeof body.variantId !== 'string' || !VARIANT_ID_RE.test(body.variantId)) {
          return res.status(400).json({ ok: false, error: 'invalid_variant_id' });
        }
        try {
          rawPngBuffer = await fsp.readFile(variantRawPngPath(body.experimentId, body.variantId));
        } catch {
          return res.status(404).json({ ok: false, error: 'variant_not_found' });
        }
      } else {
        if (typeof body.traitId !== 'string' || !TRAIT_ID_RE.test(body.traitId)) {
          return res.status(400).json({ ok: false, error: 'invalid_trait_id' });
        }
        const traitPng = await getTraitAssetPngBuffer(body.traitId);
        if (!traitPng) return res.status(404).json({ ok: false, error: 'trait_not_found' });
        rawPngBuffer = traitPng;
      }

      const metadata = await sharp(rawPngBuffer).metadata();
      const sourceSize = metadata.width;
      if (!sourceSize || !metadata.height || sourceSize !== metadata.height) {
        return res.status(502).json({ ok: false, error: 'source_not_square' });
      }

      const upscaledBuffer = await upscalePixelArtPng(rawPngBuffer, FIXED_SCALE);

      return res.json({
        ok: true,
        sourceSize,
        outputSize: sourceSize * FIXED_SCALE,
        scale: FIXED_SCALE,
        upscaledPngBase64: upscaledBuffer.toString('base64'),
        ...(includeRaw ? { rawPngBase64: rawPngBuffer.toString('base64') } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-export] export-upscaled failed', msg);
      return res.status(502).json({ ok: false, error: 'export_failed' });
    }
  });

  return router;
}
