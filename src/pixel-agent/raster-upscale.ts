/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 7 (pixel-art upscale).
 * See docs/pixel-forge-image-to-traits-pipeline-mvp.md. Deterministic
 * nearest-neighbor upscale only — no smoothing, no antialiasing, no AI.
 * Every source pixel becomes an exact `scale`×`scale` block of identical
 * color/alpha; this is the standard "pixel-art scaling" operation, NOT a
 * general-purpose image resize (which would blur edges).
 *
 * `scale` defaults to, and for this stage is fixed at, 8 — this
 * pipeline's canonical raw grid (48×48, the default/max `targetSize` in
 * tools-pixel-forge-raster.ts) becomes exactly 384×384 (48*8=384), the
 * correct main export size. 400×400 was explicitly ruled out: 400/48 is
 * not an integer, so it cannot be produced by pure nearest-neighbor block
 * replication without uneven block sizes on some edge — that would
 * silently break "every source pixel becomes an exact N×N block," the
 * one invariant this whole module exists to guarantee. A smaller stored
 * trait (e.g. 32×32) still scales correctly at ×8 (→256×256); the
 * function itself is size-agnostic, only the *default* scale is fixed.
 */

import sharp from 'sharp';

/**
 * Upscales a PNG (as bytes) by an integer factor using nearest-neighbor
 * sampling only. Pure function — never mutates `inputPngBuffer`, and
 * makes no network/file-system/AI call of any kind.
 *
 * Deliberately does NOT use sharp/libvips's own `resize({ kernel:
 * 'nearest' })` — that was tried first and rejected during this module's
 * own testing: libvips still routes every resize (regardless of kernel)
 * through an internal premultiply-alpha / unpremultiply round-trip, which
 * is exactly right for a smooth resize's blending math but has no reason
 * to run at all for nearest-neighbor, and introduces a real, measurable
 * side effect — a fully transparent (alpha=0) source pixel's RGB comes
 * back zeroed, and a partially-transparent pixel's RGB can be off by ±1.
 * Neither is "blur" in the blend-between-neighbors sense (a hard color
 * boundary between two adjacent blocks stays perfectly sharp either way),
 * but it does mean the output isn't a byte-exact replication of the
 * source, which this task explicitly requires ("every source pixel
 * becomes an exact scale×scale block"). Building the enlarged raw buffer
 * by hand — a straight byte-for-byte copy per output pixel, no
 * interpolation math anywhere — sidesteps the whole question by
 * construction: there is nothing for any alpha handling to round.
 *
 * @param inputPngBuffer Source PNG bytes (any square or non-square size).
 * @param scale Integer scale factor, minimum 1. Defaults to 8.
 * @returns The upscaled image, re-encoded as PNG bytes, alpha preserved
 *   byte-for-byte.
 */
export async function upscalePixelArtPng(inputPngBuffer: Buffer, scale = 8): Promise<Buffer> {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error('upscale_invalid_scale');
  }

  const { data: srcData, info } = await sharp(inputPngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height) {
    throw new Error('upscale_source_unreadable');
  }

  const outWidth = width * scale;
  const outHeight = height * scale;
  const outData = Buffer.alloc(outWidth * outHeight * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const r = srcData[srcOff], g = srcData[srcOff + 1], b = srcData[srcOff + 2], a = srcData[srcOff + 3];
      const baseOutX = x * scale, baseOutY = y * scale;
      for (let by = 0; by < scale; by++) {
        let rowOff = ((baseOutY + by) * outWidth + baseOutX) * 4;
        for (let bx = 0; bx < scale; bx++) {
          outData[rowOff] = r; outData[rowOff + 1] = g; outData[rowOff + 2] = b; outData[rowOff + 3] = a;
          rowOff += 4;
        }
      }
    }
  }

  return sharp(outData, { raw: { width: outWidth, height: outHeight, channels: 4 } }).png().toBuffer();
}
