/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 6 (OpenAI Image Source).
 * See docs/pixel-forge-image-to-traits-pipeline-mvp.md and the Stage 6
 * design notes: user uploads a reference NFT image + a prompt, OpenAI
 * (gpt-image-1, via src/pixel-agent/openai-image-source.ts) generates a
 * new full source PNG, and that PNG is fed into the EXISTING, unmodified
 * `POST /raster/normalize` as an alternate source — same contract a
 * manual upload already satisfies.
 *
 * Kept in its own file, deliberately NOT added to
 * tools-pixel-forge-raster.ts — that file's normalize/cleanup/repair/
 * split/import-split logic must stay untouched, and this is the one route
 * in this whole area that spends real money again (mirrors this
 * codebase's own "isolate the one paid route" convention — see the
 * removed Claude job-start route's own tighter, separate rate bucket).
 *
 * This route NEVER creates a TraitAsset and NEVER calls normalize/split
 * itself — it only returns a generated PNG + its own small metadata
 * record for the user to explicitly feed into the existing pipeline via
 * "Use for Normalize". No auto-normalize, no auto-split, no auto-import.
 *
 *   POST /api/tools/pixel-forge/raster/generate-source
 */

import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  generateSourceImage, openaiApiKey, OPENAI_IMAGE_MODEL, OPENAI_IMAGE_SIZE, OPENAI_IMAGE_QUALITY,
} from '../pixel-agent/openai-image-source';
import { ImageSourceMode } from '../pixel-agent/image-source';
import { buildTraitSheetPrompt, TraitSheetPromptMode } from '../pixel-agent/openai-trait-sheet-prompts';
import { buildTraitFamilySheetPrompt } from '../pixel-agent/openai-trait-family-sheet-prompts';

const GENERATED_SOURCES_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'generated-sources');
const ALLOWED_REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Generous like the raster router's own upload cap — a full reference NFT
// image, not a thumbnail. Well under OpenAI's own 25MB ceiling for
// gpt-image-1 edit inputs.
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_LEN = 2000;
// Stage 9.3 — sourceMode is optional and defaults to 'single-image', so an
// omitted field reproduces today's exact existing behavior (design doc's
// own "layout defaults to today's 'single' behavior so nothing existing
// changes" requirement). Stage 10.4 adds 'trait-family-sheet-10x8' — the
// three 'trait-sheet-*' (2/4/8-cell) modes stay valid here (not removed,
// per the Stage 10.1 UI-hide-not-delete precedent) even though the
// frontend no longer surfaces them.
const VALID_SOURCE_MODES: ReadonlySet<ImageSourceMode> = new Set([
  'single-image', 'trait-sheet-2-cell', 'trait-sheet-4-cell', 'trait-sheet-8-cell', 'trait-family-sheet-10x8',
]);

export function createPixelForgeGenerateSourceRouter(): Router {
  const router = Router();
  // Tight bucket — this route spends real OpenAI credits per call, same
  // reasoning as the old (removed) job-start route's own separate,
  // tighter bucket vs. the generous shared one every free raster route
  // uses (tools-pixel-forge-raster.ts's own `limit`, 90/min).
  const startLimit = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/pixel-forge-generate-source' });

  router.post('/tools/pixel-forge/raster/generate-source', startLimit, requireAuth, async (req: Request, res: Response) => {
    if (!openaiApiKey()) {
      return res.status(503).json({ ok: false, error: 'openai_api_key_not_configured' });
    }

    const body = req.body as {
      referenceImageBase64?: unknown; referenceMimeType?: unknown; prompt?: unknown;
      referenceRightsConfirmed?: unknown; sourceMode?: unknown;
    };

    if (typeof body.referenceImageBase64 !== 'string' || body.referenceImageBase64.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_reference_image' });
    }
    if (typeof body.referenceMimeType !== 'string' || !ALLOWED_REFERENCE_MIME_TYPES.has(body.referenceMimeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_reference_mime_type' });
    }
    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0 || body.prompt.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ ok: false, error: 'invalid_prompt' });
    }
    // Optional — defaults to 'single-image' (today's exact existing
    // behavior) when omitted, per the Stage 9.3 task spec.
    const sourceMode: ImageSourceMode = body.sourceMode === undefined ? 'single-image' : (body.sourceMode as ImageSourceMode);
    if (!VALID_SOURCE_MODES.has(sourceMode)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_mode' });
    }
    // Required server-side, not just a client-side checkbox — a request
    // that omits this or sends anything other than the literal `true`
    // boolean is rejected before any OpenAI call is even attempted.
    if (body.referenceRightsConfirmed !== true) {
      return res.status(400).json({ ok: false, error: 'reference_rights_not_confirmed' });
    }

    let referenceImageBuffer: Buffer;
    try {
      referenceImageBuffer = Buffer.from(body.referenceImageBase64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_reference_encoding' });
    }
    if (referenceImageBuffer.length === 0) return res.status(400).json({ ok: false, error: 'invalid_reference_encoding' });
    if (referenceImageBuffer.length > MAX_REFERENCE_BYTES) {
      return res.status(400).json({ ok: false, error: 'reference_image_too_large' });
    }

    const referenceMimeType = body.referenceMimeType as 'image/png' | 'image/jpeg' | 'image/webp';
    const userPrompt = body.prompt.trim();
    // Never written to disk anywhere in this handler — referenceImageBuffer
    // is held in memory only for this request and is not referenced again
    // after generateSourceImage returns or throws. Only its hash is
    // persisted below, for audit/dedup, never for reconstruction. See the
    // Stage 6 design doc's storage plan / "preventing an accidental exact
    // copy" sections.
    const referenceImageHash = createHash('sha256').update(referenceImageBuffer).digest('hex');

    // Stage 9.3 — only the PROMPT TEXT changes by mode; the OpenAI call
    // itself (generateSourceImage: gpt-image-1, reference + prompt,
    // 1024x1024, medium quality, n=1, background=transparent,
    // output_format=png per Stage 10.1) is completely unmodified and
    // mode-agnostic. 'single-image' passes userPrompt straight through,
    // byte-identical to today's existing call. Stage 10.4 — the pivot's
    // replacement mode routes through buildTraitFamilySheetPrompt instead
    // of the (superseded, still-present) Stage 9 2/4/8-cell builder.
    const effectivePrompt = sourceMode === 'single-image'
      ? userPrompt
      : sourceMode === 'trait-family-sheet-10x8'
        ? buildTraitFamilySheetPrompt(userPrompt)
        : buildTraitSheetPrompt(sourceMode as TraitSheetPromptMode, userPrompt);

    const sourceId = randomUUID();
    try {
      const result = await generateSourceImage({ prompt: effectivePrompt, referenceImageBuffer, referenceMimeType });

      const sourceDir = path.join(GENERATED_SOURCES_DIR, sourceId);
      await fsp.mkdir(sourceDir, { recursive: true });
      await fsp.writeFile(path.join(sourceDir, 'source.png'), Buffer.from(result.pngBase64, 'base64'));
      await fsp.writeFile(path.join(sourceDir, 'meta.json'), JSON.stringify({
        id: sourceId,
        createdAt: Date.now(),
        sourceMode,
        userPrompt,
        fullPromptSent: result.fullPromptSent,
        model: OPENAI_IMAGE_MODEL,
        size: OPENAI_IMAGE_SIZE,
        quality: OPENAI_IMAGE_QUALITY,
        tokenUsage: result.tokenUsage,
        estimatedCostUsd: result.estimatedCostUsd,
        referenceImageHash,
        referenceRightsConfirmed: true,
      }));

      console.log('[tools/pixel-forge-generate-source] usage', {
        sourceId, sourceMode, model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_SIZE, quality: OPENAI_IMAGE_QUALITY,
        tokenUsage: result.tokenUsage, estimatedCostUsd: result.estimatedCostUsd,
      });

      // Preview-only response — no TraitAsset, no write to the trait
      // store, no normalize/split call made from here. The user must
      // explicitly click "Use for Normalize" client-side to continue.
      return res.json({
        ok: true, sourceId, sourceMode, pngBase64: result.pngBase64,
        tokenUsage: result.tokenUsage, estimatedCostUsd: result.estimatedCostUsd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/pixel-forge-generate-source] generate failed', msg);
      return res.status(502).json({ ok: false, error: 'generate_source_failed' });
    }
  });

  return router;
}
