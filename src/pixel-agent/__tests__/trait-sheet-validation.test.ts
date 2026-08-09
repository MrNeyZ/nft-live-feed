/**
 * Pixel Forge — Stage 9.4 offline tests: trait-sheet validation. No
 * network access at all — trait-sheet-validation.ts makes no fetch call
 * of any kind (pure sharp + arithmetic), so unlike the Stage 9.3 test
 * there is no global.fetch to mock and nothing to chdir a scratch
 * directory for (this module never touches disk). Every sheet here is a
 * synthetic 1024x1024 PNG built in-memory with sharp — solid-color rects
 * placed at exact fractions of each LAYER_SHEET_2X4 cell's own bbox, same
 * "distinct solid colors at each cell's centered-square location"
 * synthetic-fixture convention Stage 9.1's own kickoff prompt specified
 * for trait-sheet.ts's tests.
 * Run: `npx ts-node src/pixel-agent/__tests__/trait-sheet-validation.test.ts`.
 */
import assert from 'assert';
import sharp from 'sharp';
import { LAYER_SHEET_2X4 } from '../trait-sheet';
import { validateTraitSheet } from '../trait-sheet-validation';

const SOURCE_SIZE = 1024;

interface RectFraction { fx0: number; fy0: number; fx1: number; fy1: number; }
interface CellRectSpec extends RectFraction { color: [number, number, number, number]; }
interface TinyMark { x: number; y: number; size: number; }

// Well inset (30%-70% of the cell's own region) — used for every "valid,
// aligned" cell across the tests below so their normalized foreground bbox
// centers land at the same relative position, giving near-zero alignment
// drift by construction.
const CENTERED: RectFraction = { fx0: 0.3, fy0: 0.3, fx1: 0.7, fy1: 0.7 };
// Shifted hard toward the cell's own top-left corner — for the
// misalignment test.
const OFFSET: RectFraction = { fx0: 0.02, fy0: 0.02, fx1: 0.32, fy1: 0.32 };
// Spans the full cell width and most of its height, touching the left/
// top/right edges — for the boundary-bleed test. Still leaves ~35% of
// the crop transparent (bottom strip) so background classification
// correctly reads this as a real "transparent" cell, not an
// (indistinguishable) fully-opaque one.
const BOUNDARY_TOUCH: RectFraction = { fx0: 0, fy0: 0, fx1: 1, fy1: 0.65 };
const FULL: RectFraction = { fx0: 0, fy0: 0, fx1: 1, fy1: 1 };

function cellPxBounds(cellId: string): { x: number; y: number; w: number; h: number } {
  const cell = LAYER_SHEET_2X4.cells.find(c => c.cellId === cellId);
  if (!cell) throw new Error(`unknown cellId in test fixture: ${cellId}`);
  return {
    x: Math.round(cell.bboxFraction.x * SOURCE_SIZE), y: Math.round(cell.bboxFraction.y * SOURCE_SIZE),
    w: Math.round(cell.bboxFraction.w * SOURCE_SIZE), h: Math.round(cell.bboxFraction.h * SOURCE_SIZE),
  };
}

// Each cell may draw MULTIPLE stacked rects (bottom to top, array order) —
// needed for a realistic "well-formed" sheet where the preview cell shows
// a background fill PLUS a foreground subject on top, matching what
// composing the real background + layer cells would actually produce.
async function buildSyntheticSheet(
  cellRects: Partial<Record<string, CellRectSpec[]>>,
  marks: Partial<Record<string, TinyMark[]>> = {},
): Promise<Buffer> {
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (const [cellId, specs] of Object.entries(cellRects)) {
    if (!specs) continue;
    const b = cellPxBounds(cellId);
    for (const spec of specs) {
      const rx0 = Math.round(spec.fx0 * b.w), ry0 = Math.round(spec.fy0 * b.h);
      const rx1 = Math.round(spec.fx1 * b.w), ry1 = Math.round(spec.fy1 * b.h);
      const rw = Math.max(1, rx1 - rx0), rh = Math.max(1, ry1 - ry0);
      const [r, g, bch, a] = spec.color;
      const rectBuf = await sharp({ create: { width: rw, height: rh, channels: 4, background: { r, g, b: bch, alpha: a / 255 } } }).png().toBuffer();
      composites.push({ input: rectBuf, left: b.x + rx0, top: b.y + ry0 });
    }
  }
  for (const [cellId, cellMarks] of Object.entries(marks)) {
    if (!cellMarks) continue;
    const b = cellPxBounds(cellId);
    for (const m of cellMarks) {
      const markBuf = await sharp({ create: { width: m.size, height: m.size, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } } }).png().toBuffer();
      composites.push({ input: markBuf, left: b.x + m.x, top: b.y + m.y });
    }
  }
  return sharp({ create: { width: SOURCE_SIZE, height: SOURCE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png().toBuffer();
}

async function main() {
  // ── 1. valid 2-cell ────────────────────────────────────────────────
  const sheet1 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    hat_accessory: [{ ...CENTERED, color: [80, 200, 80, 255] }],
  });
  const r1 = await validateTraitSheet(sheet1, 'trait-sheet-2-cell');
  assert.notStrictEqual(r1.verdict, 'fail', `expected valid 2-cell not to fail: ${JSON.stringify(r1.issues)} / ${JSON.stringify(r1.cellReports.flatMap(c => c.issues))}`);
  assert.ok(r1.score >= 50, `expected a reasonable score for a clean sheet, got ${r1.score}`);
  assert.strictEqual(r1.recommendedNextStep, 'run_4_cell');
  const r1FailIssues = r1.cellReports.flatMap(c => c.issues).filter(i => i.severity === 'fail');
  assert.strictEqual(r1FailIssues.length, 0, `unexpected fail-severity issues on a clean sheet: ${JSON.stringify(r1FailIssues)}`);
  console.log(`[ok] valid 2-cell: verdict=${r1.verdict} score=${r1.score}`);

  // ── 2. valid 4-cell ────────────────────────────────────────────────
  const sheet2 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    body_hoodie: [{ ...CENTERED, color: [80, 200, 80, 255] }],
    eyes: [{ ...CENTERED, color: [80, 80, 200, 255] }],
    nose_mouth: [{ ...CENTERED, color: [200, 200, 80, 255] }],
  });
  const r2 = await validateTraitSheet(sheet2, 'trait-sheet-4-cell');
  assert.notStrictEqual(r2.verdict, 'fail', `expected valid 4-cell not to fail: ${JSON.stringify(r2.issues)}`);
  assert.ok(r2.score >= 50, `expected a reasonable score, got ${r2.score}`);
  assert.strictEqual(r2.recommendedNextStep, 'run_8_cell');
  console.log(`[ok] valid 4-cell: verdict=${r2.verdict} score=${r2.score}`);

  // ── 3. invalid sheet with labels/dark text-like pixels (advisory only) ──
  // Marks sit at x/y 15-24px — inside the 38px (15% of 256px) text-detection
  // band but outside the ~10px (4%) boundary-bleed margin, so this
  // isolates the text heuristic from the boundary-bleed check.
  const sheet3 = await buildSyntheticSheet(
    { preview: [{ ...CENTERED, color: [200, 80, 80, 255] }], hat_accessory: [{ ...CENTERED, color: [80, 200, 80, 255] }] },
    { hat_accessory: [{ x: 15, y: 15, size: 3 }, { x: 21, y: 15, size: 3 }, { x: 15, y: 21, size: 3 }, { x: 21, y: 21, size: 3 }] },
  );
  const r3 = await validateTraitSheet(sheet3, 'trait-sheet-2-cell');
  const hatReport3 = r3.cellReports.find(c => c.cellId === 'hat_accessory');
  assert.ok(hatReport3?.possibleTextOrLabel, 'expected the text/label heuristic to trigger on scattered tiny dark marks');
  assert.ok(hatReport3?.issues.some(i => i.code === 'possible_text_or_label'), 'expected a possible_text_or_label issue');
  assert.ok(hatReport3?.issues.every(i => i.code !== 'possible_text_or_label' || i.severity === 'warn'), 'text/label heuristic must never be fail-severity');
  assert.notStrictEqual(r3.verdict, 'fail', 'a text/label heuristic hit alone must never fail the sheet');
  const r3FailIssues = r3.cellReports.flatMap(c => c.issues).filter(i => i.severity === 'fail');
  assert.strictEqual(r3FailIssues.length, 0, `text/label marks alone must never produce a fail-severity issue: ${JSON.stringify(r3FailIssues)}`);
  // The scoring function never reads possibleTextOrLabel at all (see
  // trait-sheet-validation.ts's own scoring section) — that guarantee is
  // architectural, not something this synthetic fixture can fully isolate:
  // stray corner marks are, structurally, ALSO new foreground pixels, so
  // they can nudge the bbox-based alignment check (a real structural
  // dimension) a little on a small synthetic rect where marks are
  // proportionally significant — a large real character wouldn't move
  // nearly as much. A generous tolerance here checks "still basically the
  // same score", not "the text heuristic itself has zero weight" (that's
  // guaranteed by the score computation never referencing it).
  assert.ok(Math.abs(r3.score - r1.score) <= 20, `expected text/label marks to leave the score roughly unchanged, got ${r3.score} vs clean ${r1.score}`);
  console.log(`[ok] text/label heuristic: detected=${hatReport3?.possibleTextOrLabel} score=${r3.score} (clean=${r1.score}, advisory-only)`);

  // ── 4. inactive cell not empty ──────────────────────────────────────
  const sheet4 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    hat_accessory: [{ ...CENTERED, color: [80, 200, 80, 255] }],
    eyes: [{ ...CENTERED, color: [80, 80, 200, 255] }], // 'eyes' is NOT active for trait-sheet-2-cell
  });
  const r4 = await validateTraitSheet(sheet4, 'trait-sheet-2-cell');
  const eyesReport4 = r4.cellReports.find(c => c.cellId === 'eyes');
  assert.strictEqual(eyesReport4?.active, false);
  assert.ok(eyesReport4?.issues.some(i => i.code === 'inactive_cell_not_empty'), 'expected an inactive_cell_not_empty issue');
  assert.ok(r4.score < r1.score, `expected leaked content in an inactive cell to lower the score (got ${r4.score} vs clean ${r1.score})`);
  console.log(`[ok] inactive cell leakage: verdict=${r4.verdict} score=${r4.score} (< clean ${r1.score})`);

  // ── 5. object touching crop boundary ────────────────────────────────
  const sheet5 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    hat_accessory: [{ ...BOUNDARY_TOUCH, color: [80, 200, 80, 255] }],
  });
  const r5 = await validateTraitSheet(sheet5, 'trait-sheet-2-cell');
  const hatReport5 = r5.cellReports.find(c => c.cellId === 'hat_accessory');
  assert.strictEqual(hatReport5?.boundaryBleed, true, 'expected boundary bleed to be detected');
  assert.ok(hatReport5?.issues.some(i => i.code === 'boundary_bleed'), 'expected a boundary_bleed issue');
  console.log(`[ok] boundary bleed: detected on hat_accessory, verdict=${r5.verdict} score=${r5.score}`);

  // ── 5b. background cell is exempt from boundary-bleed (fills the whole crop by design) ──
  const sheet5b = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    background: [{ ...FULL, color: [30, 30, 30, 255] }],
    body_hoodie: [{ ...CENTERED, color: [80, 200, 80, 255] }],
    eyes: [{ ...CENTERED, color: [80, 80, 200, 255] }],
    nose_mouth: [{ ...CENTERED, color: [200, 200, 80, 255] }],
  });
  const r5b = await validateTraitSheet(sheet5b, 'trait-sheet-4-cell');
  const bgReport5b = r5b.cellReports.find(c => c.cellId === 'background');
  assert.strictEqual(bgReport5b?.boundaryBleed, false, 'background cell must never be flagged for boundary bleed');
  // Also confirms the "background cell is real content, not corner-noise"
  // fix: a fully opaque flat background fill must NOT be reported empty.
  assert.ok(bgReport5b && bgReport5b.foregroundRatio > 0.5, `expected the flat background fill to register as non-empty, got ratio=${bgReport5b?.foregroundRatio}`);
  assert.ok(bgReport5b?.issues.every(i => i.code !== 'active_cell_empty'), 'a solid opaque background fill must never be flagged empty');
  console.log(`[ok] background cell: exempt from boundary-bleed, foregroundRatio=${bgReport5b?.foregroundRatio.toFixed(2)} (not wrongly flagged empty)`);

  // ── 6. misaligned layer cell ────────────────────────────────────────
  const sheet6 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: [200, 80, 80, 255] }],
    body_hoodie: [{ ...OFFSET, color: [80, 200, 80, 255] }],
    eyes: [{ ...CENTERED, color: [80, 80, 200, 255] }],
    nose_mouth: [{ ...CENTERED, color: [200, 200, 80, 255] }],
  });
  const r6 = await validateTraitSheet(sheet6, 'trait-sheet-4-cell');
  const bodyReport6 = r6.cellReports.find(c => c.cellId === 'body_hoodie');
  assert.ok(bodyReport6 && bodyReport6.alignmentDriftPx !== null && bodyReport6.alignmentDriftPx > 4, `expected alignment drift > 4px, got ${bodyReport6?.alignmentDriftPx}`);
  assert.ok(bodyReport6?.issues.some(i => i.code === 'alignment_drift'), 'expected an alignment_drift issue');
  const eyesReport6 = r6.cellReports.find(c => c.cellId === 'eyes');
  assert.ok(eyesReport6 && eyesReport6.alignmentDriftPx !== null && eyesReport6.alignmentDriftPx <= 4, 'aligned cells must not falsely trigger alignment drift');
  console.log(`[ok] misalignment: body_hoodie drift=${bodyReport6?.alignmentDriftPx?.toFixed(1)}px, verdict=${r6.verdict}`);

  // ── 7. 8-cell reconstruction mismatch (advisory only) ───────────────
  const nearBlack: [number, number, number, number] = [10, 10, 10, 255];
  const offWhite: [number, number, number, number] = [240, 240, 240, 255];
  const sheet7 = await buildSyntheticSheet({
    preview: [{ ...CENTERED, color: nearBlack }],
    background: [{ ...FULL, color: offWhite }],
    body_hoodie: [{ ...CENTERED, color: offWhite }],
    head_fur: [{ ...CENTERED, color: offWhite }],
    face_mask: [{ ...CENTERED, color: offWhite }],
    eyes: [{ ...CENTERED, color: offWhite }],
    nose_mouth: [{ ...CENTERED, color: offWhite }],
    hat_accessory: [{ ...CENTERED, color: offWhite }],
  });
  const r7 = await validateTraitSheet(sheet7, 'trait-sheet-8-cell');
  assert.ok(r7.reconstruction, 'expected a reconstruction result for trait-sheet-8-cell');
  assert.ok(r7.reconstruction!.diffPct > 15, `expected a high reconstruction diff, got ${r7.reconstruction!.diffPct}`);
  assert.ok(r7.issues.some(i => i.code === 'reconstruction_mismatch' && i.severity === 'warn'), 'expected an advisory (warn) reconstruction_mismatch issue');
  assert.strictEqual(r7.recommendedNextStep, r7.verdict === 'fail' ? 'regenerate' : 'try_import');
  console.log(`[ok] 8-cell reconstruction mismatch: diffPct=${r7.reconstruction!.diffPct.toFixed(1)}% verdict=${r7.verdict} score=${r7.score}`);

  // ── 8. a fully well-formed 8-cell sheet (reconstruction should NOT be
  //    flagged) — the preview cell shows the SAME background fill +
  //    foreground subject that stacking the 7 real layer cells would
  //    actually produce, so the reconstruction diff should be small. ──
  const bgColor: [number, number, number, number] = [40, 60, 50, 255];
  const fgColor: [number, number, number, number] = [220, 200, 80, 255];
  const sheet8 = await buildSyntheticSheet({
    preview: [{ ...FULL, color: bgColor }, { ...CENTERED, color: fgColor }],
    background: [{ ...FULL, color: bgColor }],
    body_hoodie: [{ ...CENTERED, color: fgColor }],
    head_fur: [{ ...CENTERED, color: fgColor }],
    face_mask: [{ ...CENTERED, color: fgColor }],
    eyes: [{ ...CENTERED, color: fgColor }],
    nose_mouth: [{ ...CENTERED, color: fgColor }],
    hat_accessory: [{ ...CENTERED, color: fgColor }],
  });
  const r8 = await validateTraitSheet(sheet8, 'trait-sheet-8-cell');
  const r8FailIssues = r8.cellReports.flatMap(c => c.issues).filter(i => i.severity === 'fail');
  assert.strictEqual(r8FailIssues.length, 0, `unexpected fail-severity issues on a well-formed sheet: ${JSON.stringify(r8FailIssues)}`);
  assert.ok(r8.reconstruction, 'expected a reconstruction result');
  assert.ok(r8.reconstruction!.diffPct < 15, `expected a low reconstruction diff for matching layers/preview, got ${r8.reconstruction!.diffPct}`);
  assert.ok(!r8.issues.some(i => i.code === 'reconstruction_mismatch'), 'a well-formed sheet must not surface a reconstruction_mismatch issue');
  assert.notStrictEqual(r8.verdict, 'fail');
  assert.strictEqual(r8.recommendedNextStep, 'try_import');
  console.log(`[ok] well-formed 8-cell: reconstruction diffPct=${r8.reconstruction!.diffPct.toFixed(1)}% verdict=${r8.verdict} recommendedNextStep=${r8.recommendedNextStep}`);

  // ── 9. undecodable source ───────────────────────────────────────────
  const garbage = Buffer.from('this is not a real png file at all');
  const rBad = await validateTraitSheet(garbage, 'trait-sheet-2-cell');
  assert.strictEqual(rBad.verdict, 'fail');
  assert.strictEqual(rBad.score, 0);
  assert.ok(rBad.issues.some(i => i.code === 'sheet_undecodable'));
  console.log('[ok] undecodable source -> fail, score 0, sheet_undecodable issue');

  // ── 10. unsupported layout/mode combination ─────────────────────────
  const rLayoutMismatch = await validateTraitSheet(sheet1, 'trait-sheet-2-cell', '4x4-family-sheet');
  assert.strictEqual(rLayoutMismatch.verdict, 'fail');
  assert.ok(rLayoutMismatch.issues.some(i => i.code === 'layout_mode_mismatch'));
  console.log('[ok] unsupported layoutId -> fail, layout_mode_mismatch issue');

  console.log('[pass] trait-sheet-validation.test.ts — no network access, no OpenAI/Anthropic call');
}

main().catch((err) => {
  console.error('[fail] trait-sheet-validation.test.ts', err);
  process.exitCode = 1;
});
