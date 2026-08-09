/**
 * Documents the plug-in point for an image source, per
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md §8 and the Stage 6
 * OpenAI Image Source design notes. Pure types only — no API call lives
 * here; src/pixel-agent/openai-image-source.ts is the actual
 * implementation for OpenAI.
 *
 * The Image-to-Traits pipeline (src/server/tools-pixel-forge-raster.ts's
 * `POST /raster/normalize` → Cleanup → Repair → Split → Import Split
 * Layers) is already fully agnostic to where its source PNG came from —
 * `normalize` just accepts `{ imageBase64, mimeType }`. Manual browser
 * upload is one producer of that shape (the Import Image tab); the OpenAI
 * generator (Stage 6) is a second, additive producer of the exact same
 * shape, feeding the exact same `normalize` call — no change to
 * normalize/cleanup/repair/split/import-split was needed for this to work.
 *
 * Revision note: an earlier version of `ImageSourceProducer` here took
 * only a `prompt` (text-only generation). That was wrong for the actual
 * product requirement — reference image + prompt is the required primary
 * path, not text-only — so the signature below takes both.
 */

export interface GeneratedImage {
  pngBase64: string;
  mimeType: 'image/png';
}

/**
 * Stage 9.3 addition — what KIND of image a generation request is asking
 * for. `'single-image'` is today's only real behavior (a single
 * full-character source PNG, unchanged); the three `trait-sheet-*` modes
 * are additive (docs/pixel-forge-trait-sheet-stage9-design.md, staged
 * validation plan A6) and only change what PROMPT TEXT is built
 * (src/pixel-agent/openai-trait-sheet-prompts.ts) before calling
 * `generateSourceImage` below — this type has no effect on
 * `ImageSourceRequest`/`generateSourceImage` itself, which stays
 * completely untouched and mode-agnostic.
 *
 * Stage 10.4 addition — `'trait-family-sheet-10x8'` is the pivot's
 * replacement mode (see project memory
 * project_pixel_forge_stage10_pivot): a single 10x8, 80-cell trait
 * catalog with no preview cell, prompt-built by
 * `buildTraitFamilySheetPrompt` (src/pixel-agent/openai-trait-family-
 * sheet-prompts.ts). Same "prompt-text-only, no effect on
 * ImageSourceRequest/generateSourceImage" contract as the Stage 9.3
 * modes above. The three `trait-sheet-*` (2/4/8-cell) modes stay present
 * — not removed, still valid on the backend, just no longer surfaced in
 * the UI — so already-generated sheets of those modes remain readable. */
export type ImageSourceMode =
  | 'single-image' | 'trait-sheet-2-cell' | 'trait-sheet-4-cell' | 'trait-sheet-8-cell' | 'trait-family-sheet-10x8';

export interface ImageSourceRequest {
  prompt: string;
  /** Held in memory only by every real implementation — never written to
   *  disk (see openai-image-source.ts / the Stage 6 design doc §6-8). */
  referenceImageBuffer: Buffer;
  referenceMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** Anything that can produce a PNG to feed into `/raster/normalize` from a
 *  reference image + prompt. Manual upload doesn't implement this
 *  interface at all — the browser IS that producer, directly populating
 *  the same `{imageBase64, mimeType}` shape without going through this
 *  type. An OpenAI-backed implementation (openai-image-source.ts) is a
 *  second, additive producer — never a replacement for manual upload,
 *  never a change to the pipeline stages downstream of normalize. */
export type ImageSourceProducer = (request: ImageSourceRequest) => Promise<GeneratedImage>;
