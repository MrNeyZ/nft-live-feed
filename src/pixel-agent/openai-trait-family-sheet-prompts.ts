/**
 * Pixel Forge — Stage 10.3: Trait Family Sheet prompt builder. Pure
 * string-building only — no network call, no OpenAI/Anthropic import, no
 * fetch, no side effects. Not wired into any route yet (that's Stage
 * 10.4) — this module exists purely so its prompt text can be built and
 * unit-tested in isolation.
 *
 * Conceptual pivot from Stage 9's `openai-trait-sheet-prompts.ts` (the
 * 2/4/8-cell "preview + decomposed layers of one completed character"
 * sheet, now superseded — see project memory
 * project_pixel_forge_stage10_pivot): this is NOT a completed-NFT
 * decomposition and there is NO preview/reference cell anywhere on the
 * sheet. Every one of the 80 cells is its own independent, reusable trait
 * component destined for the Trait Library — the model is asked to draw
 * a small CATALOG of interchangeable parts, not a character split into
 * pieces. Row/category order matches trait-sheet.ts's
 * `TRAIT_FAMILY_SHEET_10X8`/`TraitFamilyCategory` exactly (imported here
 * for the category vocabulary/order, not for pixel geometry — same
 * "duplicate the grid description, don't import crop math" precedent
 * openai-trait-sheet-prompts.ts already established for its own 2x4 grid,
 * since a prompt-builder module has no business depending on crop/sharp
 * code to stay independently testable).
 *
 * Background strategy deliberately diverges from Stage 9.5's magenta-key-
 * color hardening: that hardening existed because, at the time, nothing
 * in this codebase ever requested OpenAI's `background`/`output_format`
 * API parameters — transparency was prompt-text-only and gpt-image-1
 * didn't reliably honor it. Stage 10.1 (already shipped) changed that:
 * `generateSourceImage` (openai-image-source.ts) now unconditionally
 * sends `background: 'transparent'` and `output_format: 'png'` as real
 * request parameters on every call, regardless of source mode. This
 * prompt's "transparent PNG, alpha channel" language is therefore
 * reinforcing an actual API-level request, not hoping words alone produce
 * one — so there is no key-color fallback here by design.
 */

import { TraitFamilyCategory } from './trait-sheet';

/** Bump whenever the prompt text changes meaningfully — lets any future
 *  logging/debug tooling (mirroring trait-sheet-debug.ts's own
 *  diagnosis-only posture) tag which prompt revision produced a given
 *  generated sheet, without needing to diff the full string. */
export const TRAIT_FAMILY_SHEET_PROMPT_VERSION = 'trait-family-sheet-prompt-v1';

export interface TraitFamilySheetRowDescription {
  category: TraitFamilyCategory;
  /** Prompt-facing description of this row's 10 variants — matches the
   *  Stage 10.3 task spec's row table verbatim. */
  description: string;
}

/**
 * Row order matches `TRAIT_FAMILY_SHEET_10X8.cells[].row` (trait-sheet.ts)
 * exactly: index 0 = row 0 = hats, ... index 7 = row 7 = backgrounds/misc.
 * Duplicated here (not imported) on purpose — see this file's header
 * comment on why a prompt-builder module doesn't depend on the crop
 * module's layout object.
 */
export const TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS: readonly TraitFamilySheetRowDescription[] = [
  { category: 'hat', description: '10 hats/headwear variants' },
  { category: 'hoodie', description: '10 hoodie/body/clothing variants' },
  { category: 'eyes', description: '10 eye variants' },
  { category: 'mouth', description: '10 mouth/nose expression variants' },
  { category: 'face_mask', description: '10 face mask/fur marking variants' },
  { category: 'accessory', description: '10 accessory variants' },
  { category: 'head_fur', description: '10 head/fur/base-head variants' },
  { category: 'background', description: '10 background/misc variants' },
];

export const TRAIT_FAMILY_SHEET_ROWS = 8;
export const TRAIT_FAMILY_SHEET_COLS = 10;
export const TRAIT_FAMILY_SHEET_CELL_COUNT = TRAIT_FAMILY_SHEET_ROWS * TRAIT_FAMILY_SHEET_COLS;

/** Minimum empty padding, as a percentage of each cell's own width/height,
 *  required on all four sides of every component — same numeric values
 *  Stage 9.5 already proved necessary (a real smoke test found gpt-
 *  image-1 drawing at roughly double the intended scale without an
 *  explicit budget), redefined locally rather than imported from
 *  openai-trait-sheet-prompts.ts so this module stays fully independent
 *  of the (superseded) Stage 9 prompt builder. */
export const TRAIT_FAMILY_SHEET_MIN_PADDING_PCT = 20;
export const TRAIT_FAMILY_SHEET_MAX_HEIGHT_PCT = 55;
export const TRAIT_FAMILY_SHEET_MAX_WIDTH_PCT = 70;

/**
 * Builds the full prompt text for a Trait Family Sheet generation
 * request. `userPrompt` is the caller-supplied collection/character style
 * description (equivalent to today's single-image `prompt` field) — the
 * reference image + this text together describe STYLE only (pixel-art
 * look, outline weight, palette family, shading, scale logic), never a
 * specific character to reproduce or decompose. The returned string is a
 * complete, self-contained prompt; callers may still append their own
 * unconditional safety suffix on top (e.g. `DO_NOT_COPY_SUFFIX` in
 * openai-image-source.ts) exactly as every other prompt in this codebase
 * already does — this function does not assume or duplicate that.
 */
export function buildTraitFamilySheetPrompt(userPrompt: string): string {
  const lines: string[] = [];

  lines.push(
    `Generate ONE flat image: a ${TRAIT_FAMILY_SHEET_COLS}x${TRAIT_FAMILY_SHEET_ROWS} TRAIT FAMILY SHEET, a reusable `
    + `component catalog for a pixel-art NFT collection — NOT a finished character, NOT a completed NFT, and NOT a `
    + `preview of one. This is a strict, PHYSICAL grid of ${TRAIT_FAMILY_SHEET_COLS} columns by `
    + `${TRAIT_FAMILY_SHEET_ROWS} rows, exactly ${TRAIT_FAMILY_SHEET_CELL_COUNT} cells total, evenly divided. Treat `
    + `every cell as an INDEPENDENT, SEPARATE FRAME containing exactly one isolated, reusable trait component — `
    + `never a continuous scene, never a full character, never a completed NFT.`,
  );
  lines.push('');
  lines.push(
    'Use the reference image for STYLE ONLY — pixel-art look, outline weight, color palette family, shading '
    + 'technique, and overall scale logic. Do not copy the reference image\'s specific subject, identity, pose, or '
    + 'exact character design; every component you draw must still belong to the SAME collection style, but must '
    + 'be a genuinely new, independent trait, not a copy or a crop of the reference character.',
  );
  lines.push('');
  lines.push(`Each row is ONE fixed trait category, with exactly 10 different variants of that category, one per column:`);
  for (let row = 0; row < TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS.length; row++) {
    lines.push(`- Row ${row}: ${TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS[row].description}.`);
  }
  lines.push('');
  lines.push(`Collection style: ${userPrompt}`);
  lines.push('');
  lines.push('CRITICAL RULES — apply to every single one of the 80 cells, no exceptions:');
  lines.push('- Do not draw assembled characters.');
  lines.push('- Do not draw the same finished character 80 times.');
  lines.push('- Do not draw a full NFT preview cell anywhere on the sheet — there is no preview cell in this layout.');
  lines.push('- Do not include full bodies in hat/eyes/mouth rows.');
  lines.push('- Only draw the specific category for that row — nothing from any other row\'s category.');
  lines.push('- Every object must be isolated and reusable — a single self-contained component, not part of a larger scene.');
  lines.push(
    '- All 10 variants within one row must be clearly different from each other — no two cells in the same row may '
    + 'be identical or near-identical.',
  );
  lines.push('');
  lines.push('SIZE, PLACEMENT, AND CONSISTENCY RULES — apply to every single cell:');
  lines.push('- Each component must be CENTERED inside its own cell.');
  lines.push(
    `- Leave AT LEAST ${TRAIT_FAMILY_SHEET_MIN_PADDING_PCT}% empty padding on all four sides of every component — `
    + `it must never touch or come closer than ${TRAIT_FAMILY_SHEET_MIN_PADDING_PCT}% of the cell's own width/height `
    + 'from any edge.',
  );
  lines.push(
    `- Each component must occupy NO MORE than ${TRAIT_FAMILY_SHEET_MAX_HEIGHT_PCT}% of the cell's own height and `
    + `NO MORE than ${TRAIT_FAMILY_SHEET_MAX_WIDTH_PCT}% of the cell's own width.`,
  );
  lines.push(
    "- Each component must fit ENTIRELY inside its own cell boundaries — do not crop, cut off, touch, or overlap "
    + "the cell's own edges, and never cross into a neighboring cell.",
  );
  lines.push(
    '- All 80 components must share the exact SAME collection style: the same pixel-art style, the same outline '
    + 'weight, the same palette family, the same shading style, and the same scale logic — as if every component '
    + 'were designed to belong to one single, coherent collection.',
  );
  lines.push(
    '- Every component must be designed to stack correctly on the same invisible 48x48 avatar canvas — same '
    + 'implied scale and anchor position across all 80 cells, so any hat lines up with any head/fur variant, any '
    + 'eyes line up with any face mask, and so on, regardless of which specific variants are later combined.',
  );
  lines.push('');
  lines.push('BACKGROUND — read carefully, this is critical:');
  lines.push(
    'The entire image is ONE transparent PNG sheet. Every pixel that is not part of a component itself must be '
    + 'fully transparent (alpha = 0) — not white, not black, not any flat color, not a gradient. Only the 80 '
    + 'components themselves may have any opacity.',
  );
  lines.push(
    'No grid lines, no borders, no dividing lines of any kind, no text, no numbers, and no labels anywhere in the '
    + 'image — the grid boundaries are entirely invisible; only transparent space separates one cell from the next.',
  );
  lines.push('');
  lines.push(
    'Output exactly ONE sheet image containing all 80 cells together — never separate images, never a collage of '
    + 'files, never fewer than 80 components.',
  );

  return lines.join('\n');
}
