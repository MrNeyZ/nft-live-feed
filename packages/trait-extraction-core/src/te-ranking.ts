/**
 * Trait Extraction (Stage 5.1) - weighted candidate ranking, large-
 * footprint rejection, and the adaptive exact -> Level 1 -> Level 2
 * comparison-search controller (spec sections 4, 6, 7, 9, 11).
 *
 * Responsibility split with te-run.ts: this module decides WHICH pairs to
 * gather and why the metadata-level search stopped (`ValueSearchDiagnostics
 * .adaptiveStopReason`). It never touches pixel data. Once te-run.ts
 * downloads and diffs the returned pairs, it may report the SAME value's
 * ultimate evidence as `visually_identical`/`unresolved`/etc regardless of
 * how many candidates were found here - search success and pixel-evidence
 * success are different questions.
 *
 * "consensus_stabilized" here specifically means: adaptive expansion
 * (Level 1 or 2) found enough converging evidence to stop widening BEFORE
 * hitting the preset's pair cap or exhausting the collection - distinct
 * from `exact_evidence_sufficient` (Level 0 alone was already enough, no
 * expansion needed at all).
 */
import type { NormalizedAsset } from './asset-types';
import {
  buildSignatureExcluding, computeComparisonLevel, exactCandidatesFor, shortlistNearCandidates,
} from './te-index';
import type { CollectionIndex } from './te-index';
import type { CategoryImpactModel } from './te-impact';
import { selectDiverseSourceAssets } from './te-diversity';
import {
  TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE, TE_MAX_NEAR_CANDIDATES_PER_SOURCE, TE_MAX_SEARCH_MS_PER_VALUE,
  TE_SOURCE_SEARCH_POOL_MAX, rejectionThresholdsFor,
} from './te-limits';
import type {
  ComparisonCandidate, ComparisonLevel, ExtractionPreset, ExtractionPresetLimits,
  PairEvidenceWeight, SearchStopReason, ValueSearchDiagnostics,
} from './te-types';

function attrValue(asset: NormalizedAsset, traitType: string): string | null {
  const attr = asset.attributes.find((a) => a.trait_type === traitType);
  return attr ? attr.value : null;
}

// ── Ranking (spec section 6) ─────────────────────────────────────────────

type RankKey = [number, number, number, number, string, string];

function rankKey(p: ComparisonCandidate): RankKey {
  return [
    p.weightedImpactPenalty,        // 1. lower weighted visual-impact penalty
    p.differingCategories.length,   // 2. fewer non-target mismatches
    p.maxSingleCategoryImpact,      // 3. lower maximum single-category impact
    -p.matchingCategoryCount,       // 4. more matching categories
    p.sourceMint,                   // 6. deterministic mint order (tiebreak)
    p.comparisonMint,
  ];
}
function compareRankKeys(a: RankKey, b: RankKey): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export interface RejectedCandidate { candidate: ComparisonCandidate; reason: string }
export interface RankAndFilterResult { accepted: ComparisonCandidate[]; rejected: RejectedCandidate[] }

/** Applies preset-specific large-footprint rejection (spec section 7),
 *  then sorts survivors by the weighted-impact ranking formula. A Level 2
 *  pair differing in two tiny categories legitimately outranks a Level 1
 *  pair that differs only in a high-impact category like Background -
 *  raw level is a tiebreaker here, never the primary key. */
export function rankAndFilterCandidates(rawCandidates: ComparisonCandidate[], preset: ExtractionPreset): RankAndFilterResult {
  const thresholds = rejectionThresholdsFor(preset);
  const accepted: ComparisonCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const c of rawCandidates) {
    if (c.weightedImpactPenalty > thresholds.maxWeightedImpactPenalty) {
      rejected.push({ candidate: c, reason: 'weighted_impact_penalty_exceeded' });
      continue;
    }
    if (c.maxSingleCategoryImpact > thresholds.maxSingleCategoryImpact) {
      rejected.push({ candidate: c, reason: 'single_category_impact_exceeded' });
      continue;
    }
    accepted.push(c);
  }
  accepted.sort((a, b) => compareRankKeys(rankKey(a), rankKey(b)));
  return { accepted, rejected };
}

/** Final diversity-aware truncation to the preset's pair cap - same
 *  two-pass shape as pre-5.1 (new-source-mint OR new-comparison-value
 *  first, then fill in rank order), operating on the WEIGHTED ranking. */
export function selectFinalPairs(ranked: ComparisonCandidate[], cap: number): ComparisonCandidate[] {
  const selected: ComparisonCandidate[] = [];
  const usedComparisonValues = new Set<string>();
  const usedSourceMints = new Set<string>();
  for (const p of ranked) {
    if (selected.length >= cap) break;
    const newComparisonValue = !usedComparisonValues.has(p.comparisonValue ?? ' null');
    const newSourceMint = !usedSourceMints.has(p.sourceMint);
    if (newComparisonValue || newSourceMint) {
      selected.push(p);
      usedComparisonValues.add(p.comparisonValue ?? ' null');
      usedSourceMints.add(p.sourceMint);
    }
  }
  for (const p of ranked) {
    if (selected.length >= cap) break;
    if (selected.includes(p)) continue;
    selected.push(p);
  }
  return selected;
}

// ── Pair evidence weight for consensus (spec section 8) ─────────────────

const IMPACT_PENALTY_SOFT_CAP = 4.5; // matches thorough's maxWeightedImpactPenalty

/** How much a single accepted pair should contribute to the multi-pair
 *  pixel consensus (te-pixel-diff.ts). Exact Level 0 pairs with no
 *  competing high-impact mismatch carry the most weight; a Thorough-only
 *  pair that was allowed through despite a real (but sub-rejection)
 *  footprint mismatch is deliberately down-weighted rather than excluded -
 *  "weak evidence, lower consensus weight," never silently equal. */
export function computePairEvidenceWeight(
  candidate: Pick<ComparisonCandidate, 'level' | 'weightedImpactPenalty'>,
  isNewSourceMint: boolean,
  isNewComparisonValue: boolean,
): PairEvidenceWeight {
  const exactnessScore = candidate.level === 0 ? 1.0 : candidate.level === 1 ? 0.6 : 0.35;
  const impactPenaltyScore = Math.max(0, Math.min(1, 1 - candidate.weightedImpactPenalty / IMPACT_PENALTY_SOFT_CAP));
  const sourceDiversityScore = isNewSourceMint ? 1.0 : 0.85;
  const targetValueDiversityScore = isNewComparisonValue ? 1.0 : 0.85;
  const weight = exactnessScore * (0.5 + 0.5 * impactPenaltyScore) * ((sourceDiversityScore + targetValueDiversityScore) / 2);
  return {
    weight: Math.max(0.05, Math.min(1.5, Math.round(weight * 1000) / 1000)),
    components: { exactnessScore, impactPenaltyScore, sourceDiversityScore, targetValueDiversityScore },
  };
}

// ── Adaptive exact -> Level 1 -> Level 2 search (spec sections 4, 9, 11) ─

function buildCandidate(
  source: NormalizedAsset,
  comparison: NormalizedAsset,
  targetTraitType: string,
  targetValue: string,
  impactModel: CategoryImpactModel,
  index: CollectionIndex,
): ComparisonCandidate | null {
  if (!source.image || !comparison.image) return null;
  const sourceSig = buildSignatureExcluding(source, targetTraitType);
  const cmpSig = buildSignatureExcluding(comparison, targetTraitType);
  const { level, differingCategories, matchingCategoryCount } = computeComparisonLevel(sourceSig, cmpSig);
  if (level === null) return null;
  const comparisonValue = attrValue(comparison, targetTraitType);
  if (comparisonValue === targetValue) return null; // must be an ALTERNATIVE value (spec section 4)

  let weightedImpactPenalty = 0;
  let maxSingleCategoryImpact = 0;
  for (const cat of differingCategories) {
    const est = impactModel.estimate(cat, index);
    weightedImpactPenalty += est.impactWeight;
    if (est.impactWeight > maxSingleCategoryImpact) maxSingleCategoryImpact = est.impactWeight;
  }

  return {
    sourceMint: source.mint, comparisonMint: comparison.mint,
    sourceImage: source.image, comparisonImage: comparison.image,
    level, differingCategories, matchingCategoryCount, comparisonValue,
    weightedImpactPenalty: Math.round(weightedImpactPenalty * 1000) / 1000,
    maxSingleCategoryImpact: Math.round(maxSingleCategoryImpact * 1000) / 1000,
  };
}

/** Distinguishes "nothing was found at all" from "candidates were found
 *  but every one of them was rejected for high visual-impact footprint" -
 *  both are zero-accepted-evidence outcomes but mean very different
 *  things for the report (spec section 10/15). */
function zeroEvidenceStopReason(ranked: RankAndFilterResult): SearchStopReason {
  if (ranked.accepted.length > 0) return 'no_more_candidates';
  return ranked.rejected.length > 0 ? 'weighted_quality_threshold' : 'no_more_candidates';
}

function sufficientEvidence(list: ComparisonCandidate[], sourcePoolSize: number, limits: ExtractionPresetLimits): boolean {
  const minPairs = Math.min(3, limits.maxComparisonPairsPerValue);
  if (list.length < minPairs) return false;
  const distinctSources = new Set(list.map((p) => p.sourceMint)).size;
  return distinctSources >= Math.min(2, sourcePoolSize);
}

export interface ExpandSearchInputs {
  targetTraitType: string;
  targetValue: string;
  index: CollectionIndex;
  impactModel: CategoryImpactModel;
  limits: ExtractionPresetLimits;
  preset: ExtractionPreset;
}

export interface ExpandSearchResult {
  candidates: ComparisonCandidate[]; // final selected, ranked, diversity-capped
  diagnostics: ValueSearchDiagnostics;
}

/** Runs the full adaptive metadata-level search for one target value:
 *  diversity-aware source selection, then exact (Level 0) candidates via
 *  the O(1)-per-lookup excluded-signature index, expanding into Level 1/2
 *  via the inverted-index shortlist ONLY if Level 0 evidence is
 *  insufficient and the preset allows it. Every expansion step is time-
 *  and intersection-bounded (TE_MAX_SEARCH_MS_PER_VALUE /
 *  TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE) - never falls back to a
 *  lexical prefix when a limit is hit; it just stops with the limit
 *  recorded as the stop reason. */
export function expandComparisonSearch(inputs: ExpandSearchInputs): ExpandSearchResult {
  const { targetTraitType, targetValue, index, impactModel, limits, preset } = inputs;
  const t0 = Date.now();
  const timeBudgetExceeded = (): boolean => Date.now() - t0 > TE_MAX_SEARCH_MS_PER_VALUE;

  // Search a WIDER diversity-selected source pool than the preset's
  // download cap (see TE_SOURCE_SEARCH_POOL_MULTIPLIER doc comment) - a
  // real many-category collection is sparse enough that a meaningful
  // fraction of any small sample can have zero valid comparison partner
  // anywhere in the collection. Only sources that actually PRODUCE
  // accepted evidence count against `limits.maxSourceAssetsPerValue` in
  // the final output (enforced below, after ranking).
  const sourceSelectionResult = selectDiverseSourceAssets(targetTraitType, targetValue, index, TE_SOURCE_SEARCH_POOL_MAX);
  const sources = sourceSelectionResult.sources;
  const excludedIdx = index.excludedSignatureIndexFor(targetTraitType);

  const seenPairKeys = new Set<string>();
  const allRaw: ComparisonCandidate[] = [];
  let level0Found = 0, level1Found = 0, level2Found = 0;
  let exactBucketSize = 0;
  let intersectionsScanned = 0;
  let hitIntersectionCap = false;

  function addCandidatesFromMints(source: NormalizedAsset, mints: string[], expectedLevel: ComparisonLevel): void {
    for (const cmpMint of mints) {
      const key = `${source.mint}|${cmpMint}`;
      if (seenPairKeys.has(key)) continue;
      seenPairKeys.add(key);
      const cmpAsset = index.assetsByMint.get(cmpMint);
      if (!cmpAsset) continue;
      const built = buildCandidate(source, cmpAsset, targetTraitType, targetValue, impactModel, index);
      if (!built) continue;
      allRaw.push(built);
      if (built.level === 0) level0Found++;
      else if (built.level === 1) level1Found++;
      else level2Found++;
      void expectedLevel;
    }
  }

  if (sources.length === 0) {
    return {
      candidates: [],
      diagnostics: {
        traitType: targetTraitType, traitValue: targetValue, assetsSearchable: index.totalAssets,
        exactBucketSize: 0, level0CandidatesFound: 0, level1CandidatesFound: 0, level2CandidatesFound: 0,
        candidatesRejectedHighImpact: 0, rejectionReasons: {}, sourceSelection: sourceSelectionResult.diagnostics,
        indexBuildTimeMs: index.buildTimeMs, searchTimeMs: Date.now() - t0, pairsAccepted: 0, lowQualityPairsCount: 0,
        levelsExpandedTo: 0, adaptiveStopReason: 'no_more_candidates',
      },
    };
  }

  // Level 0: exact, indexed O(1) lookup per source.
  for (const source of sources) {
    const exact = exactCandidatesFor(excludedIdx, source.mint);
    exactBucketSize += exact.length;
    addCandidatesFromMints(source, exact, 0);
  }

  let ranked = rankAndFilterCandidates(allRaw, preset);
  let levelsExpandedTo: ComparisonLevel = 0;
  let stopReason: SearchStopReason;

  if (sufficientEvidence(ranked.accepted, sources.length, limits)) {
    stopReason = 'exact_evidence_sufficient';
  } else if (timeBudgetExceeded()) {
    stopReason = 'timeout';
  } else if (limits.maxComparisonLevel < 1) {
    stopReason = zeroEvidenceStopReason(ranked);
  } else {
    // Level 1 expansion.
    levelsExpandedTo = 1;
    for (const source of sources) {
      if (timeBudgetExceeded() || hitIntersectionCap) break;
      const sourceEntries = buildSignatureExcluding(source, targetTraitType).entries;
      const shortlist = shortlistNearCandidates(index, sourceEntries, source.mint, { maxRelax: 1, maxCandidates: TE_MAX_NEAR_CANDIDATES_PER_SOURCE });
      intersectionsScanned += shortlist.postingEntriesScanned;
      if (intersectionsScanned > TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE) hitIntersectionCap = true;
      addCandidatesFromMints(source, shortlist.candidates, 1);
    }
    ranked = rankAndFilterCandidates(allRaw, preset);

    if (sufficientEvidence(ranked.accepted, sources.length, limits)) {
      stopReason = 'consensus_stabilized';
    } else if (timeBudgetExceeded()) {
      stopReason = 'timeout';
    } else if (limits.maxComparisonLevel < 2) {
      stopReason = zeroEvidenceStopReason(ranked);
    } else {
      // Level 2 expansion.
      levelsExpandedTo = 2;
      hitIntersectionCap = false;
      for (const source of sources) {
        if (timeBudgetExceeded() || hitIntersectionCap) break;
        const sourceEntries = buildSignatureExcluding(source, targetTraitType).entries;
        const shortlist = shortlistNearCandidates(index, sourceEntries, source.mint, { maxRelax: 2, maxCandidates: TE_MAX_NEAR_CANDIDATES_PER_SOURCE });
        intersectionsScanned += shortlist.postingEntriesScanned;
        if (intersectionsScanned > TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE) hitIntersectionCap = true;
        addCandidatesFromMints(source, shortlist.candidates, 2);
      }
      ranked = rankAndFilterCandidates(allRaw, preset);

      if (sufficientEvidence(ranked.accepted, sources.length, limits)) {
        stopReason = 'consensus_stabilized';
      } else if (timeBudgetExceeded()) {
        stopReason = 'timeout';
      } else if (ranked.accepted.length >= limits.maxComparisonPairsPerValue) {
        stopReason = 'preset_pair_cap';
      } else {
        stopReason = zeroEvidenceStopReason(ranked);
      }
    }
  }

  if (ranked.accepted.length >= limits.maxComparisonPairsPerValue && stopReason !== 'timeout') {
    stopReason = 'preset_pair_cap';
  }

  const rankedFinal = selectFinalPairs(ranked.accepted, limits.maxComparisonPairsPerValue);
  // The SEARCH pool was widened beyond limits.maxSourceAssetsPerValue (see
  // TE_SOURCE_SEARCH_POOL_MULTIPLIER) so a productive source can be found
  // even when many candidates in the pool turn out to be duds - but the
  // preset's source-count intent still applies to the OUTPUT: cap
  // distinct source mints here, in rank order, so the best-ranked pairs'
  // sources win the slots.
  const finalPairs: ComparisonCandidate[] = [];
  const distinctSourcesUsed = new Set<string>();
  for (const p of rankedFinal) {
    if (!distinctSourcesUsed.has(p.sourceMint) && distinctSourcesUsed.size >= limits.maxSourceAssetsPerValue) continue;
    distinctSourcesUsed.add(p.sourceMint);
    finalPairs.push(p);
  }
  const rejectionReasons: Record<string, number> = {};
  for (const r of ranked.rejected) rejectionReasons[r.reason] = (rejectionReasons[r.reason] ?? 0) + 1;
  const lowQualityPairsCount = finalPairs.filter((p) => p.level === 2 || p.weightedImpactPenalty > 0.5).length;

  return {
    candidates: finalPairs,
    diagnostics: {
      traitType: targetTraitType, traitValue: targetValue, assetsSearchable: index.totalAssets,
      exactBucketSize, level0CandidatesFound: level0Found, level1CandidatesFound: level1Found, level2CandidatesFound: level2Found,
      candidatesRejectedHighImpact: ranked.rejected.length, rejectionReasons, sourceSelection: sourceSelectionResult.diagnostics,
      indexBuildTimeMs: index.buildTimeMs, searchTimeMs: Date.now() - t0, pairsAccepted: finalPairs.length, lowQualityPairsCount,
      levelsExpandedTo, adaptiveStopReason: stopReason,
    },
  };
}
