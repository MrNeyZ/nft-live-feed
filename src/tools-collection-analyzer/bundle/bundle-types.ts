/**
 * Collection Analyzer — Stage 3 bundle-generation shared types.
 */

export type BundleJobStatus = 'queued' | 'downloading' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';

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
}

export interface BundleErrorInfo {
  code:
    | 'scan_not_found' | 'scan_not_completed' | 'scan_expired' | 'empty_selection' | 'collection_too_large'
    | 'insufficient_disk_space' | 'archive_creation_failed' | 'total_size_exceeded' | 'job_timeout'
    | 'cancelled' | 'capacity';
  message: string;
}

export interface BundleJobRecord {
  jobId: string;
  scanId: string;
  status: BundleJobStatus;
  options: BundleOptions;
  createdAt: number;
  terminalAt: number | null;
  progress: BundleProgressSnapshot;
  failures: FailedDownloadEntry[];
  error: BundleErrorInfo | null;
  /** Server-owned working directory for this job, under os.tmpdir(). Never
   *  exposed to the client. */
  workDir: string;
  /** Absolute path to the finished ZIP, set only once archiving succeeds. */
  zipPath: string | null;
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
}
