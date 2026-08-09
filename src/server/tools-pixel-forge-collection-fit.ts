/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 8 (Collection DNA Lock /
 * Fit Check). See src/pixel-agent/collection-fit.ts for the deterministic
 * metrics/scoring this route wraps — pure sharp + arithmetic, no
 * Anthropic call, no OpenAI call, no generation of any kind.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts — that file's normalize/cleanup/repair/
 * split/import-split logic must stay untouched. Both routes below only
 * READ an already-written `<variantId>-raw.png` (same file the Stage 7
 * export route reads); neither ever creates or mutates a TraitAsset, and
 * neither persists a profile server-side — the client holds the profile
 * JSON from profile-from-variant and passes it back into check.
 *
 *   POST /api/tools/pixel-forge/raster/collection-fit/profile-from-variant
 *     Input: { experimentId, variantId, name }
 *     Output: { ok, profile }
 *
 *   POST /api/tools/pixel-forge/raster/collection-fit/check
 *     Input: { experimentId, variantId, profile }
 *     Output: { ok, score, verdict, metrics, issues }
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  computeCollectionFitMetrics, buildProfileFromMetrics, checkCollectionFit,
  CollectionFitProfile, BBox, Point,
} from '../pixel-agent/collection-fit';

const RASTER_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'raster-experiments');
// Same convention as tools-pixel-forge-export.ts's own EXPERIMENT_ID_RE /
// VARIANT_ID_RE — never trust path input beyond this.
const EXPERIMENT_ID_RE = /^[0-9a-f-]{36}$/i;
const VARIANT_ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_NAME_LEN = 200;
const REQUIRED_CANVAS_SIZE = 48;

function variantRawPngPath(experimentId: string, variantId: string): string {
  return path.join(RASTER_DIR, experimentId, `${variantId}-raw.png`);
}

async function loadVariantPng(experimentId: unknown, variantId: unknown): Promise<
  { ok: true; buffer: Buffer } | { ok: false; status: number; error: string }
> {
  if (typeof experimentId !== 'string' || !EXPERIMENT_ID_RE.test(experimentId)) {
    return { ok: false, status: 400, error: 'invalid_experiment_id' };
  }
  if (typeof variantId !== 'string' || !VARIANT_ID_RE.test(variantId)) {
    return { ok: false, status: 400, error: 'invalid_variant_id' };
  }
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(variantRawPngPath(experimentId, variantId));
  } catch {
    return { ok: false, status: 404, error: 'variant_not_found' };
  }
  const metadata = await sharp(buffer).metadata();
  if (metadata.width !== REQUIRED_CANVAS_SIZE || metadata.height !== REQUIRED_CANVAS_SIZE) {
    return { ok: false, status: 400, error: 'source_not_48x48' };
  }
  return { ok: true, buffer };
}

function isBBox(v: unknown): v is BBox {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.x === 'number' && typeof b.y === 'number' && typeof b.w === 'number' && typeof b.h === 'number';
}

function isPoint(v: unknown): v is Point {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.x === 'number' && typeof p.y === 'number';
}

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

/** Client-supplied JSON is never trusted — the profile the frontend sends
 *  into /check originated from our own /profile-from-variant response,
 *  but nothing stops a malformed or hand-edited payload from arriving
 *  here, so every field is shape-checked before use. */
function isValidProfile(v: unknown): v is CollectionFitProfile {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && typeof p.name === 'string' && p.canvasSize === REQUIRED_CANVAS_SIZE &&
    isBBox(p.targetForegroundBBox) && isPoint(p.targetSubjectCenter) &&
    typeof p.allowedCenterDriftPx === 'number' && typeof p.allowedBBoxDriftPx === 'number' &&
    isRange(p.allowedCoverageRange) && typeof p.allowedPaletteDistance === 'number' &&
    isRange(p.allowedOutlineRatioRange) &&
    Array.isArray(p.targetPalette) && p.targetPalette.every(c => typeof c === 'string') &&
    (p.notes === undefined || typeof p.notes === 'string');
}

export function createPixelForgeCollectionFitRouter(): Router {
  const router = Router();
  // Local image processing only, no AI, no external call — same generous
  // free bucket every other raster route here uses.
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-collection-fit' });

  router.post('/tools/pixel-forge/raster/collection-fit/profile-from-variant', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { experimentId?: unknown; variantId?: unknown; name?: unknown };
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > MAX_NAME_LEN) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }
    const loaded = await loadVariantPng(body.experimentId, body.variantId);
    if (!loaded.ok) return res.status(loaded.status).json({ ok: false, error: loaded.error });

    try {
      const metrics = await computeCollectionFitMetrics(loaded.buffer);
      const profile = buildProfileFromMetrics(randomUUID(), body.name.trim(), metrics);
      return res.json({ ok: true, profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-collection-fit] profile-from-variant failed', msg);
      return res.status(502).json({ ok: false, error: 'profile_from_variant_failed' });
    }
  });

  router.post('/tools/pixel-forge/raster/collection-fit/check', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { experimentId?: unknown; variantId?: unknown; profile?: unknown };
    if (!isValidProfile(body.profile)) {
      return res.status(400).json({ ok: false, error: 'invalid_profile' });
    }
    const loaded = await loadVariantPng(body.experimentId, body.variantId);
    if (!loaded.ok) return res.status(loaded.status).json({ ok: false, error: loaded.error });

    try {
      const metrics = await computeCollectionFitMetrics(loaded.buffer);
      const result = checkCollectionFit(metrics, body.profile);
      return res.json({ ok: true, score: result.score, verdict: result.verdict, metrics: result.metrics, issues: result.issues });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-collection-fit] check failed', msg);
      return res.status(502).json({ ok: false, error: 'collection_fit_check_failed' });
    }
  });

  return router;
}
