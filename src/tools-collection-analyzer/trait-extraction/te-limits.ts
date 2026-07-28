/**
 * Trait Extraction - safety limits + preset definitions.
 *
 * Server-side, env-overridable, never trusts client input for anything
 * that bounds RPC/download/CPU/memory spend. Mirrors bundle-limits.ts.
 */
import type { ExtractionPreset, ExtractionPresetLimits } from './te-types';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envFloat(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const TE_MAX_CONCURRENT_JOBS = envInt('TE_MAX_CONCURRENT_JOBS', 2);
export const TE_MAX_CONCURRENT_DOWNLOADS = envInt('TE_MAX_CONCURRENT_DOWNLOADS', 6);
export const TE_MAX_CONCURRENT_PROCESSING = envInt('TE_MAX_CONCURRENT_PROCESSING', 3);

export const TE_MAX_SELECTED_CATEGORIES = envInt('TE_MAX_SELECTED_CATEGORIES', 5);
export const TE_MAX_SELECTED_VALUES = envInt('TE_MAX_SELECTED_VALUES', 40);

export const TE_MAX_IMAGE_WIDTH = envInt('TE_MAX_IMAGE_WIDTH', 4096);
export const TE_MAX_IMAGE_HEIGHT = envInt('TE_MAX_IMAGE_HEIGHT', 4096);
export const TE_MAX_IMAGE_PIXELS = envInt('TE_MAX_IMAGE_PIXELS', 8_000_000); // ~2828x2828
export const TE_MAX_DECODED_BYTES_PER_IMAGE = envInt('TE_MAX_DECODED_BYTES_PER_IMAGE', TE_MAX_IMAGE_PIXELS * 4);
export const TE_MAX_TOTAL_DECODED_BYTES = envInt('TE_MAX_TOTAL_DECODED_BYTES', 1.5 * 1024 * 1024 * 1024);

export const TE_MAX_IMAGE_BYTES = envInt('TE_MAX_IMAGE_BYTES', 8 * 1024 * 1024);
export const TE_MAX_TOTAL_DOWNLOAD_BYTES = envInt('TE_MAX_TOTAL_DOWNLOAD_BYTES', 500 * 1024 * 1024);
export const TE_MAX_UNIQUE_IMAGE_DOWNLOADS = envInt('TE_MAX_UNIQUE_IMAGE_DOWNLOADS', 800);

export const TE_MAX_TEMP_DISK_BYTES = envInt('TE_MAX_TEMP_DISK_BYTES', 2 * 1024 * 1024 * 1024);
export const TE_MIN_FREE_DISK_BYTES = envInt('TE_MIN_FREE_DISK_BYTES', 500 * 1024 * 1024);

export const TE_PER_RESOURCE_TIMEOUT_MS = envInt('TE_PER_RESOURCE_TIMEOUT_MS', 20_000);
export const TE_MAX_REDIRECTS = envInt('TE_MAX_REDIRECTS', 3);
export const TE_MAX_RETRIES = envInt('TE_MAX_RETRIES', 3);
export const TE_RETRY_BASE_MS = envInt('TE_RETRY_BASE_MS', 500);
export const TE_RETRY_MAX_WAIT_MS = envInt('TE_RETRY_MAX_WAIT_MS', 8_000);

export const TE_JOB_TIMEOUT_MS = envInt('TE_JOB_TIMEOUT_MS', 20 * 60_000);
export const TE_STATE_TTL_MS = envInt('TE_STATE_TTL_MS', 30 * 60_000);
export const TE_TEMP_DIR_MAX_AGE_MS = envInt('TE_TEMP_DIR_MAX_AGE_MS', 2 * 60 * 60_000);

/** Diff-detection sensitivity - Euclidean RGBA distance above which two
 *  pixels are considered "different." 0-510 range (max possible distance
 *  for 4x8-bit channels is sqrt(4*255^2) ~= 510). */
export const TE_PIXEL_DIFF_THRESHOLD = envFloat('TE_PIXEL_DIFF_THRESHOLD', 24);
/** Connected components smaller than this many pixels are treated as
 *  noise and dropped from a pair's difference mask before it contributes
 *  to consensus. */
export const TE_MIN_COMPONENT_SIZE = envInt('TE_MIN_COMPONENT_SIZE', 6);

export const PRESET_LIMITS: Record<ExtractionPreset, ExtractionPresetLimits> = {
  fast: {
    maxSourceAssetsPerValue: envInt('TE_FAST_MAX_SOURCE_ASSETS', 3),
    maxComparisonPairsPerValue: envInt('TE_FAST_MAX_COMPARISON_PAIRS', 3),
    maxComparisonLevel: 1,
    consensusAgreementThreshold: envFloat('TE_FAST_CONSENSUS_THRESHOLD', 0.6),
  },
  balanced: {
    maxSourceAssetsPerValue: envInt('TE_BALANCED_MAX_SOURCE_ASSETS', 8),
    maxComparisonPairsPerValue: envInt('TE_BALANCED_MAX_COMPARISON_PAIRS', 10),
    maxComparisonLevel: 2,
    consensusAgreementThreshold: envFloat('TE_BALANCED_CONSENSUS_THRESHOLD', 0.7),
  },
  thorough: {
    maxSourceAssetsPerValue: envInt('TE_THOROUGH_MAX_SOURCE_ASSETS', 16),
    maxComparisonPairsPerValue: envInt('TE_THOROUGH_MAX_COMPARISON_PAIRS', 24),
    maxComparisonLevel: 2,
    consensusAgreementThreshold: envFloat('TE_THOROUGH_CONSENSUS_THRESHOLD', 0.8),
  },
};

export function presetLimitsFor(preset: ExtractionPreset): ExtractionPresetLimits {
  return PRESET_LIMITS[preset];
}

// ── Stage 5.1: full-collection search safety limits ────────────────────
// Replace the old COMPARISON_POOL_CAP (lexical-first-2000 cap, removed) -
// the whole completed scan (up to SCAN_MAX_ASSETS, see scan-limits.ts) is
// searchable, but every stage of that search is still explicitly bounded
// so CPU/memory/time spend is safe on the largest collections this tool
// accepts.

/** Total category/value posting-list entries a single source asset's
 *  near-match shortlist search (Level 1/2) may visit before it stops
 *  widening and works with whatever it already has. */
export const TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE = envInt('TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE', 2_000_000);
/** Near-match shortlist size cap per source asset, ranked-then-truncated
 *  (never a lexical prefix). */
export const TE_MAX_NEAR_CANDIDATES_PER_SOURCE = envInt('TE_MAX_NEAR_CANDIDATES_PER_SOURCE', 500);
/** A real many-category collection (e.g. 14 largely independent
 *  categories) is combinatorially sparse - MOST diversity-selected source
 *  assets can have NO valid comparison partner anywhere in the collection
 *  at all (confirmed on Retardio Cousins: only 78/548, ~14%, of
 *  Eyebrows=Clown source candidates had ANY level<=2 match among 4441
 *  assets - and every one of those was Level 2, none Level 0/1). Picking
 *  only `maxSourceAssetsPerValue` sources blind to productivity risks
 *  finding nothing at all. The METADATA-LEVEL search (cheap, no network -
 *  an indexed O(1) lookup per source for Level 0, a bounded posting-list
 *  walk for Level 1/2) therefore considers EVERY target-bearing asset as
 *  a candidate source, up to a generous safety ceiling; only the sources
 *  that actually produce accepted evidence ever reach
 *  `limits.maxSourceAssetsPerValue` in the final result (te-ranking.ts
 *  enforces that cap on the OUTPUT, not the search). This never widens
 *  the expensive part (image downloads/pixel diffing) - only in-memory
 *  candidate discovery, which is separately time/intersection-bounded
 *  (TE_MAX_SEARCH_MS_PER_VALUE / TE_MAX_CANDIDATE_INTERSECTIONS_PER_VALUE). */
export const TE_SOURCE_SEARCH_POOL_MAX = envInt('TE_SOURCE_SEARCH_POOL_MAX', 2_000);
/** Wall-clock budget for one target value's ENTIRE candidate search
 *  (exact + Level 1 + Level 2, across every source asset). */
export const TE_MAX_SEARCH_MS_PER_VALUE = envInt('TE_MAX_SEARCH_MS_PER_VALUE', 4_000);
/** Wall-clock budget for candidate search summed across every value in
 *  the job - independent of TE_JOB_TIMEOUT_MS (which also covers
 *  download/pixel-diff time). */
export const TE_MAX_SEARCH_MS_PER_JOB = envInt('TE_MAX_SEARCH_MS_PER_JOB', 60_000);
/** Hard ceiling on low-quality (Level 2 / high-impact-but-not-rejected)
 *  pairs contributing to one value's evidence, independent of the
 *  preset's overall maxComparisonPairsPerValue. */
export const TE_MAX_LOW_QUALITY_PAIRS_PER_VALUE = envInt('TE_MAX_LOW_QUALITY_PAIRS_PER_VALUE', 6);

export interface RejectionThresholds {
  /** Reject a candidate pair outright when the SUM of its differing
   *  non-target categories' impact weights exceeds this. */
  maxWeightedImpactPenalty: number;
  /** Reject outright when any SINGLE differing category's impact weight
   *  exceeds this (e.g. a lone Background mismatch). */
  maxSingleCategoryImpact: number;
}

/** Preset-specific large-footprint rejection thresholds (spec section 7).
 *  Fast is strict (near-exact pairs only); Thorough tolerates broader,
 *  explicitly weaker evidence rather than hard-rejecting it - weight
 *  (te-impact.ts / te-ranking.ts pair-evidence-weight), not raw
 *  acceptance, is what keeps it from dominating consensus. */
export const REJECTION_THRESHOLDS: Record<ExtractionPreset, RejectionThresholds> = {
  fast: { maxWeightedImpactPenalty: envFloat('TE_FAST_MAX_IMPACT_PENALTY', 1.0), maxSingleCategoryImpact: envFloat('TE_FAST_MAX_SINGLE_IMPACT', 1.3) },
  balanced: { maxWeightedImpactPenalty: envFloat('TE_BALANCED_MAX_IMPACT_PENALTY', 2.4), maxSingleCategoryImpact: envFloat('TE_BALANCED_MAX_SINGLE_IMPACT', 2.2) },
  thorough: { maxWeightedImpactPenalty: envFloat('TE_THOROUGH_MAX_IMPACT_PENALTY', 4.5), maxSingleCategoryImpact: envFloat('TE_THOROUGH_MAX_SINGLE_IMPACT', 2.8) },
};

export function rejectionThresholdsFor(preset: ExtractionPreset): RejectionThresholds {
  return REJECTION_THRESHOLDS[preset];
}
