/**
 * Trait Extraction - documented confidence formula.
 *
 * Pure function over measurable inputs only - no hidden state, no
 * hand-tuned per-collection fudging. Every component is 0..1, the overall
 * score is a fixed weighted average (weights sum to 1) scaled to 0-100.
 *
 * Two status overrides take priority over the numeric score, because a
 * high score computed from an EMPTY or UNRESOLVABLE result would be
 * actively misleading (spec: "do not hide weak evidence behind a high
 * score"):
 *   - `visually_identical`: essentially no pixels differed between target
 *     and comparison images at all (metadata claims a difference the
 *     images don't show).
 *   - `unresolved`: real pixel differences exist, but no candidate pixel
 *     ever passed evidence thresholds (nothing safe to export), OR there
 *     was no usable evidence in the first place.
 */
import type { ConfidenceComponents, ConfidenceResult, ConfidenceStatus } from './te-types';

export const VISUALLY_IDENTICAL_CHANGED_PERCENT_THRESHOLD = 0.05; // %

const WEIGHTS: Record<keyof ConfidenceComponents, number> = {
  level0PairAvailability: 0.10,
  sourceAssetCountScore: 0.10,
  comparisonValueDiversityScore: 0.10,
  comparisonPairCountScore: 0.10,
  consensusAgreementScore: 0.15,
  sourcePixelConsistencyScore: 0.15,
  nonTargetMetadataDifferenceScore: 0.10,
  canvasConsistencyScore: 0.05,
  changedAreaReasonablenessScore: 0.10,
  uncertaintyPenaltyScore: 0.05,
};

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function saturating(value: number, cap: number): number { return cap <= 0 ? 0 : clamp01(value / cap); }

export interface ConfidenceInputs {
  level0PairCount: number;
  totalPairCount: number;
  distinctSourceAssetCount: number;
  distinctComparisonValueCount: number;
  meanComparisonLevel: number; // 0..2
  consensusAgreementMean: number; // 0..1, from ConsensusResult
  sourcePixelConsistencyMean: number; // 0..1, from ConsensusResult
  canvasMatchedPairCount: number;
  canvasAttemptedPairCount: number;
  changedPixelPercent: number; // 0..100
  uncertaintyPixelPercent: number; // 0..100
  candidatePixelCount: number;
  expandedCandidatePixelCount: number;
  changedPixelCount: number;
}

/** "Reasonable" changed-area band: too small looks like noise/no real
 *  difference; too large looks like the pair wasn't a clean single-trait
 *  swap (background or multiple regions changed together). Score tapers
 *  linearly outside [reasonableLow, reasonableHigh]. */
const REASONABLE_LOW_PERCENT = 0.3;
const REASONABLE_HIGH_PERCENT = 45;

function changedAreaReasonablenessScore(changedPixelPercent: number): number {
  if (changedPixelPercent <= 0) return 0;
  if (changedPixelPercent < REASONABLE_LOW_PERCENT) return clamp01(changedPixelPercent / REASONABLE_LOW_PERCENT);
  if (changedPixelPercent <= REASONABLE_HIGH_PERCENT) return 1;
  const over = changedPixelPercent - REASONABLE_HIGH_PERCENT;
  return clamp01(1 - over / REASONABLE_HIGH_PERCENT);
}

export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const components: ConfidenceComponents = {
    level0PairAvailability: inputs.totalPairCount > 0 ? clamp01(inputs.level0PairCount / inputs.totalPairCount) : 0,
    sourceAssetCountScore: saturating(inputs.distinctSourceAssetCount, 6),
    comparisonValueDiversityScore: saturating(inputs.distinctComparisonValueCount, 4),
    comparisonPairCountScore: saturating(inputs.totalPairCount, 8),
    consensusAgreementScore: clamp01(inputs.consensusAgreementMean),
    sourcePixelConsistencyScore: clamp01(inputs.sourcePixelConsistencyMean),
    nonTargetMetadataDifferenceScore: clamp01(1 - inputs.meanComparisonLevel / 2),
    canvasConsistencyScore: inputs.canvasAttemptedPairCount > 0 ? clamp01(inputs.canvasMatchedPairCount / inputs.canvasAttemptedPairCount) : 0,
    changedAreaReasonablenessScore: changedAreaReasonablenessScore(inputs.changedPixelPercent),
    uncertaintyPenaltyScore: clamp01(1 - inputs.uncertaintyPixelPercent / 100),
  };

  let weightedSum = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof ConfidenceComponents>) {
    weightedSum += components[key] * WEIGHTS[key];
  }
  const score = Math.round(clamp01(weightedSum) * 100);

  let status: ConfidenceStatus;
  if (inputs.totalPairCount === 0 || inputs.changedPixelCount === 0) {
    status = inputs.totalPairCount === 0 ? 'unresolved' : 'visually_identical';
  } else if (inputs.changedPixelPercent < VISUALLY_IDENTICAL_CHANGED_PERCENT_THRESHOLD) {
    status = 'visually_identical';
  } else if (inputs.candidatePixelCount === 0 && inputs.expandedCandidatePixelCount === 0) {
    status = 'unresolved';
  } else if (score >= 80) {
    status = 'high_confidence';
  } else if (score >= 60) {
    status = 'medium_confidence';
  } else if (score >= 35) {
    status = 'low_confidence';
  } else {
    status = 'unresolved';
  }

  return { score, status, components };
}
