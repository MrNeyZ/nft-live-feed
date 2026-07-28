/**
 * Trait Extraction (Stage 5.1) - weighted ranking, rejection, and
 * adaptive exact -> Level 1 -> Level 2 search controller tests.
 *
 * Run: npm run test:collection-analyzer-te-ranking
 */
import assert from 'assert';
import { buildCollectionIndex } from '../te-index';
import { CategoryImpactModel } from '../te-impact';
import { rankAndFilterCandidates, expandComparisonSearch, computePairEvidenceWeight } from '../te-ranking';
import { presetLimitsFor } from '../te-limits';
import type { ComparisonCandidate } from '../te-types';
import type { NormalizedAsset } from '../asset-types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, attrs: Record<string, string>): NormalizedAsset {
  return { mint, name: mint, image: `https://img/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) };
}

function candidate(over: Partial<ComparisonCandidate>): ComparisonCandidate {
  return {
    sourceMint: 'S', comparisonMint: 'C', sourceImage: 'https://img/s.png', comparisonImage: 'https://img/c.png',
    level: 0, differingCategories: [], matchingCategoryCount: 2, comparisonValue: 'Alt',
    weightedImpactPenalty: 0, maxSingleCategoryImpact: 0,
    ...over,
  };
}

console.log('\nrankAndFilterCandidates - weighted ranking beats raw level');
check('a Level 2 pair with two TINY-impact mismatches outranks a Level 1 pair with one HIGH-impact mismatch', () => {
  const cleanL2 = candidate({ level: 2, comparisonMint: 'C_L2', differingCategories: ['Tiny1', 'Tiny2'], matchingCategoryCount: 5, weightedImpactPenalty: 0.4, maxSingleCategoryImpact: 0.25 });
  const contaminatedL1 = candidate({ level: 1, comparisonMint: 'C_L1', differingCategories: ['Background'], matchingCategoryCount: 6, weightedImpactPenalty: 2.0, maxSingleCategoryImpact: 2.0 });
  const { accepted } = rankAndFilterCandidates([contaminatedL1, cleanL2], 'thorough');
  assert.strictEqual(accepted[0].comparisonMint, 'C_L2', 'the weighted-clean Level 2 pair should rank ABOVE the contaminated Level 1 pair');
});
check('large single-category impact (lone Background mismatch) is rejected outright under Fast', () => {
  const contaminated = candidate({ differingCategories: ['Background'], level: 1, weightedImpactPenalty: 2.0, maxSingleCategoryImpact: 2.0 });
  const fast = rankAndFilterCandidates([contaminated], 'fast');
  assert.strictEqual(fast.accepted.length, 0);
  assert.strictEqual(fast.rejected.length, 1);
});
check('combined high-impact mismatch (e.g. Background + Shirt together) is rejected even under Balanced', () => {
  const doublyContaminated = candidate({ differingCategories: ['Background', 'Shirt'], level: 2, weightedImpactPenalty: 4.0, maxSingleCategoryImpact: 2.0 });
  const balanced = rankAndFilterCandidates([doublyContaminated], 'balanced');
  assert.strictEqual(balanced.accepted.length, 0, 'a pair with two high-impact category mismatches should not survive Balanced');
});
check('a clean Level 0 pair (zero impact penalty) is never rejected under any preset', () => {
  const clean = candidate({ level: 0, differingCategories: [], weightedImpactPenalty: 0, maxSingleCategoryImpact: 0 });
  for (const preset of ['fast', 'balanced', 'thorough'] as const) {
    const { accepted, rejected } = rankAndFilterCandidates([clean], preset);
    assert.strictEqual(accepted.length, 1, `preset=${preset}`);
    assert.strictEqual(rejected.length, 0, `preset=${preset}`);
  }
});
check('rejection reason is reported per rejected candidate', () => {
  const huge = candidate({ weightedImpactPenalty: 10, maxSingleCategoryImpact: 3, comparisonMint: 'HUGE' });
  const { rejected } = rankAndFilterCandidates([huge], 'balanced');
  assert.strictEqual(rejected.length, 1);
  assert.ok(['weighted_impact_penalty_exceeded', 'single_category_impact_exceeded'].includes(rejected[0].reason));
});

console.log('\ncomputePairEvidenceWeight - contamination cannot outvote clean evidence by volume');
check('an exact Level 0 pair carries more weight than a Level 2 pair with real impact penalty', () => {
  const exact = computePairEvidenceWeight({ level: 0, weightedImpactPenalty: 0 }, true, true);
  const contaminated = computePairEvidenceWeight({ level: 2, weightedImpactPenalty: 2.5 }, false, false);
  assert.ok(exact.weight > contaminated.weight);
});
check('weight is always positive (never zero) so a pair can never fully vanish from the record', () => {
  const worst = computePairEvidenceWeight({ level: 2, weightedImpactPenalty: 100 }, false, false);
  assert.ok(worst.weight > 0);
});

console.log('\nexpandComparisonSearch - adaptive exact -> Level 1 -> Level 2, stop-reason diagnostics');
check('sufficient exact (Level 0) evidence -> never expands, stop reason = exact_evidence_sufficient', () => {
  const assets: NormalizedAsset[] = [];
  // 3 sources all sharing the SAME non-target signature as 3 distinct comparisons -> plenty of Level 0 evidence.
  for (let i = 0; i < 3; i++) {
    assets.push(asset(`SRC${i}`, { Body: 'Green', Hat: 'Cap', Eyebrows: 'Confused' }));
    assets.push(asset(`CMP${i}`, { Body: 'Green', Hat: 'Cap', Eyebrows: 'Neutral' }));
  }
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const result = expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('balanced'), preset: 'balanced' });
  assert.strictEqual(result.diagnostics.adaptiveStopReason, 'exact_evidence_sufficient');
  assert.strictEqual(result.diagnostics.levelsExpandedTo, 0);
  assert.ok(result.candidates.every((c) => c.level === 0));
});
check('insufficient exact evidence expands into Level 1 and finds a near-match', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Body: 'Green', Hat: 'Cap', Eyebrows: 'Confused' }),
    asset('NEAR', { Body: 'Blue', Hat: 'Cap', Eyebrows: 'Neutral' }), // Body differs -> Level 1, no exact match exists
  ];
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const result = expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('balanced'), preset: 'balanced' });
  assert.ok(result.diagnostics.levelsExpandedTo >= 1, 'should have expanded past Level 0');
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].comparisonMint, 'NEAR');
});
check('no candidates at all (target value has no source assets) -> no_more_candidates, empty result', () => {
  const assets: NormalizedAsset[] = [asset('A', { Eyebrows: 'Other' })];
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const result = expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('balanced'), preset: 'balanced' });
  assert.strictEqual(result.candidates.length, 0);
  assert.strictEqual(result.diagnostics.adaptiveStopReason, 'no_more_candidates');
});
check('every discovered candidate rejected for high impact -> weighted_quality_threshold, zero candidates returned (never blindly used)', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Background: 'Blue', Eyebrows: 'Confused' }),
    asset('CMP', { Background: 'Green', Eyebrows: 'Neutral' }), // ONLY comparison available differs on Background
  ];
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  // Force Background to have already-measured HUGE impact so this pair gets hard-rejected under fast.
  model.recordObservation('Background', 95);
  const result = expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('fast'), preset: 'fast' });
  assert.strictEqual(result.candidates.length, 0);
  assert.strictEqual(result.diagnostics.adaptiveStopReason, 'weighted_quality_threshold');
  assert.ok(result.diagnostics.candidatesRejectedHighImpact >= 1);
});
check('diagnostics report assetsSearchable = the FULL collection size, not a lexical prefix', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 50; i++) assets.push(asset(`M${i}`, { Eyebrows: i === 0 ? 'Confused' : 'Neutral', Body: `B${i}` }));
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const result = expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('balanced'), preset: 'balanced' });
  assert.strictEqual(result.diagnostics.assetsSearchable, 50);
});
check('deterministic: identical inputs always produce identical candidates and diagnostics', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 12; i++) assets.push(asset(`M${i}`, { Eyebrows: i % 4 === 0 ? 'Confused' : 'Neutral', Body: `B${i % 3}`, Hat: `H${i % 2}` }));
  const run = () => {
    const index = buildCollectionIndex(assets);
    const model = new CategoryImpactModel();
    return expandComparisonSearch({ targetTraitType: 'Eyebrows', targetValue: 'Confused', index, impactModel: model, limits: presetLimitsFor('balanced'), preset: 'balanced' });
  };
  const r1 = run();
  const r2 = run();
  assert.deepStrictEqual(r1.candidates.map((c) => `${c.sourceMint}/${c.comparisonMint}`), r2.candidates.map((c) => `${c.sourceMint}/${c.comparisonMint}`));
  assert.strictEqual(r1.diagnostics.adaptiveStopReason, r2.diagnostics.adaptiveStopReason);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
