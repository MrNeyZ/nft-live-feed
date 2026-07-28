/**
 * Trait Extraction Core - the `ImageAcquirer` interface the orchestrator
 * depends on (dependency injection point for image acquisition, per
 * Stage 5.3 section 2). `ImageDecodeCache` (te-image-io.ts) is the
 * default, SSRF-guarded, per-job-memoized implementation the website
 * adapter uses; the CLI provides its OWN implementation backed by a
 * persistent on-disk cache (URL/mint dedup across process restarts) while
 * satisfying the exact same shape.
 */
import type { ImageDecodeOutcome } from './te-image-io';

export interface ImageAcquirer {
  get(url: string | null): Promise<ImageDecodeOutcome>;
  readonly uniqueImageCount: number;
  readonly bytesDownloaded: number;
}
