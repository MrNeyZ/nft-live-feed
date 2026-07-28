/**
 * Collection Analyzer - Trait Extraction ("Download Trait Collection" mode)
 * shared types.
 *
 * Mirrors the Stage 3/4 bundle module's shape (own types file, own limits,
 * own state store, own job registry) so this mode plugs into the existing
 * detached-job architecture without touching bundle/*.
 *
 * `download_mode` is the minimal shared typing the product spec asked for
 * so a future "Download 1/1 Collection" mode can be added without
 * reshaping this one.
 */
import type { NormalizedAsset } from '../types';

export type DownloadMode = 'trait_collection' | 'one_of_one_collection';

// ── Eligibility ──────────────────────────────────────────────────────────

export type EligibilityClassification = 'suitable' | 'possibly_suitable' | 'unsuitable';

export interface TraitCollectionEligibility {
  totalAssets: number;
  assetsWithAttributes: number;
  percentWithAttributes: number;
  totalTraitCategories: number;
  categoriesWithRepeatedValues: number;
  totalRepeatedTraitValues: number;
  medianAssetsPerTraitValue: number;
  valuesOccurringOnce: number;
  assetsWithNoAttributes: number;
  malformedAttributeCount: number;
  percentInRepeatedStructure: number;
  classification: EligibilityClassification;
  reasons: string[];
}

// ── Configuration ────────────────────────────────────────────────────────

export type ExtractionPreset = 'fast' | 'balanced' | 'thorough';

export interface ExtractionPresetLimits {
  maxSourceAssetsPerValue: number;
  maxComparisonPairsPerValue: number;
  maxComparisonLevel: 0 | 1 | 2;
  /** Pair masks must reach at least this level of "certain" agreement
   *  (consensus) before a candidate pixel is accepted for the CONSERVATIVE
   *  candidate.png - thorough uses a stricter (higher) value. */
  consensusAgreementThreshold: number;
}

export interface TraitExtractionSelection {
  traitType: string;
  /** Empty/omitted = every value in this category (bounded by
   *  TE_MAX_SELECTED_VALUES at the router layer). */
  values?: string[];
}

export interface TraitExtractionConfig {
  scanId: string;
  selections: TraitExtractionSelection[];
  preset: ExtractionPreset;
}

// ── Comparison candidate selection ─────────────────────────────────────

/** 0 = only the target category differs; 1 = target + 1 other category;
 *  2 = target + 2 other categories. Worse than the preset's
 *  maxComparisonLevel is rejected outright. */
export type ComparisonLevel = 0 | 1 | 2;

export interface ComparisonCandidate {
  sourceMint: string;
  comparisonMint: string;
  sourceImage: string;
  comparisonImage: string;
  level: ComparisonLevel;
  differingCategories: string[];
  matchingCategoryCount: number;
  comparisonValue: string | null;
}

// ── Pixel/consensus outputs ─────────────────────────────────────────────

export type ConfidenceStatus = 'high_confidence' | 'medium_confidence' | 'low_confidence' | 'unresolved' | 'visually_identical';

export interface ConfidenceComponents {
  level0PairAvailability: number;
  sourceAssetCountScore: number;
  comparisonValueDiversityScore: number;
  comparisonPairCountScore: number;
  consensusAgreementScore: number;
  sourcePixelConsistencyScore: number;
  nonTargetMetadataDifferenceScore: number;
  canvasConsistencyScore: number;
  changedAreaReasonablenessScore: number;
  uncertaintyPenaltyScore: number;
}

export interface ConfidenceResult {
  score: number; // 0-100
  status: ConfidenceStatus;
  components: ConfidenceComponents;
}

export interface PixelBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TraitValueEvidence {
  traitType: string;
  traitValue: string;
  occurrenceCount: number;
  sourceMints: string[];
  comparisonMints: string[];
  comparisonLevels: ComparisonLevel[];
  matchingCategoriesSample: string[];
  differingCategoriesSample: string[];
  canvasWidth: number | null;
  canvasHeight: number | null;
  pairCount: number;
  sourceAssetCount: number;
  comparisonValueCount: number;
  changedPixelCount: number;
  changedPixelPercent: number;
  candidatePixelCount: number;
  expandedCandidatePixelCount: number;
  uncertaintyPixelCount: number;
  uncertaintyPixelPercent: number;
  candidateBoundingBox: PixelBoundingBox | null;
  consensusAgreementMean: number;
  sourcePixelConsistencyMean: number;
  confidence: ConfidenceResult;
  warnings: string[];
  outputFiles: {
    candidate: string | null;
    candidateExpanded: string | null;
    changeMask: string | null;
    uncertaintyMask: string | null;
    preview: string | null;
    evidence: string;
  };
  outputDirKey: string; // sanitized "<value>--<hash>" folder name
}

// ── Job progress / state ────────────────────────────────────────────────

export type TraitExtractionJobStatus = 'queued' | 'downloading' | 'processing' | 'archiving' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface TraitExtractionProgressSnapshot {
  jobId: string;
  scanId: string;
  status: TraitExtractionJobStatus;
  phase: TraitExtractionJobStatus;
  currentCategory: string | null;
  currentTraitValue: string | null;
  totalValues: number;
  processedValues: number;
  uniqueImagesDownloaded: number;
  comparisonsEvaluated: number;
  resolvedHigh: number;
  resolvedMedium: number;
  resolvedLow: number;
  resolvedUnresolved: number;
  resolvedVisuallyIdentical: number;
  failedImageCount: number;
  bytesDownloaded: number;
  elapsedMs: number;
  warning?: string;
}

export interface TraitExtractionErrorInfo {
  code:
    | 'scan_not_found' | 'scan_not_completed' | 'ineligible' | 'empty_selection' | 'selection_too_large'
    | 'insufficient_disk_space' | 'archive_creation_failed' | 'total_size_exceeded' | 'job_timeout'
    | 'cancelled' | 'capacity';
  message: string;
}

export interface TraitExtractionJobRecord {
  jobId: string;
  scanId: string;
  status: TraitExtractionJobStatus;
  config: TraitExtractionConfig;
  createdAt: number;
  terminalAt: number | null;
  progress: TraitExtractionProgressSnapshot;
  evidence: TraitValueEvidence[];
  unresolvedValues: Array<{ traitType: string; traitValue: string; reason: string }>;
  error: TraitExtractionErrorInfo | null;
  workDir: string;
  zipPath: string | null;
  collectionDisplayName: string;
  abortController: AbortController;
  ttlTimer: NodeJS.Timeout | null;
}

export interface TraitExtractionStatusResponse {
  jobId: string;
  scanId: string;
  status: TraitExtractionJobStatus;
  config: TraitExtractionConfig;
  progress: TraitExtractionProgressSnapshot;
  evidenceSummary: Array<{ traitType: string; traitValue: string; status: ConfidenceStatus; score: number; outputDirKey: string }>;
  unresolvedValues: TraitExtractionJobRecord['unresolvedValues'];
  error?: TraitExtractionErrorInfo;
  collectionDisplayName: string;
  downloadAvailable: boolean;
}

export interface GeneratorSchemaCategoryValue {
  value: string;
  occurrenceCount: number;
  percent: number;
  extracted: boolean;
  confidence?: ConfidenceStatus;
  score?: number;
  outputDirKey?: string;
}

export interface GeneratorSchemaCategory {
  traitType: string;
  mandatoryEstimate: 'mandatory' | 'optional' | 'unknown';
  values: GeneratorSchemaCategoryValue[];
}

export interface GeneratorSchema {
  collectionAddress: string;
  exactScannedAssetCount: number;
  categories: GeneratorSchemaCategory[];
  selectedCategories: string[];
  extractedFileCount: number;
  unresolvedValues: TraitExtractionJobRecord['unresolvedValues'];
  generatedAt: string;
  note: string;
}

export type { NormalizedAsset };
