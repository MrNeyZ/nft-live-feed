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
/** Stage 5.1 hard override (spec section 15: "unresolved is preferred
 *  over a severely contaminated candidate"). The per-pair weighting and
 *  rejection thresholds (te-ranking.ts) reduce contamination risk BEFORE
 *  consensus, but cannot guarantee the AGGREGATE weighted candidate
 *  stays small - e.g. several accepted-but-moderate Level 1/2 pairs can
 *  still jointly agree across a large shared area (a Background mismatch
 *  touches nearly the whole canvas in every such pair). A candidate this
 *  large is not a usable single-trait asset regardless of its numeric
 *  score, which a 10%-weighted reasonableness component alone cannot
 *  reliably veto. */
export const LARGE_CANDIDATE_AREA_UNRESOLVED_THRESHOLD_PERCENT = 60;
/** When this job has already learned the TARGET CATEGORY's own typical
 *  footprint from earlier clean Level 0 pairs (te-impact.ts self-
 *  observations - e.g. this collection's Eyebrows category typically
 *  changes ~0.7% of the canvas), a candidate many times that size is a
 *  much stronger contamination signal than the fixed global ceiling
 *  alone. Multiplier/floor are a heuristic starting point, not an exact
 *  calibration - documented as such in the Stage 5.1 report. */
const SELF_FOOTPRINT_CEILING_MULTIPLIER = 10;
const SELF_FOOTPRINT_CEILING_FLOOR_PERCENT = 5;

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
  /** candidatePixelCount as a % of canvas area (Stage 5.1) - the
   *  reasonableness score judges the size of the ACTUAL exported
   *  candidate, not the diagnostic "any pair differed anywhere" union
   *  (`changedPixelPercent`), which balloons whenever ANY comparison
   *  pair - even a low-weight, rejected-adjacent Level 2 one - happens
   *  to touch a large area (e.g. a Background/Shirt mismatch), even when
   *  the actual weighted candidate stayed small and clean. */
  candidatePixelPercent: number; // 0..100
  /** Median changed-area% this JOB has already directly observed for the
   *  TARGET category itself, from earlier clean Level 0 pairs (null if
   *  none yet - e.g. the first value of a category processed, or every
   *  value in this category has needed Level 1/2 evidence so far). */
  selfCategoryMedianFootprintPercent: number | null;
}

/** "Reasonable" area band. Too small looks like noise/no real difference -
 *  checked against `changedPixelPercent` (the broad diagnostic union),
 *  because a real trait's raw affected area scales with canvas
 *  resolution and this floor needs to tolerate that. Too large looks
 *  like the pair wasn't a clean single-trait swap (background or
 *  multiple regions changed together) - checked against
 *  `candidatePixelPercent` (Stage 5.1), because that is literally the
 *  region that ends up in the exported candidate; a contaminated,
 *  low-weight Level 2 pair ballooning the diagnostic union must not get
 *  to hide behind a small floor check that was never meant to guard
 *  against it. Score tapers linearly outside [reasonableLow, reasonableHigh]. */
const REASONABLE_LOW_PERCENT = 0.3;
const REASONABLE_HIGH_PERCENT = 45;

function changedAreaReasonablenessScore(changedPixelPercent: number, candidatePixelPercent: number): number {
  if (changedPixelPercent <= 0) return 0;
  const lowScore = changedPixelPercent < REASONABLE_LOW_PERCENT ? clamp01(changedPixelPercent / REASONABLE_LOW_PERCENT) : 1;
  let highScore = 1;
  if (candidatePixelPercent > REASONABLE_HIGH_PERCENT) {
    const over = candidatePixelPercent - REASONABLE_HIGH_PERCENT;
    highScore = clamp01(1 - over / REASONABLE_HIGH_PERCENT);
  }
  return Math.min(lowScore, highScore);
}

function largeCandidateAreaThreshold(selfCategoryMedianFootprintPercent: number | null): number {
  if (selfCategoryMedianFootprintPercent === null || selfCategoryMedianFootprintPercent <= 0) {
    return LARGE_CANDIDATE_AREA_UNRESOLVED_THRESHOLD_PERCENT;
  }
  const dynamic = selfCategoryMedianFootprintPercent * SELF_FOOTPRINT_CEILING_MULTIPLIER;
  return Math.min(LARGE_CANDIDATE_AREA_UNRESOLVED_THRESHOLD_PERCENT, Math.max(SELF_FOOTPRINT_CEILING_FLOOR_PERCENT, dynamic));
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
    changedAreaReasonablenessScore: changedAreaReasonablenessScore(inputs.changedPixelPercent, inputs.candidatePixelPercent),
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
  } else if (inputs.candidatePixelPercent > largeCandidateAreaThreshold(inputs.selfCategoryMedianFootprintPercent)) {
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
