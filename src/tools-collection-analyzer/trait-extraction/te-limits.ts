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
