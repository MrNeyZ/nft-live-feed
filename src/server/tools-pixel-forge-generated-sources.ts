/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 6 companion: Generated
 * Sources Library. `tools-pixel-forge-generate-source.ts` already persists
 * every successful OpenAI generation to
 * data/pixel-forge/generated-sources/<id>/{source.png,meta.json} — this
 * file only adds read/delete routes over that existing storage so
 * previously generated images survive a page refresh and can be reused
 * ("Use for Normalize") without paying OpenAI again.
 *
 * Kept in its own file for the same reason as
 * tools-pixel-forge-generate-source.ts itself: isolate anything touching
 * the OpenAI-spend area from tools-pixel-forge-raster.ts's
 * normalize/cleanup/repair/split/import-split logic, which must stay
 * untouched. Unlike that file, these routes make NO OpenAI/Anthropic call
 * and NO generation of any kind — pure filesystem read/delete over
 * already-generated data. No TraitAsset is ever created or touched here.
 *
 *   GET    /api/tools/pixel-forge/raster/generated-sources
 *   GET    /api/tools/pixel-forge/raster/generated-sources/:id
 *   DELETE /api/tools/pixel-forge/raster/generated-sources/:id
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

const GENERATED_SOURCES_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'generated-sources');
// Same shape convention as tools-pixel-forge-export.ts's EXPERIMENT_ID_RE —
// these ids are always a generate-source.ts randomUUID(), never trust path
// input beyond this.
const SOURCE_ID_RE = /^[0-9a-f-]{36}$/i;
// Keeps the list payload light — the source PNGs are full 1024x1024
// gpt-image-1 outputs, too heavy to ship one-per-card in a list response.
// GET :id still returns the untouched full-size source.png.
const LIST_THUMBNAIL_SIZE = 160;

interface GeneratedSourceMeta {
  id: string;
  createdAt: number;
  userPrompt: string;
  fullPromptSent?: string;
  model: string;
  size: string;
  quality: string;
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  estimatedCostUsd: number | null;
  referenceImageHash: string;
  referenceRightsConfirmed: boolean;
  // Not written by generate-source.ts today — forward-compatible only,
  // per the task spec ("if present").
  outputMatchesReferenceHash?: boolean;
  // Stage 9.3 addition — absent on any record written before that stage;
  // defaulted to 'single-image' below (today's pre-Stage-9.3 behavior).
  sourceMode?: string;
}

async function readMeta(id: string): Promise<GeneratedSourceMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(GENERATED_SOURCES_DIR, id, 'meta.json'), 'utf8');
    return JSON.parse(raw) as GeneratedSourceMeta;
  } catch {
    return null;
  }
}

export function createPixelForgeGeneratedSourcesRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge-generated-sources' });

  router.get('/tools/pixel-forge/raster/generated-sources', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      let entries: string[];
      try {
        entries = await fsp.readdir(GENERATED_SOURCES_DIR);
      } catch {
        return res.json({ ok: true, sources: [] }); // dir doesn't exist yet — nothing generated so far
      }

      const ids = entries.filter(id => SOURCE_ID_RE.test(id));
      const sources = (await Promise.all(ids.map(async (id) => {
        const meta = await readMeta(id);
        if (!meta) return null;
        let pngBase64: string;
        try {
          const sourceBuf = await fsp.readFile(path.join(GENERATED_SOURCES_DIR, id, 'source.png'));
          const thumbBuf = await sharp(sourceBuf).resize(LIST_THUMBNAIL_SIZE, LIST_THUMBNAIL_SIZE, { fit: 'inside' }).png().toBuffer();
          pngBase64 = thumbBuf.toString('base64');
        } catch {
          return null; // source.png missing/corrupt — skip rather than fail the whole list
        }
        return {
          id: meta.id,
          createdAt: meta.createdAt,
          prompt: meta.userPrompt,
          sourceMode: meta.sourceMode ?? 'single-image',
          model: meta.model,
          size: meta.size,
          quality: meta.quality,
          estimatedCostUsd: meta.estimatedCostUsd,
          tokenUsage: meta.tokenUsage ?? null,
          pngBase64,
          referenceImageHash: meta.referenceImageHash,
          ...(meta.outputMatchesReferenceHash !== undefined ? { outputMatchesReferenceHash: meta.outputMatchesReferenceHash } : {}),
        };
      }))).filter((s): s is NonNullable<typeof s> => s !== null);

      sources.sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ ok: true, sources });
    } catch (err) {
      console.error('[tools/pixel-forge-generated-sources] list failed', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ ok: false, error: 'list_failed' });
    }
  });

  router.get('/tools/pixel-forge/raster/generated-sources/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!SOURCE_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const meta = await readMeta(id);
    if (!meta) return res.status(404).json({ ok: false, error: 'not_found' });
    let pngBase64: string;
    try {
      const buf = await fsp.readFile(path.join(GENERATED_SOURCES_DIR, id, 'source.png'));
      pngBase64 = buf.toString('base64');
    } catch {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    return res.json({ ok: true, meta, pngBase64 });
  });

  router.delete('/tools/pixel-forge/raster/generated-sources/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!SOURCE_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const dir = path.join(GENERATED_SOURCES_DIR, id);
    // Extra guard against path traversal beyond the regex — the resolved
    // dir must stay a direct child of GENERATED_SOURCES_DIR.
    if (path.dirname(dir) !== GENERATED_SOURCES_DIR) return res.status(400).json({ ok: false, error: 'invalid_id' });

    try {
      await fsp.access(dir);
    } catch {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return res.json({ ok: true, deleted: true });
    } catch (err) {
      console.error('[tools/pixel-forge-generated-sources] delete failed', id, err instanceof Error ? err.message : String(err));
      return res.status(500).json({ ok: false, error: 'delete_failed' });
    }
  });

  return router;
}
