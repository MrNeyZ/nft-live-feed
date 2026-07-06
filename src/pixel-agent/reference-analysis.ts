/**
 * Pixel Forge — Reference Mode MVP: validation + (mocked) analysis of an
 * optional, per-generation reference image. See
 * docs/pixel-forge-reference-mode-mvp.md for the full design; this file
 * implements §2 (validation) and the mock half of §8.3/§10 (analysis).
 *
 * Hard rule this file exists to enforce: the reference image is shown to
 * NOTHING except `analyzeReferenceImage` (and, once wired, the one
 * forced-tool-call vision request inside it) — never to `runDrawingJob`,
 * never persisted to disk, never echoed back to the caller. Only the
 * short derived `ReferenceGuidance` text is allowed to outlive this
 * module's one call. This is a structural anti-copying guarantee, not a
 * policy comment — see design doc §5.
 *
 * CURRENT STATUS: `analyzeReferenceImage` is a MOCK — it makes no
 * Anthropic call and returns a fixed placeholder. Wiring in the real
 * call (a forced-tool-call request, same pattern as
 * `SUBMIT_EVALUATION_TOOL` in ./tools.ts, forced to the `fast`/Haiku
 * preset regardless of the job's own model per design doc §8.4) is
 * deliberately deferred — see the function's own doc comment below for
 * exactly what to replace.
 */

import sharp from 'sharp';

export type ReferenceMimeType = 'image/png' | 'image/jpeg';

export const ALLOWED_REFERENCE_MIME_TYPES: ReadonlySet<string> = new Set<ReferenceMimeType>([
  'image/png', 'image/jpeg',
]);

/** Deliberately small — this is a one-shot style hint analyzed once, not a
 *  stored asset. Keeps the (future) vision call's image tokens tiny and
 *  keeps the existing 10mb express.json() body limit (app.ts) irrelevant
 *  to this feature (2mb base64 is well under that with room to spare). */
export const REFERENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Analysis only, never rendered at native resolution — no reason for a
 *  reference to be larger than this. */
export const REFERENCE_IMAGE_MAX_DIMENSION = 1024;

export interface ReferenceImageInput {
  /** Raw image bytes, base64-encoded, no `data:` URL prefix. */
  base64: string;
  mimeType: ReferenceMimeType;
}

export type ReferenceValidationResult =
  | { ok: true; buffer: Buffer; mimeType: ReferenceMimeType; width: number; height: number }
  | { ok: false; error: string };

/** Validates an uploaded reference image: declared mime type, decoded byte
 *  size, and — via `sharp`, which throws on a non-image buffer regardless
 *  of what the caller claimed — that it's an actual image within the
 *  allowed dimensions. Never writes the buffer anywhere; the caller is
 *  responsible for discarding it once analysis (real or mock) returns. */
export async function validateReferenceImage(input: ReferenceImageInput): Promise<ReferenceValidationResult> {
  if (!ALLOWED_REFERENCE_MIME_TYPES.has(input.mimeType)) {
    return { ok: false, error: 'invalid_reference_mime_type' };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.base64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_reference_encoding' };
  }
  if (buffer.length === 0) return { ok: false, error: 'invalid_reference_encoding' };
  if (buffer.length > REFERENCE_IMAGE_MAX_BYTES) return { ok: false, error: 'reference_image_too_large' };

  let width: number | undefined;
  let height: number | undefined;
  try {
    const metadata = await sharp(buffer).metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    return { ok: false, error: 'reference_image_unreadable' };
  }
  if (!width || !height) return { ok: false, error: 'reference_image_unreadable' };
  if (width > REFERENCE_IMAGE_MAX_DIMENSION || height > REFERENCE_IMAGE_MAX_DIMENSION) {
    return { ok: false, error: 'reference_image_dimensions_too_large' };
  }

  return { ok: true, buffer, mimeType: input.mimeType, width, height };
}

/** Structure/style-only guidance derived from a reference image — no
 *  coordinates, no literal color values, no "reproduce this" fields.
 *  `exclusions` is deliberately mandatory-shaped (never optional) so a
 *  caller can't accidentally fold guidance into a prompt with no
 *  do-not-copy instruction attached. See design doc §5/§6. */
export interface ReferenceGuidance {
  /** Transferable construction properties only — proportions, outline
   *  weight/consistency, palette-ramp behavior, silhouette, cluster
   *  density. Never literal hex values, never the subject itself. */
  inherit: string[];
  /** What must NOT be carried over — the reference's specific subject,
   *  named accessories/symbols, exact colors, exact composition. Folded
   *  into the prompt as active negative guidance, not passive omission. */
  exclusions: string[];
  /** One-line free-text summary, shown in the UI (design doc §1.5) and
   *  optionally persisted on the resulting TraitAsset (§8.7). */
  note: string;
}

/** Folds a ReferenceGuidance into the single text block
 *  `buildSystemPrompt` accepts as its `referenceGuidance` param — kept
 *  here (not duplicated in agent-loop.ts) so the inherit/exclusions
 *  structure has exactly one place that turns it into prose. */
export function renderReferenceGuidanceText(guidance: ReferenceGuidance): string {
  const lines: string[] = [];
  if (guidance.inherit.length > 0) {
    lines.push('Inherit (structure/style only):');
    for (const item of guidance.inherit) lines.push(`- ${item}`);
  }
  if (guidance.exclusions.length > 0) {
    lines.push('Do NOT reproduce (active exclusions, not a suggestion):');
    for (const item of guidance.exclusions) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

/**
 * MOCK — makes no Anthropic call. Returns a fixed, clearly-labeled
 * placeholder so the rest of the pipeline (upload → validate → guidance
 * → buildSystemPrompt → TraitAsset) can be exercised and tested end to
 * end with zero API calls, per the current implementation phase.
 *
 * TO WIRE IN THE REAL ANALYSIS LATER: replace this function's body with
 * a single forced-tool-call request — same pattern as
 * `SUBMIT_EVALUATION_TOOL`/`parseEvaluation` in ./tools.ts — that:
 *   1. Sends `buffer` as one image content block, forces a tool call with
 *      an `inherit`/`exclusions`/`note` schema identical to
 *      `ReferenceGuidance` above.
 *   2. ALWAYS uses the `fast` (Haiku) model preset, regardless of the
 *      drawing job's own `modelPreset` — see design doc §8.4.
 *   3. Never lets `buffer` (or the Anthropic client's image content block
 *      built from it) survive past this function returning — the caller
 *      already only holds onto the returned `ReferenceGuidance`.
 * Nothing else in this file or its callers needs to change when that
 * swap happens.
 */
export async function analyzeReferenceImage(
  input: { buffer: Buffer; mimeType: ReferenceMimeType },
): Promise<ReferenceGuidance> {
  void input; // mock does not inspect the image — no API call is made
  console.log('[pixel-forge/reference] analyzeReferenceImage: MOCK path, no Anthropic call made');
  return {
    inherit: [
      'MOCK — placeholder guidance only; no reference image was actually analyzed.',
    ],
    exclusions: [
      'MOCK — do not reproduce the reference\'s specific subject, accessories, symbols, exact colors, or composition.',
    ],
    note: 'Reference analysis is stubbed in this build (no Anthropic call yet) — this generation used placeholder guidance only, not real image analysis.',
  };
}
