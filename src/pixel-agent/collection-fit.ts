/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 8 (Collection DNA Lock /
 * Fit Check). Pure deterministic image-processing (sharp + arithmetic
 * only) — no Anthropic call, no OpenAI call, no ML/clustering/generation
 * of any kind. Computes simple geometry/style metrics from a normalized
 * 48×48 PNG and, given a CollectionFitProfile built from a reference
 * variant, scores how well a candidate matches it. Advisory only — this
 * module never rejects or blocks anything; see
 * src/server/tools-pixel-forge-collection-fit.ts for the two routes that
 * wrap it, neither of which mutates a TraitAsset.
 *
 * Reuses raster-convert.ts's existing RgbaImage/loadRawRgba/
 * deriveSourcePalette/colorDistance/hexToRgb rather than duplicating them
 * — those are pure helpers, not part of Normalize/Repair/Split/Import's
 * own pipeline logic, so importing them does not touch that logic.
 * Connected-components labeling IS duplicated here (a small, local
 * darkMask-only labeler) rather than imported from raster-split.ts,
 * matching this codebase's own established convention of each raster-*
 * file standing alone (see raster-split.ts's own comment on why its
 * `labelMask` isn't shared either).
 *
 * MVP SCOPE NOTE: `CollectionFitProfile` only carries enough fields to
 * check bbox drift, subject-center drift, foreground-coverage range,
 * palette distance, and dark-outline-ratio range — the fields the task
 * spec enumerated for this stage. `CollectionFitMetrics` additionally
 * computes headBBox/eyeLineY/mouthLineY/bodyBBox as informational
 * geometry (useful for a human eyeballing the result, and a foundation
 * for a future stage), but there is no corresponding target field on the
 * profile to compare them against yet, so they are NOT part of the pass/
 * fail scoring below.
 */

import sharp from 'sharp';
import { RgbaImage, loadRawRgba, deriveSourcePalette, hexToRgb, colorDistance } from './raster-convert';

export interface BBox { x: number; y: number; w: number; h: number; }
export interface Point { x: number; y: number; }

export interface CollectionFitMetrics {
  canvasSize: number;
  foregroundBBox: BBox | null;
  foregroundCoveragePct: number;
  transparentRatio: number;
  canvasCenter: Point;
  subjectCenter: Point | null;
  /** MVP heuristic: tightest bbox of foreground pixels within the top
   *  HEAD_REGION_FRACTION of the foreground bbox's own height. Not a real
   *  head segmentation. */
  headBBox: BBox | null;
  eyeLineY: number | null;
  eyeLineConfidence: 'high' | 'low';
  mouthLineY: number | null;
  mouthLineConfidence: 'high' | 'low';
  /** Foreground pixels at/below the head-region cutoff. */
  bodyBBox: BBox | null;
  dominantPalette: string[];
  /** Dark (luminance < DARK_LUMINANCE_THRESHOLD) foreground pixels ÷ all
   *  foreground pixels — a proxy for outline thickness, not a true
   *  outline-tracing measurement. */
  darkOutlineRatio: number;
  warnings: string[];
}

const FOREGROUND_ALPHA_THRESHOLD = 128; // matches raster-convert.ts's own opaque-pixel convention
const DARK_LUMINANCE_THRESHOLD = 70; // matches raster-split.ts's own "dark" threshold
const HEAD_REGION_FRACTION = 0.55; // MVP heuristic: top 55% of the foreground bbox height is "head"
const EYE_MOUTH_MAX_COMPONENT_AREA_FRACTION = 0.10; // vs head bbox area — excludes big outline strokes
const EYE_MOUTH_MAX_DIMENSION_FRACTION = 0.30; // vs head bbox width/height — excludes wide outline runs
const EYE_ZONE_MAX_HEIGHT_FRACTION = 0.70; // eye candidates must sit in the upper 70% of the head bbox
const EYE_PAIR_MAX_Y_DIFF_FRACTION = 0.15; // vs head bbox height — how "level" a candidate pair must be
const EYE_LINE_FALLBACK_FRACTION = 0.55; // within head bbox height, used when no confident pair is found
const MOUTH_LINE_FALLBACK_FRACTION = 0.85;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

interface DarkComponent { size: number; minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number; }

/** 4-connectivity connected-components labeling over a binary mask,
 *  deterministic fixed scan/neighbor order — same shape as raster-
 *  convert.ts's and raster-split.ts's own (each duplicated locally rather
 *  than shared; see this file's header comment). */
function labelDarkComponents(mask: Uint8Array, width: number, height: number): DarkComponent[] {
  const labels = new Int32Array(width * height).fill(-1);
  const comps: DarkComponent[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const label = comps.length;
    let size = 0, sumX = 0, sumY = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      size++;
      const x = idx % width, y = Math.floor(idx / width);
      sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] === 1 && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] === 1 && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] === 1 && labels[idx - width] === -1) { labels[idx - width] = label; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] === 1 && labels[idx + width] === -1) { labels[idx + width] = label; stack.push(idx + width); }
    }
    comps.push({ size, minX, minY, maxX, maxY, cx: sumX / size, cy: sumY / size });
  }
  return comps;
}

/** Tightest bbox of foreground (alpha >= threshold) pixels within
 *  [x0,x0+w0) x [y0,y0+h0) of `img`. Returns null if none found. */
function tightForegroundBBox(img: RgbaImage, x0: number, y0: number, w0: number, h0: number): BBox | null {
  const { width, data } = img;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
  const yEnd = Math.min(y0 + h0, img.height);
  const xEnd = Math.min(x0 + w0, width);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      const off = (y * width + x) * 4;
      if (data[off + 3] < FOREGROUND_ALPHA_THRESHOLD) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return found ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
}

export async function computeCollectionFitMetrics(pngBuffer: Buffer): Promise<CollectionFitMetrics> {
  const img = await loadRawRgba(sharp(pngBuffer).ensureAlpha());
  const { width, height, data } = img;
  const canvasCenter: Point = { x: width / 2, y: height / 2 };
  const warnings: string[] = [];

  let fgCount = 0, darkCount = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      if (data[off + 3] < FOREGROUND_ALPHA_THRESHOLD) continue;
      fgCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (luminance(data[off], data[off + 1], data[off + 2]) < DARK_LUMINANCE_THRESHOLD) darkCount++;
    }
  }

  const foregroundBBox: BBox | null = fgCount > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  const foregroundCoveragePct = (fgCount / (width * height)) * 100;
  const transparentRatio = 1 - fgCount / (width * height);
  const subjectCenter: Point | null = foregroundBBox
    ? { x: foregroundBBox.x + foregroundBBox.w / 2, y: foregroundBBox.y + foregroundBBox.h / 2 }
    : null;
  const darkOutlineRatio = fgCount > 0 ? darkCount / fgCount : 0;
  if (fgCount === 0) warnings.push('No foreground pixels detected (fully transparent image) — all geometry metrics are null.');

  let headBBox: BBox | null = null;
  let bodyBBox: BBox | null = null;
  let eyeLineY: number | null = null;
  let eyeLineConfidence: 'high' | 'low' = 'low';
  let mouthLineY: number | null = null;
  let mouthLineConfidence: 'high' | 'low' = 'low';

  if (foregroundBBox) {
    const headRowLimit = foregroundBBox.y + Math.max(1, Math.round(foregroundBBox.h * HEAD_REGION_FRACTION));
    headBBox = tightForegroundBBox(img, foregroundBBox.x, foregroundBBox.y, foregroundBBox.w, headRowLimit - foregroundBBox.y);
    if (!headBBox) warnings.push('Head-region heuristic found no pixels in the top fraction of the foreground bbox — headBBox is null.');

    const bodyRowStart = headRowLimit;
    const bodyRowEnd = foregroundBBox.y + foregroundBBox.h;
    bodyBBox = bodyRowEnd > bodyRowStart
      ? tightForegroundBBox(img, foregroundBBox.x, bodyRowStart, foregroundBBox.w, bodyRowEnd - bodyRowStart)
      : null;
    if (!bodyBBox) warnings.push('No foreground pixels below the head-region heuristic — this portrait may be head-only; bodyBBox is null.');

    if (headBBox) {
      const hb = headBBox;
      const darkMask = new Uint8Array(hb.w * hb.h);
      for (let y = 0; y < hb.h; y++) {
        for (let x = 0; x < hb.w; x++) {
          const gx = hb.x + x, gy = hb.y + y;
          const off = (gy * width + gx) * 4;
          if (data[off + 3] < FOREGROUND_ALPHA_THRESHOLD) continue;
          if (luminance(data[off], data[off + 1], data[off + 2]) < DARK_LUMINANCE_THRESHOLD) darkMask[y * hb.w + x] = 1;
        }
      }
      const headArea = hb.w * hb.h;
      const candidates = labelDarkComponents(darkMask, hb.w, hb.h)
        .filter(c =>
          c.size <= headArea * EYE_MOUTH_MAX_COMPONENT_AREA_FRACTION &&
          (c.maxX - c.minX + 1) <= hb.w * EYE_MOUTH_MAX_DIMENSION_FRACTION &&
          (c.maxY - c.minY + 1) <= hb.h * EYE_MOUTH_MAX_DIMENSION_FRACTION,
        )
        .map(c => ({ ...c, gx: hb.x + c.cx, gy: hb.y + c.cy }));

      const eyeZoneMaxY = hb.y + hb.h * EYE_ZONE_MAX_HEIGHT_FRACTION;
      const eyeCandidates = candidates.filter(c => c.gy <= eyeZoneMaxY);
      let eyePair: typeof eyeCandidates = [];
      if (eyeCandidates.length >= 2) {
        let bestDiff = Infinity;
        let best: [typeof eyeCandidates[0], typeof eyeCandidates[0]] | null = null;
        for (let i = 0; i < eyeCandidates.length; i++) {
          for (let j = i + 1; j < eyeCandidates.length; j++) {
            const diff = Math.abs(eyeCandidates[i].gy - eyeCandidates[j].gy);
            if (diff < bestDiff) { bestDiff = diff; best = [eyeCandidates[i], eyeCandidates[j]]; }
          }
        }
        if (best && bestDiff <= hb.h * EYE_PAIR_MAX_Y_DIFF_FRACTION) {
          eyeLineY = (best[0].gy + best[1].gy) / 2;
          eyeLineConfidence = 'high';
          eyePair = best;
        }
      }
      if (eyeLineY === null) {
        eyeLineY = hb.y + hb.h * EYE_LINE_FALLBACK_FRACTION;
        eyeLineConfidence = 'low';
        warnings.push('Could not confidently detect a symmetric eye pair — eyeLineY is a fallback heuristic estimate.');
      }

      const mouthCandidates = candidates.filter(c => c.gy > (eyeLineY as number) && !eyePair.includes(c));
      if (mouthCandidates.length > 0) {
        const centerX = hb.x + hb.w / 2;
        mouthCandidates.sort((a, b) => Math.abs(a.gx - centerX) - Math.abs(b.gx - centerX));
        mouthLineY = mouthCandidates[0].gy;
        mouthLineConfidence = 'high';
      } else {
        mouthLineY = hb.y + hb.h * MOUTH_LINE_FALLBACK_FRACTION;
        mouthLineConfidence = 'low';
        warnings.push('Could not confidently detect a mouth/nose marking — mouthLineY is a fallback heuristic estimate.');
      }
    }
  }

  const dominantPalette = fgCount > 0 ? deriveSourcePalette(img, 6) : [];

  return {
    canvasSize: width,
    foregroundBBox, foregroundCoveragePct, transparentRatio, canvasCenter, subjectCenter,
    headBBox, eyeLineY, eyeLineConfidence, mouthLineY, mouthLineConfidence, bodyBBox,
    dominantPalette, darkOutlineRatio, warnings,
  };
}

// ── Collection DNA profile ──────────────────────────────────────────────

export interface CollectionFitProfile {
  id: string;
  name: string;
  canvasSize: 48;
  targetForegroundBBox: BBox;
  targetSubjectCenter: Point;
  allowedCenterDriftPx: number;
  allowedBBoxDriftPx: number;
  allowedCoverageRange: [number, number];
  allowedPaletteDistance: number;
  allowedOutlineRatioRange: [number, number];
  /** Reference dominant palette this profile was built from — required to
   *  evaluate `allowedPaletteDistance` against. Not separately named in
   *  the task's own field list, but implied by "allowedPaletteDistance"
   *  needing a palette to measure distance FROM. */
  targetPalette: string[];
  notes?: string;
}

const DEFAULT_ALLOWED_CENTER_DRIFT_PX = 3;
const DEFAULT_ALLOWED_BBOX_DRIFT_PX = 4;
const DEFAULT_COVERAGE_TOLERANCE_PP = 8; // percentage points, each side
const DEFAULT_ALLOWED_PALETTE_DISTANCE = 40; // avg RGB Euclidean distance
const DEFAULT_OUTLINE_RATIO_TOLERANCE = 0.08; // each side

/** Builds a CollectionFitProfile from one reference image's own metrics —
 *  that image's own bbox/center/coverage/palette/outline-ratio become the
 *  profile's target, with fixed MVP default tolerances around each. */
export function buildProfileFromMetrics(id: string, name: string, metrics: CollectionFitMetrics, notes?: string): CollectionFitProfile {
  const targetForegroundBBox = metrics.foregroundBBox ?? { x: 0, y: 0, w: metrics.canvasSize, h: metrics.canvasSize };
  const targetSubjectCenter = metrics.subjectCenter ?? metrics.canvasCenter;
  const coverage = metrics.foregroundCoveragePct;
  const outline = metrics.darkOutlineRatio;
  return {
    id, name, canvasSize: 48,
    targetForegroundBBox, targetSubjectCenter,
    allowedCenterDriftPx: DEFAULT_ALLOWED_CENTER_DRIFT_PX,
    allowedBBoxDriftPx: DEFAULT_ALLOWED_BBOX_DRIFT_PX,
    allowedCoverageRange: [Math.max(0, coverage - DEFAULT_COVERAGE_TOLERANCE_PP), Math.min(100, coverage + DEFAULT_COVERAGE_TOLERANCE_PP)],
    allowedPaletteDistance: DEFAULT_ALLOWED_PALETTE_DISTANCE,
    allowedOutlineRatioRange: [Math.max(0, outline - DEFAULT_OUTLINE_RATIO_TOLERANCE), Math.min(1, outline + DEFAULT_OUTLINE_RATIO_TOLERANCE)],
    targetPalette: metrics.dominantPalette,
    ...(notes ? { notes } : {}),
  };
}

// ── Fit check ────────────────────────────────────────────────────────────

export type FitVerdict = 'pass' | 'warn' | 'fail';
export type FitIssueSeverity = 'warn' | 'fail';

export interface FitIssue {
  code: 'center_drift' | 'bbox_drift' | 'coverage_out_of_range' | 'palette_drift' | 'outline_ratio_out_of_range';
  severity: FitIssueSeverity;
  message: string;
  expected: string;
  actual: string;
}

export interface CollectionFitResult {
  score: number;
  verdict: FitVerdict;
  metrics: CollectionFitMetrics;
  issues: FitIssue[];
}

// A single dimension's badness (0 = perfect match, 1 = at/beyond the
// allowed tolerance) at or above this becomes a 'fail'-severity issue;
// below it (but > 0) is 'warn'. Purely an MVP display/triage cutoff, not
// a hard accept/reject gate — checkCollectionFit() never blocks anything.
const ISSUE_FAIL_SEVERITY_THRESHOLD = 0.6;
const SCORE_PASS_THRESHOLD = 80;
const SCORE_WARN_THRESHOLD = 50;

function paletteDistance(candidate: string[], target: string[]): number {
  if (candidate.length === 0 || target.length === 0) return 0;
  const targetRgb = target.map(hexToRgb);
  let sum = 0;
  for (const hex of candidate) {
    const rgb = hexToRgb(hex);
    let best = Infinity;
    for (const t of targetRgb) {
      const d = colorDistance(rgb, t);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / candidate.length;
}

function severityFor(badness: number): FitIssueSeverity {
  return badness >= ISSUE_FAIL_SEVERITY_THRESHOLD ? 'fail' : 'warn';
}

/** Deterministic, advisory-only scoring: compares `metrics` (from a
 *  candidate variant) against `profile` (from a reference variant) across
 *  five dimensions — center drift, bbox drift, coverage range, palette
 *  distance, outline-ratio range — each normalized to a 0..1 "badness",
 *  averaged into a 0-100 score. Never mutates anything, never throws on a
 *  bad match — a "fail" verdict is just the worst score bucket, for a
 *  human to act on or ignore. */
export function checkCollectionFit(metrics: CollectionFitMetrics, profile: CollectionFitProfile): CollectionFitResult {
  const issues: FitIssue[] = [];
  const badnesses: number[] = [];

  if (metrics.subjectCenter) {
    const dist = Math.hypot(
      metrics.subjectCenter.x - profile.targetSubjectCenter.x,
      metrics.subjectCenter.y - profile.targetSubjectCenter.y,
    );
    const badness = profile.allowedCenterDriftPx > 0 ? Math.min(1, dist / profile.allowedCenterDriftPx) : (dist > 0 ? 1 : 0);
    badnesses.push(badness);
    if (badness > 0) {
      issues.push({
        code: 'center_drift', severity: severityFor(badness),
        message: `Subject center drifted ${dist.toFixed(1)}px from the profile target (allowed ${profile.allowedCenterDriftPx}px).`,
        expected: `(${profile.targetSubjectCenter.x.toFixed(1)}, ${profile.targetSubjectCenter.y.toFixed(1)}) ±${profile.allowedCenterDriftPx}px`,
        actual: `(${metrics.subjectCenter.x.toFixed(1)}, ${metrics.subjectCenter.y.toFixed(1)})`,
      });
    }
  } else {
    badnesses.push(1);
    issues.push({
      code: 'center_drift', severity: 'fail', message: 'No foreground detected — cannot evaluate subject center.',
      expected: `(${profile.targetSubjectCenter.x.toFixed(1)}, ${profile.targetSubjectCenter.y.toFixed(1)})`, actual: 'n/a',
    });
  }

  if (metrics.foregroundBBox) {
    const b = metrics.foregroundBBox, t = profile.targetForegroundBBox;
    const maxDiff = Math.max(Math.abs(b.x - t.x), Math.abs(b.y - t.y), Math.abs(b.w - t.w), Math.abs(b.h - t.h));
    const badness = profile.allowedBBoxDriftPx > 0 ? Math.min(1, maxDiff / profile.allowedBBoxDriftPx) : (maxDiff > 0 ? 1 : 0);
    badnesses.push(badness);
    if (badness > 0) {
      issues.push({
        code: 'bbox_drift', severity: severityFor(badness),
        message: `Foreground bbox differs by up to ${maxDiff}px from the profile target (allowed ${profile.allowedBBoxDriftPx}px) — possible crop/framing or scale drift.`,
        expected: `x=${t.x} y=${t.y} w=${t.w} h=${t.h} ±${profile.allowedBBoxDriftPx}px`,
        actual: `x=${b.x} y=${b.y} w=${b.w} h=${b.h}`,
      });
    }
  } else {
    badnesses.push(1);
    const t = profile.targetForegroundBBox;
    issues.push({
      code: 'bbox_drift', severity: 'fail', message: 'No foreground detected — cannot evaluate bbox.',
      expected: `x=${t.x} y=${t.y} w=${t.w} h=${t.h}`, actual: 'n/a',
    });
  }

  {
    const [lo, hi] = profile.allowedCoverageRange;
    const c = metrics.foregroundCoveragePct;
    let badness = 0;
    if (c < lo) badness = Math.min(1, (lo - c) / Math.max(1, lo));
    else if (c > hi) badness = Math.min(1, (c - hi) / Math.max(1, 100 - hi));
    badnesses.push(badness);
    if (badness > 0) {
      issues.push({
        code: 'coverage_out_of_range', severity: severityFor(badness),
        message: `Foreground coverage ${c.toFixed(1)}% is outside the profile's expected ${lo.toFixed(1)}–${hi.toFixed(1)}% range — subject may be too ${c < lo ? 'small' : 'large'}.`,
        expected: `${lo.toFixed(1)}–${hi.toFixed(1)}%`, actual: `${c.toFixed(1)}%`,
      });
    }
  }

  {
    const dist = paletteDistance(metrics.dominantPalette, profile.targetPalette);
    const badness = profile.allowedPaletteDistance > 0 ? Math.min(1, dist / profile.allowedPaletteDistance) : (dist > 0 ? 1 : 0);
    badnesses.push(badness);
    if (badness > 0) {
      issues.push({
        code: 'palette_drift', severity: severityFor(badness),
        message: `Dominant palette differs by an average ${dist.toFixed(1)} RGB units from the profile target (allowed ${profile.allowedPaletteDistance}).`,
        expected: profile.targetPalette.join(', ') || '(none)', actual: metrics.dominantPalette.join(', ') || '(none)',
      });
    }
  }

  {
    const [lo, hi] = profile.allowedOutlineRatioRange;
    const r = metrics.darkOutlineRatio;
    let badness = 0;
    if (r < lo) badness = Math.min(1, (lo - r) / Math.max(0.01, lo));
    else if (r > hi) badness = Math.min(1, (r - hi) / Math.max(0.01, 1 - hi));
    badnesses.push(badness);
    if (badness > 0) {
      issues.push({
        code: 'outline_ratio_out_of_range', severity: severityFor(badness),
        message: `Dark-outline pixel ratio ${(r * 100).toFixed(1)}% is outside the profile's expected ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}% range.`,
        expected: `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`, actual: `${(r * 100).toFixed(1)}%`,
      });
    }
  }

  const avgBadness = badnesses.reduce((a, b) => a + b, 0) / badnesses.length;
  const score = Math.round(100 * (1 - avgBadness));
  const verdict: FitVerdict = score >= SCORE_PASS_THRESHOLD ? 'pass' : (score >= SCORE_WARN_THRESHOLD ? 'warn' : 'fail');

  return { score, verdict, metrics, issues };
}
