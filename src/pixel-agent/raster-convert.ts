/**
 * Pixel Forge — raster-to-pixel-art conversion primitives. Pure
 * image-processing (sharp only) — no Anthropic call, no OpenAI call, no
 * network access. Shared by the offline CLI prototype
 * (src/scripts/pixel-forge-raster-to-pixel.ts) and the Image-to-Traits
 * Stage 1 HTTP route (src/server/tools-pixel-forge-raster.ts) so both use
 * the exact same tested conversion logic — see
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md for the design this
 * implements.
 *
 * Every function here accepts either a file path or an in-memory Buffer
 * (sharp() takes both identically) so the same code serves a CLI script
 * reading a local file and an HTTP route decoding an uploaded base64 body.
 */

import sharp from 'sharp';

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer; // RGBA, 4 bytes/pixel
}

export async function loadRawRgba(input: ReturnType<typeof sharp>): Promise<RgbaImage> {
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Square-fit via padding (never crops — safest default for a character
 *  portrait where cropping risks cutting off ears/hood/hat). Transparent
 *  padding on the shorter axis, centered. */
export async function squareFit(input: Buffer | string): Promise<ReturnType<typeof sharp>> {
  const meta = await sharp(input).metadata();
  const side = Math.max(meta.width ?? 1, meta.height ?? 1);
  return sharp(input)
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha();
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}

export function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Best-effort, non-ML background removal: samples the four corner pixels
 *  of the ORIGINAL (pre-square-fit) image, averages them as the assumed
 *  background color, and treats any pixel within `threshold` RGB distance
 *  of it as background. Only reliable for a flat/near-uniform background;
 *  a busy or gradient background will not be cleanly separated by this
 *  method. A threshold of 0 disables this step entirely (alpha channel,
 *  if any, still applies). Callers MUST sample this from the original
 *  image, not a square-fit one — square-fit pads with transparent black,
 *  and sampling its corners for a non-square input would read the padding
 *  color instead of the real background (a real bug caught and fixed
 *  during this feature's own prototyping). */
export function estimateBackgroundColor(img: RgbaImage): [number, number, number] {
  const corners = [
    0,
    (img.width - 1) * 4,
    (img.height - 1) * img.width * 4,
    ((img.height - 1) * img.width + (img.width - 1)) * 4,
  ];
  let r = 0, g = 0, b = 0;
  for (const off of corners) { r += img.data[off]; g += img.data[off + 1]; b += img.data[off + 2]; }
  return [r / 4, g / 4, b / 4];
}

export function applyBackgroundRemoval(img: RgbaImage, bgColor: [number, number, number], threshold: number): void {
  for (let i = 0; i < img.width * img.height; i++) {
    const off = i * 4;
    const rgb: [number, number, number] = [img.data[off], img.data[off + 1], img.data[off + 2]];
    if (colorDistance(rgb, bgColor) <= threshold) img.data[off + 3] = 0;
  }
}

/** Nearest-neighbor variant: square-fit → nearest-kernel resize straight
 *  to the target grid. No forced palette — keeps whatever RGB survives
 *  the resize verbatim (including source anti-aliasing). */
export async function buildNearestVariant(
  squareFitImg: ReturnType<typeof sharp>, size: number, bgColor: [number, number, number], bgThreshold: number,
): Promise<RgbaImage> {
  const resized = squareFitImg.clone().resize(size, size, { kernel: 'nearest', fit: 'fill' });
  const img = await loadRawRgba(resized);
  if (bgThreshold > 0) applyBackgroundRemoval(img, bgColor, bgThreshold);
  return img;
}

/** Smooth (area-average) resize to the target grid — each output cell
 *  reflects the source region's blended/dominant color, not one randomly
 *  sampled pixel. This is the shared first step both `deriveSourcePalette`
 *  and `quantizeToPalette` build on: derive the palette from, and quantize,
 *  the SAME already-downscaled pixel population, so the palette is
 *  actually representative of what the target grid will contain. */
async function smoothResize(squareFitImg: ReturnType<typeof sharp>, size: number): Promise<RgbaImage> {
  // Default (non-'nearest') kernel — lanczos3 — area-averages.
  const resized = squareFitImg.clone().resize(size, size, { fit: 'fill' });
  return loadRawRgba(resized);
}

/** Every pixel snapped to the nearest color in a fixed palette by simple
 *  Euclidean RGB distance — no ML, no clustering. Palette-agnostic: the
 *  caller decides where the palette came from (a generic fixed list, or
 *  `deriveSourcePalette` below). */
export function quantizeToPalette(
  img: RgbaImage, palette: string[],
): { pixelPaletteIndex: number[] } {
  const paletteRgb = palette.map(hexToRgb);
  const pixelPaletteIndex: number[] = new Array(img.width * img.height).fill(0);
  for (let i = 0; i < img.width * img.height; i++) {
    const off = i * 4;
    const alpha = img.data[off + 3];
    if (alpha < 128) { pixelPaletteIndex[i] = 0; continue; } // 0 = transparent
    const rgb: [number, number, number] = [img.data[off], img.data[off + 1], img.data[off + 2]];
    let bestIdx = 0, bestDist = Infinity;
    for (let p = 0; p < paletteRgb.length; p++) {
      const d = colorDistance(rgb, paletteRgb[p]);
      if (d < bestDist) { bestDist = d; bestIdx = p; }
    }
    pixelPaletteIndex[i] = bestIdx + 1; // +1: index 0 reserved for transparent
    const snapped = paletteRgb[bestIdx];
    img.data[off] = snapped[0]; img.data[off + 1] = snapped[1]; img.data[off + 2] = snapped[2];
    img.data[off + 3] = 255;
  }
  return { pixelPaletteIndex };
}

/** Square-fit → smooth resize → snap every pixel to the nearest color in
 *  `palette` (mutates a fresh RgbaImage, returns it alongside the
 *  resulting palette-index grid). Convenience wrapper combining
 *  `smoothResize` + `quantizeToPalette` + background removal — used by
 *  both the CLI (fixed/DEFAULT_PALETTE) and the HTTP route
 *  (source-derived palette) call sites. */
export async function buildQuantizedVariant(
  squareFitImg: ReturnType<typeof sharp>, size: number, palette: string[],
  bgColor: [number, number, number], bgThreshold: number,
): Promise<{ img: RgbaImage; pixelPaletteIndex: number[] }> {
  const img = await smoothResize(squareFitImg, size);
  if (bgThreshold > 0) applyBackgroundRemoval(img, bgColor, bgThreshold);
  const { pixelPaletteIndex } = quantizeToPalette(img, palette);
  return { img, pixelPaletteIndex };
}

/**
 * Derives a small, curated palette FROM the image itself — top-K dominant
 * colors by frequency, not "every distinct color" (see
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md §6's caveat: a real
 * raster import this feature was prototyped against extracted 675 raw
 * distinct colors from an unbucketed nearest-neighbor resize, which is not
 * a usable "palette" in any curated sense). Each opaque pixel's color is
 * bucketed by rounding every channel to the nearest `bucketSize` (default
 * 16) BEFORE counting frequency — this merges near-duplicate shades that
 * are really the same visual color plus source anti-aliasing noise, which
 * a raw distinct-color count does not. Buckets are ranked by pixel count;
 * the top `maxColors` become the palette, each rendered as the ACTUAL
 * average color of the pixels that fell in that bucket (not the bucket's
 * rounded corner), so the palette stays visually faithful to the source
 * even though it's been deliberately size-limited. Deterministic, no ML,
 * no external dependency beyond arithmetic.
 */
export function deriveSourcePalette(img: RgbaImage, maxColors = 16, bucketSize = 16): string[] {
  const buckets = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
  for (let i = 0; i < img.width * img.height; i++) {
    const off = i * 4;
    if (img.data[off + 3] < 128) continue; // skip transparent/background pixels
    const r = img.data[off], g = img.data[off + 1], b = img.data[off + 2];
    const key = [
      Math.round(r / bucketSize),
      Math.round(g / bucketSize),
      Math.round(b / bucketSize),
    ].join(',');
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++; bucket.rSum += r; bucket.gSum += g; bucket.bSum += b;
    } else {
      buckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, maxColors);
  return ranked.map(bucket => rgbToHex([bucket.rSum / bucket.count, bucket.gSum / bucket.count, bucket.bSum / bucket.count]));
}

// ── Stage 2: deterministic cleanup ──────────────────────────────────────
// See docs/pixel-forge-image-to-traits-pipeline-mvp.md. Purely algorithmic
// despeckle/hole-fill pass over an already-resized RgbaImage — no AI, no
// randomness, same input always produces the same output (every step
// below is a single deterministic scan/BFS with a fixed neighbor order).

/** Simple perceptual-ish average — good enough to classify "dark" vs.
 *  "light" for the preserveSmallDarkDetails guard, not for anything
 *  color-critical. */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Below this average luminance (0-255), a small component is treated as
 *  a likely deliberate dark detail (pupil, nose, thin outline fragment)
 *  rather than noise, when `preserveSmallDarkDetails` is on. */
const DARK_LUMINANCE_THRESHOLD = 60;

/** 4-connectivity connected-components labeling over a binary mask —
 *  deterministic (fixed left-to-right/top-to-bottom scan order, fixed
 *  neighbor order, no randomness). Returns one label per pixel (-1 where
 *  the mask is 0) and each label's pixel count. */
function labelComponents(mask: Uint8Array, width: number, height: number): { labels: Int32Array; sizes: number[] } {
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

export interface CleanupOptions {
  /** Connected components (4-connectivity, on the opaque/transparent mask)
   *  smaller than this are candidates for removal/fill. Default 2 — only
   *  single isolated pixels and true 2-pixel specks, deliberately
   *  conservative. Components are defined by OPACITY, not per-pixel
   *  color, so ANY opaque pixel touching the main character mass —
   *  regardless of its own color (an eye highlight, a badge glyph, a
   *  mouth line) — is part of that same large component and never a
   *  candidate, by construction. This is what satisfies "never remove
   *  important small details connected to larger regions" without a
   *  separate per-color analysis. */
  minComponentSize?: number;
  /** When true (default), a small component that would otherwise be
   *  removed/filled is left alone instead if its average luminance is
   *  below DARK_LUMINANCE_THRESHOLD — small dark regions (pupils, nose
   *  dots, thin outline fragments) are exactly the ones most likely to be
   *  a deliberate detail rather than noise, so this errs toward leaving
   *  them rather than guessing. */
  preserveSmallDarkDetails?: boolean;
}

export interface CleanupStats {
  pixelsChanged: number;
  componentsRemoved: number;
}

/**
 * Two deterministic passes, in order, mutating `img` in place:
 *
 *   1. Remove tiny OPAQUE components — background speckles/isolated
 *      pixels that survived threshold-based background removal because
 *      their color wasn't close enough to the sampled corner color.
 *   2. Fill tiny TRANSPARENT holes — repairs background removal being too
 *      aggressive (a small patch of character wrongly stripped because it
 *      was close enough to the background color). Never touches a
 *      transparent component that reaches the image border — that's
 *      legitimate background, not a hole, regardless of size.
 *
 * Both passes operate on OPACITY connectivity, not per-pixel color —
 * deliberately, not an oversight. An earlier version of this function
 * also despeckled any single pixel that didn't color-match its
 * neighbors; that was caught, during this feature's own testing, actively
 * repainting a deliberate single-pixel eye highlight (white, surrounded
 * by dark fur — exactly the shape of a legitimate detail, and exactly
 * what a pure color-mismatch rule cannot distinguish from noise) back to
 * the surrounding fur color. Opacity-based connectivity has no such
 * failure mode: an eye highlight, badge glyph, or mouth line is OPAQUE
 * and touches the character's main opaque mass, so it's part of that same
 * large connected component and never a removal candidate, regardless of
 * how different its own color is. The tradeoff, stated plainly: this
 * means a same-alpha color speckle sitting inside an otherwise-uniform
 * opaque region (e.g. stray noise within a KEPT, fully-opaque background)
 * is NOT cleaned up by this function — only alpha-boundary noise is.
 * That's the safe side of this tradeoff to be on.
 *
 * Same input always produces the same output — no AI, no randomness.
 */
export function cleanupRasterImage(img: RgbaImage, options: CleanupOptions = {}): CleanupStats {
  const minSize = Math.max(1, options.minComponentSize ?? 2);
  const preserveDark = options.preserveSmallDarkDetails ?? true;
  const { width, height, data } = img;
  const n = width * height;
  let pixelsChanged = 0;
  let componentsRemoved = 0;

  // ── pass 1: remove tiny opaque components (background speckles) ────
  const opaqueMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) opaqueMask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const opaque = labelComponents(opaqueMask, width, height);
  const removeOpaqueLabel = new Array(opaque.sizes.length).fill(false);
  for (let label = 0; label < opaque.sizes.length; label++) {
    if (opaque.sizes[label] >= minSize) continue;
    removeOpaqueLabel[label] = true; // tentative; darkness guard applied below
  }
  if (preserveDark) {
    const lumSum = new Array(opaque.sizes.length).fill(0);
    for (let i = 0; i < n; i++) {
      const label = opaque.labels[i];
      if (label === -1 || !removeOpaqueLabel[label]) continue;
      const off = i * 4;
      lumSum[label] += luminance(data[off], data[off + 1], data[off + 2]);
    }
    for (let label = 0; label < opaque.sizes.length; label++) {
      if (!removeOpaqueLabel[label]) continue;
      const avgLum = lumSum[label] / opaque.sizes[label];
      if (avgLum < DARK_LUMINANCE_THRESHOLD) removeOpaqueLabel[label] = false; // preserved
    }
  }
  for (let i = 0; i < n; i++) {
    const label = opaque.labels[i];
    if (label === -1 || !removeOpaqueLabel[label]) continue;
    const off = i * 4;
    if (data[off + 3] !== 0) { data[off + 3] = 0; pixelsChanged++; }
  }
  componentsRemoved += removeOpaqueLabel.filter(Boolean).length;

  // ── pass 2: fill tiny transparent holes (over-aggressive bg removal) ──
  // Recomputed AFTER pass 1 — removing opaque specks can only ever CREATE
  // new transparent pixels, never remove existing ones, so this reflects
  // the true current state.
  const transparentMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) transparentMask[i] = data[i * 4 + 3] < 128 ? 1 : 0;
  const trans = labelComponents(transparentMask, width, height);
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
    fillLabel[label] = trans.sizes[label] < minSize && !touchesBorder[label];
  }
  if (fillLabel.some(Boolean)) {
    // Fill color = average of each hole's own OPAQUE 4-neighbors (not a
    // global average) — a hole gets the color of what actually surrounds
    // it, so a hole inside dark fur fills dark, inside light fur fills
    // light. Computed BEFORE any writes so multi-pixel holes all read
    // from the same pre-fill neighborhood.
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
    if (preserveDark) {
      for (let label = 0; label < trans.sizes.length; label++) {
        if (!fillLabel[label] || fillCount[label] === 0) continue;
        const avgLum = luminance(fillSumR[label] / fillCount[label], fillSumG[label] / fillCount[label], fillSumB[label] / fillCount[label]);
        if (avgLum < DARK_LUMINANCE_THRESHOLD) fillLabel[label] = false; // preserved — leave the hole as-is
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
      pixelsChanged++;
    }
    componentsRemoved += fillLabel.filter(Boolean).length;
  }

  return { pixelsChanged, componentsRemoved };
}

export async function writeRgbaPng(img: RgbaImage, outPath: string): Promise<void> {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(outPath);
}

export async function writePreview(img: RgbaImage, upscale: number, outPath: string): Promise<void> {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(img.width * upscale, img.height * upscale, { kernel: 'nearest' })
    .png()
    .toFile(outPath);
}

export async function rgbaToPngBase64(img: RgbaImage): Promise<string> {
  const buf = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
  return buf.toString('base64');
}
