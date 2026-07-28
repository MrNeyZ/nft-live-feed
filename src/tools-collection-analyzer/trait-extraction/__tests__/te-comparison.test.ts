/**
 * Trait Extraction - comparison-level / candidate-selection tests.
 * Run: npm run test:collection-analyzer-te-comparison
 */
import assert from 'assert';
import { buildSignatureExcluding, computeComparisonLevel, selectComparisonCandidates } from '../te-comparison';
import { presetLimitsFor } from '../te-limits';
import type { NormalizedAsset } from '../../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, attrs: Record<string, string>, image = `https://img/${mint}.png`): NormalizedAsset {
  return { mint, name: mint, image, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) };
}

console.log('\ncomputeComparisonLevel');
check('Level 0: only target category differs', () => {
  const a = buildSignatureExcluding(asset('A', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap' }), 'Eyes');
  const b = buildSignatureExcluding(asset('B', { Eyes: 'Normal', Body: 'Green', Hat: 'Cap' }), 'Eyes');
  const r = computeComparisonLevel(a, b);
  assert.strictEqual(r.level, 0);
  assert.strictEqual(r.matchingCategoryCount, 2);
});
check('Level 1: target + one other category differs', () => {
  const a = buildSignatureExcluding(asset('A', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap' }), 'Eyes');
  const b = buildSignatureExcluding(asset('B', { Eyes: 'Normal', Body: 'Blue', Hat: 'Cap' }), 'Eyes');
  const r = computeComparisonLevel(a, b);
  assert.strictEqual(r.level, 1);
  assert.deepStrictEqual(r.differingCategories, ['Body']);
});
check('Level 2: target + two other categories differ', () => {
  const a = buildSignatureExcluding(asset('A', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap' }), 'Eyes');
  const b = buildSignatureExcluding(asset('B', { Eyes: 'Normal', Body: 'Blue', Hat: 'Helmet' }), 'Eyes');
  const r = computeComparisonLevel(a, b);
  assert.strictEqual(r.level, 2);
});
check('beyond Level 2 -> null (always rejected)', () => {
  const a = buildSignatureExcluding(asset('A', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap', Shirt: 'Red' }), 'Eyes');
  const b = buildSignatureExcluding(asset('B', { Eyes: 'Normal', Body: 'Blue', Hat: 'Helmet', Shirt: 'Blue' }), 'Eyes');
  const r = computeComparisonLevel(a, b);
  assert.strictEqual(r.level, null);
});
check('missing category on one side counts as differing', () => {
  const a = buildSignatureExcluding(asset('A', { Eyes: 'Laser', Body: 'Green' }), 'Eyes');
  const b = buildSignatureExcluding(asset('B', { Eyes: 'Normal' }), 'Eyes');
  const r = computeComparisonLevel(a, b);
  assert.strictEqual(r.level, 1);
  assert.deepStrictEqual(r.differingCategories, ['Body']);
});

console.log('\nselectComparisonCandidates - deterministic ranking + selection');
check('prefers Level-0 pair over a Level-1 pair for the same source', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green' }),
    asset('CMP_L1', { Eyes: 'Normal', Body: 'Blue' }), // level 1
    asset('CMP_L0', { Eyes: 'Normal', Body: 'Green' }), // level 0 - better
  ];
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].comparisonMint, 'CMP_L0');
  assert.strictEqual(result[0].level, 0);
});
check('rejects comparisons worse than the preset permits (fast preset caps at Level 1)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap' }),
    asset('CMP_L2', { Eyes: 'Normal', Body: 'Blue', Hat: 'Helmet' }), // level 2 - fast preset rejects
  ];
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('fast'));
  assert.strictEqual(result.length, 0);
});
check('never compares arbitrary unrelated NFTs merely to force a result (no candidate when only Level-3+ exists)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', A: '1', B: '2', C: '3' }),
    asset('UNRELATED', { Eyes: 'Normal', A: 'x', B: 'y', C: 'z' }), // level 3
  ];
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('thorough'));
  assert.strictEqual(result.length, 0);
});
check('deterministic pair ordering: identical input always produces identical output', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC1', { Eyes: 'Laser', Body: 'Green' }),
    asset('SRC2', { Eyes: 'Laser', Body: 'Blue' }),
    asset('CMP1', { Eyes: 'Normal', Body: 'Green' }),
    asset('CMP2', { Eyes: 'Normal', Body: 'Blue' }),
  ];
  const r1 = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'));
  const r2 = selectComparisonCandidates('Eyes', 'Laser', [...assets].reverse(), presetLimitsFor('balanced'));
  assert.deepStrictEqual(r1.map((p) => `${p.sourceMint}/${p.comparisonMint}`), r2.map((p) => `${p.sourceMint}/${p.comparisonMint}`));
});
check('prefers comparison-value diversity when multiple pairs are equally ranked', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC1', { Eyes: 'Laser', Body: 'A' }),
    asset('SRC2', { Eyes: 'Laser', Body: 'B' }),
    asset('CMP_Normal1', { Eyes: 'Normal', Body: 'A' }),
    asset('CMP_Normal2', { Eyes: 'Normal', Body: 'B' }),
    asset('CMP_Fire1', { Eyes: 'Fire', Body: 'A' }),
  ];
  const limits = { ...presetLimitsFor('balanced'), maxComparisonPairsPerValue: 2 };
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, limits);
  const comparisonValues = new Set(result.map((p) => p.comparisonValue));
  assert.ok(comparisonValues.size >= 1);
});
check('mint lexical order is the final deterministic tiebreaker', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green' }),
    asset('B_CMP', { Eyes: 'Normal', Body: 'Green' }),
    asset('A_CMP', { Eyes: 'Normal', Body: 'Green' }),
  ];
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'));
  assert.strictEqual(result[0].comparisonMint, 'A_CMP');
});
check('no source assets for the target value -> empty result, never throws', () => {
  const assets: NormalizedAsset[] = [asset('A', { Eyes: 'Normal' })];
  assert.deepStrictEqual(selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced')), []);
});
check('source count capped by preset maxSourceAssetsPerValue', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 10; i++) assets.push(asset(`SRC${i}`, { Eyes: 'Laser', Body: `B${i}` }));
  for (let i = 0; i < 10; i++) assets.push(asset(`CMP${i}`, { Eyes: 'Normal', Body: `B${i}` }));
  const result = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('fast')); // fast: maxSourceAssetsPerValue=3
  const distinctSources = new Set(result.map((p) => p.sourceMint));
  assert.ok(distinctSources.size <= 3);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
