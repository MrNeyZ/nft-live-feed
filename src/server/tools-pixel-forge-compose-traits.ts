/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 9.2 (real compose route).
 * Wraps the offline Stage 9.1 compositor (src/pixel-agent/trait-
 * compositor.ts) with an HTTP route — no OpenAI call, no Anthropic call,
 * no generation of any kind, no mutation, no TraitAsset creation. This is
 * the REAL replacement for the frontend Layer Stack's own CSS-`<img>`-
 * stack preview when the user actually wants a downloadable PNG — see
 * docs/pixel-forge-trait-sheet-stage9-design.md Part C2.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts.
 *
 *   POST /api/tools/pixel-forge/raster/compose-traits
 */

import { Router, Request, Response } from 'express';
import { composeTraitAssetsById } from '../pixel-agent/trait-compositor';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

const MAX_TRAIT_IDS = 32;
const TRAIT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPOSE_UPSCALE = 8;

export function createPixelForgeComposeTraitsRouter(): Router {
  const router = Router();
  // Local image processing only, no AI, no external call — same generous
  // free bucket every other raster route in this codebase uses.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-compose-traits' });

  router.post('/tools/pixel-forge/raster/compose-traits', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { traitIds?: unknown; includeRaw?: unknown; includeUpscaled384?: unknown };

    if (!Array.isArray(body.traitIds) || body.traitIds.length === 0 || body.traitIds.length > MAX_TRAIT_IDS) {
      return res.status(400).json({ ok: false, error: 'invalid_trait_ids' });
    }
    for (const id of body.traitIds) {
      if (typeof id !== 'string' || !TRAIT_ID_RE.test(id)) {
        return res.status(400).json({ ok: false, error: 'invalid_trait_ids' });
      }
    }
    if (body.includeRaw !== undefined && typeof body.includeRaw !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_include_raw' });
    }
    if (body.includeUpscaled384 !== undefined && typeof body.includeUpscaled384 !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_include_upscaled_384' });
    }
    // Both default true — a caller asking to compose almost always wants
    // at least one of the two exports back; explicit `false` opts out.
    const includeRaw = body.includeRaw !== false;
    const includeUpscaled384 = body.includeUpscaled384 !== false;

    try {
      const result = await composeTraitAssetsById(body.traitIds as string[]);
      return res.json({
        ok: true,
        ...(includeRaw ? { rawPngBase64: result.rawPngBuffer.toString('base64') } : {}),
        ...(includeUpscaled384 ? { upscaled384PngBase64: result.upscaled384PngBuffer.toString('base64') } : {}),
        layersUsed: result.layersUsed,
        outputSize: result.canvasSize,
        scale: COMPOSE_UPSCALE,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('compose_trait_not_found')) return res.status(404).json({ ok: false, error: 'trait_not_found' });
      if (msg.startsWith('compose_trait_png_missing')) return res.status(404).json({ ok: false, error: 'trait_png_missing' });
      if (msg.startsWith('compose_canvas_size_mismatch')) return res.status(400).json({ ok: false, error: 'canvas_size_mismatch', detail: msg });
      console.error('[tools/pixel-forge-compose-traits] compose failed', msg);
      return res.status(502).json({ ok: false, error: 'compose_failed' });
    }
  });

  return router;
}
