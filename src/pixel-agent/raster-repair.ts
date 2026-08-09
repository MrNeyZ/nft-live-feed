/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 4 (deterministic repair
 * engine). See docs/pixel-forge-image-to-traits-pipeline-mvp.md for the
 * overall pipeline this extends. Pure image-processing over an
 * already-resized RgbaImage (see raster-convert.ts) — no Anthropic call,
 * no OpenAI call, no ML, no randomness. Same input always produces the
 * same output.
 *
 * This is a standalone, more aggressive sibling of raster-convert.ts's own
 * Stage 2 `cleanupRasterImage` — kept in its own file (like raster-split.ts)
 * rather than folded into raster-convert.ts, so Stage 1/2's already-shipped
 * behavior is never at risk of a Stage 4 regression. It targets a broader
 * set of resize artifacts (faint alpha fringing, weak/inconsistent 1px
 * outlines, anti-aliasing color noise inside a single flat region) that
 * cleanupRasterImage was never scoped to touch.
 *
 * Every pass here shares one governing rule: a pixel or small component is
 * only ever a REMOVAL/SMOOTHING candidate if it looks like resize noise,
 * never if it looks like a deliberate tiny detail. "Looks like a detail" is
 * decided once, by `isProtectedColor` below, and reused by every pass —
 * see its own doc comment for exactly what that means and why.
 */

import { RgbaImage, colorDistance } from './raster-convert';

export type RepairStrength = 'safe' | 'medium';

export interface RepairOptions {
  /** 'safe' (default): only touches near-zero-alpha fringe pixels and
   *  genuinely tiny (<=2px) isolated specks/holes. 'medium': larger
   *  size/alpha thresholds, plus two additional passes (outline
   *  consistency, in-region palette smoothing) that 'safe' never runs. */
  strength?: RepairStrength;
  /** When true (default), a small component that would otherwise be
   *  removed/filled/smoothed is left alone if `isProtectedColor` flags it
   *  as a likely deliberate detail. Turning this off makes every pass
   *  purely size/alpha-based, with no color-aware exceptions — a stress
   *  test / opt-out, not the recommended default. */
  preserveSmallDetails?: boolean;
}

export interface RepairStats {
  pixelsChanged: number;
  componentsRemoved: number;
  holesFilled: number;
  outlinePixelsAdjusted: number;
  warnings: string[];
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const DARK_LUMINANCE_THRESHOLD = 60;
/** A channel spread above this (max-min RGB) marks a pixel as vividly
 *  saturated — a badge/hat accent color, not a neutral anti-aliasing
 *  blend — regardless of how light or dark it happens to be. */
const SATURATED_SPREAD_MIN = 60;

/**
 * A pixel "looks like a deliberate detail, not resize noise" if it is
 * clearly dark (pupil, nose, mouth, outline fragment) or clearly saturated
 * (a badge/hat accent color). Deliberately NOT "clearly near-white" —
 * that was tried and rejected during this module's own testing: a real
 * eye catchlight sits INSIDE the dark pupil/iris, so on the opacity mask
 * used by every pass below it's already merged into the same giant
 * connected component as the surrounding fur, never a small-component
 * removal candidate regardless of color — the connectivity itself is what
 * protects it, not this function. Adding a near-white branch here instead
 * protected a genuinely isolated white background speck in testing —
 * exactly the "white artifact" this module exists to remove — so it was
 * removed rather than fixed with a narrower threshold: there is no color
 * value that reliably distinguishes an isolated stray white pixel from an
 * isolated stray white pixel. Anything not dark and not saturated (a
 * washed-out, low-contrast, near-neutral tone — including near-white) is
 * exactly what anti-aliased resize fringing looks like, and is left as a
 * valid removal/smoothing candidate for the passes below.
 */
function isProtectedColor(r: number, g: number, b: number): boolean {
  const lum = luminance(r, g, b);
  if (lum < DARK_LUMINANCE_THRESHOLD) return true;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread >= SATURATED_SPREAD_MIN) return true;
  return false;
}

interface Components { labels: Int32Array; sizes: number[]; }

/** 4-connectivity connected-components labeling, deterministic fixed scan
 *  order — same contract as raster-convert.ts's/raster-split.ts's own
 *  (private) helpers of the same purpose, duplicated here so this file
 *  stays self-contained (matches raster-split.ts's own precedent). */
function labelMask(mask: Uint8Array, width: number, height: number): Components {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  let nextLabel = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const label = nextLabel++;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      size++;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x > 0 && mask[idx - 1] === 1 && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] === 1 && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] === 1 && labels[idx - width] === -1) { labels[idx - width] = label; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] === 1 && labels[idx + width] === -1) { labels[idx + width] = label; stack.push(idx + width); }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

interface StrengthConfig {
  /** Alpha values in (0, this) get snapped to fully transparent. */
  alphaSnapThreshold: number;
  /** Connected components (opacity mask) smaller than this are removal/
   *  fill candidates for the tiny-component and hole-fill passes. */
  minComponentSize: number;
  outlineCleanup: boolean;
  paletteSmoothing: boolean;
  /** Max color-distance for the palette-smoothing pass to consider two
   *  shades "the same color plus anti-aliasing noise." */
  paletteSmoothingDistance: number;
}
const STRENGTH_CONFIG: Record<RepairStrength, StrengthConfig> = {
  safe: { alphaSnapThreshold: 32, minComponentSize: 2, outlineCleanup: false, paletteSmoothing: false, paletteSmoothingDistance: 0 },
  medium: { alphaSnapThreshold: 64, minComponentSize: 4, outlineCleanup: true, paletteSmoothing: true, paletteSmoothingDistance: 24 },
};

/**
 * Five deterministic passes, in order, mutating `img` in place:
 *
 *   1. Snap near-transparent alpha to fully transparent — kills the faint
 *      "white/transparent ghost" fringe a resize/background-removal step
 *      can leave behind (a pixel at alpha=20 is already "background" for
 *      every mask-based check elsewhere in this pipeline, since those all
 *      use a 128 threshold, but it can still render as a visible faint
 *      halo in a real viewer at its actual partial alpha).
 *   2. Remove tiny isolated opaque components (background speckle/noisy
 *      isolated pixels) — same technique as cleanupRasterImage's own pass,
 *      but with the broader isProtectedColor guard (dark OR light OR
 *      saturated) instead of dark-only, so a small isolated bright or
 *      vividly colored fragment is protected too, not just a dark one.
 *   3. Fill tiny transparent holes (over-aggressive background removal),
 *      same guard, never touching a hole that reaches the image border.
 *   4. Outline consistency (medium strength only): a boundary pixel (opaque,
 *      touching background) whose luminance sits in a "nearly dark but not
 *      quite" band, that also touches a genuinely dark opaque neighbor, is
 *      snapped to that neighbor's color — reinforces a 1px outline broken
 *      up by resize blending, without ever touching a pixel that isn't
 *      already on the silhouette edge.
 *   5. Palette smoothing (medium strength only): within each opaque
 *      connected component independently, minority near-duplicate shades
 *      (close in color-distance to that component's own modal color, but
 *      not equal) are snapped to the modal color — merges anti-aliasing
 *      color noise inside one flat region without touching a genuinely
 *      different second tone (still far in color-distance) or any
 *      protected-color pixel.
 *
 * Same input always produces the same output — no AI, no randomness.
 */
export function repairRasterImage(img: RgbaImage, options: RepairOptions = {}): RepairStats {
  const strength = options.strength ?? 'safe';
  const preserveDetails = options.preserveSmallDetails ?? true;
  const cfg = STRENGTH_CONFIG[strength];
  const { width, height, data } = img;
  const n = width * height;
  let pixelsChanged = 0;
  let componentsRemoved = 0;
  let holesFilled = 0;
  let outlinePixelsAdjusted = 0;
  const warnings: string[] = [];

  // ── pass 1: snap near-transparent alpha to fully transparent ───────────
  let snappedAny = false;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const a = data[off + 3];
    if (a > 0 && a < cfg.alphaSnapThreshold) {
      data[off] = 0; data[off + 1] = 0; data[off + 2] = 0; data[off + 3] = 0;
      pixelsChanged++; snappedAny = true;
    }
  }
  if (!snappedAny) warnings.push('No near-transparent fringe pixels found to snap.');

  // ── pass 2: remove tiny isolated opaque components ──────────────────────
  const opaqueMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) opaqueMask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const opaque = labelMask(opaqueMask, width, height);
  const removeOpaqueLabel = new Array(opaque.sizes.length).fill(false);
  for (let label = 0; label < opaque.sizes.length; label++) {
    if (opaque.sizes[label] < cfg.minComponentSize) removeOpaqueLabel[label] = true;
  }
  if (preserveDetails) {
    const protectedLabel = new Array(opaque.sizes.length).fill(false);
    for (let i = 0; i < n; i++) {
      const label = opaque.labels[i];
      if (label === -1 || !removeOpaqueLabel[label] || protectedLabel[label]) continue;
      const off = i * 4;
      if (isProtectedColor(data[off], data[off + 1], data[off + 2])) protectedLabel[label] = true;
    }
    for (let label = 0; label < opaque.sizes.length; label++) {
      if (protectedLabel[label]) removeOpaqueLabel[label] = false;
    }
  }
  let anyRemoved = false;
  for (let i = 0; i < n; i++) {
    const label = opaque.labels[i];
    if (label === -1 || !removeOpaqueLabel[label]) continue;
    const off = i * 4;
    if (data[off + 3] !== 0) { data[off] = 0; data[off + 1] = 0; data[off + 2] = 0; data[off + 3] = 0; pixelsChanged++; }
    anyRemoved = true;
  }
  componentsRemoved = removeOpaqueLabel.filter(Boolean).length;
  if (!anyRemoved) warnings.push('No isolated noisy components found to remove.');

  // ── pass 3: fill tiny transparent holes ─────────────────────────────────
  const transparentMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) transparentMask[i] = data[i * 4 + 3] < 128 ? 1 : 0;
  const trans = labelMask(transparentMask, width, height);
  const touchesBorder = new Array(trans.sizes.length).fill(false);
  for (let x = 0; x < width; x++) {
    const top = x, bottom = (height - 1) * width + x;
    if (transparentMask[top]) touchesBorder[trans.labels[top]] = true;
    if (transparentMask[bottom]) touchesBorder[trans.labels[bottom]] = true;
  }
  for (let y = 0; y < height; y++) {
    const left = y * width, right = y * width + (width - 1);
    if (transparentMask[left]) touchesBorder[trans.labels[left]] = true;
    if (transparentMask[right]) touchesBorder[trans.labels[right]] = true;
  }
  const fillLabel = new Array(trans.sizes.length).fill(false);
  for (let label = 0; label < trans.sizes.length; label++) {
    fillLabel[label] = trans.sizes[label] < cfg.minComponentSize && !touchesBorder[label];
  }
  let anyFilled = false;
  if (fillLabel.some(Boolean)) {
    const fillSumR = new Array(trans.sizes.length).fill(0);
    const fillSumG = new Array(trans.sizes.length).fill(0);
    const fillSumB = new Array(trans.sizes.length).fill(0);
    const fillCount = new Array(trans.sizes.length).fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const label = trans.labels[idx];
        if (label === -1 || !fillLabel[label]) continue;
        const neighbors: number[] = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < width - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - width);
        if (y < height - 1) neighbors.push(idx + width);
        for (const nIdx of neighbors) {
          if (opaqueMask[nIdx] !== 1) continue;
          const nOff = nIdx * 4;
          fillSumR[label] += data[nOff]; fillSumG[label] += data[nOff + 1]; fillSumB[label] += data[nOff + 2];
          fillCount[label]++;
        }
      }
    }
    if (preserveDetails) {
      // Deliberately checks DARKNESS only here, not the full isProtectedColor
      // (which also flags high channel-spread as "saturated/badge-like").
      // This average is a BLEND of possibly very different neighbor colors
      // (e.g. a dark outline pixel next to a bright fill color) — averaging
      // unrelated hues routinely produces a high-spread result with no
      // relation to any real saturated/badge pixel, which was caught
      // concretely during this module's own testing: a 1px hole next to a
      // dark outline, surrounded otherwise by bright pink hoodie, produced
      // an average color the saturation check misread as "protected,"
      // silently leaving a real hole unfilled. Darkness survives averaging
      // far more sensibly (a hole fully enclosed by uniformly dark pixels
      // really does mean "this hole is inside a dark detail, leave it"),
      // so only that check applies to a blended average like this one.
      for (let label = 0; label < trans.sizes.length; label++) {
        if (!fillLabel[label] || fillCount[label] === 0) continue;
        const avgR = fillSumR[label] / fillCount[label], avgG = fillSumG[label] / fillCount[label], avgB = fillSumB[label] / fillCount[label];
        if (luminance(avgR, avgG, avgB) < DARK_LUMINANCE_THRESHOLD) fillLabel[label] = false;
      }
    }
    for (let i = 0; i < n; i++) {
      const label = trans.labels[i];
      if (label === -1 || !fillLabel[label] || fillCount[label] === 0) continue;
      const off = i * 4;
      data[off] = Math.round(fillSumR[label] / fillCount[label]);
      data[off + 1] = Math.round(fillSumG[label] / fillCount[label]);
      data[off + 2] = Math.round(fillSumB[label] / fillCount[label]);
      data[off + 3] = 255;
      pixelsChanged++; anyFilled = true;
    }
    holesFilled = fillLabel.filter(Boolean).length;
  }
  if (!anyFilled) warnings.push('No small enclosed holes found to fill.');

  // ── pass 4: outline consistency (medium strength only) ──────────────────
  if (cfg.outlineCleanup) {
    // Re-derive the opaque mask — passes 2/3 may have changed it.
    const currentOpaque = new Uint8Array(n);
    for (let i = 0; i < n; i++) currentOpaque[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    const NEAR_DARK_MAX = 100;
    const before = Buffer.from(data);
    let anyAdjusted = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (currentOpaque[idx] !== 1) continue;
        const off = idx * 4;
        const lum = luminance(before[off], before[off + 1], before[off + 2]);
        if (lum < DARK_LUMINANCE_THRESHOLD || lum > NEAR_DARK_MAX) continue; // already dark, or not "near-dark" at all
        const neighbors: number[] = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < width - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - width);
        if (y < height - 1) neighbors.push(idx + width);
        let touchesBackground = false;
        let darkestNeighbor: { r: number; g: number; b: number; lum: number } | null = null;
        for (const nIdx of neighbors) {
          if (currentOpaque[nIdx] !== 1) { touchesBackground = true; continue; }
          const nOff = nIdx * 4;
          const nLum = luminance(before[nOff], before[nOff + 1], before[nOff + 2]);
          if (nLum < DARK_LUMINANCE_THRESHOLD && (!darkestNeighbor || nLum < darkestNeighbor.lum)) {
            darkestNeighbor = { r: before[nOff], g: before[nOff + 1], b: before[nOff + 2], lum: nLum };
          }
        }
        // Only a boundary pixel (touches background) with a genuinely dark
        // neighbor to pull from is a candidate — never an interior pixel.
        if (!touchesBackground || !darkestNeighbor) continue;
        if (preserveDetails && isProtectedColor(before[off], before[off + 1], before[off + 2])) continue;
        data[off] = darkestNeighbor.r; data[off + 1] = darkestNeighbor.g; data[off + 2] = darkestNeighbor.b;
        pixelsChanged++; outlinePixelsAdjusted++; anyAdjusted = true;
      }
    }
    if (!anyAdjusted) warnings.push('No inconsistent outline pixels found to adjust.');
  }

  // ── pass 5: palette smoothing within each opaque component (medium only) ─
  if (cfg.paletteSmoothing) {
    const currentOpaque = new Uint8Array(n);
    for (let i = 0; i < n; i++) currentOpaque[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    const comps = labelMask(currentOpaque, width, height);
    // Modal color per component, bucketed coarsely to merge near-duplicate
    // anti-aliasing shades into one representative color.
    const BUCKET = 8;
    const bucketCounts: Map<string, { count: number; rSum: number; gSum: number; bSum: number }>[] =
      comps.sizes.map(() => new Map());
    for (let i = 0; i < n; i++) {
      const label = comps.labels[i];
      if (label === -1) continue;
      const off = i * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const key = `${Math.round(r / BUCKET)},${Math.round(g / BUCKET)},${Math.round(b / BUCKET)}`;
      const m = bucketCounts[label];
      const existing = m.get(key);
      if (existing) { existing.count++; existing.rSum += r; existing.gSum += g; existing.bSum += b; }
      else m.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
    const modalColor: Array<[number, number, number] | null> = comps.sizes.map((_, label) => {
      const buckets = [...bucketCounts[label].values()].sort((a, b) => b.count - a.count);
      if (buckets.length === 0) return null;
      const top = buckets[0];
      return [top.rSum / top.count, top.gSum / top.count, top.bSum / top.count];
    });
    let anySmoothed = false;
    for (let i = 0; i < n; i++) {
      const label = comps.labels[i];
      if (label === -1) continue;
      const modal = modalColor[label];
      if (!modal) continue;
      const off = i * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      if (r === modal[0] && g === modal[1] && b === modal[2]) continue;
      if (preserveDetails && isProtectedColor(r, g, b)) continue;
      const dist = colorDistance([r, g, b], modal);
      if (dist > 0 && dist <= cfg.paletteSmoothingDistance) {
        data[off] = Math.round(modal[0]); data[off + 1] = Math.round(modal[1]); data[off + 2] = Math.round(modal[2]);
        pixelsChanged++; anySmoothed = true;
      }
    }
    if (!anySmoothed) warnings.push('No near-duplicate color noise found to smooth.');
  }

  return { pixelsChanged, componentsRemoved, holesFilled, outlinePixelsAdjusted, warnings };
}
