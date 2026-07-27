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

/** Total downloaded-byte budget for ONE PART (images + original metadata
 *  combined within that part). Exceeded mid-download -> the part closes
 *  early and any not-yet-started assets in its planned range carry
 *  forward into the next part (see bundle-run.ts) rather than failing the
 *  job. Stage 3 named this BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES when a "job"
 *  was always exactly one part; Stage 4 repoints it at the per-part
 *  budget and adds a separate overall-job aggregate below. */
export const BUNDLE_MAX_PART_DOWNLOAD_BYTES = envInt('BUNDLE_MAX_PART_DOWNLOAD_BYTES', 750 * 1024 * 1024);

/** Overall job-wide downloaded-byte budget across ALL parts combined.
 *  Exceeding this IS a terminal job failure (unlike a single part's
 *  budget, which just closes that part early) — it means the job as a
 *  whole has grown beyond what this process should spend on one request. */
export const BUNDLE_MAX_JOB_DOWNLOAD_BYTES = envInt('BUNDLE_MAX_JOB_DOWNLOAD_BYTES', 6 * 1024 * 1024 * 1024);

/** Informational/enforced ceiling on ONE PART's final ZIP size — the
 *  per-part download budget above already bounds the INPUT bytes, this is
 *  a defensive post-hoc check on the actual written archive. A part whose
 *  archive would exceed this is never left downloadable. */
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

/** Maximum assets in a single ZIP part. Collections larger than this are
 *  automatically split into multiple parts rather than rejected (Stage 4) —
 *  see bundle-part-plan.ts. */
export const BUNDLE_MAX_ASSETS_PER_PART = envInt('BUNDLE_MAX_ASSETS_PER_PART', 5_000);

/** Hard cap on TOTAL assets eligible for a bundle job (across every part
 *  combined). Collections larger than this are rejected up front with a
 *  structured `collection_too_large` error — there is no unbounded
 *  multi-part support. */
export const BUNDLE_MAX_TOTAL_ASSETS = envInt('BUNDLE_MAX_TOTAL_ASSETS', 25_000);

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
