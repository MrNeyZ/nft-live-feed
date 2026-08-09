// Standalone (no test framework — the frontend has none) verification of
// the Layer Stack / Compositor MVP pure helpers. Compile + run:
//   npx tsc src/app/tools/pixel-forge/layer-stack.ts src/app/tools/pixel-forge/layer-stack.test.ts \
//     --outDir /tmp/layer-stack --module commonjs --target es2020 --esModuleInterop \
//     && node /tmp/layer-stack/layer-stack.test.js
import assert from 'assert';
import {
  groupTraitsForStack, sortSelectedLayersForPreview, getStackCanvasSize,
  isTraitCanvasCompatible, detectStackWarnings, LayerStackTrait,
} from './layer-stack';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

function trait(overrides: Partial<LayerStackTrait> & { id: string }): LayerStackTrait {
  return {
    name: overrides.id,
    layerType: 'body',
    zIndex: 10,
    size: 32,
    status: 'approved',
    collectionId: null,
    ...overrides,
  };
}

// ── groupTraitsForStack ───────────────────────────────────────────────────
{
  const traits = [
    trait({ id: 'body-a', layerType: 'body', zIndex: 10, name: 'Body A' }),
    trait({ id: 'body-b-candidate', layerType: 'body', status: 'candidate', name: 'Body B' }),
    trait({ id: 'body-c-rejected', layerType: 'body', status: 'rejected', name: 'Body C' }),
    trait({ id: 'eyes-a', layerType: 'eyes', zIndex: 20, name: 'Eyes A' }),
  ];
  const groups = groupTraitsForStack(traits);
  check('excludes candidate traits by default', !groups.some(g => g.options.some(o => o.id === 'body-b-candidate')));
  check('excludes rejected traits', !groups.some(g => g.options.some(o => o.id === 'body-c-rejected')));
  check('keeps approved traits', groups.some(g => g.layerType === 'body' && g.options.some(o => o.id === 'body-a')));
  check('groups by layerType (2 groups: body, eyes)', groups.length === 2);
}

{
  const traits = [
    trait({ id: 'a', collectionId: 'col-1' }),
    trait({ id: 'b', collectionId: 'col-2' }),
    trait({ id: 'c', collectionId: null }),
  ];
  const scoped = groupTraitsForStack(traits, 'col-1');
  check('collectionId filter keeps only matching collection', scoped.flatMap(g => g.options).length === 1
    && scoped[0].options[0].id === 'a');
  const unscoped = groupTraitsForStack(traits);
  check('omitting collectionId includes every collection', unscoped.flatMap(g => g.options).length === 3);
  const nullScoped = groupTraitsForStack(traits, null);
  check('passing null collectionId also means "no filter"', nullScoped.flatMap(g => g.options).length === 3);
}

{
  // A validation-preview-shaped object: no layerType/status/collectionId.
  const validationPreview = { seq: 1, runId: 'run-1', pngBase64: 'abc' };
  const traits = [validationPreview, trait({ id: 'real-body' })];
  const groups = groupTraitsForStack(traits);
  check('structurally invalid (validation-preview-shaped) items are excluded, not thrown',
    groups.flatMap(g => g.options).length === 1 && groups[0].options[0].id === 'real-body');
}

{
  const traits = [
    trait({ id: 'z-hi-name-z', layerType: 'body', zIndex: 20, name: 'Zebra' }),
    trait({ id: 'z-lo-name-a', layerType: 'body', zIndex: 10, name: 'Aardvark' }),
    trait({ id: 'same-z-b', layerType: 'body', zIndex: 15, name: 'Bear' }),
    trait({ id: 'same-z-a', layerType: 'body', zIndex: 15, name: 'Ant' }),
  ];
  const groups = groupTraitsForStack(traits);
  const ids = groups[0].options.map(o => o.id);
  check('within-group sort: zIndex ascending, then name', ids.join(',') === 'z-lo-name-a,same-z-a,same-z-b,z-hi-name-z');
}

{
  const traits = [
    trait({ id: 'icon-a', layerType: 'icon' }),
    trait({ id: 'weird-a', layerType: 'zzz-unknown' }),
    trait({ id: 'mouth-a', layerType: 'mouth' }),
    trait({ id: 'body-a', layerType: 'body' }),
  ];
  const groups = groupTraitsForStack(traits);
  const layerTypeOrder = groups.map(g => g.layerType);
  check('group order follows KNOWN_LAYER_TYPES priority, unknown types last',
    layerTypeOrder.join(',') === 'body,mouth,icon,zzz-unknown');
}

// ── sortSelectedLayersForPreview ─────────────────────────────────────────
{
  const selected = [
    trait({ id: 'accessory-a', layerType: 'accessory', zIndex: 40 }),
    trait({ id: 'body-a', layerType: 'body', zIndex: 10 }),
    trait({ id: 'eyes-a', layerType: 'eyes', zIndex: 20 }),
  ];
  const sorted = sortSelectedLayersForPreview(selected);
  check('preview sort: ascending zIndex', sorted.map(t => t.id).join(',') === 'body-a,eyes-a,accessory-a');
}

{
  // Same zIndex, different layerType — tiebreak by KNOWN_LAYER_TYPES index.
  const selected = [
    trait({ id: 'icon-tied', layerType: 'icon', zIndex: 40 }),
    trait({ id: 'accessory-tied', layerType: 'accessory', zIndex: 40 }),
  ];
  const sorted = sortSelectedLayersForPreview(selected);
  check('preview sort tiebreak: layerType priority (accessory before icon)',
    sorted.map(t => t.id).join(',') === 'accessory-tied,icon-tied');
}

{
  // Same zIndex, same layerType (duplicate slot) — tiebreak by name then id.
  const selected = [
    trait({ id: 'dup-b', layerType: 'body', zIndex: 10, name: 'Bravo' }),
    trait({ id: 'dup-a', layerType: 'body', zIndex: 10, name: 'Alpha' }),
  ];
  const sorted = sortSelectedLayersForPreview(selected);
  check('preview sort final tiebreak: name', sorted.map(t => t.id).join(',') === 'dup-a,dup-b');
  check('sortSelectedLayersForPreview does not mutate the input array', selected[0].id === 'dup-b');
}

// ── getStackCanvasSize ────────────────────────────────────────────────────
{
  check('empty selection -> null', getStackCanvasSize([]) === null);
  const selected = [
    trait({ id: 'first', size: 48, zIndex: 999 }),
    trait({ id: 'second', size: 32, zIndex: 1 }),
  ];
  check('returns the FIRST selected trait\'s size, not the smallest zIndex/size',
    getStackCanvasSize(selected) === 48);
}

// ── isTraitCanvasCompatible ───────────────────────────────────────────────
{
  check('null target size is always compatible', isTraitCanvasCompatible({ size: 32 }, null));
  check('matching size is compatible', isTraitCanvasCompatible({ size: 32 }, 32));
  check('mismatched size is not compatible', !isTraitCanvasCompatible({ size: 48 }, 32));
}

// ── detectStackWarnings ───────────────────────────────────────────────────
{
  const warnings = detectStackWarnings([]);
  const codes = warnings.map(w => w.code);
  check('empty selection: no duplicate/size warnings', !codes.includes('duplicate-layer-type') && !codes.includes('canvas-size-mismatch'));
  check('empty selection: all 3 core layers reported missing',
    codes.filter(c => c === 'missing-core-layer').length === 3);
}

{
  const complete = [
    trait({ id: 'body', layerType: 'body', zIndex: 10, size: 32 }),
    trait({ id: 'eyes', layerType: 'eyes', zIndex: 20, size: 32 }),
    trait({ id: 'mouth', layerType: 'mouth', zIndex: 30, size: 32 }),
  ];
  check('a complete, consistent selection produces zero warnings', detectStackWarnings(complete).length === 0);
}

{
  const duplicated = [
    trait({ id: 'body-1', layerType: 'body', size: 32 }),
    trait({ id: 'body-2', layerType: 'body', size: 32 }),
  ];
  const warnings = detectStackWarnings(duplicated);
  const dup = warnings.find(w => w.code === 'duplicate-layer-type');
  check('duplicate-layer-type warning fires with both trait ids', !!dup
    && dup.layerType === 'body'
    && (dup.traitIds ?? []).length === 2);
}

{
  const mismatched = [
    trait({ id: 'body-32', layerType: 'body', size: 32 }),
    trait({ id: 'eyes-48', layerType: 'eyes', size: 48 }),
  ];
  const warnings = detectStackWarnings(mismatched);
  const sizeWarning = warnings.find(w => w.code === 'canvas-size-mismatch');
  check('canvas-size-mismatch warning fires and names the mismatched trait, reference = first selected (32)',
    !!sizeWarning && (sizeWarning.traitIds ?? []).includes('eyes-48') && !(sizeWarning.traitIds ?? []).includes('body-32'));
}

{
  const withUnknown = [
    trait({ id: 'weird', layerType: 'head' }), // not in KNOWN_LAYER_TYPES today — see docs §2
  ];
  const warnings = detectStackWarnings(withUnknown);
  const unknownWarning = warnings.find(w => w.code === 'unknown-layer-type');
  check('unknown-layer-type warning fires for a layerType outside KNOWN_LAYER_TYPES (e.g. "head")',
    !!unknownWarning && unknownWarning.layerType === 'head' && (unknownWarning.traitIds ?? []).includes('weird'));
}

assert.strictEqual(failures, 0, `${failures} layer-stack case(s) failed`);
console.log('\nAll layer-stack cases passed.');
