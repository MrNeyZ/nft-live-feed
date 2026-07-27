/**
 * Collection Analyzer - Stage 4 deterministic multi-part bundle planner.
 *
 * Pure, network-free. Produces an INITIAL, deterministic split of the
 * completed scan's asset list into contiguous parts:
 *   1. sort assets by mint address (stable ordering across retries/reruns)
 *   2. divide into contiguous ranges bounded by BOTH max-assets-per-part
 *      AND an estimated-bytes-per-part ceiling (never asset-count-only)
 *
 * This plan is a STARTING POINT for progress display and part numbering.
 * The runtime downloader (bundle-run.ts) can still close a part early and
 * carry remaining assets into the next part if real download bytes exceed
 * the runtime budget faster than the estimate predicted - see its own doc
 * comment for why that's a deliberate, spec-required safety valve rather
 * than a violation of determinism (same collection + same options always
 * plans the same way; only genuine size surprises reshuffle boundaries).
 */
import type { NormalizedAsset } from '../types';

export interface BundlePartRange {
  partNumber: number; // 1-based
  startIndex: number; // inclusive, into the mint-sorted asset array
  endIndex: number;    // exclusive
  assetCount: number;
  firstMint: string;
  lastMint: string;
}

export interface BundlePlan {
  totalAssets: number;
  parts: BundlePartRange[];
}

/** Deterministic mint sort - stable regardless of the order DAS returned
 *  assets in, so replanning the same completed scan always yields the
 *  same part boundaries. */
export function sortAssetsByMint(assets: NormalizedAsset[]): NormalizedAsset[] {
  return [...assets].sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
}

/**
 * Plans contiguous parts over the (already mint-sorted) asset list. A part
 * grows until EITHER the asset-count cap OR the estimated-byte cap would be
 * exceeded by adding one more asset - whichever is more conservative wins,
 * so the planner "must not depend only on asset count" per spec.
 */
export function planBundleParts(
  sortedAssets: NormalizedAsset[],
  maxAssetsPerPart: number,
  maxEstimatedBytesPerPart: number,
  estimatedBytesPerAsset: number,
): BundlePlan {
  const totalAssets = sortedAssets.length;
  if (totalAssets === 0) return { totalAssets: 0, parts: [] };

  const parts: BundlePartRange[] = [];
  let start = 0;
  let partNumber = 1;

  while (start < totalAssets) {
    const maxByEstimate = estimatedBytesPerAsset > 0
      ? Math.max(1, Math.floor(maxEstimatedBytesPerPart / estimatedBytesPerAsset))
      : maxAssetsPerPart;
    const partSize = Math.max(1, Math.min(maxAssetsPerPart, maxByEstimate, totalAssets - start));
    const end = start + partSize;
    parts.push({
      partNumber,
      startIndex: start,
      endIndex: end,
      assetCount: end - start,
      firstMint: sortedAssets[start].mint,
      lastMint: sortedAssets[end - 1].mint,
    });
    start = end;
    partNumber++;
  }

  return { totalAssets, parts };
}
