/**
 * Collection Analyzer — Stage 3/4 bundle-generation shared types.
 *
 * Stage 4 note: a "job" now always has >=1 "part". A single-part job is
 * the Stage 3 behavior (one ZIP, `totalParts === 1`) — nothing about its
 * wire shape or endpoint behavior changes. `BundleJobRecord.zipPath` /
 * top-level `failures` remain populated (mirrored from the single part)
 * so old single-part call sites keep working unmodified.
 */

export type BundleJobStatus = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type BundlePartStatus = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled';

export interface BundleOptions {
  images: boolean;
  normalizedMetadata: boolean;
  originalMetadata: boolean;
  collectionSummary: boolean;
  assetsJson: boolean;
  assetsCsv: boolean;
  traitCounts: boolean;
  failureReport: boolean;
}

export const DEFAULT_BUNDLE_OPTIONS: BundleOptions = {
  images: true,
  normalizedMetadata: true,
  originalMetadata: false,
  collectionSummary: true,
  assetsJson: true,
  assetsCsv: true,
  traitCounts: true,
  failureReport: true,
};

export function isEmptySelection(opts: BundleOptions): boolean {
  return !Object.values(opts).some(Boolean);
}

export type DownloadResourceType = 'image' | 'original_metadata';

/** Machine-readable, never a raw provider/error message. */
export type DownloadFailureCode =
  | 'no_source_url'
  | 'invalid_url'
  | 'blocked_destination'
  | 'unsupported_protocol'
  | 'too_many_redirects'
  | 'http_error'
  | 'unsupported_content_type'
  | 'oversized'
  | 'timeout'
  | 'malformed_json'
  | 'network_error'
  | 'cancelled'
  | 'retries_exhausted';

export const FAILURE_MESSAGE: Record<DownloadFailureCode, string> = {
  no_source_url: 'No source URL available for this resource.',
  invalid_url: 'The source URL could not be parsed.',
  blocked_destination: 'The source host resolves to a private/internal network address and was blocked.',
  unsupported_protocol: 'Only http/https URLs are supported.',
  too_many_redirects: 'The source URL redirected too many times.',
  http_error: 'The source host returned an error response.',
  unsupported_content_type: 'The response was not a supported file type.',
  oversized: 'The response exceeded the maximum allowed size.',
  timeout: 'The request timed out.',
  malformed_json: 'The metadata response was not valid JSON.',
  network_error: 'A network error occurred while fetching the resource.',
  cancelled: 'The bundle job was cancelled.',
  retries_exhausted: 'The source host kept failing after repeated retries.',
};

export interface FailedDownloadEntry {
  mint: string;
  name: string | null;
  resourceType: DownloadResourceType;
  sourceUrl: string | null;
  code: DownloadFailureCode;
  message: string;
  retryCount: number;
}

export type BundlePhase = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** Overall (job-wide, aggregated-across-parts) progress. Shape unchanged
 *  from Stage 3 for single-part jobs; `totalParts`/`currentPartNumber` are
 *  additive fields multi-part consumers can read (default 1/1). */
export interface BundleProgressSnapshot {
  jobId: string;
  scanId: string;
  status: BundleJobStatus;
  phase: BundlePhase;
  totalAssets: number;
  processedAssets: number;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
  bytesDownloaded: number;
  archiveBytesWritten: number | null;
  elapsedMs: number;
  warning?: string;
  totalParts: number;
  currentPartNumber: number;
}

export interface BundleErrorInfo {
  code:
    | 'scan_not_found' | 'scan_not_completed' | 'scan_expired' | 'empty_selection' | 'collection_too_large'
    | 'insufficient_disk_space' | 'archive_creation_failed' | 'total_size_exceeded' | 'job_timeout'
    | 'cancelled' | 'capacity';
  message: string;
}

/** One part's asset range within the mint-sorted asset list — see
 *  bundle-part-plan.ts for how this is derived. */
export interface BundlePartRange {
  partNumber: number;
  startIndex: number;
  endIndex: number;
  assetCount: number;
  firstMint: string;
  lastMint: string;
}

/** Internal, server-side record for one part. */
export interface BundlePartRecord {
  partNumber: number;
  status: BundlePartStatus;
  range: BundlePartRange;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
  bytesDownloaded: number;
  archiveBytesWritten: number | null;
  sha256: string | null;
  failures: FailedDownloadEntry[];
  /** Server-owned absolute path — never serialized to the client. */
  zipPath: string | null;
  zipFilename: string | null;
  error: BundleErrorInfo | null;
}

/** What a part looks like over the wire (status/manifest responses) — no
 *  filesystem path, ever. */
export interface BundlePartStatusWire {
  partNumber: number;
  status: BundlePartStatus;
  assetCount: number;
  firstMint: string;
  lastMint: string;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
  bytesDownloaded: number;
  archiveBytesWritten: number | null;
  sha256: string | null;
  filename: string | null;
  downloadAvailable: boolean;
  error?: BundleErrorInfo;
}

export interface BundleManifestPartEntry {
  filename: string;
  partNumber: number;
  assetCount: number;
  firstMint: string;
  lastMint: string;
  archiveBytes: number | null;
  sha256: string | null;
  status: BundlePartStatus;
  downloadAvailable: boolean;
}

/** The downloadable top-level manifest (`<collection>-manifest.json`). */
export interface BundleManifest {
  jobId: string;
  scanId: string;
  collectionAddress: string;
  collectionDisplayName: string;
  generatedAt: string;
  exactAssetCount: number;
  totalParts: number;
  options: BundleOptions;
  parts: BundleManifestPartEntry[];
}

/** Written as `part-manifest.json` INSIDE each part's ZIP. */
export interface PartManifestEntry {
  collectionAddress: string;
  collectionDisplayName: string;
  jobId: string;
  partNumber: number;
  totalParts: number;
  firstMint: string;
  lastMint: string;
  assetsInPart: number;
  exactCollectionCount: number;
  options: BundleOptions;
  generatedAt: string;
}

export interface BundleJobRecord {
  jobId: string;
  scanId: string;
  status: BundleJobStatus;
  options: BundleOptions;
  createdAt: number;
  terminalAt: number | null;
  progress: BundleProgressSnapshot;
  /** Aggregate across every part — kept for Stage 3 backward compatibility
   *  (single-part jobs: identical to that one part's failures). */
  failures: FailedDownloadEntry[];
  error: BundleErrorInfo | null;
  /** Server-owned working directory for this job, under os.tmpdir(). Never
   *  exposed to the client. */
  workDir: string;
  /** Single-part convenience mirror of parts[0].zipPath — kept so Stage 3
   *  code (and the legacy /download endpoint for single-part jobs) needs
   *  no changes. Null for multi-part jobs. */
  zipPath: string | null;
  collectionDisplayName: string;
  totalParts: number;
  currentPartNumber: number;
  parts: BundlePartRecord[];
  manifestStatus: 'pending' | 'completed' | 'failed';
  manifestPath: string | null;
  abortController: AbortController;
  ttlTimer: NodeJS.Timeout | null;
}

/** What the SSE/status endpoints return — never includes `workDir`/`zipPath`
 *  (no server filesystem path is ever exposed to the client). */
export interface BundleStatusResponse {
  jobId: string;
  scanId: string;
  status: BundleJobStatus;
  options: BundleOptions;
  progress: BundleProgressSnapshot;
  failures: FailedDownloadEntry[];
  error?: BundleErrorInfo;
  collectionDisplayName: string;
  totalParts: number;
  currentPartNumber: number;
  parts: BundlePartStatusWire[];
  manifestStatus: 'pending' | 'completed' | 'failed';
  manifestAvailable: boolean;
}
