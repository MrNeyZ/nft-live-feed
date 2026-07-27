/**
 * Collection Analyzer — Stage 3 bundle-generation safety limits.
 *
 * Server-side, env-overridable, never trusts client input. Mirrors the
 * shape of `scan-limits.ts` (Stage 2). Defaults are conservative for the
 * current shared single-process deployment (see CLAUDE.md "CREDIT
 * OPTIMIZATION") — bundle downloads hit third-party image/metadata hosts,
 * not Helius, but still share the box's disk/CPU/bandwidth with live
 * ingestion and every other pm2 process.
 */

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Process-wide concurrent bundle-job ceiling. */
export const BUNDLE_MAX_CONCURRENT_JOBS = envInt('BUNDLE_MAX_CONCURRENT_JOBS', 2);

/** Per-job download concurrency (images + original-metadata combined). */
export const BUNDLE_DOWNLOAD_CONCURRENCY = envInt('BUNDLE_DOWNLOAD_CONCURRENCY', 6);

/** Per-resource (single image or metadata fetch) timeout, one attempt. */
export const BUNDLE_PER_RESOURCE_TIMEOUT_MS = envInt('BUNDLE_PER_RESOURCE_TIMEOUT_MS', 20_000);

/** Per-image / per-metadata-file max size. Oversized responses are aborted
 *  mid-stream, never buffered fully first. */
export const BUNDLE_MAX_IMAGE_BYTES = envInt('BUNDLE_MAX_IMAGE_BYTES', 8 * 1024 * 1024);
export const BUNDLE_MAX_METADATA_BYTES = envInt('BUNDLE_MAX_METADATA_BYTES', 1 * 1024 * 1024);

/** Total downloaded-byte budget for one bundle job (images + original
 *  metadata combined). Exceeding this is a terminal job failure. */
export const BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES = envInt('BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES', 750 * 1024 * 1024);

/** Informational/enforced ceiling on the final ZIP size — the download
 *  budget above already bounds the INPUT bytes, this is a defensive
 *  post-hoc check on the actual written archive. */
export const BUNDLE_MAX_ZIP_BYTES = envInt('BUNDLE_MAX_ZIP_BYTES', 900 * 1024 * 1024);

/** Overall wall-clock cap per bundle job (download phase + archive phase). */
export const BUNDLE_JOB_TIMEOUT_MS = envInt('BUNDLE_JOB_TIMEOUT_MS', 20 * 60_000);

/** Bounded retry — 429 and transient 5xx only, exponential backoff. */
export const BUNDLE_MAX_RETRIES = envInt('BUNDLE_MAX_RETRIES', 3);
export const BUNDLE_RETRY_BASE_MS = envInt('BUNDLE_RETRY_BASE_MS', 500);
export const BUNDLE_RETRY_MAX_WAIT_MS = envInt('BUNDLE_RETRY_MAX_WAIT_MS', 8_000);

/** Redirect hops permitted per resource fetch — each hop is re-validated
 *  against the SSRF blocklist before being followed. */
export const BUNDLE_MAX_REDIRECTS = envInt('BUNDLE_MAX_REDIRECTS', 3);

/** How long a completed/failed/cancelled bundle job's ZIP + state stays
 *  downloadable/queryable before being swept. */
export const BUNDLE_STATE_TTL_MS = envInt('BUNDLE_STATE_TTL_MS', 30 * 60_000);

/** Hard cap on assets eligible for a single bundle job. Collections larger
 *  than this are rejected up front — chunked/paginated bundles are a
 *  candidate for a later stage, not this one. */
export const BUNDLE_MAX_ASSET_COUNT = envInt('BUNDLE_MAX_ASSET_COUNT', 5_000);

/** Crude per-asset byte estimate used ONLY for the early-rejection sizing
 *  check (before any network call) — deliberately generous so it rarely
 *  false-rejects a legitimately-sized collection, while still catching
 *  requests that are obviously beyond the configured total-download budget. */
export const BUNDLE_ESTIMATED_BYTES_PER_ASSET = envInt('BUNDLE_ESTIMATED_BYTES_PER_ASSET', 400 * 1024);

/** Minimum free space required on the temp filesystem before a job may
 *  start, on top of the job's own estimated need. */
export const BUNDLE_MIN_FREE_DISK_BYTES = envInt('BUNDLE_MIN_FREE_DISK_BYTES', 500 * 1024 * 1024);

/** Process-wide soft cap on temp disk dedicated to ALL active collection
 *  bundles combined (sum of each active job's downloaded-bytes-so-far). */
export const BUNDLE_MAX_TEMP_DISK_BYTES = envInt('BUNDLE_MAX_TEMP_DISK_BYTES', 2 * 1024 * 1024 * 1024);

/** Orphaned per-job temp directories older than this (e.g. left behind by
 *  a process crash mid-job) are swept on the NEXT server startup. */
export const BUNDLE_TEMP_DIR_MAX_AGE_MS = envInt('BUNDLE_TEMP_DIR_MAX_AGE_MS', 2 * 60 * 60_000);
