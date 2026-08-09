/**
 * Pixel Forge — Stage 10.5 offline tests: the Trait Family Sheet import
 * route (POST /raster/import-trait-sheet, layoutId='trait-family-sheet-
 * 10x8'). No OpenAI/Anthropic call of any kind — this route has never
 * made one (see tools-pixel-forge-import-trait-sheet.ts's own header
 * comment); the "generated source" here is a synthetic, in-memory PNG
 * built with sharp, standing in for what would have been an OpenAI
 * output, same "mock the generated source, not a network call" approach
 * trait-sheet-validation.test.ts already established. Runs entirely
 * inside a scratch temp directory (via process.chdir, before the store/
 * router modules are first imported) so it never reads or writes real
 * data/pixel-forge files — same convention as
 * openai-trait-sheet-prompts.test.ts.
 * Run: `npx ts-node src/pixel-agent/__tests__/import-trait-family-sheet.test.ts`.
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-forge-import-family-sheet-test-'));
const realCwd = process.cwd();
process.chdir(scratchDir);

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 800;

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(obj: unknown): FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(obj: unknown) { res.body = obj; return res; },
  };
  return res;
}

async function main() {
  const { TRAIT_FAMILY_SHEET_10X8 } = await import('../trait-sheet');

  // Two cellIds deliberately left blank (fully transparent) to exercise
  // the "empty cells are skipped" path — everything else gets a solid
  // opaque 40x40 square centered in its own 100x100 cell (1000/10=100
  // cols, 800/8=100 rows, per the Stage 10.2 layout test's own math).
  const EMPTY_CELL_IDS = new Set(['mouth_05', 'accessory_02']);

  function cellPxBounds(cellId: string): { x: number; y: number; w: number; h: number } {
    const cell = TRAIT_FAMILY_SHEET_10X8.cells.find(c => c.cellId === cellId);
    if (!cell) throw new Error(`unknown cellId in test fixture: ${cellId}`);
    return {
      x: Math.round(cell.bboxFraction.x * CANVAS_WIDTH), y: Math.round(cell.bboxFraction.y * CANVAS_HEIGHT),
      w: Math.round(cell.bboxFraction.w * CANVAS_WIDTH), h: Math.round(cell.bboxFraction.h * CANVAS_HEIGHT),
    };
  }

  async function buildSyntheticFamilySheet(): Promise<Buffer> {
    const composites: { input: Buffer; left: number; top: number }[] = [];
    for (const cell of TRAIT_FAMILY_SHEET_10X8.cells) {
      if (EMPTY_CELL_IDS.has(cell.cellId)) continue;
      const b = cellPxBounds(cell.cellId);
      const rectSize = 40;
      const rectBuf = await sharp({
        create: { width: rectSize, height: rectSize, channels: 4, background: { r: 90, g: 140, b: 200, alpha: 1 } },
      }).png().toBuffer();
      composites.push({ input: rectBuf, left: b.x + Math.round((b.w - rectSize) / 2), top: b.y + Math.round((b.h - rectSize) / 2) });
    }
    return sharp({
      create: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite(composites).png().toBuffer();
  }

  const sheetPngBuffer = await buildSyntheticFamilySheet();
  const sheetBase64 = sheetPngBuffer.toString('base64');

  const { createPixelForgeImportTraitSheetRouter } = await import('../../server/tools-pixel-forge-import-trait-sheet');
  const { getTraitAsset, listTraitAssets } = await import('../store');

  const router = createPixelForgeImportTraitSheetRouter() as unknown as {
    stack: { route?: { path: string; stack: { handle: (req: unknown, res: unknown) => Promise<unknown> }[] } }[];
  };
  const layer = router.stack.find(l => l.route?.path === '/tools/pixel-forge/raster/import-trait-sheet');
  assert.ok(layer?.route, 'expected the import-trait-sheet route to be registered');
  const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle;

  const res = makeRes();
  await handler({
    body: {
      imageBase64: sheetBase64, mimeType: 'image/png', layoutId: 'trait-family-sheet-10x8',
      backgroundMode: 'keep', baseName: 'test-family-sheet',
    },
  }, res);

  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const body = res.body as {
    ok: boolean; layoutId: string;
    created: { id: string; name: string; cellId: string; layerType: string; zIndex: number; row: number; col: number; familyCategory?: string }[];
    skipped: { cellId: string; reason: string }[];
  };
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.layoutId, 'trait-family-sheet-10x8');
  console.log('[ok] POST /raster/import-trait-sheet accepts layoutId=trait-family-sheet-10x8 and returns 200');

  // ── 1. all 80 cells accounted for (no selectedCellIds — default
  //        "every real-layer cell" selection already covers all 80) ──────
  assert.strictEqual(body.created.length + body.skipped.length, 80, 'created+skipped must account for all 80 cells');
  console.log('[ok] all 80 cells were processed (created + skipped = 80)');

  // ── 2. empty cells are skipped, everything else is created ───────────
  assert.strictEqual(body.skipped.length, EMPTY_CELL_IDS.size, `expected exactly ${EMPTY_CELL_IDS.size} skipped cells`);
  for (const s of body.skipped) {
    assert.ok(EMPTY_CELL_IDS.has(s.cellId), `unexpected skipped cellId: ${s.cellId}`);
    assert.strictEqual(s.reason, 'empty_layer', `cell ${s.cellId} must be skipped with reason "empty_layer"`);
  }
  assert.strictEqual(body.created.length, 80 - EMPTY_CELL_IDS.size);
  for (const c of body.created) {
    assert.ok(!EMPTY_CELL_IDS.has(c.cellId), `cellId ${c.cellId} should have been skipped, not created`);
  }
  console.log(`[ok] empty cells (${[...EMPTY_CELL_IDS].join(', ')}) skipped with reason "empty_layer"; all other 78 cells created`);

  // ── 3. category/layerType mapping is correct on a sample of cells,
  //        per the Stage 10.2 mapping table ─────────────────────────────
  const EXPECTED_LAYER_TYPE: Record<string, string> = {
    hat_00: 'accessory', hoodie_03: 'body', eyes_07: 'eyes', mouth_09: 'mouth',
    face_mask_01: 'other', accessory_04: 'accessory', head_fur_06: 'body', background_09: 'background',
  };
  for (const [cellId, expectedLayerType] of Object.entries(EXPECTED_LAYER_TYPE)) {
    const entry = body.created.find(c => c.cellId === cellId);
    assert.ok(entry, `expected created entry for cellId ${cellId}`);
    assert.strictEqual(entry!.layerType, expectedLayerType, `cellId ${cellId} expected layerType ${expectedLayerType}, got ${entry!.layerType}`);
    assert.strictEqual(entry!.familyCategory, cellId.replace(/_\d+$/, ''), `cellId ${cellId} familyCategory mismatch`);
  }
  console.log('[ok] layerType/familyCategory mapping matches the Stage 10.2 spec on a sample of cells');

  // ── 4. row/col + variant index are stored, and tags/notes carry
  //        familyCategory (fetch the full TraitAsset, not just the
  //        response summary) ───────────────────────────────────────────
  const hat00 = body.created.find(c => c.cellId === 'hat_00')!;
  assert.strictEqual(hat00.row, 0);
  assert.strictEqual(hat00.col, 0);
  const hat00Full = await getTraitAsset(hat00.id);
  assert.ok(hat00Full, 'expected the imported trait to be readable via getTraitAsset');
  assert.ok(hat00Full!.tags.includes('hat_00'), 'tags must include the cellId');
  assert.ok(hat00Full!.tags.includes('hat'), 'tags must include the familyCategory');
  assert.ok(hat00Full!.notes?.includes('familyCategory=hat'), 'notes must record familyCategory');
  assert.ok(hat00Full!.notes?.includes('variantIndex=0'), 'notes must record the variant index (col)');
  assert.strictEqual(hat00Full!.status, 'candidate', 'a freshly imported trait must never be auto-approved');
  console.log('[ok] row/col/variantIndex/familyCategory are recorded in tags+notes, status=candidate (no auto-approve)');

  // ── 5. Trait Library (listTraitAssets) can read all 78 imported
  //        traits ──────────────────────────────────────────────────────
  const allTraits = await listTraitAssets();
  assert.strictEqual(allTraits.length, body.created.length, 'listTraitAssets must return exactly the imported traits (scratch dir starts empty)');
  const allIds = new Set(allTraits.map(t => t.id));
  for (const c of body.created) {
    assert.ok(allIds.has(c.id), `Trait Library must be able to read imported trait ${c.id} (${c.cellId})`);
  }
  console.log('[ok] Trait Library (listTraitAssets) can read all 78 imported traits');

  // ── 6. no overwrite — every created id is unique ─────────────────────
  assert.strictEqual(new Set(body.created.map(c => c.id)).size, body.created.length, 'every created trait must get a fresh, unique id');
  console.log('[ok] every imported trait gets a fresh id — no overwrite');

  console.log('[pass] import-trait-family-sheet.test.ts — no OpenAI/Anthropic call, no real network access');
}

main()
  .then(() => {
    process.chdir(realCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  })
  .catch((err) => {
    process.chdir(realCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    console.error('[fail] import-trait-family-sheet.test.ts', err);
    process.exitCode = 1;
  });
