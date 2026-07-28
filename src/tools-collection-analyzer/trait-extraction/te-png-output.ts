/**
 * Trait Extraction - PNG output builders. Pure image composition over
 * already-computed masks/colors via Sharp - no further inference here.
 */
import sharp from 'sharp';
import type { BinaryMask, ConsensusResult } from './te-pixel-diff';
import type { PixelBoundingBox } from './te-types';

/** candidate.png / candidate-expanded.png: full original canvas size,
 *  transparent outside `mask`, estimated median color inside it. */
export async function buildCandidatePng(consensus: ConsensusResult, mask: BinaryMask): Promise<Buffer> {
  const { width, height, estimatedColor } = consensus;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    out[o] = estimatedColor[o]; out[o + 1] = estimatedColor[o + 1]; out[o + 2] = estimatedColor[o + 2]; out[o + 3] = 255;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** change-mask.png / uncertainty-mask.png: diagnostic - semi-transparent
 *  color overlay wherever the mask is set, fully transparent elsewhere. */
export async function buildMaskOverlayPng(mask: BinaryMask, width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 190;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function checkerboardBuffer(width: number, height: number, cell = 8): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const light = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = light ? 235 : 205;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}

export interface PreviewResult {
  buffer: Buffer;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** preview.png: checkerboard-backed crop around the candidate's bounding
 *  box (padded), with x/y offset recorded so the crop can be traced back
 *  to the full-canvas coordinate space (spec section 7, step 13). Falls
 *  back to the full canvas when there's no bounding box to crop to. */
export async function buildPreviewPng(
  candidatePng: Buffer,
  boundingBox: PixelBoundingBox | null,
  canvasWidth: number,
  canvasHeight: number,
  pad = 8,
): Promise<PreviewResult> {
  const region = boundingBox
    ? {
        x: Math.max(0, boundingBox.x - pad),
        y: Math.max(0, boundingBox.y - pad),
        width: Math.min(canvasWidth - Math.max(0, boundingBox.x - pad), boundingBox.width + pad * 2),
        height: Math.min(canvasHeight - Math.max(0, boundingBox.y - pad), boundingBox.height + pad * 2),
      }
    : { x: 0, y: 0, width: canvasWidth, height: canvasHeight };

  const bg = checkerboardBuffer(region.width, region.height);
  const cropped = await sharp(candidatePng).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png().toBuffer();
  const composed = await sharp(bg, { raw: { width: region.width, height: region.height, channels: 4 } })
    .composite([{ input: cropped }])
    .png()
    .toBuffer();
  return { buffer: composed, offsetX: region.x, offsetY: region.y, width: region.width, height: region.height };
}
