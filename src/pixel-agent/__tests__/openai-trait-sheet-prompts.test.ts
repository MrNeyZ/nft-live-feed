/**
 * Pixel Forge — Stage 9.3 offline tests: trait-sheet prompt builder +
 * generate-source route widening. Mocked `global.fetch` ONLY — no real
 * OpenAI/Anthropic call anywhere in this file (the mock below never makes
 * a network request; it just records what would have been sent and
 * returns a synthetic response). Runs entirely inside a scratch temp
 * directory (via process.chdir, before either route module is first
 * imported) so it never reads or writes real data/pixel-forge files —
 * same convention as collections-store.test.ts.
 * Run: `npx ts-node src/pixel-agent/__tests__/openai-trait-sheet-prompts.test.ts`.
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-forge-trait-sheet-prompts-test-'));
const realCwd = process.cwd();
process.chdir(scratchDir);

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
  // ── 1. buildTraitSheetPrompt: prompt content differs by mode ──────────
  const {
    buildTraitSheetPrompt, TRAIT_SHEET_SAFETY_INSTRUCTION, TRAIT_SHEET_KEY_COLOR_HEX,
    TRAIT_SHEET_MIN_PADDING_PCT, TRAIT_SHEET_MAX_HEIGHT_PCT, TRAIT_SHEET_MAX_WIDTH_PCT,
  } = await import('../openai-trait-sheet-prompts');

  const p2 = buildTraitSheetPrompt('trait-sheet-2-cell', 'a pixel raccoon');
  const p4 = buildTraitSheetPrompt('trait-sheet-4-cell', 'a pixel raccoon');
  const p8 = buildTraitSheetPrompt('trait-sheet-8-cell', 'a pixel raccoon');

  // 2-cell: only preview + hat/accessory are ACTIVE content lines.
  assert.ok(p2.includes('the HAT / ACCESSORY layer only'), '2-cell prompt must include hat/accessory as an active cell');
  assert.ok(p2.includes('the FULL character with every layer composed together'), '2-cell prompt must include the preview cell');
  assert.ok(!p2.includes('the BODY / HOODIE layer only'), '2-cell prompt must NOT make body/hoodie an active cell');
  assert.ok(!p2.includes('the EYES layer only'), '2-cell prompt must NOT make eyes an active cell');
  assert.ok(!p2.includes('the BACKGROUND layer only'), '2-cell prompt must NOT make background an active cell');
  assert.ok(p2.includes('COMPLETELY EMPTY'), '2-cell prompt must instruct unused cells to stay empty');

  // 4-cell: preview + body/hoodie + eyes + nose/mouth active; others not.
  assert.ok(p4.includes('the BODY / HOODIE layer only'));
  assert.ok(p4.includes('the EYES layer only'));
  assert.ok(p4.includes('the NOSE / MOUTH layer only'));
  assert.ok(!p4.includes('the HAT / ACCESSORY layer only'), '4-cell prompt must NOT make hat/accessory an active cell');
  assert.ok(!p4.includes('the HEAD / FUR layer only'), '4-cell prompt must NOT make head/fur an active cell');
  assert.ok(!p4.includes('the FACE MASK layer only'), '4-cell prompt must NOT make face mask an active cell');

  // 8-cell: every layer is active, nothing left empty.
  for (const phrase of [
    'the FULL character with every layer composed together', 'the BACKGROUND layer only', 'the BODY / HOODIE layer only',
    'the HEAD / FUR layer only', 'the FACE MASK layer only', 'the EYES layer only', 'the NOSE / MOUTH layer only',
    'the HAT / ACCESSORY layer only',
  ]) {
    assert.ok(p8.includes(phrase), `8-cell prompt missing active cell content: ${phrase}`);
  }
  assert.ok(!p8.includes('COMPLETELY EMPTY'), '8-cell prompt has no unused cells, so no empty-cell instruction should appear');

  // Every sheet mode carries the safety instruction and the user's own text.
  for (const p of [p2, p4, p8]) {
    assert.ok(p.includes(TRAIT_SHEET_SAFETY_INSTRUCTION), 'every sheet prompt must include the safety instruction');
    assert.ok(p.includes('Character: a pixel raccoon'), 'every sheet prompt must include the caller-supplied character description');
  }
  assert.notStrictEqual(p2, p4);
  assert.notStrictEqual(p4, p8);
  assert.notStrictEqual(p2, p8);
  console.log('[ok] buildTraitSheetPrompt: prompt content differs by mode');

  // ── Stage 9.5 hardening: strict geometry + magenta key background ─────
  assert.strictEqual(TRAIT_SHEET_KEY_COLOR_HEX, '#FF00FF');
  assert.strictEqual(TRAIT_SHEET_MIN_PADDING_PCT, 20);
  assert.strictEqual(TRAIT_SHEET_MAX_HEIGHT_PCT, 55);
  assert.strictEqual(TRAIT_SHEET_MAX_WIDTH_PCT, 70);
  for (const p of [p2, p4, p8]) {
    // #FF00FF magenta key background appears (never "transparent").
    assert.ok(p.includes(TRAIT_SHEET_KEY_COLOR_HEX), 'every sheet prompt must reference the #FF00FF key background');
    assert.ok(!/\btransparent\b/i.test(p), 'sheet prompts must NOT request transparency (real test proved gpt-image-1 returns no alpha)');
    // 20% minimum padding instruction.
    assert.ok(p.includes(`${TRAIT_SHEET_MIN_PADDING_PCT}%`), 'every sheet prompt must state the minimum padding percentage');
    assert.ok(/padding/i.test(p), 'every sheet prompt must mention padding explicitly');
    // No cell-boundary-crossing instruction.
    assert.ok(/cross/i.test(p) && /boundary/i.test(p), 'every sheet prompt must explicitly forbid crossing a cell boundary');
    // Max 55% height / 70% width occupancy instruction.
    assert.ok(p.includes(`${TRAIT_SHEET_MAX_HEIGHT_PCT}%`), 'every sheet prompt must state the max height percentage');
    assert.ok(p.includes(`${TRAIT_SHEET_MAX_WIDTH_PCT}%`), 'every sheet prompt must state the max width percentage');
    assert.ok(/occupy/i.test(p), 'every sheet prompt must use "occupy" language for the size budget');
    // Object must fit entirely inside its own cell.
    assert.ok(/fit entirely inside/i.test(p), 'every sheet prompt must require the object to fit entirely inside its own cell');
    // No borders/grid lines that could become false traits.
    assert.ok(/no grid lines/i.test(p) && /no borders/i.test(p), 'every sheet prompt must forbid grid lines/borders');
  }
  console.log('[ok] Stage 9.5 hardening: #FF00FF, 20% padding, no-crossing, 55%/70% occupancy all present in every sheet mode');

  // ── 2-4: route-level — mocked fetch, single-image unchanged, meta.json
  //         stores sourceMode/finalPrompt, no real OpenAI call ─────────
  const {
    DO_NOT_COPY_SUFFIX, OPENAI_IMAGE_MODEL, OPENAI_IMAGE_SIZE, OPENAI_IMAGE_QUALITY,
  } = await import('../openai-image-source');

  // Every call to generateSourceImage — regardless of sourceMode — must
  // send the same fixed transparency + model params. Transparency is
  // controlled by explicit `background`/`output_format` fields, not by
  // prompt text (that's what caused the RGB-no-alpha bug this asserts
  // against a regression of).
  function assertTransparencyAndFixedParams(form: FormData | null, label: string): void {
    assert.ok(form, `${label}: expected a captured FormData`);
    assert.strictEqual(form!.get('background'), 'transparent', `${label}: background must be "transparent"`);
    assert.strictEqual(form!.get('output_format'), 'png', `${label}: output_format must be "png"`);
    assert.strictEqual(form!.get('model'), OPENAI_IMAGE_MODEL, `${label}: model must be unchanged`);
    assert.strictEqual(form!.get('size'), OPENAI_IMAGE_SIZE, `${label}: size must be unchanged`);
    assert.strictEqual(form!.get('quality'), OPENAI_IMAGE_QUALITY, `${label}: quality must be unchanged`);
    assert.strictEqual(form!.get('n'), '1', `${label}: n must be unchanged`);
  }
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  const { createPixelForgeGenerateSourceRouter } = await import('../../server/tools-pixel-forge-generate-source');

  const router = createPixelForgeGenerateSourceRouter() as unknown as {
    stack: { route?: { path: string; stack: { handle: (req: unknown, res: unknown) => Promise<unknown> }[] } }[];
  };
  const layer = router.stack.find(l => l.route?.path === '/tools/pixel-forge/raster/generate-source');
  assert.ok(layer?.route, 'expected the generate-source route to be registered');
  const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle;

  let fetchCallCount = 0;
  let lastCapturedPrompt: string | null = null;
  let lastCapturedUrl: string | null = null;
  let lastCapturedForm: FormData | null = null;
  const originalFetch = global.fetch;
  // Mocked fetch ONLY — never performs a real network request. Records
  // what would have been sent (the exact `prompt` form field, plus the
  // full FormData for the background/output_format/model/size/quality/n
  // assertions below) and returns a synthetic, well-formed OpenAI
  // images/edits response shape.
  global.fetch = (async (url: string, init?: { body?: FormData }) => {
    fetchCallCount++;
    lastCapturedUrl = url;
    lastCapturedForm = init?.body as FormData | undefined ?? null;
    lastCapturedPrompt = (init?.body as FormData | undefined)?.get('prompt') as string | null;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }],
        usage: { input_tokens: 111, output_tokens: 222 },
      }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  const refImageBase64 = Buffer.from('fake-reference-image-bytes').toString('base64');

  async function callGenerate(body: Record<string, unknown>): Promise<{ res: FakeRes }> {
    const res = makeRes();
    await handler({ body }, res);
    return { res };
  }

  // 2a. sourceMode omitted (undefined) -> defaults to single-image,
  //     byte-for-byte equivalent to pre-Stage-9.3 behavior: the raw
  //     userPrompt is sent as-is (no grid instructions injected).
  const userPromptA = 'a moody pixel fox in a red hoodie';
  const { res: resA } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: userPromptA, referenceRightsConfirmed: true,
  });
  assert.strictEqual(resA.statusCode, 200, `expected 200, got ${resA.statusCode}: ${JSON.stringify(resA.body)}`);
  // The `prompt` field actually sent to OpenAI is always request.prompt +
  // DO_NOT_COPY_SUFFIX (openai-image-source.ts's own unconditional,
  // pre-existing append) — for single-image mode request.prompt IS the
  // raw userPrompt untouched, so this is exactly today's pre-Stage-9.3
  // wire format, byte-for-byte.
  assert.strictEqual(lastCapturedPrompt, userPromptA + DO_NOT_COPY_SUFFIX, 'sourceMode-omitted request must send userPrompt+DO_NOT_COPY_SUFFIX unchanged, same as before Stage 9.3');
  assert.strictEqual((resA.body as { sourceMode?: string }).sourceMode, 'single-image', 'omitted sourceMode must default to single-image in the response');
  assertTransparencyAndFixedParams(lastCapturedForm, 'single-image (sourceMode omitted)');

  let sourceIdA = (resA.body as { sourceId: string }).sourceId;
  let metaA = JSON.parse(fs.readFileSync(path.join(scratchDir, 'data', 'pixel-forge', 'generated-sources', sourceIdA, 'meta.json'), 'utf8'));
  assert.strictEqual(metaA.sourceMode, 'single-image');
  assert.strictEqual(metaA.userPrompt, userPromptA);
  assert.strictEqual(metaA.fullPromptSent, userPromptA + DO_NOT_COPY_SUFFIX, 'single-image finalPrompt must be byte-for-byte the pre-existing userPrompt+DO_NOT_COPY_SUFFIX concatenation');
  console.log('[ok] single-image mode is behavior-equivalent to pre-Stage-9.3 (raw prompt, unchanged suffix)');

  // 2b. sourceMode explicitly 'single-image' -> identical result to 2a.
  const { res: resB } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: userPromptA, referenceRightsConfirmed: true, sourceMode: 'single-image',
  });
  assert.strictEqual(lastCapturedPrompt, userPromptA + DO_NOT_COPY_SUFFIX, 'explicit single-image must also send userPrompt+DO_NOT_COPY_SUFFIX unchanged');
  assert.strictEqual(resB.statusCode, 200);

  // 3. sourceMode='trait-sheet-2-cell' -> meta.json stores sourceMode +
  //    finalPrompt (the built sheet prompt + the unchanged DO_NOT_COPY_SUFFIX).
  const userPromptC = 'a pixel raccoon wearing a bucket hat';
  const { res: resC } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: userPromptC, referenceRightsConfirmed: true, sourceMode: 'trait-sheet-2-cell',
  });
  assert.strictEqual(resC.statusCode, 200, `expected 200, got ${resC.statusCode}: ${JSON.stringify(resC.body)}`);
  assert.strictEqual((resC.body as { sourceMode?: string }).sourceMode, 'trait-sheet-2-cell');
  assert.notStrictEqual(lastCapturedPrompt, userPromptC, 'trait-sheet prompt sent to OpenAI must differ from the raw userPrompt');
  assert.ok((lastCapturedPrompt as string).includes('the HAT / ACCESSORY layer only'), 'trait-sheet-2-cell must send the grid-instruction prompt');
  assertTransparencyAndFixedParams(lastCapturedForm, 'trait-sheet-2-cell');

  const sourceIdC = (resC.body as { sourceId: string }).sourceId;
  const metaC = JSON.parse(fs.readFileSync(path.join(scratchDir, 'data', 'pixel-forge', 'generated-sources', sourceIdC, 'meta.json'), 'utf8'));
  assert.strictEqual(metaC.sourceMode, 'trait-sheet-2-cell');
  assert.strictEqual(metaC.userPrompt, userPromptC, 'meta.json must still keep the raw user prompt separately from the built sheet prompt');
  assert.ok(metaC.fullPromptSent.includes('the HAT / ACCESSORY layer only'));
  assert.strictEqual(metaC.fullPromptSent, buildTraitSheetPrompt('trait-sheet-2-cell', userPromptC) + DO_NOT_COPY_SUFFIX);
  console.log('[ok] meta.json stores sourceMode + finalPrompt for a trait-sheet generation');

  // 3b. Stage 10.4 — sourceMode='trait-family-sheet-10x8' routes through
  //     buildTraitFamilySheetPrompt (the Stage 10.3 builder), NOT the
  //     (superseded, still-present) Stage 9 buildTraitSheetPrompt, keeps
  //     the same transparency/model params, and meta.json stores the new
  //     sourceMode + the family-sheet prompt as fullPromptSent.
  const { buildTraitFamilySheetPrompt } = await import('../openai-trait-family-sheet-prompts');
  const userPromptE = 'a pixel raccoon collection, dark palette, thick outlines';
  const { res: resE } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: userPromptE, referenceRightsConfirmed: true, sourceMode: 'trait-family-sheet-10x8',
  });
  assert.strictEqual(resE.statusCode, 200, `expected 200, got ${resE.statusCode}: ${JSON.stringify(resE.body)}`);
  assert.strictEqual((resE.body as { sourceMode?: string }).sourceMode, 'trait-family-sheet-10x8');
  assert.strictEqual(lastCapturedPrompt, buildTraitFamilySheetPrompt(userPromptE) + DO_NOT_COPY_SUFFIX, 'trait-family-sheet-10x8 must send buildTraitFamilySheetPrompt output (+ the unconditional DO_NOT_COPY_SUFFIX), not the Stage 9 builder\'s output');
  assert.ok(!(lastCapturedPrompt as string).includes('the HAT / ACCESSORY layer only'), 'trait-family-sheet-10x8 must NOT use the Stage 9 2x4-grid prompt language');
  assertTransparencyAndFixedParams(lastCapturedForm, 'trait-family-sheet-10x8');

  const sourceIdE = (resE.body as { sourceId: string }).sourceId;
  const metaE = JSON.parse(fs.readFileSync(path.join(scratchDir, 'data', 'pixel-forge', 'generated-sources', sourceIdE, 'meta.json'), 'utf8'));
  assert.strictEqual(metaE.sourceMode, 'trait-family-sheet-10x8');
  assert.strictEqual(metaE.userPrompt, userPromptE, 'meta.json must keep the raw user prompt separately from the built family-sheet prompt');
  assert.strictEqual(metaE.fullPromptSent, buildTraitFamilySheetPrompt(userPromptE) + DO_NOT_COPY_SUFFIX);
  console.log('[ok] trait-family-sheet-10x8 routes through buildTraitFamilySheetPrompt, keeps transparency/model params, meta.json stores the new sourceMode');

  // 3c. single-image prompt is still unchanged after adding the new mode
  //     (no cross-contamination from the new branch in the ternary).
  const { res: resF } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: userPromptA, referenceRightsConfirmed: true, sourceMode: 'single-image',
  });
  assert.strictEqual(lastCapturedPrompt, userPromptA + DO_NOT_COPY_SUFFIX, 'single-image prompt must remain unchanged after adding trait-family-sheet-10x8');
  assert.strictEqual(resF.statusCode, 200);
  console.log('[ok] single-image prompt remains unchanged after wiring in trait-family-sheet-10x8');

  // 4. Invalid sourceMode is rejected before any fetch call.
  const preInvalidCallCount = fetchCallCount;
  const { res: resD } = await callGenerate({
    referenceImageBase64: refImageBase64, referenceMimeType: 'image/png',
    prompt: 'x', referenceRightsConfirmed: true, sourceMode: 'trait-sheet-99-cell',
  });
  assert.strictEqual(resD.statusCode, 400);
  assert.strictEqual((resD.body as { error?: string }).error, 'invalid_source_mode');
  assert.strictEqual(fetchCallCount, preInvalidCallCount, 'an invalid sourceMode must not reach fetch at all');
  console.log('[ok] invalid sourceMode rejected with 400, no fetch attempted');

  // 5. No real OpenAI call was ever made — every "call" above hit the
  //    local mock only (recorded url, never touched the network).
  assert.strictEqual(lastCapturedUrl, 'https://api.openai.com/v1/images/edits');
  assert.strictEqual(fetchCallCount, 5, 'expected exactly 5 mocked fetch calls (2a single-image, 2b single-image, 3 trait-sheet-2-cell, 3b trait-family-sheet-10x8, 3c single-image)');
  console.log(`[ok] no real OpenAI call made — global.fetch was mocked for all ${fetchCallCount} calls`);

  global.fetch = originalFetch;
}

main()
  .then(() => {
    process.chdir(realCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    console.log('[pass] openai-trait-sheet-prompts.test.ts');
  })
  .catch((err) => {
    process.chdir(realCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    console.error('[fail] openai-trait-sheet-prompts.test.ts', err);
    process.exitCode = 1;
  });
