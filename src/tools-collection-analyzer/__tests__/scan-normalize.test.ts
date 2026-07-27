/**
 * Collection Analyzer Stage 2 — trait normalization + full-analysis offline
 * tests. Pure, no network.
 *
 * Run: npm run test:collection-analyzer-normalize
 */
import assert from 'assert';
import { normalizeTraitValue, normalizeAssetAttributesFull, buildFullAnalysis, metadataSignature } from '../scan-normalize';
import type { NormalizedAsset } from '../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

console.log('\nnormalizeTraitValue');
check('number -> string, no issue', () => assert.deepStrictEqual(normalizeTraitValue(5), { value: '5' }));
check('boolean true -> "true", no issue', () => assert.deepStrictEqual(normalizeTraitValue(true), { value: 'true' }));
check('boolean false -> "false", no issue', () => assert.deepStrictEqual(normalizeTraitValue(false), { value: 'false' }));
check('null -> "(null)", issue=null_value', () => assert.deepStrictEqual(normalizeTraitValue(null), { value: '(null)', issue: 'null_value' }));
check('undefined -> "(null)", issue=null_value', () => assert.deepStrictEqual(normalizeTraitValue(undefined), { value: '(null)', issue: 'null_value' }));
check('whitespace-padded string trimmed', () => assert.deepStrictEqual(normalizeTraitValue('  Blue  '), { value: 'Blue' }));
check('blank string -> "(empty)", issue=empty_value', () => assert.deepStrictEqual(normalizeTraitValue('   '), { value: '(empty)', issue: 'empty_value' }));

console.log('\nnormalizeAssetAttributesFull');
check('non-array attributes container -> malformed_shape, empty result, never throws', () => {
  const r = normalizeAssetAttributesFull('not an array' as unknown);
  assert.deepStrictEqual(r.attributes, []);
  assert.deepStrictEqual(r.issues, ['malformed_shape']);
});
check('undefined attributes container -> no issue, empty result (simply absent)', () => {
  const r = normalizeAssetAttributesFull(undefined);
  assert.deepStrictEqual(r.attributes, []);
  assert.deepStrictEqual(r.issues, []);
});
check('non-string numeric trait_type is coerced', () => {
  const r = normalizeAssetAttributesFull([{ trait_type: 5, value: 'x' }]);
  assert.deepStrictEqual(r.attributes, [{ trait_type: '5', value: 'x' }]);
  assert.deepStrictEqual(r.issues, ['non_string_trait_type_coerced']);
});
check('object-shaped trait_type -> malformed_shape, skipped entirely', () => {
  const r = normalizeAssetAttributesFull([{ trait_type: { nested: true }, value: 'x' }]);
  assert.deepStrictEqual(r.attributes, []);
  assert.deepStrictEqual(r.issues, ['malformed_shape']);
});
check('non-object array entry -> malformed_shape, skipped', () => {
  const r = normalizeAssetAttributesFull(['just a string', 42]);
  assert.deepStrictEqual(r.attributes, []);
  assert.deepStrictEqual(r.issues, ['malformed_shape', 'malformed_shape']);
});
check('object/array value -> malformed_shape, skipped (not treated as null)', () => {
  const r = normalizeAssetAttributesFull([{ trait_type: 'Background', value: { r: 1 } }]);
  assert.deepStrictEqual(r.attributes, []);
  assert.deepStrictEqual(r.issues, ['malformed_shape']);
});
check('null attribute value -> kept as "(null)" attribute + issue', () => {
  const r = normalizeAssetAttributesFull([{ trait_type: 'Background', value: null }]);
  assert.deepStrictEqual(r.attributes, [{ trait_type: 'Background', value: '(null)' }]);
  assert.deepStrictEqual(r.issues, ['null_value']);
});
check('duplicated trait_type with IDENTICAL value collapses to one + issue', () => {
  const r = normalizeAssetAttributesFull([
    { trait_type: 'Background', value: 'Blue' },
    { trait_type: 'Background', value: 'Blue' },
  ]);
  assert.deepStrictEqual(r.attributes, [{ trait_type: 'Background', value: 'Blue' }]);
  assert.deepStrictEqual(r.issues, ['duplicate_identical_pair']);
});
check('duplicated trait_type with DIFFERING values keeps the FIRST + issue', () => {
  const r = normalizeAssetAttributesFull([
    { trait_type: 'Background', value: 'Blue' },
    { trait_type: 'Background', value: 'Red' },
  ]);
  assert.deepStrictEqual(r.attributes, [{ trait_type: 'Background', value: 'Blue' }]);
  assert.deepStrictEqual(r.issues, ['duplicate_conflicting_trait_type']);
});
check('whitespace-differing trait_type is trimmed before dedup key comparison', () => {
  const r = normalizeAssetAttributesFull([
    { trait_type: '  Background', value: 'Blue' },
    { trait_type: 'Background  ', value: 'Blue' },
  ]);
  assert.strictEqual(r.attributes.length, 1);
  assert.strictEqual(r.issues.includes('duplicate_identical_pair'), true);
});

console.log('\nmetadataSignature');
check('same attribute set in different order -> identical signature', () => {
  const a = metadataSignature([{ trait_type: 'B', value: '1' }, { trait_type: 'A', value: '2' }]);
  const b = metadataSignature([{ trait_type: 'A', value: '2' }, { trait_type: 'B', value: '1' }]);
  assert.strictEqual(a, b);
});
check('different attribute values -> different signature', () => {
  const a = metadataSignature([{ trait_type: 'A', value: '1' }]);
  const b = metadataSignature([{ trait_type: 'A', value: '2' }]);
  assert.notStrictEqual(a, b);
});

// ── buildFullAnalysis ────────────────────────────────────────────────────
console.log('\nbuildFullAnalysis');

function asset(over: Partial<NormalizedAsset>): NormalizedAsset {
  return {
    mint: 'M', name: 'N', image: 'https://img/x.png', jsonUri: null,
    collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [],
    ...over,
  };
}

check('exact totals + missing-metadata counters', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', name: 'A', image: 'img1' }),
    asset({ mint: '2', name: null, image: 'img2' }),
    asset({ mint: '3', name: 'C', image: null }),
    asset({ mint: '4', name: null, image: null, attributes: [] }),
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  assert.strictEqual(r.quality.totalAssets, 4);
  assert.strictEqual(r.quality.assetsWithValidMetadata, 1); // only #1 has both
  assert.strictEqual(r.quality.assetsMissingName, 2);
  assert.strictEqual(r.quality.assetsMissingImage, 2);
  assert.strictEqual(r.quality.assetsMissingAttributes, 4); // none have attributes
});

check('compressed vs regular counts', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', compressed: true, standard: 'compressed' }),
    asset({ mint: '2', compressed: false, standard: 'core' }),
    asset({ mint: '3', compressed: false, standard: 'legacy' }),
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  assert.strictEqual(r.quality.compressedCount, 1);
  assert.strictEqual(r.quality.regularCount, 2);
});

check('trait category value counts + percentages + missing category count', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', attributes: [{ trait_type: 'Background', value: 'Blue' }] }),
    asset({ mint: '2', attributes: [{ trait_type: 'Background', value: 'Blue' }] }),
    asset({ mint: '3', attributes: [{ trait_type: 'Background', value: 'Red' }] }),
    asset({ mint: '4', attributes: [] }), // missing Background entirely
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  const bg = r.traitCategories.find((c) => c.traitType === 'Background')!;
  assert.ok(bg, 'Background category present');
  assert.strictEqual(bg.missingCount, 1);
  assert.strictEqual(bg.missingPercent, 25);
  const blue = bg.values.find((v) => v.value === 'Blue')!;
  assert.strictEqual(blue.count, 2);
  assert.strictEqual(blue.percent, 50);
  assert.strictEqual(blue.oneOfOne, false);
  const red = bg.values.find((v) => v.value === 'Red')!;
  assert.strictEqual(red.count, 1);
  assert.strictEqual(red.oneOfOne, true);
});

check('traits-per-NFT distribution buckets by attribute count', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', attributes: [{ trait_type: 'A', value: '1' }] }),
    asset({ mint: '2', attributes: [{ trait_type: 'A', value: '1' }, { trait_type: 'B', value: '2' }] }),
    asset({ mint: '3', attributes: [] }),
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  assert.deepStrictEqual(r.traitsPerNftDistribution, [
    { traitsCount: 0, nftCount: 1 },
    { traitsCount: 1, nftCount: 1 },
    { traitsCount: 2, nftCount: 1 },
  ]);
});

check('duplicate metadata signature groups (>=2 members only)', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', attributes: [{ trait_type: 'A', value: '1' }] }),
    asset({ mint: '2', attributes: [{ trait_type: 'A', value: '1' }] }), // identical set to #1
    asset({ mint: '3', attributes: [{ trait_type: 'A', value: '2' }] }), // unique, not grouped
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  assert.strictEqual(r.duplicateMetadataGroups.length, 1);
  assert.strictEqual(r.duplicateMetadataGroups[0].count, 2);
  assert.deepStrictEqual(r.duplicateMetadataGroups[0].mints.sort(), ['1', '2']);
});

check('duplicate image URI groups (>=2 members only, nulls excluded)', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', image: 'https://img/same.png' }),
    asset({ mint: '2', image: 'https://img/same.png' }),
    asset({ mint: '3', image: 'https://img/unique.png' }),
    asset({ mint: '4', image: null }),
  ];
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  assert.strictEqual(r.duplicateImageGroups.length, 1);
  assert.strictEqual(r.duplicateImageGroups[0].key, 'https://img/same.png');
  assert.strictEqual(r.duplicateImageGroups[0].count, 2);
});

check('per-asset issue tallies roll up into quality diagnostics + warnings', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1' }),
    asset({ mint: '2' }),
  ];
  const r = buildFullAnalysis({
    assets,
    perAssetIssues: [
      ['malformed_shape', 'non_string_trait_type_coerced'],
      ['duplicate_conflicting_trait_type', 'null_value', 'empty_value'],
    ],
  });
  assert.strictEqual(r.quality.malformedAttributesSkipped, 1);
  assert.strictEqual(r.quality.nonStringTraitTypeCoerced, 1);
  assert.strictEqual(r.quality.conflictingDuplicateTraitTypeAssets, 1);
  assert.strictEqual(r.quality.nullValueAttributes, 1);
  assert.strictEqual(r.quality.emptyStringValueAttributes, 1);
  assert.ok(r.warnings.some((w) => w.includes('malformed shape')));
  assert.ok(r.warnings.some((w) => w.includes('non-string trait_type')));
  assert.ok(r.warnings.some((w) => w.includes('DIFFERING values')));
});

check('one-of-one highlights capped, aggregate counts stay exact in traitCategories', () => {
  const assets: NormalizedAsset[] = Array.from({ length: 5 }, (_, i) =>
    asset({ mint: String(i), attributes: [{ trait_type: 'Unique', value: `v${i}` }] }));
  const r = buildFullAnalysis({ assets, perAssetIssues: assets.map(() => []) });
  const cat = r.traitCategories.find((c) => c.traitType === 'Unique')!;
  assert.strictEqual(cat.values.length, 5);
  assert.ok(cat.values.every((v) => v.oneOfOne));
  assert.ok(r.oneOfOneHighlights.length <= 5);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
