/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 3 (deterministic semantic
 * trait split MVP). See docs/pixel-forge-image-to-traits-pipeline-mvp.md
 * §10/§11/§13 for the design this implements. Pure image-processing over an
 * already-normalized RgbaImage (see raster-convert.ts) — no Anthropic call,
 * no OpenAI call, no ML, no randomness. Same input always produces the same
 * output.
 *
 * This is explicitly an MVP heuristic, not a general segmentation model: it
 * is tuned around SMB-like animal portrait busts — centered character,
 * flat colors, strong dark outlines, hat/accessory near the top, body/
 * hoodie near the bottom, a dark facial marking near the center. See §13's
 * own honest caveat: small, low-contrast features (eyes, nose/mouth)
 * genuinely cannot be reliably isolated by color/connected-components alone
 * — this module is expected to return them at low confidence or empty with
 * a warning on many real images, and that is a correct, not a buggy,
 * outcome. A human accept/reject step downstream (not built in this stage)
 * is exactly why: this route is preview-only and never calls
 * `saveTraitAsset`.
 *
 * Core technique: every foreground pixel is assigned to EXACTLY ONE of the
 * 7 output layers (a strict partition, first-match-wins by priority order
 * below) — so the union of every non-background layer is, by construction,
 * pixel-identical to the original image's foreground. That's what makes the
 * "composite preview" reconstruction exact rather than approximate.
 */

import { RgbaImage, colorDistance, estimateBackgroundColor } from './raster-convert';
import { LayerType } from './agent-loop';

export type SplitLayerId =
  | 'background' | 'hat_accessory' | 'body_hoodie' | 'head_fur'
  | 'face_mask' | 'eyes' | 'nose_mouth';

/** Every possible layer id, in the same fixed order `splitRasterImage`
 *  always emits them — Stage 5's import-split route validates
 *  `selectedLayerIds` against this rather than re-declaring the list. */
export const SPLIT_LAYER_IDS: readonly SplitLayerId[] = [
  'background', 'hat_accessory', 'body_hoodie', 'face_mask', 'eyes', 'nose_mouth', 'head_fur',
];

export type SplitConfidence = 'high' | 'medium' | 'low';
export type SplitMethod = 'color-mask' | 'component' | 'heuristic';

export interface SplitBbox { x: number; y: number; w: number; h: number; }

export interface SplitLayer {
  layerId: SplitLayerId;
  label: string;
  suggestedLayerType: LayerType;
  confidence: SplitConfidence;
  method: SplitMethod;
  pixelCount: number;
  bbox: SplitBbox;
  warnings: string[];
  /** Internal — same canvas size as the input, transparent outside this
   *  layer's mask. Callers (the HTTP route) render this to a PNG; kept as
   *  an RgbaImage here so this module stays free of any PNG-encoding
   *  dependency beyond what raster-convert.ts already provides. */
  img: RgbaImage;
}

export interface SplitResult {
  layers: SplitLayer[];
  /** Union of every non-background layer's assigned pixels, rendered at
   *  their original colors on a transparent canvas — exact by
   *  construction (see module doc comment), not merely a visual estimate. */
  composite: RgbaImage;
  warnings: string[];
}

export interface SplitOptions {
  /** Background color estimate, e.g. from estimateBackgroundColor() run on
   *  the pre-normalize original image. Optional — if omitted, this module
   *  estimates it from the input image's own four corners instead (correct
   *  for a "keep background" variant; harmless for a "remove background"
   *  variant, whose corners are already transparent and thus excluded from
   *  the foreground mask by the alpha check regardless). */
  bgColor?: [number, number, number];
  /** RGB distance under which a pixel counts as background. Default 24 —
   *  mirrors tools-pixel-forge-raster.ts's own DEFAULT_BG_THRESHOLD. */
  bgThreshold?: number;
}

const DEFAULT_BG_THRESHOLD = 24;
/** Below this average luminance (0-255) a pixel is "dark" — face markings,
 *  pupils, outline. Matches raster-convert.ts's own cleanup threshold. */
const DARK_LUMINANCE_THRESHOLD = 70;
/** Above this per-channel floor (and low channel spread) a pixel is "near
 *  white" — eye catchlights, not general light fur. */
const LIGHT_CHANNEL_MIN = 235;
const LIGHT_CHANNEL_SPREAD_MAX = 30;
/** Components smaller than this on a color mask are treated as stray noise
 *  rather than a real hat/body region, and fall through to head/fur. */
const MIN_REGION_COMPONENT_SIZE = 3;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

type PixelClass = 'dark' | 'light' | 'blue_gold' | 'pink_red' | 'tan_gray';

/** Deliberately mutually exclusive, checked in this fixed priority order —
 *  every foreground pixel gets exactly one class, so the color-mask layers
 *  below never fight over the same pixel. Thresholds are tuned for flat
 *  SMB-like portrait palettes (strong dark outline, saturated hat/hoodie
 *  colors, mid-tone fur), not a general-purpose color namer. */
function classifyPixel(r: number, g: number, b: number): PixelClass {
  // Hue-dominant checks run BEFORE the luminance-based "dark" check,
  // deliberately: a hat/hoodie is typically drawn with two tones of its
  // own color (a bright main fill plus a darker shading/outline tone), and
  // that darker tone can easily have luminance under DARK_LUMINANCE_THRESHOLD
  // even though it's clearly still "that hat's blue," not a generic dark
  // facial marking. Caught concretely on this MVP's own test image: a
  // shaded navy pixel like (13,55,152) has luminance ~53 (would trip the
  // dark check first) despite being unmistakably blue — checking hue first
  // keeps it correctly bucketed with the rest of the hat instead of
  // leaking into face_mask.
  //
  // Blue: blue channel clearly dominant. Gold/yellow: red+green high, blue
  // low, red visibly ahead of blue — both bucketed together as one
  // "hat/accessory" color family per the task's own heuristic rule.
  if (b > r + 15 && b > g + 5) return 'blue_gold';
  if (r > 140 && g > 90 && b < 130 && (r - b) > 40 && (g - b) > 10) return 'blue_gold';
  // Pink/red: red channel STRONGLY dominant over green — a much bigger gap
  // than "dark outline vs. fur" needs, specifically to exclude cream/tan
  // fur tones (e.g. a muzzle highlight around r-g=15-20) that would
  // otherwise false-positive here; real pink/red hoodie samples measured
  // against this MVP's test image sit at r-g=60+ even at their lightest.
  if (r > g + 50 && r > b + 5 && r > 110) return 'pink_red';
  const lum = luminance(r, g, b);
  if (lum < DARK_LUMINANCE_THRESHOLD) return 'dark';
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (r >= LIGHT_CHANNEL_MIN && g >= LIGHT_CHANNEL_MIN && b >= LIGHT_CHANNEL_MIN && spread <= LIGHT_CHANNEL_SPREAD_MAX) {
    return 'light';
  }
  return 'tan_gray';
}

interface Components { labels: Int32Array; sizes: number[]; }

/** 4-connectivity connected-components labeling, deterministic fixed scan
 *  order — same shape/contract as raster-convert.ts's own (private) helper
 *  of the same purpose, duplicated here rather than exported/shared since
 *  this module operates on arbitrary color-class masks, not just opacity,
 *  and this file is meant to stand alone per the task's file layout. */
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

interface ComponentInfo { label: number; size: number; centroidX: number; centroidY: number; bbox: SplitBbox; }

function describeComponents(comps: Components, width: number): ComponentInfo[] {
  const n = comps.labels.length;
  const sumX = new Array(comps.sizes.length).fill(0);
  const sumY = new Array(comps.sizes.length).fill(0);
  const minX = new Array(comps.sizes.length).fill(Infinity);
  const minY = new Array(comps.sizes.length).fill(Infinity);
  const maxX = new Array(comps.sizes.length).fill(-Infinity);
  const maxY = new Array(comps.sizes.length).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const label = comps.labels[i];
    if (label === -1) continue;
    const x = i % width, y = Math.floor(i / width);
    sumX[label] += x; sumY[label] += y;
    if (x < minX[label]) minX[label] = x;
    if (x > maxX[label]) maxX[label] = x;
    if (y < minY[label]) minY[label] = y;
    if (y > maxY[label]) maxY[label] = y;
  }
  return comps.sizes.map((size, label) => ({
    label, size,
    centroidX: sumX[label] / size, centroidY: sumY[label] / size,
    bbox: { x: minX[label], y: minY[label], w: maxX[label] - minX[label] + 1, h: maxY[label] - minY[label] + 1 },
  }));
}

function computeBbox(mask: Uint8Array, width: number, height: number): SplitBbox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function maskToImage(img: RgbaImage, mask: Uint8Array): RgbaImage {
  const data = Buffer.alloc(img.data.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const off = i * 4;
    data[off] = img.data[off]; data[off + 1] = img.data[off + 1];
    data[off + 2] = img.data[off + 2]; data[off + 3] = img.data[off + 3];
  }
  return { width: img.width, height: img.height, data };
}

function emptyBbox(): SplitBbox { return { x: 0, y: 0, w: 0, h: 0 }; }

/** Sets `mask[i] = 1` for every pixel of every component in `comps` whose
 *  size is >= minSize, and marks it `assigned` so later passes skip it. */
function assignComponents(
  comps: ComponentInfo[], labels: Int32Array, minSize: number, assigned: Uint8Array,
): { mask: Uint8Array; pixelCount: number } {
  const mask = new Uint8Array(labels.length);
  const keep = new Set(comps.filter(c => c.size >= minSize).map(c => c.label));
  let pixelCount = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === -1 || !keep.has(label)) continue;
    mask[i] = 1; assigned[i] = 1; pixelCount++;
  }
  return { mask, pixelCount };
}

export function splitRasterImage(img: RgbaImage, options: SplitOptions = {}): SplitResult {
  const { width, height, data } = img;
  const n = width * height;
  const topWarnings: string[] = [];
  const bgThreshold = options.bgThreshold ?? DEFAULT_BG_THRESHOLD;
  const bgColor = options.bgColor ?? estimateBackgroundColor(img);

  // ── foreground mask: opaque AND not background-colored ─────────────────
  const foreground = new Uint8Array(n);
  let foregroundCount = 0;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    if (data[off + 3] < 128) continue;
    const rgb: [number, number, number] = [data[off], data[off + 1], data[off + 2]];
    if (colorDistance(rgb, bgColor) <= bgThreshold) continue;
    foreground[i] = 1; foregroundCount++;
  }

  const backgroundMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) backgroundMask[i] = foreground[i] ? 0 : 1;

  const layers: SplitLayer[] = [];
  const assigned = new Uint8Array(n); // 1 once a foreground pixel has a home

  // ── background layer (not part of the foreground partition) ────────────
  {
    const pixelCount = n - foregroundCount;
    const warnings: string[] = [];
    if (foregroundCount === n) warnings.push('No background pixels detected — image may fill the entire canvas.');
    layers.push({
      layerId: 'background', label: 'Background', suggestedLayerType: 'background',
      confidence: pixelCount > 0 ? 'high' : 'low', method: 'color-mask',
      pixelCount, bbox: computeBbox(backgroundMask, width, height) ?? emptyBbox(),
      warnings, img: maskToImage(img, backgroundMask),
    });
  }

  if (foregroundCount === 0) {
    topWarnings.push('No foreground pixels detected at all — every other layer will be empty.');
  }
  const fgBbox = computeBbox(foreground, width, height);

  // ── classify every foreground pixel once ────────────────────────────────
  const cls = new Uint8Array(n); // index into CLASS_NAMES, only meaningful where foreground[i] === 1
  const CLASS_NAMES: PixelClass[] = ['dark', 'light', 'blue_gold', 'pink_red', 'tan_gray'];
  for (let i = 0; i < n; i++) {
    if (!foreground[i]) continue;
    const off = i * 4;
    const c = classifyPixel(data[off], data[off + 1], data[off + 2]);
    cls[i] = CLASS_NAMES.indexOf(c);
  }
  const isClass = (i: number, c: PixelClass) => foreground[i] === 1 && CLASS_NAMES[cls[i]] === c;

  // ── hat/accessory: blue/gold, upper band of the foreground bbox ────────
  // `hatBbox` is captured (even on failure, as null) for the face-mask step
  // below — a hat's black OUTLINE isn't itself blue/gold, so it's still
  // "dark" and unassigned after this block; anchoring the face region's
  // top edge to just below the hat's own bbox (rather than a fixed
  // fraction of the whole portrait) keeps that outline out of face_mask.
  let hatBbox: SplitBbox | null = null;
  {
    const upperLimit = fgBbox ? fgBbox.y + fgBbox.h * 0.50 : height;
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      const y = Math.floor(i / width);
      if (isClass(i, 'blue_gold') && y <= upperLimit) raw[i] = 1;
    }
    const labeled = labelMask(raw, width, height);
    const comps = describeComponents(labeled, width);
    const { mask, pixelCount } = assignComponents(comps, labeled.labels, MIN_REGION_COMPONENT_SIZE, assigned);
    const warnings: string[] = [];
    let confidence: SplitConfidence = 'low';
    if (pixelCount === 0) warnings.push('No blue/gold upper-region component found — hat/accessory may be absent, a different color, or below the detection threshold.');
    else { confidence = foregroundCount > 0 && pixelCount / foregroundCount >= 0.03 ? 'high' : 'medium'; hatBbox = computeBbox(mask, width, height); }
    layers.push({
      layerId: 'hat_accessory', label: 'Hat / Accessory', suggestedLayerType: 'accessory',
      confidence, method: 'color-mask', pixelCount,
      bbox: hatBbox ?? emptyBbox(), warnings, img: maskToImage(img, mask),
    });
  }

  // ── body/hoodie: pink/red, lower band of the foreground bbox ────────────
  {
    const lowerLimit = fgBbox ? fgBbox.y + fgBbox.h * 0.45 : 0;
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      const y = Math.floor(i / width);
      if (isClass(i, 'pink_red') && y >= lowerLimit) raw[i] = 1;
    }
    const labeled = labelMask(raw, width, height);
    const comps = describeComponents(labeled, width);
    const { mask, pixelCount } = assignComponents(comps, labeled.labels, MIN_REGION_COMPONENT_SIZE, assigned);
    const warnings: string[] = [];
    let confidence: SplitConfidence = 'low';
    if (pixelCount === 0) warnings.push('No pink/red lower-region component found — body/hoodie may be absent, a different color, or below the detection threshold.');
    else confidence = foregroundCount > 0 && pixelCount / foregroundCount >= 0.03 ? 'high' : 'medium';
    layers.push({
      layerId: 'body_hoodie', label: 'Body / Hoodie', suggestedLayerType: 'body',
      confidence, method: 'color-mask', pixelCount,
      bbox: computeBbox(mask, width, height) ?? emptyBbox(), warnings, img: maskToImage(img, mask),
    });
  }

  // ── face mask: dark component(s) near the center of the foreground bbox ─
  let faceBbox: SplitBbox | null = null;
  let smallDarkComps: ComponentInfo[] = [];
  let darkLabeled: Components | null = null;
  {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (!assigned[i] && isClass(i, 'dark')) raw[i] = 1; }
    darkLabeled = labelMask(raw, width, height);
    const comps = describeComponents(darkLabeled, width);
    const warnings: string[] = [];
    let mask: Uint8Array = new Uint8Array(n);
    let pixelCount = 0;
    let confidence: SplitConfidence = 'low';

    if (fgBbox && comps.length > 0) {
      // "Near center": horizontally within the middle 70% of the bbox,
      // vertically not in the very top (hat territory) or very bottom
      // (body territory) — the band a face sits in on a bust portrait.
      const xMin = fgBbox.x + fgBbox.w * 0.15, xMax = fgBbox.x + fgBbox.w * 0.85;
      // Push below the detected hat itself, when there is one, rather than
      // trusting a fixed fraction alone — a hat's own black outline is
      // "dark" but not blue/gold, so it's still unassigned at this point,
      // and a fixed fraction alone can let it slip into the central band.
      const yMin = Math.max(fgBbox.y + fgBbox.h * 0.20, hatBbox ? hatBbox.y + hatBbox.h : -Infinity);
      const yMax = fgBbox.y + fgBbox.h * 0.90;
      const central = comps.filter(c => c.centroidX >= xMin && c.centroidX <= xMax && c.centroidY >= yMin && c.centroidY <= yMax);
      if (central.length > 0) {
        const largestSize = Math.max(...central.map(c => c.size));
        // "Substantial" dark blobs (the mask/eye-patch shape itself) vs.
        // tiny residue (pupil/nose/mouth candidates) — see the eyes/
        // nose_mouth sections below, which consume `smallDarkComps`.
        const faceComps = central.filter(c => c.size >= Math.max(2, largestSize * 0.15));
        smallDarkComps = central.filter(c => c.size < Math.max(2, largestSize * 0.15));
        const assignResult = assignComponents(faceComps, darkLabeled.labels, 1, assigned);
        mask = assignResult.mask; pixelCount = assignResult.pixelCount;
        if (pixelCount > 0) {
          faceBbox = computeBbox(mask, width, height);
          confidence = foregroundCount > 0 && pixelCount / foregroundCount >= 0.05 ? 'high' : 'medium';
        }
      }
    }
    if (pixelCount === 0) {
      warnings.push('No centered dark facial component found — face mask may be absent, low-contrast against fur, or this heuristic does not fit this portrait\'s layout.');
    }
    layers.push({
      layerId: 'face_mask', label: 'Face Mask', suggestedLayerType: 'other',
      confidence, method: 'component', pixelCount,
      bbox: faceBbox ?? emptyBbox(), warnings, img: maskToImage(img, mask),
    });
  }

  // ── eyes: small dark residue (upper half of face bbox) + near-white
  // catchlight pixels within the face bbox ────────────────────────────────
  {
    const raw = new Uint8Array(n);
    let usedDarkResidue = false, usedLight = false;
    if (faceBbox) {
      const midY = faceBbox.y + faceBbox.h / 2;
      for (const c of smallDarkComps) {
        if (c.centroidY > midY) continue;
        for (let i = 0; i < n; i++) {
          if (assigned[i]) continue;
          if (darkLabeled!.labels[i] === c.label) { raw[i] = 1; usedDarkResidue = true; }
        }
      }
      const expand = Math.max(1, Math.round(faceBbox.w * 0.1));
      for (let i = 0; i < n; i++) {
        if (assigned[i] || raw[i] || !isClass(i, 'light')) continue;
        const x = i % width, y = Math.floor(i / width);
        if (x >= faceBbox.x - expand && x <= faceBbox.x + faceBbox.w + expand
          && y >= faceBbox.y - expand && y <= faceBbox.y + faceBbox.h + expand) {
          raw[i] = 1; usedLight = true;
        }
      }
    }
    let pixelCount = 0;
    for (let i = 0; i < n; i++) { if (raw[i]) { assigned[i] = 1; pixelCount++; } }
    const warnings: string[] = [];
    let confidence: SplitConfidence = 'low';
    if (pixelCount === 0) {
      warnings.push('No distinct small dark/light component found inside the face region — eyes are low-contrast against the face mask on this image, a known limitation of pure color/component splitting (see the design doc\'s §13).');
    } else {
      confidence = usedDarkResidue && usedLight ? 'medium' : 'low';
      if (confidence === 'low') warnings.push('Eyes detected from only one signal (dark residue or highlight, not both) — verify manually before use.');
    }
    layers.push({
      layerId: 'eyes', label: 'Eyes', suggestedLayerType: 'eyes',
      confidence, method: 'component', pixelCount,
      bbox: computeBbox(raw, width, height) ?? emptyBbox(), warnings, img: maskToImage(img, raw),
    });
  }

  // ── nose/mouth: small dark residue in the lower half of the face bbox ───
  {
    const raw = new Uint8Array(n);
    if (faceBbox) {
      const midY = faceBbox.y + faceBbox.h / 2;
      for (const c of smallDarkComps) {
        if (c.centroidY <= midY) continue;
        for (let i = 0; i < n; i++) {
          if (assigned[i]) continue;
          if (darkLabeled!.labels[i] === c.label) raw[i] = 1;
        }
      }
    }
    let pixelCount = 0;
    for (let i = 0; i < n; i++) { if (raw[i]) { assigned[i] = 1; pixelCount++; } }
    const warnings: string[] = [];
    let confidence: SplitConfidence = 'low';
    if (pixelCount === 0) {
      warnings.push('No distinct small dark component found below the face mask\'s midline — nose/mouth is low-contrast or merged with the face mask on this image (see the design doc\'s §13).');
    } else {
      confidence = 'medium';
    }
    layers.push({
      layerId: 'nose_mouth', label: 'Nose / Mouth', suggestedLayerType: 'mouth',
      confidence, method: 'component', pixelCount,
      bbox: computeBbox(raw, width, height) ?? emptyBbox(), warnings, img: maskToImage(img, raw),
    });
  }

  // ── head/fur: every remaining unassigned foreground pixel (catch-all,
  // guarantees the partition is lossless) ─────────────────────────────────
  {
    const raw = new Uint8Array(n);
    let pixelCount = 0, tanCount = 0;
    for (let i = 0; i < n; i++) {
      if (!foreground[i] || assigned[i]) continue;
      raw[i] = 1; assigned[i] = 1; pixelCount++;
      if (isClass(i, 'tan_gray')) tanCount++;
    }
    const warnings: string[] = [];
    let confidence: SplitConfidence = 'low';
    let method: SplitMethod = 'heuristic';
    if (pixelCount === 0) {
      warnings.push('No remaining pixels — every foreground pixel was claimed by another layer.');
    } else {
      const tanFraction = tanCount / pixelCount;
      if (tanFraction >= 0.7) { confidence = 'high'; method = 'color-mask'; }
      else if (tanFraction >= 0.4) { confidence = 'medium'; method = 'heuristic'; }
      else {
        confidence = 'low';
        warnings.push('Most of this layer is leftover foreground pixels not matched by the tan/gray fur heuristic — treat as a catch-all, not a confident fur mask.');
      }
    }
    layers.push({
      layerId: 'head_fur', label: 'Head / Fur', suggestedLayerType: 'body',
      confidence, method, pixelCount,
      bbox: computeBbox(raw, width, height) ?? emptyBbox(), warnings, img: maskToImage(img, raw),
    });
  }

  // ── composite: every foreground pixel at its original color — exact by
  // construction, since `assigned` above is a strict partition of foreground.
  const compositeData = Buffer.alloc(img.data.length);
  for (let i = 0; i < n; i++) {
    if (!foreground[i]) continue;
    const off = i * 4;
    compositeData[off] = data[off]; compositeData[off + 1] = data[off + 1];
    compositeData[off + 2] = data[off + 2]; compositeData[off + 3] = data[off + 3];
  }

  return {
    layers,
    composite: { width, height, data: compositeData },
    warnings: topWarnings,
  };
}
