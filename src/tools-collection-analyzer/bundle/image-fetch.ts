/**
 * Collection Analyzer - Stage 3 image download + validation.
 *
 * Downloads one asset's image (already-resolved `NormalizedAsset.image`
 * URL - no re-scan, per Stage 3 scope) through the SSRF-safe downloader,
 * then validates the ACTUAL file content via `sharp` (already a project
 * dependency) rather than trusting the response `Content-Type` header or
 * the URL's path extension. Only PNG/JPEG/WebP/GIF are accepted - video,
 * HTML, SVG, JSON, and any other binary are rejected even if a server
 * mislabels its Content-Type as an image type (sharp sniffs real content;
 * SVG is explicitly excluded from the accepted format set below even
 * though some sharp builds can rasterize it).
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { downloadToFile, type AddressValidator } from './ssrf-guard';
import { extensionForFormat, SUPPORTED_IMAGE_FORMATS } from './bundle-filenames';
import { BUNDLE_MAX_IMAGE_BYTES } from './bundle-limits';
import type { DownloadFailureCode } from './bundle-types';

export interface ImageFetchResult {
  ok: true;
  finalPath: string;
  bytesWritten: number;
  retryCount: number;
}
export interface ImageFetchFailure {
  ok: false;
  code: DownloadFailureCode;
  retryCount: number;
}

/** Downloads and validates one image. `destDirWithoutExt` is the target
 *  path WITHOUT an extension - the real extension is appended only after
 *  content validation determines it, so a rejected/failed download never
 *  leaves a misleadingly-named file behind. */
export async function fetchAssetImage(
  imageUrl: string | null,
  destDirWithoutExt: string,
  signal: AbortSignal,
  /** TEST-ONLY — see ssrf-guard.ts `DownloadOptions.isDestinationAllowedOverride`. */
  isDestinationAllowedOverride?: AddressValidator,
): Promise<ImageFetchResult | ImageFetchFailure> {
  if (!imageUrl) return { ok: false, code: 'no_source_url', retryCount: 0 };

  const tempPath = `${destDirWithoutExt}.tmp`;
  const { outcome, retryCount } = await downloadToFile(imageUrl, {
    destPath: tempPath,
    maxBytes: BUNDLE_MAX_IMAGE_BYTES,
    signal,
    isDestinationAllowedOverride,
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, retryCount };

  let format: string | undefined;
  try {
    const metadata = await sharp(tempPath).metadata();
    format = metadata.format;
  } catch {
    await unlinkQuiet(tempPath);
    return { ok: false, code: 'unsupported_content_type', retryCount };
  }

  if (!format || !SUPPORTED_IMAGE_FORMATS.has(format)) {
    await unlinkQuiet(tempPath);
    return { ok: false, code: 'unsupported_content_type', retryCount };
  }

  const ext = extensionForFormat(format);
  if (!ext) {
    await unlinkQuiet(tempPath);
    return { ok: false, code: 'unsupported_content_type', retryCount };
  }

  const finalPath = `${destDirWithoutExt}.${ext}`;
  await fs.promises.rename(tempPath, finalPath);
  return { ok: true, finalPath, bytesWritten: outcome.bytesWritten, retryCount };
}

async function unlinkQuiet(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort */ }
}

/** Convenience - the directory an image for `mint` should land in, before
 *  the extension is known. */
export function imageDestWithoutExt(imagesDir: string, mint: string): string {
  return path.join(imagesDir, mint);
}
