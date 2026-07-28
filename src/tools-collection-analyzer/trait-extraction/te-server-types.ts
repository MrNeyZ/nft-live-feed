/**
 * Trait Extraction - SERVER-SIDE job registry / HTTP wire types.
 *
 * Stage 5.3: split out of trait-extraction-core's te-types.ts. These two
 * types describe a server job-registry record (AbortController tied to an
 * HTTP request lifecycle, TTL timer, temp workDir) and an HTTP response
 * shape - neither belongs in the runtime-independent core (the CLI has no
 * use for either; it keeps its own local job/manifest state instead).
 * Everything else these types are built from (config, progress snapshot,
 * evidence, error info, confidence status, search diagnostics) still comes
 * from the core - single source of truth for the shared vocabulary.
 */
import type {
  ConfidenceStatus,
  TraitExtractionConfig,
  TraitExtractionErrorInfo,
  TraitExtractionJobStatus,
  TraitExtractionProgressSnapshot,
  TraitValueEvidence,
  UnresolvedValueEntry,
  ValueSearchDiagnostics,
} from 'trait-extraction-core';

export interface TraitExtractionJobRecord {
  jobId: string;
  scanId: string;
  status: TraitExtractionJobStatus;
  config: TraitExtractionConfig;
  createdAt: number;
  terminalAt: number | null;
  progress: TraitExtractionProgressSnapshot;
  evidence: TraitValueEvidence[];
  unresolvedValues: UnresolvedValueEntry[];
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
  evidenceSummary: Array<{ traitType: string; traitValue: string; status: ConfidenceStatus; score: number; outputDirKey: string; searchDiagnostics: ValueSearchDiagnostics }>;
  unresolvedValues: UnresolvedValueEntry[];
  error?: TraitExtractionErrorInfo;
  collectionDisplayName: string;
  downloadAvailable: boolean;
}
