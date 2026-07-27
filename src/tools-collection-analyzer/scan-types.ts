/**
 * Collection Analyzer — Stage 2 full-scan shared types.
 *
 * Separate from Stage 1's `types.ts` (preview) by design — Stage 1's
 * response shape (`CollectionAnalysis`) is unchanged and untouched. A full
 * scan reuses Stage 1's `NormalizedAsset`/`NormalizedAttribute` for the
 * per-asset identity fields (mint/name/image/jsonUri/collectionAddress/
 * compressed/standard/attributes) but adds its own scan-lifecycle and
 * full-collection-analysis types.
 */
import type { CollectionAnalyzerInputKind, NormalizedAsset } from './types';

export type ScanStatus = 'running' | 'completed' | 'error' | 'cancelled';

/** Machine-readable terminal error codes — never a raw provider message. */
export type ScanErrorCode =
  | 'collection_too_large'
  | 'scan_timeout'
  | 'rpc_error'
  | 'cancelled'
  | 'capacity';

export interface ScanErrorInfo {
  code: ScanErrorCode;
  message: string;
  pagesFetched: number;
  assetsScanned: number;
}

/** One "tick" of scan progress — delivered over SSE and mirrored into the
 *  in-memory ScanStateRecord for the REST status-poll fallback. */
export interface ScanProgressSnapshot {
  scanId: string;
  status: ScanStatus;
  pagesFetched: number;
  /** Unique assets discovered so far (post-dedup-by-mint). */
  assetsDiscovered: number;
  /** Count of duplicate mint IDs encountered across pages (already-seen
   *  asset returned again — distinct from the repeated-FULL-PAGE guard). */
  duplicatesSkipped: number;
  retryState: { page: number; attempt: number; waitMs: number; httpStatus: number | null } | null;
  elapsedMs: number;
  warning?: string;
}

// ── Full-collection analysis ────────────────────────────────────────────

export interface QualityDiagnostics {
  totalAssets: number;
  /** name AND image both present (non-null/non-empty). Loose bar — a
   *  missing jsonUri or zero attributes doesn't disqualify an asset here;
   *  those are surfaced as their own dedicated counters below. */
  assetsWithValidMetadata: number;
  assetsMissingAttributes: number;
  assetsMissingImage: number;
  assetsMissingName: number;
  compressedCount: number;
  regularCount: number;
  /** Attributes whose shape couldn't be safely normalized at all (e.g.
   *  object/array trait_type or value) — skipped from trait stats, never
   *  silently dropped without being counted here. */
  malformedAttributesSkipped: number;
  /** Same trait_type appearing twice on one asset with the IDENTICAL
   *  normalized value — collapsed to one, counted here. */
  duplicateIdenticalAttributePairsCollapsed: number;
  /** Assets where the same trait_type appeared twice with DIFFERING
   *  normalized values — first occurrence kept, counted here. */
  conflictingDuplicateTraitTypeAssets: number;
  /** Attribute value was null/undefined — normalized to the literal
   *  display value "(null)" and counted here. */
  nullValueAttributes: number;
  /** Attribute value was a string that trimmed to empty — normalized to
   *  "(empty)" and counted here (distinct bucket from null). */
  emptyStringValueAttributes: number;
  /** trait_type was a non-string primitive (number/boolean) and was
   *  coerced via String(...) — counted here. */
  nonStringTraitTypeCoerced: number;
}

export interface FullTraitValueStat {
  value: string;
  count: number;
  /** count / exactAssetCount * 100, rounded to 2dp. */
  percent: number;
  oneOfOne: boolean;
}

export interface FullTraitCategorySummary {
  traitType: string;
  values: FullTraitValueStat[];
  /** Assets that have NO attribute of this trait_type at all. */
  missingCount: number;
  missingPercent: number;
}

export interface DuplicateGroupSummary {
  /** Metadata signature hash, or the raw image URI, depending on group kind. */
  key: string;
  count: number;
  /** Bounded sample of member mints — see DUPLICATE_GROUP_MINT_SAMPLE_CAP. */
  mints: string[];
  truncated: boolean;
}

export interface TraitsPerNftBucket {
  traitsCount: number;
  nftCount: number;
}

export interface OneOfOneHighlight {
  traitType: string;
  value: string;
  mint: string;
}

export interface ScanResultSummary {
  scanId: string;
  collectionAddress: string;
  inputKind: CollectionAnalyzerInputKind;
  inputValue: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pagesFetched: number;
  /** Exact — the number of DISTINCT mints collected after pagination
   *  finished normally. Never derived from DAS `result.total`. */
  exactAssetCount: number;
  duplicatesSkipped: number;
  quality: QualityDiagnostics;
  traitCategories: FullTraitCategorySummary[];
  duplicateMetadataGroups: DuplicateGroupSummary[];
  duplicateImageGroups: DuplicateGroupSummary[];
  traitsPerNftDistribution: TraitsPerNftBucket[];
  /** Bounded convenience list — see ONE_OF_ONE_HIGHLIGHT_CAP. Full per-value
   *  counts (including every 1-count value) live in `traitCategories`. */
  oneOfOneHighlights: OneOfOneHighlight[];
  oneOfOneHighlightsTruncated: boolean;
  warnings: string[];
}

/** What the SSE/status endpoints return while a scan is in flight or just
 *  finished — never includes the full asset array (see the paginated
 *  `.../assets` endpoint and `SCAN_ASSETS_PAGE_*` limits). */
export interface ScanStatusResponse {
  scanId: string;
  status: ScanStatus;
  progress: ScanProgressSnapshot;
  summary?: ScanResultSummary;
  error?: ScanErrorInfo;
}

/** Internal-only — one full scan's server-held state. Never serialized
 *  as-is; routes project it into ScanStatusResponse / paginated asset pages
 *  / export files. */
export interface ScanStateRecord {
  scanId: string;
  status: ScanStatus;
  createdAt: number;
  terminalAt: number | null;
  collectionAddress: string;
  inputKind: CollectionAnalyzerInputKind;
  inputValue: string;
  progress: ScanProgressSnapshot;
  summary: ScanResultSummary | null;
  assets: NormalizedAsset[] | null;
  error: ScanErrorInfo | null;
  abortController: AbortController;
  ttlTimer: NodeJS.Timeout | null;
}
