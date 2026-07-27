/**
 * Collection Analyzer - Stage 3 bundle-job orchestration.
 *
 * Glues the per-resource fetchers (image-fetch.ts / metadata-fetch.ts), the
 * ZIP builder (bundle-zip.ts), and the in-memory job registry
 * (bundle-state-store.ts) together. Never re-runs the Stage 2 scan - all
 * asset data comes from the caller's already-completed ScanStateRecord.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchAssetImage, imageDestWithoutExt } from './image-fetch';
import { fetchOriginalMetadata } from './metadata-fetch';
import { buildBundleZip } from './bundle-zip';
import { buildReadmeText } from './bundle-readme';
import { safeMintFilename, sanitizeCollectionName } from './bundle-filenames';
import { addFailure, currentTrackedDiskBytes, finalizeBundleJob, trackDiskBytes, updateBundleProgress } from './bundle-state-store';
import { buildAssetsCsv } from '../scan-csv';
import {
  BUNDLE_DOWNLOAD_CONCURRENCY,
  BUNDLE_JOB_TIMEOUT_MS,
  BUNDLE_MAX_TEMP_DISK_BYTES,
  BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES,
  BUNDLE_MAX_ZIP_BYTES,
} from './bundle-limits';
import type { BundleErrorInfo, BundleJobRecord, BundleProgressSnapshot, DownloadFailureCode, FailedDownloadEntry } from './bundle-types';
import { FAILURE_MESSAGE } from './bundle-types';
import type { AddressValidator } from './ssrf-guard';
import type { NormalizedAsset } from '../types';
import type { ScanResultSummary } from '../scan-types';

/** Bounded-concurrency task runner - N lanes each pulling the next item off
 *  a shared cursor. No dependency needed for something this small. Never
 *  blocks the event loop: every `worker` call is async I/O. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (idx < items.length) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(lanes);
}

function mkFailure(
  asset: NormalizedAsset,
  resourceType: 'image' | 'original_metadata',
  sourceUrl: string | null,
  code: DownloadFailureCode,
  retryCount: number,
): FailedDownloadEntry {
  return { mint: asset.mint, name: asset.name, resourceType, sourceUrl, code, message: FAILURE_MESSAGE[code], retryCount };
}

export interface BundleRunInputs {
  record: BundleJobRecord;
  assets: NormalizedAsset[];
  summary: ScanResultSummary;
  onProgress: (p: BundleProgressSnapshot) => void;
  /** TEST-ONLY — see ssrf-guard.ts `DownloadOptions.isDestinationAllowedOverride`.
   *  The real router NEVER passes this; only direct-call tests do, mirroring
   *  Stage 2's `walkFullCollection(..., overrides?)` test hook. */
  isDestinationAllowedOverride?: AddressValidator;
}

export async function executeBundleJob({ record, assets, summary, onProgress, isDestinationAllowedOverride }: BundleRunInputs): Promise<void> {
  const { options } = record;
  const externalSignal = record.abortController.signal;
  const startedAt = record.createdAt;

  const jobTimeoutController = new AbortController();
  const jobTimeoutTimer = setTimeout(() => jobTimeoutController.abort(), BUNDLE_JOB_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([externalSignal, jobTimeoutController.signal]);

  const finishTerminal = (status: 'cancelled' | 'failed' | 'completed', extra: { zipPath?: string; error?: BundleErrorInfo } = {}) => {
    finalizeBundleJob(record, status, extra);
    onProgress(record.progress);
  };

  try {
    await runBundleJobBody();
  } catch (err) {
    // Any unexpected exception (disk full on mkdir, permission error, a bug
    // elsewhere) MUST still finalize the job — otherwise it'd stay
    // 'downloading' forever, its concurrency slot would never be released,
    // and the TTL sweep would never be scheduled. finalizeBundleJob is
    // idempotent, so this is safe even if a terminal state was already set
    // before the throw.
    console.error('[collection-analyzer/bundle] job crashed', (err as Error)?.message ?? err);
    finishTerminal(combinedSignal.aborted && !jobTimeoutController.signal.aborted ? 'cancelled' : 'failed', {
      error: { code: jobTimeoutController.signal.aborted ? 'job_timeout' : combinedSignal.aborted ? 'cancelled' : 'archive_creation_failed', message: 'Unexpected internal error during bundle generation.' },
    });
  } finally {
    clearTimeout(jobTimeoutTimer);
  }

  async function runBundleJobBody(): Promise<void> {
    await fs.promises.mkdir(record.workDir, { recursive: true });
    const imagesDir = path.join(record.workDir, 'images');
    const origMetaDir = path.join(record.workDir, 'original-metadata');
    if (options.images) await fs.promises.mkdir(imagesDir, { recursive: true });
    if (options.originalMetadata) await fs.promises.mkdir(origMetaDir, { recursive: true });

    record.status = 'downloading';
    updateBundleProgress(record, { status: 'downloading', phase: 'downloading' });
    onProgress(record.progress);

    const imageEntries: Array<{ mint: string; filePath: string; ext: string }> = [];
    const originalMetaEntries: Array<{ mint: string; filePath: string }> = [];
    let overBudget = false;

    if (options.images || options.originalMetadata) {
      await runWithConcurrency(assets, BUNDLE_DOWNLOAD_CONCURRENCY, async (asset) => {
        if (combinedSignal.aborted || overBudget) return;
        const mintSafe = safeMintFilename(asset.mint);

        if (options.images) {
          if (!mintSafe) {
            addFailure(record, mkFailure(asset, 'image', asset.image, 'invalid_url', 0));
            updateBundleProgress(record, { failedImages: record.progress.failedImages + 1 });
          } else {
            const result = await fetchAssetImage(asset.image, imageDestWithoutExt(imagesDir, mintSafe), combinedSignal, isDestinationAllowedOverride);
            if (result.ok) {
              imageEntries.push({ mint: mintSafe, filePath: result.finalPath, ext: path.extname(result.finalPath).slice(1) });
              trackDiskBytes(result.bytesWritten);
              updateBundleProgress(record, {
                successfulImages: record.progress.successfulImages + 1,
                bytesDownloaded: record.progress.bytesDownloaded + result.bytesWritten,
              });
            } else {
              addFailure(record, mkFailure(asset, 'image', asset.image, result.code, result.retryCount));
              updateBundleProgress(record, { failedImages: record.progress.failedImages + 1 });
            }
          }
        }

        if (options.originalMetadata && !combinedSignal.aborted && !overBudget) {
          if (!mintSafe) {
            addFailure(record, mkFailure(asset, 'original_metadata', asset.jsonUri, 'invalid_url', 0));
            updateBundleProgress(record, { failedOriginalMetadata: record.progress.failedOriginalMetadata + 1 });
          } else {
            const destPath = path.join(origMetaDir, `${mintSafe}.json`);
            const result = await fetchOriginalMetadata(asset.jsonUri, destPath, combinedSignal, isDestinationAllowedOverride);
            if (result.ok) {
              originalMetaEntries.push({ mint: mintSafe, filePath: result.finalPath });
              trackDiskBytes(result.bytesWritten);
              updateBundleProgress(record, {
                successfulOriginalMetadata: record.progress.successfulOriginalMetadata + 1,
                bytesDownloaded: record.progress.bytesDownloaded + result.bytesWritten,
              });
            } else {
              addFailure(record, mkFailure(asset, 'original_metadata', asset.jsonUri, result.code, result.retryCount));
              updateBundleProgress(record, { failedOriginalMetadata: record.progress.failedOriginalMetadata + 1 });
            }
          }
        }

        if (record.progress.bytesDownloaded > BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES || currentTrackedDiskBytes() > BUNDLE_MAX_TEMP_DISK_BYTES) {
          overBudget = true;
        }

        updateBundleProgress(record, { processedAssets: record.progress.processedAssets + 1, elapsedMs: Date.now() - startedAt });
        onProgress(record.progress);
      });

      if (jobTimeoutController.signal.aborted) {
        finishTerminal('failed', { error: { code: 'job_timeout', message: 'Bundle generation exceeded the time budget.' } });
        return;
      }
      if (externalSignal.aborted) {
        finishTerminal('cancelled', { error: { code: 'cancelled', message: 'Bundle job cancelled.' } });
        return;
      }
      if (overBudget) {
        finishTerminal('failed', { error: { code: 'total_size_exceeded', message: 'Total download size exceeded the configured budget.' } });
        return;
      }
    }

    // Archiving phase - no network involved past this point.
    record.status = 'archiving';
    updateBundleProgress(record, { status: 'archiving', phase: 'archiving' });
    onProgress(record.progress);

    const collectionFolderName = sanitizeCollectionName(summary.collectionAddress);
    const readmeText = buildReadmeText({
      collectionAddress: summary.collectionAddress,
      scanCompletedAt: summary.completedAt,
      exactAssetCount: summary.exactAssetCount,
      bundleGeneratedAt: new Date().toISOString(),
      options,
      successfulImages: record.progress.successfulImages,
      failedImages: record.progress.failedImages,
      successfulOriginalMetadata: record.progress.successfulOriginalMetadata,
      failedOriginalMetadata: record.progress.failedOriginalMetadata,
    });

    const zipPath = path.join(record.workDir, 'bundle.zip');
    try {
      const zipResult = await buildBundleZip({
        collectionFolderName,
        readmeText,
        collectionSummaryJson: options.collectionSummary ? JSON.stringify(summary, null, 2) : undefined,
        assetsJson: options.assetsJson ? JSON.stringify(assets, null, 2) : undefined,
        assetsCsv: options.assetsCsv ? buildAssetsCsv(assets) : undefined,
        traitCountsJson: options.traitCounts ? JSON.stringify(summary.traitCategories, null, 2) : undefined,
        failedDownloadsJson: options.failureReport ? JSON.stringify(record.failures, null, 2) : undefined,
        normalizedMetadataEntries: options.normalizedMetadata
          ? assets.filter((a) => safeMintFilename(a.mint)).map((a) => ({ mint: a.mint, json: JSON.stringify(a, null, 2) }))
          : undefined,
        imageFiles: options.images ? imageEntries : undefined,
        originalMetadataFiles: options.originalMetadata ? originalMetaEntries : undefined,
      }, zipPath, combinedSignal);

      if (zipResult.bytesWritten > BUNDLE_MAX_ZIP_BYTES) {
        await fs.promises.rm(zipPath, { force: true });
        finishTerminal('failed', { error: { code: 'total_size_exceeded', message: 'Generated archive exceeded the configured size limit.' } });
        return;
      }

      updateBundleProgress(record, { archiveBytesWritten: zipResult.bytesWritten, elapsedMs: Date.now() - startedAt });
      finishTerminal('completed', { zipPath });
    } catch {
      if (combinedSignal.aborted) {
        finishTerminal('cancelled', { error: { code: 'cancelled', message: 'Bundle job cancelled.' } });
      } else {
        finishTerminal('failed', { error: { code: 'archive_creation_failed', message: 'Failed to create the ZIP archive.' } });
      }
    }
  }
}
