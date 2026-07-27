/**
 * Collection Analyzer — Stage 2 scan orchestration.
 *
 * Glues the network pagination walker (`scan-fetch.ts`), the pure analysis
 * layer (`scan-normalize.ts`), and the in-memory state store together. Kept
 * separate from the router so the router stays a thin HTTP/SSE adapter.
 */
import { walkFullCollection } from './scan-fetch';
import { buildFullAnalysis } from './scan-normalize';
import { finalizeScan, updateProgress } from './scan-state-store';
import type { ScanProgressSnapshot, ScanResultSummary, ScanStateRecord } from './scan-types';

/** Runs a full scan to completion (or cancellation/error), mutating
 *  `record` throughout via the state-store helpers and invoking
 *  `onProgress` after every tick (including the terminal one) so the SSE
 *  route can forward each snapshot as a wire frame. Never throws. */
export async function executeScan(record: ScanStateRecord, onProgress: (p: ScanProgressSnapshot) => void): Promise<void> {
  const startedAt = record.createdAt;

  const result = await walkFullCollection(record.collectionAddress, record.abortController.signal, {
    onProgress: (tick) => {
      updateProgress(record, { ...tick, elapsedMs: Date.now() - startedAt });
      onProgress(record.progress);
    },
  });

  if (result.outcome === 'cancelled') {
    finalizeScan(record, 'cancelled', {
      error: { code: 'cancelled', message: 'Scan cancelled.', pagesFetched: result.pagesFetched, assetsScanned: result.assetsScanned },
    });
    onProgress(record.progress);
    return;
  }
  if (result.outcome === 'error') {
    finalizeScan(record, 'error', {
      error: { code: result.code, message: result.message, pagesFetched: result.pagesFetched, assetsScanned: result.assetsScanned },
    });
    onProgress(record.progress);
    return;
  }

  const analysis = buildFullAnalysis({ assets: result.assets, perAssetIssues: result.perAssetIssues });
  const completedAt = Date.now();
  const summary: ScanResultSummary = {
    scanId: record.scanId,
    collectionAddress: record.collectionAddress,
    inputKind: record.inputKind,
    inputValue: record.inputValue,
    startedAt: new Date(record.createdAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - record.createdAt,
    pagesFetched: result.pagesFetched,
    exactAssetCount: result.assets.length,
    duplicatesSkipped: result.duplicatesSkipped,
    quality: analysis.quality,
    traitCategories: analysis.traitCategories,
    duplicateMetadataGroups: analysis.duplicateMetadataGroups,
    duplicateImageGroups: analysis.duplicateImageGroups,
    traitsPerNftDistribution: analysis.traitsPerNftDistribution,
    oneOfOneHighlights: analysis.oneOfOneHighlights,
    oneOfOneHighlightsTruncated: analysis.oneOfOneHighlightsTruncated,
    warnings: [...result.warnings, ...analysis.warnings],
  };
  finalizeScan(record, 'completed', { summary, assets: result.assets });
  onProgress(record.progress);
}
