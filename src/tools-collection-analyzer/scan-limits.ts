/**
 * Collection Analyzer — Stage 2 full-scan safety limits.
 *
 * Server-side, env-overridable, never trusts client input for anything that
 * bounds RPC spend or memory. Defaults are conservative for the current
 * single-process deployment (one Helius plan shared with live ingestion —
 * see CLAUDE.md "CREDIT OPTIMIZATION") and this pm2 `fork`-mode instance
 * (no cluster/Redis — a plain in-memory counter is correct here, matching
 * the project's existing single-process SSE architecture).
 */

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** DAS page size. 1000 is the documented Helius max and is already relied
 *  on in production by the Holder Count tool (`tools-holders/fetch-assets.ts`
 *  `PAGE_LIMIT`) — verified reliable on the current plan. */
export const SCAN_PAGE_LIMIT = envInt('COLLECTION_SCAN_PAGE_LIMIT', 1000);

/** Hard page ceiling. Combined with SCAN_PAGE_LIMIT this bounds worst-case
 *  collection size at 60 * 1000 = 60,000 assets. Reaching this cap WITHOUT
 *  having seen a short/empty page is treated as a fatal `collection_too_large`
 *  error (not a silent truncation) — the exact-total/full-analysis contract
 *  can't be honestly satisfied for a collection larger than the cap. */
export const SCAN_MAX_PAGES = envInt('COLLECTION_SCAN_MAX_PAGES', 60);

/** Derived, informational — the largest collection size the scanner will
 *  ever confirm as complete. */
export const SCAN_MAX_ASSETS = SCAN_MAX_PAGES * SCAN_PAGE_LIMIT;

/** Per-page RPC timeout. Larger than the preview fetch's 10s (Stage 1) since
 *  a full 1000-item page is a heavier response body. */
export const SCAN_PAGE_TIMEOUT_MS = envInt('COLLECTION_SCAN_PAGE_TIMEOUT_MS', 15_000);

/** Overall wall-clock cap per scan, independent of page count — protects
 *  against a slow-but-not-erroring provider stringing the request along. */
export const SCAN_TOTAL_TIMEOUT_MS = envInt('COLLECTION_SCAN_TOTAL_TIMEOUT_MS', 10 * 60_000);

/** Bounded retry — only for HTTP 429 and transient 5xx (500/502/503/504).
 *  Any other failure (4xx, malformed JSON, DAS JSON-RPC error code) is
 *  treated as fatal immediately, never retried. */
export const SCAN_MAX_RETRIES_PER_PAGE = envInt('COLLECTION_SCAN_MAX_RETRIES', 4);
/** Exponential backoff base; actual wait = base * 2^(attempt-1) + jitter,
 *  capped at SCAN_RETRY_MAX_WAIT_MS. */
export const SCAN_RETRY_BASE_MS = envInt('COLLECTION_SCAN_RETRY_BASE_MS', 400);
export const SCAN_RETRY_MAX_WAIT_MS = envInt('COLLECTION_SCAN_RETRY_MAX_WAIT_MS', 8_000);

/** Process-wide concurrent full-scan ceiling. Each scan can issue up to
 *  SCAN_MAX_PAGES sequential Helius calls — capping concurrency protects the
 *  shared Helius credit budget the live ingestion pipeline also depends on
 *  (see CLAUDE.md "CREDIT OPTIMIZATION"). Conservative default of 2. */
export const SCAN_MAX_CONCURRENT = envInt('COLLECTION_SCAN_MAX_CONCURRENT', 2);

/** How long a scan's result (assets + summary) stays queryable/exportable
 *  after reaching a terminal state (completed / error / cancelled) before
 *  being swept from memory. */
export const SCAN_STATE_TTL_MS = envInt('COLLECTION_SCAN_STATE_TTL_MS', 30 * 60_000);

/** Default / max page size for the paginated GET .../assets endpoint over a
 *  completed scan's normalized asset list. */
export const SCAN_ASSETS_PAGE_DEFAULT = 50;
export const SCAN_ASSETS_PAGE_MAX = 500;

/** Cap on how many mints are listed per duplicate group (metadata-signature
 *  or image-URI) in the result payload — the aggregate counts in
 *  `QualityDiagnostics`/`FullTraitCategorySummary` stay exact regardless;
 *  only these "example mints" convenience lists are bounded. */
export const DUPLICATE_GROUP_MINT_SAMPLE_CAP = 25;

/** Cap on how many one-of-one trait highlights are surfaced directly in the
 *  scan summary (a convenience list — the full per-value counts already
 *  live, uncapped, in `traitCategories`). */
export const ONE_OF_ONE_HIGHLIGHT_CAP = 300;
