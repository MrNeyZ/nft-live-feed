/**
 * Trait Extraction (Stage 5.1) - comparison-pair selection entry point.
 *
 * Pre-5.1 this file did everything itself: lexical-first source sampling,
 * a hard `COMPARISON_POOL_CAP = 2000` comparison pool, and raw-mismatch-
 * count ranking. The Retardio Cousins Eyebrows pilot showed all three
 * were wrong for a large, many-category collection - see the Stage 5.1
 * spec. The algorithm now lives across three focused modules:
 *   - te-index.ts      full-collection metadata indexes + exact/near
 *                       candidate lookup (also still hosts the exact
 *                       `computeComparisonLevel`/`buildSignatureExcluding`
 *                       primitives, unchanged from Stage 5).
 *   - te-diversity.ts   diversity-aware source-asset selection.
 *   - te-impact.ts      collection-local category visual-impact weights.
 *   - te-ranking.ts     weighted ranking, large-footprint rejection, the
 *                       adaptive exact -> Level 1 -> Level 2 search.
 * This file just wires them together and is what te-run.ts calls.
 *
 * Pure, network-free. Only ever reads attributes already present in the
 * completed scan's NormalizedAsset list.
 */
import { buildCollectionIndex } from './te-index';
import type { CollectionIndex } from './te-index';
import { CategoryImpactModel } from './te-impact';
import { expandComparisonSearch } from './te-ranking';
import type { ComparisonCandidate, ExtractionPreset, ExtractionPresetLimits, ValueSearchDiagnostics } from './te-types';
import type { NormalizedAsset } from './asset-types';

export {
  buildSignatureExcluding, computeComparisonLevel,
  type AssetSignature, type ComparisonLevelResult,
} from './te-index';
export { CategoryImpactModel } from './te-impact';
export { buildCollectionIndex, type CollectionIndex } from './te-index';

export interface SelectComparisonCandidatesResult {
  candidates: ComparisonCandidate[];
  diagnostics: ValueSearchDiagnostics;
}

/** One-shot convenience wrapper (builds a throwaway index) - used by
 *  tests and any one-off caller that doesn't already have a job-scoped
 *  CollectionIndex/CategoryImpactModel handy. te-run.ts calls
 *  `expandComparisonSearch` directly with its own job-scoped index/model
 *  so the index is built exactly once per job, not once per value. */
export function selectComparisonCandidates(
  targetTraitType: string,
  targetValue: string,
  allAssets: NormalizedAsset[],
  limits: ExtractionPresetLimits,
  preset: ExtractionPreset = 'balanced',
  index?: CollectionIndex,
  impactModel?: CategoryImpactModel,
): SelectComparisonCandidatesResult {
  const result = expandComparisonSearch({
    targetTraitType,
    targetValue,
    index: index ?? buildCollectionIndex(allAssets),
    impactModel: impactModel ?? new CategoryImpactModel(),
    limits,
    preset,
  });
  return { candidates: result.candidates, diagnostics: result.diagnostics };
}
