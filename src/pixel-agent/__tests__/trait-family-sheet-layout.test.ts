/**
 * Pixel Forge — Stage 10.2 offline tests: the 10×8 Trait Family Sheet
 * layout foundation (src/pixel-agent/trait-sheet.ts's
 * `TRAIT_FAMILY_SHEET_10X8` + its Stage 10.2 helper exports). Pure
 * geometry/schema checks plus the existing, unmodified `cropTraitSheetCells`
 * against synthetic in-memory PNGs (sharp `create` — no file I/O, no
 * network, no OpenAI/Anthropic call of any kind).
 * Run: `npx ts-node src/pixel-agent/__tests__/trait-family-sheet-layout.test.ts`.
 */
import assert from 'assert';
import sharp from 'sharp';
import {
  TRAIT_FAMILY_SHEET_10X8, TRAIT_FAMILY_CATEGORIES, TraitFamilyCategory,
  getTraitFamilyCategoryForCell, getTraitFamilyRowForCategory, getTraitFamilyCellsByCategory,
  getTraitFamilyCellName, cropTraitSheetCells,
} from '../trait-sheet';

const ROW_CATEGORY_ORDER: TraitFamilyCategory[] = [
  'hat', 'hoodie', 'eyes', 'mouth', 'face_mask', 'accessory', 'head_fur', 'background',
];

// suggestedLayerType mapping per the Stage 10.2 task spec — a category can
// legitimately diverge from its own name (e.g. 'hat' -> 'accessory') since
// LayerType is deliberately NOT widened in this stage.
const EXPECTED_SUGGESTED_LAYER_TYPE: Record<TraitFamilyCategory, string> = {
  hat: 'accessory',
  hoodie: 'body',
  eyes: 'eyes',
  mouth: 'mouth',
  face_mask: 'other',
  accessory: 'accessory',
  head_fur: 'body',
  background: 'background',
};

async function main() {
  // ── 1. geometry: 80 cells, 8 rows x 10 cols ─────────────────────────────
  assert.strictEqual(TRAIT_FAMILY_SHEET_10X8.rows, 8);
  assert.strictEqual(TRAIT_FAMILY_SHEET_10X8.cols, 10);
  assert.strictEqual(TRAIT_FAMILY_SHEET_10X8.cells.length, 80, 'expected exactly 80 cells (8 rows x 10 cols)');
  console.log('[ok] TRAIT_FAMILY_SHEET_10X8 has 80 cells (rows=8, cols=10)');

  // ── 2. every row has exactly 10 cells ────────────────────────────────────
  for (let row = 0; row < 8; row++) {
    const inRow = TRAIT_FAMILY_SHEET_10X8.cells.filter(c => c.row === row);
    assert.strictEqual(inRow.length, 10, `row ${row} must have exactly 10 cells, got ${inRow.length}`);
  }
  console.log('[ok] every row has exactly 10 cells');

  // ── 3. bounds are fractional (0..1) and non-overlapping (an even grid
  //        tiling — verify by summing cell areas to exactly 1.0 and
  //        checking no two cells share the same row/col slot) ─────────────
  let totalArea = 0;
  const seenSlots = new Set<string>();
  for (const cell of TRAIT_FAMILY_SHEET_10X8.cells) {
    const { x, y, w, h } = cell.bboxFraction;
    for (const v of [x, y, w, h]) {
      assert.ok(v >= 0 && v <= 1, `bboxFraction value ${v} for cell ${cell.cellId} must be in [0,1]`);
    }
    assert.ok(x + w <= 1 + 1e-9, `cell ${cell.cellId} bbox must not extend past the sheet's right edge`);
    assert.ok(y + h <= 1 + 1e-9, `cell ${cell.cellId} bbox must not extend past the sheet's bottom edge`);
    totalArea += w * h;
    const slotKey = `${cell.row},${cell.col}`;
    assert.ok(!seenSlots.has(slotKey), `row/col slot ${slotKey} must be unique (no overlapping cells)`);
    seenSlots.add(slotKey);
  }
  assert.ok(Math.abs(totalArea - 1) < 1e-9, `cell areas must sum to exactly 1.0 (a full, non-overlapping tiling), got ${totalArea}`);
  console.log('[ok] all bounds are fractional 0..1 and cells tile the sheet with no overlap');

  // ── 4. every expected cellId exists, per category, 00..09 ──────────────
  const cellIds = new Set(TRAIT_FAMILY_SHEET_10X8.cells.map(c => c.cellId));
  for (const category of ROW_CATEGORY_ORDER) {
    for (let i = 0; i < 10; i++) {
      const expected = getTraitFamilyCellName(category, i);
      assert.ok(cellIds.has(expected), `expected cellId "${expected}" to exist in TRAIT_FAMILY_SHEET_10X8`);
    }
  }
  assert.strictEqual(cellIds.size, 80, 'all 80 cellIds must be unique');
  console.log('[ok] every expected cellId (hat_00..09, hoodie_00..09, ..., background_00..09) exists');

  // ── 5. each category maps to its correct fixed row ──────────────────────
  for (let row = 0; row < ROW_CATEGORY_ORDER.length; row++) {
    assert.strictEqual(getTraitFamilyRowForCategory(ROW_CATEGORY_ORDER[row]), row, `category "${ROW_CATEGORY_ORDER[row]}" must map to row ${row}`);
  }
  // Cross-check via the cell defs themselves, not just the row-def table.
  for (const cell of TRAIT_FAMILY_SHEET_10X8.cells) {
    assert.strictEqual(cell.familyCategory, ROW_CATEGORY_ORDER[cell.row], `cell ${cell.cellId} at row ${cell.row} must carry familyCategory "${ROW_CATEGORY_ORDER[cell.row]}"`);
  }
  console.log('[ok] each category maps to its correct row, on both the row-def table and every cell');

  // ── 6. suggestedLayerType mapping is correct ────────────────────────────
  for (const cell of TRAIT_FAMILY_SHEET_10X8.cells) {
    const expected = EXPECTED_SUGGESTED_LAYER_TYPE[cell.familyCategory as TraitFamilyCategory];
    assert.strictEqual(cell.suggestedLayerType, expected, `cell ${cell.cellId} (category ${cell.familyCategory}) expected suggestedLayerType "${expected}", got "${cell.suggestedLayerType}"`);
  }
  console.log('[ok] suggestedLayerType mapping matches the Stage 10.2 spec for every cell');

  // ── 7. getTraitFamilyCategoryForCell / getTraitFamilyCellsByCategory ────
  assert.strictEqual(getTraitFamilyCategoryForCell('hat_00'), 'hat');
  assert.strictEqual(getTraitFamilyCategoryForCell('background_09'), 'background');
  assert.strictEqual(getTraitFamilyCategoryForCell('does_not_exist'), undefined);

  const grouped = getTraitFamilyCellsByCategory();
  assert.strictEqual(TRAIT_FAMILY_CATEGORIES.length, 8);
  for (const category of TRAIT_FAMILY_CATEGORIES) {
    assert.strictEqual(grouped[category].length, 10, `getTraitFamilyCellsByCategory()["${category}"] must have exactly 10 cells`);
    assert.ok(grouped[category].every(c => c.familyCategory === category));
  }
  console.log('[ok] getTraitFamilyCategoryForCell / getTraitFamilyCellsByCategory are correct');

  // ── 8. cropTraitSheetCells() on a synthetic 1000x800 PNG -> exactly 80
  //        cells, each cropped to the expected 100x100 (1000/10 cols x
  //        800/8 rows) ───────────────────────────────────────────────────
  const squareSource = await sharp({
    create: { width: 1000, height: 800, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 255 } },
  }).png().toBuffer();

  const croppedSquareGrid = await cropTraitSheetCells(squareSource, TRAIT_FAMILY_SHEET_10X8);
  assert.strictEqual(croppedSquareGrid.length, 80, 'cropTraitSheetCells must return exactly 80 cells');
  for (const cell of croppedSquareGrid) {
    assert.strictEqual(cell.cropBBoxPx.w, 100, `cell ${cell.cellId} width must be 100px for a 1000px-wide source (1000/10 cols)`);
    assert.strictEqual(cell.cropBBoxPx.h, 100, `cell ${cell.cellId} height must be 100px for an 800px-tall source (800/8 rows)`);
    assert.strictEqual(cell.warnings.length, 0, `cell ${cell.cellId} should crop cleanly with no clamping warnings on an exact-multiple source`);
  }
  console.log('[ok] cropTraitSheetCells crops a synthetic 1000x800 source into 80 cells of exactly 100x100 each');

  // ── 9. non-square source still crops correctly by fraction (existing
  //        crop logic already reads real decoded dimensions, never
  //        assumes square — verify against a 750x400 source: cols=10 ->
  //        75px cells, rows=8 -> 50px cells) ──────────────────────────────
  const nonSquareSource = await sharp({
    create: { width: 750, height: 400, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 255 } },
  }).png().toBuffer();

  const croppedNonSquare = await cropTraitSheetCells(nonSquareSource, TRAIT_FAMILY_SHEET_10X8);
  assert.strictEqual(croppedNonSquare.length, 80);
  for (const cell of croppedNonSquare) {
    assert.strictEqual(cell.cropBBoxPx.w, 75, `cell ${cell.cellId} width must be 75px for a 750px-wide non-square source (750/10 cols)`);
    assert.strictEqual(cell.cropBBoxPx.h, 50, `cell ${cell.cellId} height must be 50px for a 400px-tall non-square source (400/8 rows)`);
  }
  // Spot-check actual pixel offsets for a couple of cells against their
  // fractional bbox, not just width/height, to confirm x/y (not just w/h)
  // scale correctly against a non-square source.
  const hat05 = croppedNonSquare.find(c => c.cellId === 'hat_05')!;
  assert.strictEqual(hat05.cropBBoxPx.x, Math.round(0.5 * 750), 'hat_05 (col 5 of 10) x offset must scale correctly against the 750px-wide source');
  assert.strictEqual(hat05.cropBBoxPx.y, 0, 'hat_05 (row 0) y offset must be 0');
  const background09 = croppedNonSquare.find(c => c.cellId === 'background_09')!;
  assert.strictEqual(background09.cropBBoxPx.y, Math.round(7 / 8 * 400), 'background_09 (row 7 of 8) y offset must scale correctly against the 400px-tall source');
  console.log('[ok] cropTraitSheetCells crops a non-square 750x400 source correctly by fraction (75x50 cells, correct x/y offsets)');
}

main()
  .then(() => console.log('[pass] trait-family-sheet-layout.test.ts'))
  .catch((err) => {
    console.error('[fail] trait-family-sheet-layout.test.ts', err);
    process.exitCode = 1;
  });
