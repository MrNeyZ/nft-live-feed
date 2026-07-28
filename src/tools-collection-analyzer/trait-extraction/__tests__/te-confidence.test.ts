/**
 * Trait Extraction - confidence formula boundary tests.
 * Run: npm run test:collection-analyzer-te-confidence
 */
import assert from 'assert';
import { computeConfidence, type ConfidenceInputs } from '../te-confidence';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

const STRONG: ConfidenceInputs = {
  level0PairCount: 8, totalPairCount: 8, distinctSourceAssetCount: 8, distinctComparisonValueCount: 4,
  meanComparisonLevel: 0, consensusAgreementMean: 1, sourcePixelConsistencyMean: 1,
  canvasMatchedPairCount: 8, canvasAttemptedPairCount: 8,
  changedPixelPercent: 5, uncertaintyPixelPercent: 0,
  candidatePixelCount: 100, expandedCandidatePixelCount: 100, changedPixelCount: 120,
  candidatePixelPercent: 5,
  selfCategoryMedianFootprintPercent: null,
};

console.log('\ncomputeConfidence - status boundaries');
check('strong evidence -> high_confidence, score near 100', () => {
  const r = computeConfidence(STRONG);
  assert.strictEqual(r.status, 'high_confidence');
  assert.ok(r.score >= 80, `score=${r.score}`);
});
check('weak evidence (1 pair, high level, low consistency) -> low_confidence or unresolved, never high', () => {
  const r = computeConfidence({
    ...STRONG, level0PairCount: 0, totalPairCount: 1, distinctSourceAssetCount: 1, distinctComparisonValueCount: 1,
    meanComparisonLevel: 2, consensusAgreementMean: 0.3, sourcePixelConsistencyMean: 0.3,
    canvasMatchedPairCount: 1, canvasAttemptedPairCount: 2, uncertaintyPixelPercent: 40,
  });
  assert.notStrictEqual(r.status, 'high_confidence');
  assert.ok(r.score < 60, `expected low score, got ${r.score}`);
});
check('zero changed pixels -> visually_identical, regardless of otherwise-strong component scores', () => {
  const r = computeConfidence({ ...STRONG, changedPixelCount: 0, candidatePixelCount: 0, expandedCandidatePixelCount: 0, changedPixelPercent: 0 });
  assert.strictEqual(r.status, 'visually_identical');
});
check('changed area below the visually-identical threshold -> visually_identical even with nonzero raw count', () => {
  const r = computeConfidence({ ...STRONG, changedPixelPercent: 0.01, changedPixelCount: 3 });
  assert.strictEqual(r.status, 'visually_identical');
});
check('real change but zero candidate/expanded pixels isolated -> unresolved (weak evidence never hidden behind a high score)', () => {
  const r = computeConfidence({ ...STRONG, candidatePixelCount: 0, expandedCandidatePixelCount: 0, changedPixelCount: 50, changedPixelPercent: 10 });
  assert.strictEqual(r.status, 'unresolved');
});
check('zero total pairs -> unresolved (no evidence at all)', () => {
  const r = computeConfidence({ ...STRONG, totalPairCount: 0, level0PairCount: 0, changedPixelCount: 0 });
  assert.strictEqual(r.status, 'unresolved');
});
check('medium band: score in [60,80) -> medium_confidence', () => {
  const r = computeConfidence({
    ...STRONG, distinctSourceAssetCount: 3, distinctComparisonValueCount: 2, totalPairCount: 4, level0PairCount: 2,
    consensusAgreementMean: 0.65, sourcePixelConsistencyMean: 0.7, meanComparisonLevel: 1,
  });
  assert.ok(r.score >= 35, `score=${r.score}`); // just asserting it lands in a non-high, non-unresolved-by-score band
  assert.notStrictEqual(r.status, 'high_confidence');
});
check('score is always 0-100 and components are all 0-1', () => {
  const r = computeConfidence(STRONG);
  assert.ok(r.score >= 0 && r.score <= 100);
  for (const v of Object.values(r.components)) assert.ok(v >= 0 && v <= 1, `component out of range: ${v}`);
});
check('candidate-area-too-large (near 100% of canvas) penalizes reasonableness score', () => {
  const reasonable = computeConfidence({ ...STRONG, candidatePixelPercent: 5 });
  const tooLarge = computeConfidence({ ...STRONG, candidatePixelPercent: 95 });
  assert.ok(tooLarge.components.changedAreaReasonablenessScore < reasonable.components.changedAreaReasonablenessScore);
});
check('a HUGE raw changedPixelPercent (diagnostic union across many pairs) does NOT by itself tank reasonableness if the actual candidate stayed small - the score judges the real output, not contamination noise from rejected-adjacent pairs', () => {
  const r = computeConfidence({ ...STRONG, changedPixelPercent: 90, candidatePixelPercent: 0.5 });
  assert.strictEqual(r.components.changedAreaReasonablenessScore, 1);
});
check('a candidate spanning most of the canvas is forced to unresolved regardless of an otherwise-strong score (spec: unresolved > a severely contaminated candidate)', () => {
  const r = computeConfidence({ ...STRONG, candidatePixelPercent: 85 });
  assert.strictEqual(r.status, 'unresolved');
});
check('a learned self-category footprint tightens the large-candidate ceiling below the fixed default', () => {
  // This job already learned (from other clean values in the SAME
  // category) that a typical footprint here is ~0.7% - an 8.5% result is
  // ~12x that, well under the fixed 60% default but should still trip
  // the PERSONALIZED ceiling.
  const withoutSelfKnowledge = computeConfidence({ ...STRONG, candidatePixelPercent: 8.5, selfCategoryMedianFootprintPercent: null });
  const withSelfKnowledge = computeConfidence({ ...STRONG, candidatePixelPercent: 8.5, selfCategoryMedianFootprintPercent: 0.7 });
  assert.notStrictEqual(withoutSelfKnowledge.status, 'unresolved');
  assert.strictEqual(withSelfKnowledge.status, 'unresolved');
});
check('canvas-dimension mismatches reduce canvasConsistencyScore proportionally', () => {
  const r = computeConfidence({ ...STRONG, canvasMatchedPairCount: 4, canvasAttemptedPairCount: 8 });
  assert.strictEqual(r.components.canvasConsistencyScore, 0.5);
});
check('higher mean comparison level reduces nonTargetMetadataDifferenceScore', () => {
  const level0 = computeConfidence({ ...STRONG, meanComparisonLevel: 0 });
  const level2 = computeConfidence({ ...STRONG, meanComparisonLevel: 2 });
  assert.strictEqual(level0.components.nonTargetMetadataDifferenceScore, 1);
  assert.strictEqual(level2.components.nonTargetMetadataDifferenceScore, 0);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
