/**
 * trait-extractor-cli - persistent on-disk ImageAcquirer.
 *
 * Same SSRF-guarded download + sharp-verified decode pipeline as the
 * website's in-memory `ImageDecodeCache` (trait-extraction-core/te-image-io),
 * but durable across process restarts: raw downloaded bytes + a small
 * metadata sidecar are kept under --output/cache/, keyed by a hash of the
 * source URL. A resumed run that already has a valid cache entry for a URL
 * skips the network entirely; a permanently-invalid entry (bad format,
 * oversized, corrupt) is remembered so it isn't retried forever; a
 * transient failure (download_failed - could be a flaky host or a dead
 * network at the time) is NOT cached as permanent, so resume retries it.
 *
 * Deliberately caches the raw compressed bytes, not decoded RGBA - decoding
 * is cheap (one sharp call) and RGBA buffers for a full collection would
 * dwarf disk usage; only ever one decoded image is held in memory here at
 * a time (spec section 6: don't load the whole collection into memory).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import {
  downloadToFile,
  TE_MAX_DECODED_BYTES_PER_IMAGE,
  TE_MAX_IMAGE_BYTES,
  TE_MAX_IMAGE_HEIGHT,
  TE_MAX_IMAGE_PIXELS,
  TE_MAX_IMAGE_WIDTH,
  TE_MAX_REDIRECTS,
  TE_MAX_TOTAL_DECODED_BYTES,
  TE_PER_RESOURCE_TIMEOUT_MS,
} from 'trait-extraction-core';
import type { AddressValidator, DecodedImage, ImageAcquirer, ImageDecodeOutcome, ImageDecodeFailureCode } from 'trait-extraction-core';

const SUPPORTED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'gif']);

/** Failure codes worth remembering permanently on disk - the URL's content
 *  itself is the problem, not the network at fetch time. `download_failed`
 *  and `cancelled` are deliberately excluded so a resume always retries them. */
const PERMANENT_FAILURE_CODES: ReadonlySet<ImageDecodeFailureCode> = new Set([
  'unsupported_content_type', 'oversized_dimensions', 'decode_failed', 'total_decoded_budget_exceeded',
]);

interface CacheMeta {
  url: string;
  ok: boolean;
  code?: ImageDecodeFailureCode;
  width?: number;
  height?: number;
  bytesDownloaded?: number;
}

function urlKey(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

async function writeAtomic(destPath: string, content: Buffer | string): Promise<void> {
  const tmp = path.join(path.dirname(destPath), `.tmp-${crypto.randomBytes(6).toString('hex')}-${path.basename(destPath)}`);
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, destPath);
}

async function readJsonQuiet<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.promises.readFile(p, 'utf8')) as T; } catch { return null; }
}

async function unlinkQuiet(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort */ }
}

export class LocalImageCache implements ImageAcquirer {
  private inFlight = new Map<string, Promise<ImageDecodeOutcome>>();
  private downloadedThisRun = 0;
  private decodedBytesThisRun = 0;
  private uniqueSeen = new Set<string>();

  constructor(
    private readonly cacheDir: string,
    private readonly signal: AbortSignal,
    private readonly isDestinationAllowedOverride?: AddressValidator,
  ) {}

  get uniqueImageCount(): number { return this.uniqueSeen.size; }
  get bytesDownloaded(): number { return this.downloadedThisRun; }

  get(url: string | null): Promise<ImageDecodeOutcome> {
    if (!url) return Promise.resolve({ ok: false, code: 'no_source_url' });
    this.uniqueSeen.add(url);
    let p = this.inFlight.get(url);
    if (p) return p;
    p = this.resolve(url);
    this.inFlight.set(url, p);
    return p;
  }

  private metaPath(key: string): string { return path.join(this.cacheDir, `${key}.meta.json`); }
  private binPath(key: string): string { return path.join(this.cacheDir, `${key}.bin`); }

  private async resolve(url: string): Promise<ImageDecodeOutcome> {
    const key = urlKey(url);
    const cached = await readJsonQuiet<CacheMeta>(this.metaPath(key));
    if (cached && cached.url === url) {
      if (cached.ok) {
        const decoded = await this.decodeFromDisk(key, cached);
        if (decoded) return decoded;
        // Cached bytes missing/corrupt on disk despite a valid meta sidecar
        // (e.g. cache dir partially deleted by hand) - fall through and
        // re-download rather than trusting a stale success record.
      } else if (cached.code && PERMANENT_FAILURE_CODES.has(cached.code)) {
        return { ok: false, code: cached.code };
      }
    }
    return this.fetchAndDecode(url, key);
  }

  private async decodeFromDisk(key: string, meta: CacheMeta): Promise<ImageDecodeOutcome | null> {
    try {
      const raw = await sharp(this.binPath(key), { animated: false }).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      const image: DecodedImage = {
        width: raw.info.width, height: raw.info.height, data: raw.data,
        bytesDownloaded: meta.bytesDownloaded ?? 0,
      };
      return { ok: true, image };
    } catch {
      return null;
    }
  }

  private async fetchAndDecode(url: string, key: string): Promise<ImageDecodeOutcome> {
    if (this.signal.aborted) return { ok: false, code: 'cancelled' };
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const tmpDownloadPath = path.join(this.cacheDir, `.dl-${key}`);

    const fail = async (code: ImageDecodeFailureCode): Promise<ImageDecodeOutcome> => {
      await unlinkQuiet(tmpDownloadPath);
      if (PERMANENT_FAILURE_CODES.has(code)) {
        await writeAtomic(this.metaPath(key), JSON.stringify({ url, ok: false, code } satisfies CacheMeta, null, 2));
      }
      return { ok: false, code };
    };

    const { outcome } = await downloadToFile(url, {
      destPath: tmpDownloadPath,
      maxBytes: TE_MAX_IMAGE_BYTES,
      timeoutMs: TE_PER_RESOURCE_TIMEOUT_MS,
      maxRedirects: TE_MAX_REDIRECTS,
      signal: this.signal,
      isDestinationAllowedOverride: this.isDestinationAllowedOverride,
    });
    if (!outcome.ok) return fail('download_failed');
    this.downloadedThisRun += outcome.bytesWritten;

    const metadata = await sharp(tmpDownloadPath).metadata().catch(() => null);
    if (!metadata) return fail('decode_failed');
    if (!metadata.format || !SUPPORTED_IMAGE_FORMATS.has(metadata.format)) return fail('unsupported_content_type');
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0 || width > TE_MAX_IMAGE_WIDTH || height > TE_MAX_IMAGE_HEIGHT || width * height > TE_MAX_IMAGE_PIXELS) {
      return fail('oversized_dimensions');
    }
    const decodedBytes = width * height * 4;
    if (decodedBytes > TE_MAX_DECODED_BYTES_PER_IMAGE) return fail('oversized_dimensions');
    if (this.decodedBytesThisRun + decodedBytes > TE_MAX_TOTAL_DECODED_BYTES) return fail('total_decoded_budget_exceeded');

    const raw = await sharp(tmpDownloadPath, { animated: false }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true }).catch(() => null);
    if (!raw) return fail('decode_failed');

    // Persist the validated compressed bytes (not the decoded RGBA) plus a
    // meta sidecar, atomically - only after both files land does a resumed
    // run consider this URL cached.
    await writeAtomic(this.binPath(key), await fs.promises.readFile(tmpDownloadPath));
    await unlinkQuiet(tmpDownloadPath);
    await writeAtomic(this.metaPath(key), JSON.stringify({
      url, ok: true, width, height, bytesDownloaded: outcome.bytesWritten,
    } satisfies CacheMeta, null, 2));

    this.decodedBytesThisRun += decodedBytes;
    return {
      ok: true,
      image: { width: raw.info.width, height: raw.info.height, data: raw.data, bytesDownloaded: outcome.bytesWritten },
    };
  }
}
