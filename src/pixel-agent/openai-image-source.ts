/**
 * OpenAI Image Source producer — Stage 6 of the Image-to-Traits pipeline.
 * See docs/pixel-forge-image-to-traits-pipeline-mvp.md and the Stage 6
 * design notes. This is the ONE place in Pixel Forge that spends real
 * money again after the Claude drawing runtime was removed — a single,
 * deterministic image-edit call, never a multi-turn loop.
 *
 * Implements `ImageSourceProducer` (image-source.ts) using OpenAI's
 * `/v1/images/edits` endpoint, model `gpt-image-1` — NOT
 * `/v1/images/generations` (text-only, no image input parameter exists on
 * it at all) and NOT `dall-e-2`/`dall-e-3` (dall-e-3 has no image-input
 * support whatsoever; dall-e-2's edit endpoint is square-PNG-only, <4MB,
 * and noticeably lower fidelity for a style-constrained prompt like this
 * pipeline's "preserve framing/proportions/outline weight/shading").
 * No mask is sent — the whole reference image is fair game for the
 * prompt's transformation, since "same style, different subject" is a
 * global reinterpretation, not a localized inpaint.
 *
 * Every real network call here can be replaced in a test by monkey-
 * patching `global.fetch` before calling `generateSourceImage` — no
 * dependency injection needed, matching this codebase's existing "patch
 * globals / temp dirs, no mocking framework" test style (see
 * raster-cleanup.test.ts, collections-store.test.ts).
 *
 * NEVER call `generateSourceImage` against a real API key without
 * explicit authorization — it spends real money per call.
 */

import { ImageSourceRequest, GeneratedImage } from './image-source';

export function openaiApiKey(): string | null {
  const v = process.env.OPENAI_API_KEY;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export const OPENAI_IMAGE_MODEL = 'gpt-image-1';
// Square — matches "collectible avatar composition" and avoids asymmetric
// padding before Normalize's own square-fit step.
export const OPENAI_IMAGE_SIZE = '1024x1024';
// Fixed, not user-configurable in this MVP — "low" is likely too soft for
// the style-fidelity this prompt demands, "high" burns budget for no clear
// MVP benefit. Revisit as a user-facing preset only if real usage shows a
// need.
export const OPENAI_IMAGE_QUALITY = 'medium';

/** Appended server-side to every prompt, never overridable by the client —
 *  see the Stage 6 design doc's "preventing an accidental exact copy"
 *  section. A prompt-only safeguard, not a technical guarantee — layered
 *  alongside the frontend's own "describe changes, don't ask for an exact
 *  copy" copy and the required rights checkbox. Mirrors the same design
 *  pattern the old (removed) Reference Mode's own
 *  DIRECT_REFERENCE_DO_NOT_COPY_TEXT constant used — same idea, re-applied
 *  to this new call site. */
export const DO_NOT_COPY_SUFFIX =
  ' This must be a transformation, not a reproduction — change the subject '
  + 'as instructed; do not attempt to recreate the reference image exactly.';

export interface OpenAiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// USD per 1M tokens — PLACEHOLDER rates, NOT verified against OpenAI's live
// pricing page as of this writing. Same convention as the deleted
// Anthropic pricing table (agent-loop.ts, pre-removal): a fixed lookup
// with an explicit "revisit" note, used only for an operator-facing cost
// signal, never for billing. MUST be confirmed against
// https://openai.com/api/pricing before this number is trusted for a real
// spend decision.
const OPENAI_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-image-1': { input: 10.00, output: 40.00 }, // PLACEHOLDER — verify before real use
};

export function estimateOpenAiCostUsd(model: string, usage: OpenAiTokenUsage): number | null {
  const pricing = OPENAI_PRICING_USD_PER_MTOK[model];
  if (!pricing) return null;
  return (usage.inputTokens / 1_000_000) * pricing.input
       + (usage.outputTokens / 1_000_000) * pricing.output;
}

export interface OpenAiImageEditResult extends GeneratedImage {
  tokenUsage: OpenAiTokenUsage | null;
  estimatedCostUsd: number | null;
  /** The exact prompt actually sent to OpenAI (user prompt + the
   *  do-not-copy suffix) — kept separate from the caller's own
   *  `userPrompt` so the route handler can persist both for audit,
   *  without this module needing to know anything about storage. */
  fullPromptSent: string;
}

/** Minimal shape of OpenAI's `/v1/images/edits` JSON response actually
 *  read here — NOT the full documented response shape, just the fields
 *  this function depends on. Verify against OpenAI's current docs at
 *  implementation/integration time; this is a best-effort shape based on
 *  the gpt-image-1 edits/generations response format, not independently
 *  confirmed against a real live call in this codebase (no real call has
 *  ever been made from here — see the module doc comment). */
interface OpenAiImagesEditResponse {
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Real network call — NEVER invoke this against a real API key without
 *  explicit authorization. Throws on any non-2xx response or malformed
 *  body; callers (the route handler) are expected to catch and translate
 *  to a safe error response, same pattern as every other external-API
 *  call in this codebase. */
export async function generateSourceImage(request: ImageSourceRequest): Promise<OpenAiImageEditResult> {
  const apiKey = openaiApiKey();
  if (!apiKey) throw new Error('openai_api_key_not_configured');

  const fullPromptSent = request.prompt + DO_NOT_COPY_SUFFIX;

  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('image', new Blob([request.referenceImageBuffer], { type: request.referenceMimeType }), 'reference');
  form.append('prompt', fullPromptSent);
  form.append('size', OPENAI_IMAGE_SIZE);
  form.append('quality', OPENAI_IMAGE_QUALITY);
  form.append('n', '1');
  // Explicit params, not prompt text — per OpenAI's docs, transparency is
  // controlled by `background`, and requires `output_format` to be a
  // format that supports alpha (png/webp). Without these, gpt-image-1
  // returned RGB PNGs with no alpha channel even when the prompt asked
  // for a transparent layer.
  form.append('background', 'transparent');
  form.append('output_format', 'png');

  // Deliberately no explicit Content-Type header — fetch sets
  // `multipart/form-data; boundary=...` itself from the FormData body;
  // setting it manually here would drop the boundary and break the upload.
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`openai_edit_failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const body = await res.json() as OpenAiImagesEditResponse;
  const pngBase64 = body.data?.[0]?.b64_json;
  if (!pngBase64) throw new Error('openai_edit_no_image_returned');

  const tokenUsage: OpenAiTokenUsage | null = body.usage
    && typeof body.usage.input_tokens === 'number' && typeof body.usage.output_tokens === 'number'
    ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }
    : null;
  const estimatedCostUsd = tokenUsage ? estimateOpenAiCostUsd(OPENAI_IMAGE_MODEL, tokenUsage) : null;

  return { pngBase64, mimeType: 'image/png', tokenUsage, estimatedCostUsd, fullPromptSent };
}
