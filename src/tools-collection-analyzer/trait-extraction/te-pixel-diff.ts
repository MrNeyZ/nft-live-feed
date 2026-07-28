/**
 * Trait Extraction - deterministic raw-RGBA pixel-difference and
 * consensus estimation. No AI, no segmentation model, no external vision
 * API - plain arithmetic over decoded pixel buffers (spec section 8).
 *
 * WHY a single raw diff is not the target layer (spec section 6): the
 * difference between `Eyes=Normal` and `Eyes=Laser` contains BOTH the
 * removed Normal-eye pixels AND the introduced Laser-eye pixels. This
 * module instead looks at MANY (source, comparison) pairs for the same
 * target value and asks two separate questions per pixel:
 *   1. "change frequency" - across every pair, how often does this pixel
 *      actually differ between the source (has target) and its comparison
 *      (doesn't)? A pixel that's part of the BACKGROUND differs in ~0% of
 *      pairs; a pixel that's part of EITHER trait's artwork differs often.
 *   2. "source-pixel consistency" - across every DISTINCT source image
 *      where this pixel was flagged changed, is the color at this pixel
 *      stable (low variance)? Genuine target-trait artwork looks the same
 *      (mod anti-aliasing) across every render that carries it; pixels
 *      that only "changed" because of what a specific comparison's
 *      alternative value looked like are NOT stable across sources paired
 *      against DIFFERENT alternative values.
 * A pixel earns a place in the conservative `candidate` set only when BOTH
 * signals agree; the `expanded` set relaxes the consistency bar; the
 * `change` mask is just raw change-frequency > 0 (the full affected
 * region, including alternative-value pixels - diagnostic, not the asset).
 */
import type { DecodedImage } from './te-image-io';
import type { PixelBoundingBox } from './te-types';

export type BinaryMask = Uint8Array; // 0|1 per pixel, length = width*height

export function computeDiffMask(a: DecodedImage, b: DecodedImage, threshold: number): BinaryMask | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = a.data[o] - b.data[o];
    const dg = a.data[o + 1] - b.data[o + 1];
    const db = a.data[o + 2] - b.data[o + 2];
    const da = a.data[o + 3] - b.data[o + 3];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db + da * da);
    if (dist > threshold) mask[i] = 1;
  }
  return mask;
}

/** 4-connected flood-fill component labeling; drops components smaller
 *  than `minSize`. Deterministic (scans in row-major order). */
export function removeSmallComponents(mask: BinaryMask, width: number, height: number, minSize: number): BinaryMask {
  const n = width * height;
  const visited = new Uint8Array(n);
  const out = new Uint8Array(n);
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (mask[start] === 0 || visited[start]) continue;
    const component: number[] = [];
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      component.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const nb of neighbors) {
        if (nb >= 0 && mask[nb] === 1 && !visited[nb]) { visited[nb] = 1; stack.push(nb); }
      }
    }
    if (component.length >= minSize) {
      for (const idx of component) out[idx] = 1;
    }
  }
  return out;
}

function morphErode(mask: BinaryMask, width: number, height: number): BinaryMask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;
      const ok = (x === 0 || mask[idx - 1]) && (x === width - 1 || mask[idx + 1])
        && (y === 0 || mask[idx - width]) && (y === height - 1 || mask[idx + width]);
      out[idx] = ok ? 1 : 0;
    }
  }
  return out;
}
function morphDilate(mask: BinaryMask, width: number, height: number): BinaryMask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 1) { out[idx] = 1; continue; }
      const hit = (x > 0 && mask[idx - 1]) || (x < width - 1 && mask[idx + 1])
        || (y > 0 && mask[idx - width]) || (y < height - 1 && mask[idx + width]);
      out[idx] = hit ? 1 : 0;
    }
  }
  return out;
}

/** Cleans one pair's raw diff mask: drop tiny/isolated components, then a
 *  light morphological open (erode -> dilate) to smooth jagged edges from
 *  anti-aliasing/compression noise (spec section 8, steps 7-8). */
export function cleanPairMask(rawMask: BinaryMask, width: number, height: number, minComponentSize: number): BinaryMask {
  const deNoised = removeSmallComponents(rawMask, width, height, minComponentSize);
  return morphDilate(morphErode(deNoised, width, height), width, height);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface CleanedPair {
  sourceMint: string;
  comparisonMint: string;
  comparisonValue: string | null;
  sourceImage: DecodedImage;
  diffMask: BinaryMask; // cleaned
}

export interface ConsensusResult {
  width: number;
  height: number;
  changeFrequency: Float32Array; // 0..1, fraction of pairs where pixel differed
  /** Binary view of changeFrequency > 0 - the full diagnostic "all regions
   *  affected" region for change-mask.png (spec section 6/8). */
  changeMask: BinaryMask;
  candidateMask: BinaryMask;
  expandedMask: BinaryMask;
  uncertaintyMask: BinaryMask;
  /** RGBA color estimate (median across distinct sources with evidence at
   *  that pixel) - alpha is 255 wherever ANY evidence exists, 0 elsewhere.
   *  PNG builders combine this with candidateMask/expandedMask to decide
   *  final per-pixel alpha (transparent outside the chosen mask). */
  estimatedColor: Buffer;
  changedPixelCount: number;
  changedPixelPercent: number;
  candidatePixelCount: number;
  expandedCandidatePixelCount: number;
  uncertaintyPixelCount: number;
  uncertaintyPixelPercent: number;
  consensusAgreementMean: number;
  sourcePixelConsistencyMean: number;
  candidateBoundingBox: PixelBoundingBox | null;
}

/** Consistency thresholds - fixed constants (not env-tunable; they define
 *  the algorithm's semantics, not a deployment safety limit). */
const CONSISTENCY_HIGH = 0.7;
const CONSISTENCY_LOW = 0.35;
/** Normalizes mean-absolute-channel-deviation (0-255 scale) into a 0..1
 *  consistency score; deviation >= this value maps to 0 consistency. */
const CONSISTENCY_DEVIATION_SCALE = 128;

export function estimateTargetCandidate(pairs: CleanedPair[], consensusAgreementThreshold: number): ConsensusResult {
  const width = pairs[0].sourceImage.width;
  const height = pairs[0].sourceImage.height;
  const n = width * height;

  const changeFrequency = new Float32Array(n);
  for (const pair of pairs) {
    for (let i = 0; i < n; i++) if (pair.diffMask[i]) changeFrequency[i]++;
  }
  for (let i = 0; i < n; i++) changeFrequency[i] /= pairs.length;

  // Union, per DISTINCT source mint, of every pair-mask that used it -
  // "pixel i changed in at least one of this source's comparisons".
  const distinctSources = new Map<string, DecodedImage>();
  const sourceUnionMask = new Map<string, BinaryMask>();
  for (const pair of pairs) {
    if (!distinctSources.has(pair.sourceMint)) distinctSources.set(pair.sourceMint, pair.sourceImage);
    let u = sourceUnionMask.get(pair.sourceMint);
    if (!u) { u = new Uint8Array(n); sourceUnionMask.set(pair.sourceMint, u); }
    for (let i = 0; i < n; i++) if (pair.diffMask[i]) u[i] = 1;
  }
  const sourceEntries = [...distinctSources.entries()];
  const minSourcesForEvidence = Math.min(2, sourceEntries.length);

  const estimatedColor = Buffer.alloc(n * 4);
  const consistency = new Float32Array(n);
  const sampleCounts = new Int16Array(n);

  for (let i = 0; i < n; i++) {
    const rs: number[] = []; const gs: number[] = []; const bs: number[] = []; const as: number[] = [];
    for (const [mint, img] of sourceEntries) {
      if (sourceUnionMask.get(mint)![i]) {
        const o = i * 4;
        rs.push(img.data[o]); gs.push(img.data[o + 1]); bs.push(img.data[o + 2]); as.push(img.data[o + 3]);
      }
    }
    sampleCounts[i] = rs.length;
    if (rs.length === 0) continue;
    const mr = median(rs), mg = median(gs), mb = median(bs), ma = median(as);
    let devSum = 0;
    for (let k = 0; k < rs.length; k++) devSum += (Math.abs(rs[k] - mr) + Math.abs(gs[k] - mg) + Math.abs(bs[k] - mb) + Math.abs(as[k] - ma)) / 4;
    consistency[i] = rs.length === 1 ? 1 : Math.max(0, 1 - (devSum / rs.length) / CONSISTENCY_DEVIATION_SCALE);
    const o = i * 4;
    estimatedColor[o] = mr; estimatedColor[o + 1] = mg; estimatedColor[o + 2] = mb; estimatedColor[o + 3] = 255;
  }

  const candidateMask = new Uint8Array(n);
  const expandedMask = new Uint8Array(n);
  const uncertaintyMask = new Uint8Array(n);
  let changedCount = 0, candidateCount = 0, expandedCount = 0, uncertaintyCount = 0;
  let consistencySum = 0, consistencySamples = 0;
  let agreementSum = 0, agreementSamples = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let i = 0; i < n; i++) {
    const cf = changeFrequency[i];
    if (cf > 0) changedCount++;
    const hasEvidence = sampleCounts[i] >= Math.max(1, minSourcesForEvidence);

    if (hasEvidence && cf >= consensusAgreementThreshold && consistency[i] >= CONSISTENCY_HIGH) {
      candidateMask[i] = 1; candidateCount++;
      const x = i % width, y = (i - x) / width;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (hasEvidence && cf > 0 && consistency[i] >= CONSISTENCY_LOW) {
      expandedMask[i] = 1; expandedCount++;
    }
    const contradictory = cf > 0 && cf < consensusAgreementThreshold;
    const unstableButIncluded = expandedMask[i] === 1 && consistency[i] < CONSISTENCY_HIGH;
    if (contradictory || unstableButIncluded) { uncertaintyMask[i] = 1; uncertaintyCount++; }

    if (hasEvidence) { consistencySum += consistency[i]; consistencySamples++; }
    if (sampleCounts[i] > 0 || cf > 0) { agreementSum += Math.abs(cf * 2 - 1); agreementSamples++; }
  }

  const changeMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (changeFrequency[i] > 0) changeMask[i] = 1;

  return {
    width, height, changeFrequency, changeMask, candidateMask, expandedMask, uncertaintyMask, estimatedColor,
    changedPixelCount: changedCount,
    changedPixelPercent: n > 0 ? Math.round((changedCount / n) * 10000) / 100 : 0,
    candidatePixelCount: candidateCount,
    expandedCandidatePixelCount: expandedCount,
    uncertaintyPixelCount: uncertaintyCount,
    uncertaintyPixelPercent: n > 0 ? Math.round((uncertaintyCount / n) * 10000) / 100 : 0,
    consensusAgreementMean: agreementSamples > 0 ? Math.round((agreementSum / agreementSamples) * 100) / 100 : 0,
    sourcePixelConsistencyMean: consistencySamples > 0 ? Math.round((consistencySum / consistencySamples) * 100) / 100 : 0,
    candidateBoundingBox: maxX >= minX ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}
