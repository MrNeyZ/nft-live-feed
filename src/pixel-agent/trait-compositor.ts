/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 9.1 (real PNG
 * compositor). Pure deterministic image-processing (sharp + manual
 * buffer math) — no Anthropic call, no OpenAI call, no generation of any
 * kind. See docs/pixel-forge-trait-sheet-stage9-design.md Part C1/C3.
 *
 * This is the REAL replacement for the frontend Layer Stack's own
 * CSS-`<img>`-stack preview (frontend/src/app/tools/pixel-forge/layer-
 * stack.ts + docs/pixel-forge-layer-stack-compositor-mvp.md §5) — that
 * preview is correct and free for on-screen display (the browser's own
 * alpha compositing over absolutely-positioned images), but was always
 * explicitly scoped as display-only, deferring "export the composite as
 * a single flattened PNG" to real `<canvas>`/backend work
 * (layer-stack-compositor-mvp.md §5/§7). This module is that deferred
 * work, done backend-side with hand-rolled pixel math instead of a
 * `<canvas>` element, so the exact same compositor can serve both a
 * future HTTP route and an offline test with zero DOM dependency.
 *
 * Deliberately hand-rolled straight-alpha compositing rather than
 * sharp's own `.composite()` — same reasoning raster-upscale.ts's own
 * header comment already gives for avoiding libvips's alpha handling for
 * its nearest-neighbor upscale (a real, previously-hit issue in this
 * exact codebase: libvips routes resizes through a premultiply/
 * unpremultiply round-trip that silently zeroes RGB on fully-transparent
 * pixels). This function needs exact, auditable, deterministic per-pixel
 * behavior for something as fundamental as trait stacking — worth the
 * same trade a second time.
 */

import sharp from 'sharp';
import { LayerType, LAYER_TYPES } from './agent-loop';
import { upscalePixelArtPng } from './raster-upscale';
import { getTraitAsset, getTraitAssetPngBuffer } from './store';

// Matches raster-upscale.ts's own FIXED_SCALE / tools-pixel-forge-export.ts's
// own FIXED_SCALE — 48 × 8 = 384, this pipeline's canonical export size.
const COMPOSE_UPSCALE = 8;

export interface ComposeTraitLayerInput {
  id: string;
  name: string;
  pngBuffer: Buffer;
  zIndex: number;
  layerType: LayerType;
}

function knownLayerTypeIndex(layerType: string): number {
  const i = (LAYER_TYPES as readonly string[]).indexOf(layerType);
  return i === -1 ? LAYER_TYPES.length : i;
}

/**
 * Deterministic ordering — zIndex ascending, then a fixed layer-type
 * priority, then name, then id. Same SHAPE as the frontend Layer Stack's
 * own `compareForStack`
 * (frontend/src/app/tools/pixel-forge/layer-stack.ts:66-73) — duplicated
 * here rather than imported, since the backend cannot import a frontend
 * module; this is the same cross-boundary duplication convention this
 * codebase already uses for connected-components labeling across
 * raster-convert.ts/raster-split.ts/collection-fit.ts (each stays
 * self-contained per that established precedent).
 */
function compareLayersForCompose(a: ComposeTraitLayerInput, b: ComposeTraitLayerInput): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  const layerDiff = knownLayerTypeIndex(a.layerType) - knownLayerTypeIndex(b.layerType);
  if (layerDiff !== 0) return layerDiff;
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;
  return a.id.localeCompare(b.id);
}

/**
 * Real straight-alpha (non-premultiplied) Porter-Duff "over" compositing,
 * one layer at a time in ascending zIndex order (ties broken by
 * `compareLayersForCompose`), accumulated in a `Float64Array` for the
 * whole pass so repeated 8-bit rounding never compounds across N layers
 * — only the final buffer is quantized back to bytes. Every input layer
 * MUST decode to exactly `canvasSize`×`canvasSize`; throws naming the
 * offending layer otherwise. Trusts its input is already-normalized (the
 * same "trust the caller already normalized" contract Stage 8's
 * collection-fit routes use) — this function does not resize anything
 * itself. Never mutates any input buffer.
 *
 * Per-pixel recurrence (dst = running composite so far, src = the next
 * layer being applied, all channels normalized 0..1 for the math):
 *   outA = srcA + dstA·(1-srcA)
 *   outRGB = (srcRGB·srcA + dstRGB·dstA·(1-srcA)) / outA   (outA > 0)
 * A fully-transparent source pixel (srcA === 0) leaves the running
 * composite completely untouched — this is what "transparent pixels
 * preserve lower layers" means concretely.
 */
export async function composeTraitPngs(layers: ComposeTraitLayerInput[], canvasSize: number): Promise<Buffer> {
  if (layers.length === 0) throw new Error('compose_no_layers');
  if (!Number.isInteger(canvasSize) || canvasSize < 1) throw new Error('compose_invalid_canvas_size');

  const ordered = [...layers].sort(compareLayersForCompose);
  const n = canvasSize * canvasSize;
  // acc[i*4+0..2] = running RGB in [0,255]; acc[i*4+3] = running alpha in [0,1].
  const acc = new Float64Array(n * 4);

  for (const layer of ordered) {
    const { data, info } = await sharp(layer.pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== canvasSize || info.height !== canvasSize) {
      throw new Error(`compose_layer_size_mismatch: layer "${layer.name}" (${layer.id}) is ${info.width}x${info.height}, expected ${canvasSize}x${canvasSize}`);
    }
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      const srcA = data[off + 3] / 255;
      if (srcA === 0) continue; // fully-transparent source pixel: running composite untouched
      const srcR = data[off], srcG = data[off + 1], srcB = data[off + 2];
      const dstA = acc[off + 3];
      const dstR = acc[off], dstG = acc[off + 1], dstB = acc[off + 2];
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) { acc[off] = 0; acc[off + 1] = 0; acc[off + 2] = 0; acc[off + 3] = 0; continue; }
      acc[off] = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
      acc[off + 1] = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
      acc[off + 2] = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;
      acc[off + 3] = outA;
    }
  }

  const outBuf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    outBuf[off] = Math.round(acc[off]);
    outBuf[off + 1] = Math.round(acc[off + 1]);
    outBuf[off + 2] = Math.round(acc[off + 2]);
    outBuf[off + 3] = Math.round(acc[off + 3] * 255);
  }

  return sharp(outBuf, { raw: { width: canvasSize, height: canvasSize, channels: 4 } }).png().toBuffer();
}

/**
 * Per-pixel RGBA Euclidean distance between two same-dimension PNGs —
 * reuses raster-convert.ts's own `colorDistance` FORMULA (RGB Euclidean
 * distance), extended with the alpha channel, rather than importing that
 * function directly (its signature is RGB-only, 3-tuple; alpha needed
 * here is a 1-line addition not worth threading through a 3-tuple
 * signature change to a shared file). A pixel counts as "different" when
 * its distance exceeds `threshold` (default 24, matching this
 * codebase's own DEFAULT_BG_THRESHOLD convention used elsewhere for a
 * similar "close enough to count as the same" judgment). Throws if the
 * two images don't share the same dimensions.
 */
export async function comparePngs(aPngBuffer: Buffer, bPngBuffer: Buffer, threshold = 24): Promise<{ diffPct: number }> {
  const [a, b] = await Promise.all([
    sharp(aPngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bPngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    throw new Error(`compare_pngs_dimension_mismatch: ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
  }
  const n = a.info.width * a.info.height;
  let differentCount = 0;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const dr = a.data[off] - b.data[off];
    const dg = a.data[off + 1] - b.data[off + 1];
    const db = a.data[off + 2] - b.data[off + 2];
    const da = a.data[off + 3] - b.data[off + 3];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db + da * da);
    if (dist > threshold) differentCount++;
  }
  return { diffPct: n > 0 ? (differentCount / n) * 100 : 0 };
}

export interface ComposedTraitAssetsResult {
  rawPngBuffer: Buffer;
  upscaled384PngBuffer: Buffer;
  layersUsed: { id: string; name: string; zIndex: number; layerType: LayerType }[];
  /** The shared canvas size every input trait was validated against
   *  (first trait's own `size`) — i.e. `rawPngBuffer`'s actual
   *  width/height. Surfaced so a caller (e.g. the compose-traits route)
   *  doesn't need to re-decode `rawPngBuffer`'s own PNG metadata just to
   *  report a value this function already computed. */
  canvasSize: number;
}

/**
 * Loads each `traitIds` entry via the existing store
 * (`getTraitAsset`/`getTraitAssetPngBuffer` — reused, not reimplemented),
 * enforces every trait shares the same `size` (first trait's `size`
 * becomes the canvas size — same "first pick establishes the reference"
 * rule the frontend Layer Stack already uses,
 * `layer-stack.ts:getStackCanvasSize`), composites via `composeTraitPngs`,
 * then upscales the result ×8 via the existing, unmodified
 * `upscalePixelArtPng` (Stage 7) — no new upscale logic. Throws
 * `compose_trait_not_found`/`compose_trait_png_missing` naming the
 * offending id, or `compose_canvas_size_mismatch` naming the offending
 * trait, rather than silently dropping or distorting a layer.
 */
export async function composeTraitAssetsById(traitIds: string[]): Promise<ComposedTraitAssetsResult> {
  if (traitIds.length === 0) throw new Error('compose_no_trait_ids');

  const layers: ComposeTraitLayerInput[] = [];
  let canvasSize: number | null = null;
  for (const id of traitIds) {
    const trait = await getTraitAsset(id);
    if (!trait) throw new Error(`compose_trait_not_found: ${id}`);
    const pngBuffer = await getTraitAssetPngBuffer(id);
    if (!pngBuffer) throw new Error(`compose_trait_png_missing: ${id}`);
    if (canvasSize === null) {
      canvasSize = trait.size;
    } else if (trait.size !== canvasSize) {
      throw new Error(`compose_canvas_size_mismatch: trait "${trait.name}" (${id}) is ${trait.size}, expected ${canvasSize}`);
    }
    layers.push({ id: trait.id, name: trait.name, pngBuffer, zIndex: trait.zIndex, layerType: trait.layerType });
  }

  const rawPngBuffer = await composeTraitPngs(layers, canvasSize as number);
  const upscaled384PngBuffer = await upscalePixelArtPng(rawPngBuffer, COMPOSE_UPSCALE);
  const layersUsed = [...layers].sort(compareLayersForCompose)
    .map(l => ({ id: l.id, name: l.name, zIndex: l.zIndex, layerType: l.layerType }));

  return { rawPngBuffer, upscaled384PngBuffer, layersUsed, canvasSize: canvasSize as number };
}
