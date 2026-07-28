/**
 * Trait Extraction - eligibility classifier tests.
 * Run: npm run test:collection-analyzer-te-eligibility
 */
import assert from 'assert';
import { buildTraitCollectionEligibility } from '../te-eligibility';
import type { NormalizedAsset } from '../../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, attrs: Array<{ trait_type: string; value: string }>): NormalizedAsset {
  return { mint, name: mint, image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: attrs };
}

console.log('\nbuildTraitCollectionEligibility - clear trait collection -> suitable');
check('classic generative PFP shape (4 categories, values repeated ~10x each) -> suitable', () => {
  const cats = ['Background', 'Body', 'Eyes', 'Clothes'];
  const values = ['A', 'B', 'C', 'D', 'E'];
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 100; i++) {
    assets.push(asset(`M${i}`, cats.map((c) => ({ trait_type: c, value: values[(i + cats.indexOf(c)) % values.length] }))));
  }
  const e = buildTraitCollectionEligibility(assets);
  assert.strictEqual(e.classification, 'suitable');
  assert.strictEqual(e.percentWithAttributes, 100);
  assert.strictEqual(e.totalTraitCategories, 4);
  assert.ok(e.categoriesWithRepeatedValues >= 2);
  assert.ok(e.reasons.length > 0);
});

console.log('\nbuildTraitCollectionEligibility - mixed collection -> possibly_suitable');
check('some repeated structure but sparse/inconsistent -> possibly_suitable', () => {
  const assets: NormalizedAsset[] = [];
  // 40 assets: half have a shared "Background" value (2 values, repeated),
  // half have entirely unique one-off attributes across other categories.
  for (let i = 0; i < 20; i++) assets.push(asset(`M${i}`, [{ trait_type: 'Background', value: i % 2 === 0 ? 'Blue' : 'Red' }]));
  for (let i = 20; i < 40; i++) assets.push(asset(`M${i}`, [{ trait_type: `Unique${i}`, value: `V${i}` }]));
  const e = buildTraitCollectionEligibility(assets);
  assert.strictEqual(e.classification, 'possibly_suitable');
});

console.log('\nbuildTraitCollectionEligibility - 1/1-style unique collection -> unsuitable');
check('every asset has entirely unique attributes -> unsuitable', () => {
  const assets: NormalizedAsset[] = Array.from({ length: 30 }, (_, i) => asset(`M${i}`, [{ trait_type: `Unique${i}`, value: `OnlyOne${i}` }]));
  const e = buildTraitCollectionEligibility(assets);
  assert.strictEqual(e.classification, 'unsuitable');
  assert.strictEqual(e.categoriesWithRepeatedValues, 0);
});
check('no attributes at all -> unsuitable', () => {
  const assets: NormalizedAsset[] = Array.from({ length: 10 }, (_, i) => asset(`M${i}`, []));
  const e = buildTraitCollectionEligibility(assets);
  assert.strictEqual(e.classification, 'unsuitable');
  assert.strictEqual(e.assetsWithNoAttributes, 10);
  assert.strictEqual(e.percentWithAttributes, 0);
});
check('empty scan -> unsuitable, never throws', () => {
  const e = buildTraitCollectionEligibility([]);
  assert.strictEqual(e.classification, 'unsuitable');
  assert.strictEqual(e.totalAssets, 0);
});

console.log('\nmalformed attributes');
check('malformed attribute (non-string trait_type/value) counted, not crashing', () => {
  const assets: NormalizedAsset[] = [
    asset('M1', [{ trait_type: 'Background', value: 'Blue' }]),
    { mint: 'M2', name: 'M2', image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [{ trait_type: 5 as unknown as string, value: 'X' }] },
  ];
  const e = buildTraitCollectionEligibility(assets);
  assert.strictEqual(e.malformedAttributeCount, 1);
});

console.log('\nreport field sanity');
check('reasons array explains the classification decision', () => {
  const assets: NormalizedAsset[] = Array.from({ length: 10 }, (_, i) => asset(`M${i}`, [{ trait_type: 'Background', value: i < 5 ? 'Blue' : 'Red' }]));
  const e = buildTraitCollectionEligibility(assets);
  assert.ok(e.reasons.length > 0);
  assert.strictEqual(typeof e.medianAssetsPerTraitValue, 'number');
  assert.strictEqual(typeof e.percentInRepeatedStructure, 'number');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
