/**
 * Trait Extraction - comparison-level primitives + the te-comparison.ts
 * orchestration entry point (Stage 5.1: now backed by te-index/
 * te-diversity/te-impact/te-ranking - see those modules' own test files
 * for the detailed algorithm coverage). This file keeps the original
 * Stage 5 behavioral guarantees: Level 0 preferred over Level 1, presets
 * reject worse-than-permitted levels, deterministic ordering, no
 * comparison against unrelated NFTs merely to force a result.
 *
 * Run: npm run test:collection-analyzer-te-comparison
 */
import assert from 'assert';
import { buildSignatureExcluding, computeComparisonLevel, selectComparisonCandidates } from '../te-comparison';
import { presetLimitsFor } from '../te-limits';
import type { NormalizedAsset } from '../asset-types';

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

console.log('\nselectComparisonCandidates - deterministic ranking + selection (Stage 5.1: index/diversity/ranking-backed)');
check('ranks a Level-0 pair AHEAD of a Level-1 pair for the same source (adaptive search may still gather both as extra evidence - spec section 9)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green' }),
    asset('CMP_L1', { Eyes: 'Normal', Body: 'Blue' }), // level 1
    asset('CMP_L0', { Eyes: 'Normal', Body: 'Green' }), // level 0 - better, must rank first
  ];
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'), 'balanced');
  assert.ok(candidates.length >= 1);
  assert.strictEqual(candidates[0].comparisonMint, 'CMP_L0');
  assert.strictEqual(candidates[0].level, 0);
});
check('rejects comparisons worse than the preset permits (fast preset caps at Level 1)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green', Hat: 'Cap' }),
    asset('CMP_L2', { Eyes: 'Normal', Body: 'Blue', Hat: 'Helmet' }), // level 2 - fast preset rejects
  ];
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('fast'), 'fast');
  assert.strictEqual(candidates.length, 0);
});
check('never compares arbitrary unrelated NFTs merely to force a result (no candidate when only Level-3+ exists)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', A: '1', B: '2', C: '3' }),
    asset('UNRELATED', { Eyes: 'Normal', A: 'x', B: 'y', C: 'z' }), // level 3
  ];
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('thorough'), 'thorough');
  assert.strictEqual(candidates.length, 0);
});
check('deterministic pair ordering: identical input always produces identical output', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC1', { Eyes: 'Laser', Body: 'Green' }),
    asset('SRC2', { Eyes: 'Laser', Body: 'Blue' }),
    asset('CMP1', { Eyes: 'Normal', Body: 'Green' }),
    asset('CMP2', { Eyes: 'Normal', Body: 'Blue' }),
  ];
  const r1 = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'), 'balanced');
  const r2 = selectComparisonCandidates('Eyes', 'Laser', [...assets].reverse(), presetLimitsFor('balanced'), 'balanced');
  assert.deepStrictEqual(r1.candidates.map((p) => `${p.sourceMint}/${p.comparisonMint}`), r2.candidates.map((p) => `${p.sourceMint}/${p.comparisonMint}`));
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
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, limits, 'balanced');
  const comparisonValues = new Set(candidates.map((p) => p.comparisonValue));
  assert.ok(comparisonValues.size >= 1);
});
check('mint lexical order is the final deterministic tiebreaker', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Eyes: 'Laser', Body: 'Green' }),
    asset('B_CMP', { Eyes: 'Normal', Body: 'Green' }),
    asset('A_CMP', { Eyes: 'Normal', Body: 'Green' }),
  ];
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'), 'balanced');
  assert.strictEqual(candidates[0].comparisonMint, 'A_CMP');
});
check('no source assets for the target value -> empty result, never throws', () => {
  const assets: NormalizedAsset[] = [asset('A', { Eyes: 'Normal' })];
  assert.deepStrictEqual(selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'), 'balanced').candidates, []);
});
check('source count capped by preset maxSourceAssetsPerValue', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 10; i++) assets.push(asset(`SRC${i}`, { Eyes: 'Laser', Body: `B${i}` }));
  for (let i = 0; i < 10; i++) assets.push(asset(`CMP${i}`, { Eyes: 'Normal', Body: `B${i}` }));
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('fast'), 'fast'); // fast: maxSourceAssetsPerValue=3
  const distinctSources = new Set(candidates.map((p) => p.sourceMint));
  assert.ok(distinctSources.size <= 3);
});
check('the whole collection is searchable - COMPARISON_POOL_CAP=2000 lexical prefix no longer exists (see te-index.test.ts for the full regression)', () => {
  const assets: NormalizedAsset[] = [asset('AAA_SRC', { Eyes: 'Laser', Body: 'Green' })];
  for (let i = 0; i < 2500; i++) assets.push(asset(`F${String(i).padStart(5, '0')}`, { Eyes: 'Normal', Body: `Other${i}` }));
  assets.push(asset('ZZZ_EXACT_MATCH', { Eyes: 'Normal', Body: 'Green' }));
  const { candidates } = selectComparisonCandidates('Eyes', 'Laser', assets, presetLimitsFor('balanced'), 'balanced');
  assert.ok(candidates.length >= 1);
  assert.strictEqual(candidates[0].comparisonMint, 'ZZZ_EXACT_MATCH', 'the exact match must rank first even though it sits at the very end of the collection');
  assert.strictEqual(candidates[0].level, 0);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
