/**
 * Pixel Forge — Stage 10.3 offline tests: the Trait Family Sheet prompt
 * builder. Pure string assertions only — no network access, no
 * global.fetch mock needed (this module makes no fetch call of any kind,
 * same as trait-sheet-validation.test.ts's own rationale), no route
 * touched, no OpenAI/Anthropic call.
 * Run: `npx ts-node src/pixel-agent/__tests__/openai-trait-family-sheet-prompts.test.ts`.
 */
import assert from 'assert';
import {
  buildTraitFamilySheetPrompt, TRAIT_FAMILY_SHEET_PROMPT_VERSION, TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS,
  TRAIT_FAMILY_SHEET_ROWS, TRAIT_FAMILY_SHEET_COLS, TRAIT_FAMILY_SHEET_CELL_COUNT,
} from '../openai-trait-family-sheet-prompts';

function main() {
  const userPrompt = 'a moody pixel raccoon collection, dark palette, thick outlines';
  const prompt = buildTraitFamilySheetPrompt(userPrompt);

  // ── grid size ────────────────────────────────────────────────────────
  assert.strictEqual(TRAIT_FAMILY_SHEET_ROWS, 8);
  assert.strictEqual(TRAIT_FAMILY_SHEET_COLS, 10);
  assert.strictEqual(TRAIT_FAMILY_SHEET_CELL_COUNT, 80);
  assert.ok(prompt.includes('10x8'), 'prompt must mention the 10x8 grid');
  assert.ok(prompt.includes('8 rows'), 'prompt must mention 8 rows');
  assert.ok(prompt.includes('10 columns'), 'prompt must mention 10 columns');
  assert.ok(prompt.includes('80'), 'prompt must mention the total 80-cell count');
  console.log('[ok] prompt states the 10x8 / 8 rows / 10 columns / 80-cell grid');

  // ── all 8 row category descriptions present, in order ───────────────
  assert.strictEqual(TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS.length, 8);
  const expectedRowDescriptions = [
    '10 hats/headwear variants',
    '10 hoodie/body/clothing variants',
    '10 eye variants',
    '10 mouth/nose expression variants',
    '10 face mask/fur marking variants',
    '10 accessory variants',
    '10 head/fur/base-head variants',
    '10 background/misc variants',
  ];
  for (let row = 0; row < expectedRowDescriptions.length; row++) {
    assert.strictEqual(TRAIT_FAMILY_SHEET_ROW_DESCRIPTIONS[row].description, expectedRowDescriptions[row], `row ${row} description mismatch`);
    assert.ok(prompt.includes(expectedRowDescriptions[row]), `prompt must include row ${row}'s description: "${expectedRowDescriptions[row]}"`);
    assert.ok(prompt.includes(`Row ${row}:`), `prompt must label row ${row} explicitly`);
  }
  console.log('[ok] prompt contains all 8 row category descriptions, in the correct row order');

  // ── no full characters / no completed NFT / no preview cell ─────────
  assert.ok(prompt.includes('NOT a finished character'));
  assert.ok(prompt.includes('NOT a completed NFT'));
  assert.ok(prompt.includes('Do not draw assembled characters.'));
  assert.ok(prompt.includes('Do not draw the same finished character 80 times.'));
  assert.ok(prompt.includes('Do not draw a full NFT preview cell anywhere on the sheet'));
  assert.ok(prompt.includes('there is no preview cell in this layout'));
  assert.ok(prompt.includes('Do not include full bodies in hat/eyes/mouth rows.'));
  assert.ok(prompt.includes("Only draw the specific category for that row"));
  assert.ok(prompt.includes('Every object must be isolated and reusable'));
  console.log('[ok] prompt explicitly forbids assembled/finished characters, completed NFTs, and any preview cell');

  // ── transparent PNG / alpha ───────────────────────────────────────────
  assert.ok(prompt.includes('transparent PNG'), 'prompt must say "transparent PNG"');
  assert.ok(/alpha\s*=\s*0/i.test(prompt), 'prompt must describe alpha = 0 for non-component pixels');
  assert.ok(!prompt.includes('#FF00FF'), 'prompt must NOT fall back to the old Stage 9.5 magenta key color');
  console.log('[ok] prompt requires a transparent PNG / alpha=0 background, with no magenta key-color fallback');

  // ── no labels/text/grid lines ─────────────────────────────────────────
  assert.ok(prompt.includes('No grid lines'));
  assert.ok(prompt.includes('no text'));
  assert.ok(prompt.includes('no labels'));
  console.log('[ok] prompt forbids grid lines, text, and labels');

  // ── same style/palette/outline/shading ────────────────────────────────
  assert.ok(prompt.includes('the same pixel-art style'));
  assert.ok(prompt.includes('the same outline weight'));
  assert.ok(prompt.includes('the same palette family'));
  assert.ok(prompt.includes('the same shading style'));
  assert.ok(prompt.includes('the same scale logic'));
  console.log('[ok] prompt requires consistent style/outline/palette/shading/scale across all 80 components');

  // ── invisible 48x48 avatar canvas ─────────────────────────────────────
  assert.ok(prompt.includes('48x48 avatar canvas'), 'prompt must mention the invisible 48x48 avatar canvas');
  assert.ok(prompt.includes('invisible 48x48'));
  console.log('[ok] prompt references the shared invisible 48x48 avatar canvas components must stack on');

  // ── centered / padding / fits inside cell ─────────────────────────────
  assert.ok(prompt.includes('CENTERED inside its own cell'));
  assert.ok(prompt.includes('empty padding on all four sides'));
  assert.ok(prompt.includes('fit ENTIRELY inside its own cell boundaries'));
  console.log('[ok] prompt requires each component to be centered, padded, and fully inside its own cell');

  // ── style-only reference / do not copy subject identity ──────────────
  assert.ok(prompt.includes('Use the reference image for STYLE ONLY'));
  assert.ok(prompt.includes("Do not copy the reference image's specific subject, identity"));
  console.log('[ok] prompt treats the reference image as style-only, explicitly forbidding subject/identity copying');

  // ── userPrompt is included verbatim ───────────────────────────────────
  assert.ok(prompt.includes(userPrompt), 'prompt must include the caller-supplied userPrompt verbatim');
  console.log('[ok] prompt includes the caller-supplied userPrompt verbatim');

  // ── version constant exists and is a non-empty string ─────────────────
  assert.strictEqual(typeof TRAIT_FAMILY_SHEET_PROMPT_VERSION, 'string');
  assert.ok(TRAIT_FAMILY_SHEET_PROMPT_VERSION.length > 0);
  console.log(`[ok] TRAIT_FAMILY_SHEET_PROMPT_VERSION = "${TRAIT_FAMILY_SHEET_PROMPT_VERSION}"`);

  // ── pure function: same input -> byte-identical output, no randomness ──
  assert.strictEqual(buildTraitFamilySheetPrompt(userPrompt), prompt, 'buildTraitFamilySheetPrompt must be deterministic for the same input');

  console.log('[pass] openai-trait-family-sheet-prompts.test.ts — pure string building only, no network access, no OpenAI/Anthropic call');
}

main();
