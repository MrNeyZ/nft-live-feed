/**
 * Trait Extraction (Stage 5.1) - collection-local category visual-impact
 * weights (spec section 5).
 *
 * The pre-5.1 algorithm treated every non-target metadata mismatch as
 * equally bad (a raw mismatch COUNT). The Retardio Cousins pilot showed
 * this is wrong: a Background or Shirt mismatch usually replaces most of
 * the canvas, while an adjacent small accessory mismatch barely touches
 * it. This module learns, per category, how much visual footprint
 * changing that category typically produces - purely from evidence this
 * job itself already gathered, never from hardcoded category names.
 *
 * Primary signal: when a Level 0 pair is processed for target category C
 * (by construction, ONLY C differs between source and comparison), that
 * pair's cleaned diff-mask changed-area% is direct ground truth for C's
 * visual footprint. Samples accumulate across every value/category this
 * job touches (a Background value processed earlier informs the impact
 * weight used when Background shows up as a non-target mismatch while
 * later processing an Eyebrows value).
 *
 * Fallback (no direct evidence yet for a category): a metadata-frequency
 * heuristic - categories present on nearly every asset with few distinct
 * values look structural (body/background-like, likely large footprint);
 * categories with many distinct values look like small variant
 * accessories (likely small footprint). Always LOW confidence, clearly
 * labeled, never treated as measured fact. With no evidence at all,
 * neutral weight 1.0.
 */
import type { CollectionIndex } from './te-index';
import type { CategoryImpactEstimate, ImpactConfidence, ImpactSource } from './te-types';

export type { CategoryImpactEstimate, ImpactConfidence, ImpactSource };

export const IMPACT_WEIGHT_MIN = 0.15;
export const IMPACT_WEIGHT_MAX = 3.0;
const IMPACT_LOG_BASE = 0.2;
const IMPACT_LOG_SCALE = 0.9;
/** Below this many direct samples, a category's estimate is "estimated"
 *  (weakly measured) rather than fully "measured". */
const MEASURED_SAMPLE_THRESHOLD = 3;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Maps a robust central changed-area% estimate to a bounded weight via a
 *  log curve - compresses the huge raw range (0.1% localized accessory to
 *  100% full background) into a comparable multiplier, without ever being
 *  presented as an exact physical measurement. */
export function weightFromMedianPercent(medianPercent: number): number {
  const raw = IMPACT_LOG_BASE + Math.log10(1 + Math.max(0, medianPercent)) * IMPACT_LOG_SCALE;
  return Math.max(IMPACT_WEIGHT_MIN, Math.min(IMPACT_WEIGHT_MAX, raw));
}

function metadataFrequencyFallbackWeight(traitType: string, index: CollectionIndex): { weight: number; confidence: ImpactConfidence; source: ImpactSource } {
  const total = index.totalAssets;
  if (total === 0) return { weight: 1.0, confidence: 'neutral', source: 'neutral_default' };
  const presentCount = index.categoryPresentCount.get(traitType) ?? 0;
  const distinctValues = index.categoryDistinctValueCount.get(traitType) ?? 0;
  const presencePercent = presentCount / total;
  if (distinctValues === 0) return { weight: 1.0, confidence: 'neutral', source: 'neutral_default' };

  // Present on nearly every asset with few distinct values -> likely a
  // structural, full/large-canvas layer (background/body-like).
  if (presencePercent >= 0.9 && distinctValues <= 6) {
    return { weight: 1.6, confidence: 'estimated', source: 'metadata_frequency_fallback' };
  }
  if (presencePercent >= 0.9 && distinctValues <= 12) {
    return { weight: 1.2, confidence: 'estimated', source: 'metadata_frequency_fallback' };
  }
  // Many distinct values -> likely a small variant accessory category.
  if (distinctValues > 20) {
    return { weight: 0.7, confidence: 'estimated', source: 'metadata_frequency_fallback' };
  }
  return { weight: 1.0, confidence: 'neutral', source: 'neutral_default' };
}

export class CategoryImpactModel {
  private samples = new Map<string, number[]>();

  /** Record one Level-0 pair's cleaned changed-area% as direct visual
   *  footprint evidence for `traitType`. */
  recordObservation(traitType: string, changedAreaPercent: number): void {
    if (!Number.isFinite(changedAreaPercent) || changedAreaPercent < 0) return;
    let arr = this.samples.get(traitType);
    if (!arr) { arr = []; this.samples.set(traitType, arr); }
    arr.push(changedAreaPercent);
  }

  sampleCountFor(traitType: string): number {
    return this.samples.get(traitType)?.length ?? 0;
  }

  estimate(traitType: string, index: CollectionIndex): CategoryImpactEstimate {
    const raw = this.samples.get(traitType);
    if (raw && raw.length > 0) {
      const sorted = [...raw].sort((a, b) => a - b);
      const median = percentile(sorted, 0.5);
      const p25 = percentile(sorted, 0.25);
      const p75 = percentile(sorted, 0.75);
      return {
        traitType,
        sampleCount: sorted.length,
        medianChangedAreaPercent: Math.round(median * 100) / 100,
        p25ChangedAreaPercent: Math.round(p25 * 100) / 100,
        p75ChangedAreaPercent: Math.round(p75 * 100) / 100,
        impactWeight: Math.round(weightFromMedianPercent(median) * 1000) / 1000,
        confidence: sorted.length >= MEASURED_SAMPLE_THRESHOLD ? 'measured' : 'estimated',
        source: 'level0_pixel_evidence',
      };
    }
    const fallback = metadataFrequencyFallbackWeight(traitType, index);
    return {
      traitType,
      sampleCount: 0,
      medianChangedAreaPercent: null,
      p25ChangedAreaPercent: null,
      p75ChangedAreaPercent: null,
      impactWeight: Math.round(fallback.weight * 1000) / 1000,
      confidence: fallback.confidence,
      source: fallback.source,
    };
  }
}
