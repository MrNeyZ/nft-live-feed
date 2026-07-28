/**
 * Trait Extraction Core - image acquisition + RGBA decoding.
 *
 * This is the package's default `ImageAcquirer` implementation - the SSRF-
 * safe downloader (`./ssrf-guard.ts`, moved here from the app's Stage 3/4
 * bundle feature since it has no Express/server dependency either) with
 * DNS/redirect validation, "no cookies/auth/secrets forwarded", 429/5xx-only
 * retry policy. Content is validated via real `sharp` decoding (never trusts
 * Content-Type/URL extension) against a narrow png/jpeg/webp/gif allowlist.
 *
 * "Download each unique source image only once per job" (spec section 7)
 * is implemented as a Promise-memoized per-job cache: concurrent callers
 * for the same URL share one in-flight download+decode, and a second call
 * after completion is a cache hit.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { downloadToFile, type AddressValidator } from './ssrf-guard';
import {
  TE_MAX_DECODED_BYTES_PER_IMAGE,
  TE_MAX_IMAGE_BYTES,
  TE_MAX_IMAGE_HEIGHT,
  TE_MAX_IMAGE_PIXELS,
  TE_MAX_IMAGE_WIDTH,
  TE_MAX_REDIRECTS,
  TE_MAX_TOTAL_DECODED_BYTES,
  TE_PER_RESOURCE_TIMEOUT_MS,
} from './te-limits';

/** sharp-reported format allowlist - deliberately narrow, matches the
 *  app's bundle/bundle-filenames.ts SUPPORTED_IMAGE_FORMATS (kept as its
 *  own local copy so this package has zero import back into the app). */
const SUPPORTED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'gif']);

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, width*height*4 bytes, top-left origin, row-major. */
  data: Buffer;
  bytesDownloaded: number;
}

export type ImageDecodeFailureCode =
  | 'no_source_url' | 'download_failed' | 'oversized_dimensions' | 'unsupported_content_type'
  | 'decode_failed' | 'total_decoded_budget_exceeded' | 'cancelled';

export type ImageDecodeOutcome = { ok: true; image: DecodedImage } | { ok: false; code: ImageDecodeFailureCode };

/** Per-job image cache + dedup. One instance per trait-extraction job. */
export class ImageDecodeCache {
  private cache = new Map<string, Promise<ImageDecodeOutcome>>();
  private totalDecodedBytes = 0;
  private totalDownloadedBytes = 0;

  constructor(
    private readonly workDir: string,
    private readonly signal: AbortSignal,
    private readonly isDestinationAllowedOverride?: AddressValidator,
  ) {}

  get uniqueImageCount(): number { return this.cache.size; }
  get bytesDownloaded(): number { return this.totalDownloadedBytes; }

  get(url: string | null): Promise<ImageDecodeOutcome> {
    if (!url) return Promise.resolve({ ok: false, code: 'no_source_url' });
    let p = this.cache.get(url);
    if (p) return p;
    p = this.fetchAndDecode(url);
    this.cache.set(url, p);
    return p;
  }

  private async fetchAndDecode(url: string): Promise<ImageDecodeOutcome> {
    if (this.signal.aborted) return { ok: false, code: 'cancelled' };
    const tmpName = `src-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
    const destPath = path.join(this.workDir, tmpName);

    const { outcome } = await downloadToFile(url, {
      destPath,
      maxBytes: TE_MAX_IMAGE_BYTES,
      timeoutMs: TE_PER_RESOURCE_TIMEOUT_MS,
      maxRedirects: TE_MAX_REDIRECTS,
      signal: this.signal,
      isDestinationAllowedOverride: this.isDestinationAllowedOverride,
    });
    if (!outcome.ok) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'download_failed' };
    }
    this.totalDownloadedBytes += outcome.bytesWritten;

    const metadata = await sharp(destPath).metadata().catch(() => null);
    if (!metadata) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'decode_failed' };
    }
    if (!metadata.format || !SUPPORTED_IMAGE_FORMATS.has(metadata.format)) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'unsupported_content_type' };
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0 || width > TE_MAX_IMAGE_WIDTH || height > TE_MAX_IMAGE_HEIGHT || width * height > TE_MAX_IMAGE_PIXELS) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'oversized_dimensions' };
    }
    const decodedBytes = width * height * 4;
    if (decodedBytes > TE_MAX_DECODED_BYTES_PER_IMAGE) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'oversized_dimensions' };
    }
    if (this.totalDecodedBytes + decodedBytes > TE_MAX_TOTAL_DECODED_BYTES) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'total_decoded_budget_exceeded' };
    }

    // animated:false -> GIF decodes its first frame only (documented per
    // spec section 7's "GIF first frame only").
    const raw = await sharp(destPath, { animated: false }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true }).catch(() => null);
    if (!raw) {
      await unlinkQuiet(destPath);
      return { ok: false, code: 'decode_failed' };
    }
    await unlinkQuiet(destPath); // only the decoded RGBA buffer is kept in memory henceforth

    this.totalDecodedBytes += decodedBytes;
    return {
      ok: true,
      image: { width: raw.info.width, height: raw.info.height, data: raw.data, bytesDownloaded: outcome.bytesWritten },
    };
  }
}

async function unlinkQuiet(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort */ }
}
