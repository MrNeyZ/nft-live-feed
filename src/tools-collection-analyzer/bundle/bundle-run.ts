/**
 * Collection Analyzer - Stage 3/4 bundle-job orchestration.
 *
 * Stage 4: a job is planned into one or more deterministic PARTS
 * (bundle-part-plan.ts) and parts are processed SEQUENTIALLY (one part's
 * downloads+archiving finish before the next starts) — this keeps the
 * "carry remaining assets into the next part on budget overflow" logic
 * race-free with no cross-part concurrency to reason about. Within a
 * single part, downloads still use the same bounded-concurrency pool as
 * Stage 3.
 *
 * Failure semantics (spec-required, documented here once): a failed PART
 * does NOT abort the job — remaining parts still run. The job's overall
 * terminal status is 'completed' if AT LEAST ONE part completed
 * successfully (any failed parts are visible via each part's own status +
 * error, never silently hidden), and 'failed' only when EVERY part failed
 * or a job-wide terminal condition fired (timeout, total byte budget,
 * archive failure before any part finished). This "preserve completed
 * parts, expose partial state honestly" choice is deliberate per the
 * Stage 4 spec.
 *
 * A single-part job (small collection) behaves byte-for-byte like Stage 3:
 * `record.zipPath` mirrors parts[0], `record.failures` mirrors parts[0]'s
 * failures, and the ZIP filename has no "-part-" suffix.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchAssetImage, imageDestWithoutExt } from './image-fetch';
import { fetchOriginalMetadata } from './metadata-fetch';
import { buildBundleZip } from './bundle-zip';
import { buildReadmeText } from './bundle-readme';
import { safeMintFilename } from './bundle-filenames';
import { deriveCollectionDisplayName } from './bundle-display-name';
import { sortAssetsByMint, planBundleParts } from './bundle-part-plan';
import { sha256File, partZipFilename, manifestFilename, buildPartManifestEntry, buildTopLevelManifest } from './bundle-manifest';
import { addFailure, currentTrackedDiskBytes, finalizeBundleJob, trackDiskBytes, updateBundleProgress } from './bundle-state-store';
import { buildAssetsCsv } from '../scan-csv';
import {
  BUNDLE_DOWNLOAD_CONCURRENCY,
  BUNDLE_ESTIMATED_BYTES_PER_ASSET,
  BUNDLE_JOB_TIMEOUT_MS,
  BUNDLE_MAX_ASSETS_PER_PART,
  BUNDLE_MAX_JOB_DOWNLOAD_BYTES,
  BUNDLE_MAX_PART_DOWNLOAD_BYTES,
  BUNDLE_MAX_TEMP_DISK_BYTES,
  BUNDLE_MAX_ZIP_BYTES,
} from './bundle-limits';
import type {
  BundleErrorInfo, BundleJobRecord, BundleOptions, BundlePartRecord, BundleProgressSnapshot,
  DownloadFailureCode, FailedDownloadEntry,
} from './bundle-types';
import { FAILURE_MESSAGE } from './bundle-types';
import type { AddressValidator } from './ssrf-guard';
import type { NormalizedAsset } from '../types';
import type { ScanResultSummary } from '../scan-types';

/** Bounded-concurrency task runner with an early-stop predicate checked
 *  before each dispatch — the mechanism behind "stop scheduling more
 *  assets into the current part when its runtime threshold is reached."
 *  The shared `idx` cursor only ever moves forward, so whatever wasn't
 *  yet claimed when `shouldStop()` first returns true is exactly the
 *  deterministic "leftover" slice carried into the next part. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<void>,
): Promise<{ leftover: T[] }> {
  let idx = 0;
  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (idx < items.length && !shouldStop()) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(lanes);
  return { leftover: items.slice(idx) };
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
   *  The real router NEVER passes this; only direct-call tests do. */
  isDestinationAllowedOverride?: AddressValidator;
}

function aggregateFromParts(parts: BundlePartRecord[]): {
  processedAssets: number; successfulImages: number; failedImages: number;
  successfulOriginalMetadata: number; failedOriginalMetadata: number; bytesDownloaded: number;
} {
  let processedAssets = 0, successfulImages = 0, failedImages = 0, successfulOriginalMetadata = 0, failedOriginalMetadata = 0, bytesDownloaded = 0;
  for (const p of parts) {
    processedAssets += p.successfulImages + p.failedImages > p.successfulOriginalMetadata + p.failedOriginalMetadata
      ? p.successfulImages + p.failedImages
      : p.successfulOriginalMetadata + p.failedOriginalMetadata;
    successfulImages += p.successfulImages;
    failedImages += p.failedImages;
    successfulOriginalMetadata += p.successfulOriginalMetadata;
    failedOriginalMetadata += p.failedOriginalMetadata;
    bytesDownloaded += p.bytesDownloaded;
  }
  return { processedAssets, successfulImages, failedImages, successfulOriginalMetadata, failedOriginalMetadata, bytesDownloaded };
}

function publishAggregate(record: BundleJobRecord, startedAt: number, onProgress: (p: BundleProgressSnapshot) => void, status?: BundleProgressSnapshot['status']): void {
  const agg = aggregateFromParts(record.parts);
  const lastPart = record.parts[record.currentPartNumber - 1];
  updateBundleProgress(record, {
    ...agg,
    archiveBytesWritten: record.parts.every((p) => p.archiveBytesWritten !== null)
      ? record.parts.reduce((s, p) => s + (p.archiveBytesWritten ?? 0), 0)
      : null,
    totalParts: record.totalParts,
    currentPartNumber: record.currentPartNumber,
    phase: (status ?? record.status) as BundleProgressSnapshot['phase'],
    elapsedMs: Date.now() - startedAt,
    ...(lastPart?.status === 'failed' && lastPart.error ? { warning: `Part ${lastPart.partNumber} failed: ${lastPart.error.message}` } : {}),
  });
  onProgress(record.progress);
}

export async function executeBundleJob({ record, assets, summary, onProgress, isDestinationAllowedOverride }: BundleRunInputs): Promise<void> {
  const { options } = record;
  const externalSignal = record.abortController.signal;
  const startedAt = record.createdAt;

  const jobTimeoutController = new AbortController();
  const jobTimeoutTimer = setTimeout(() => jobTimeoutController.abort(), BUNDLE_JOB_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([externalSignal, jobTimeoutController.signal]);

  const finishTerminal = (status: 'cancelled' | 'failed' | 'completed', extra: { error?: BundleErrorInfo } = {}) => {
    finalizeBundleJob(record, status, { zipPath: record.zipPath ?? undefined, error: extra.error });
    publishAggregate(record, startedAt, onProgress, status);
  };

  try {
    await runBundleJobBody();
  } catch (err) {
    console.error('[collection-analyzer/bundle] job crashed', (err as Error)?.message ?? err);
    const cancelledNotTimeout = combinedSignal.aborted && !jobTimeoutController.signal.aborted;
    finishTerminal(cancelledNotTimeout ? 'cancelled' : (record.parts.some((p) => p.status === 'completed') ? 'completed' : 'failed'), {
      error: {
        code: jobTimeoutController.signal.aborted ? 'job_timeout' : cancelledNotTimeout ? 'cancelled' : 'archive_creation_failed',
        message: 'Unexpected internal error during bundle generation.',
      },
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

    const sortedAssets = sortAssetsByMint(assets);
    record.collectionDisplayName = deriveCollectionDisplayName(summary.collectionAddress, sortedAssets, null);

    const plan = planBundleParts(sortedAssets, BUNDLE_MAX_ASSETS_PER_PART, BUNDLE_MAX_PART_DOWNLOAD_BYTES, BUNDLE_ESTIMATED_BYTES_PER_ASSET);
    // Mutable queue of per-part asset slices — starts from the deterministic
    // plan but can grow (overflow carry-forward appends/extends parts).
    const partAssetQueue: NormalizedAsset[][] = plan.parts.map((r) => sortedAssets.slice(r.startIndex, r.endIndex));
    record.totalParts = partAssetQueue.length;
    record.parts = plan.parts.map((range) => ({
      partNumber: range.partNumber, status: 'queued', range,
      successfulImages: 0, failedImages: 0, successfulOriginalMetadata: 0, failedOriginalMetadata: 0,
      bytesDownloaded: 0, archiveBytesWritten: null, sha256: null, failures: [], zipPath: null, zipFilename: null, error: null,
    }));

    record.status = 'downloading';
    updateBundleProgress(record, { status: 'downloading', phase: 'downloading', totalParts: record.totalParts, currentPartNumber: 1 });
    onProgress(record.progress);

    let jobBytesDownloaded = 0;
    let partIndex = 0;

    while (partIndex < partAssetQueue.length) {
      if (jobTimeoutController.signal.aborted) {
        finishTerminal(record.parts.some((p) => p.status === 'completed') ? 'completed' : 'failed', {
          error: { code: 'job_timeout', message: 'Bundle generation exceeded the time budget.' },
        });
        return;
      }
      if (externalSignal.aborted) {
        markRemainingPartsCancelled(partIndex);
        finishTerminal('cancelled', { error: { code: 'cancelled', message: 'Bundle job cancelled.' } });
        return;
      }
      if (jobBytesDownloaded > BUNDLE_MAX_JOB_DOWNLOAD_BYTES || currentTrackedDiskBytes() > BUNDLE_MAX_TEMP_DISK_BYTES) {
        markRemainingPartsCancelled(partIndex);
        finishTerminal(record.parts.some((p) => p.status === 'completed') ? 'completed' : 'failed', {
          error: { code: 'total_size_exceeded', message: 'Total download size exceeded the configured job budget.' },
        });
        return;
      }

      record.currentPartNumber = partIndex + 1;
      const partRecord = record.parts[partIndex];
      const partAssets = partAssetQueue[partIndex];

      const { processedCount, leftover } = await runPart(partRecord, partAssets, imagesDir, origMetaDir, combinedSignal);
      jobBytesDownloaded += partRecord.bytesDownloaded;

      // Runtime overflow: assets never started in this part's slice carry
      // forward into the next part (creating one if this was the last).
      if (leftover.length > 0) {
        // Shrink this part's recorded range to what it ACTUALLY contains.
        const actual = partAssets.slice(0, processedCount);
        if (actual.length > 0) {
          partRecord.range = {
            ...partRecord.range,
            endIndex: partRecord.range.startIndex + actual.length,
            assetCount: actual.length,
            lastMint: actual[actual.length - 1].mint,
          };
        }
        if (partIndex + 1 < partAssetQueue.length) {
          partAssetQueue[partIndex + 1] = [...leftover, ...partAssetQueue[partIndex + 1]];
        } else {
          partAssetQueue.push(leftover);
          const newPartNumber = partAssetQueue.length;
          record.parts.push({
            partNumber: newPartNumber, status: 'queued',
            range: {
              partNumber: newPartNumber, startIndex: partRecord.range.endIndex, endIndex: partRecord.range.endIndex + leftover.length,
              assetCount: leftover.length, firstMint: leftover[0].mint, lastMint: leftover[leftover.length - 1].mint,
            },
            successfulImages: 0, failedImages: 0, successfulOriginalMetadata: 0, failedOriginalMetadata: 0,
            bytesDownloaded: 0, archiveBytesWritten: null, sha256: null, failures: [], zipPath: null, zipFilename: null, error: null,
          });
          record.totalParts = partAssetQueue.length;
        }
      }

      if (externalSignal.aborted) {
        partRecord.status = 'cancelled';
        markRemainingPartsCancelled(partIndex + 1);
        finishTerminal('cancelled', { error: { code: 'cancelled', message: 'Bundle job cancelled.' } });
        return;
      }

      // Archive this part (only its actually-processed assets).
      record.status = 'archiving';
      partRecord.status = 'archiving';
      updateBundleProgress(record, { status: 'archiving', phase: 'archiving' });
      publishAggregate(record, startedAt, onProgress);

      const partOutcome = await archivePart(record, partRecord, sortedAssets, summary, combinedSignal);
      if (!partOutcome.ok) {
        partRecord.status = 'failed';
        partRecord.error = partOutcome.error;
      } else {
        partRecord.status = 'completed';
        partRecord.zipPath = partOutcome.zipPath;
        partRecord.zipFilename = partOutcome.zipFilename;
        partRecord.archiveBytesWritten = partOutcome.bytesWritten;
        partRecord.sha256 = partOutcome.sha256;
        if (record.totalParts === 1) { record.zipPath = partOutcome.zipPath; }
      }
      publishAggregate(record, startedAt, onProgress);

      partIndex++;
    }

    // All parts processed — build the top-level manifest, finalize.
    record.manifestStatus = 'pending';
    try {
      const manifest = buildTopLevelManifest({
        jobId: record.jobId, scanId: record.scanId, collectionAddress: summary.collectionAddress,
        collectionDisplayName: record.collectionDisplayName, generatedAt: new Date().toISOString(),
        exactAssetCount: summary.exactAssetCount, options, parts: record.parts,
      });
      const manifestPath = path.join(record.workDir, manifestFilename(record.collectionDisplayName));
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      record.manifestPath = manifestPath;
      record.manifestStatus = 'completed';
    } catch (err) {
      console.error('[collection-analyzer/bundle] manifest write failed', err);
      record.manifestStatus = 'failed';
    }

    record.failures = record.parts.flatMap((p) => p.failures);
    const anyCompleted = record.parts.some((p) => p.status === 'completed');
    finishTerminal(anyCompleted ? 'completed' : 'failed', anyCompleted ? {} : {
      error: { code: 'archive_creation_failed', message: 'Every part failed to generate an archive.' },
    });
  }

  function markRemainingPartsCancelled(fromIndex: number): void {
    for (let i = fromIndex; i < record.parts.length; i++) {
      if (record.parts[i].status === 'queued' || record.parts[i].status === 'downloading' || record.parts[i].status === 'archiving') {
        record.parts[i].status = 'cancelled';
      }
    }
  }

  /** Downloads one part's assets with bounded concurrency, honoring the
   *  per-part byte budget as an early-stop (not a mid-asset abort — an
   *  individual NFT's own resources are never split across parts). */
  async function runPart(
    partRecord: BundlePartRecord,
    partAssets: NormalizedAsset[],
    imagesDir: string,
    origMetaDir: string,
    signal: AbortSignal,
  ): Promise<{ processedCount: number; leftover: NormalizedAsset[] }> {
    partRecord.status = 'downloading';
    updateBundleProgress(record, { status: 'downloading', phase: 'downloading' });
    onProgress(record.progress);

    if (!options.images && !options.originalMetadata) {
      return { processedCount: partAssets.length, leftover: [] };
    }

    let processedCount = 0;
    const shouldStop = () => signal.aborted || partRecord.bytesDownloaded > BUNDLE_MAX_PART_DOWNLOAD_BYTES;

    const { leftover } = await runWithConcurrency(partAssets, BUNDLE_DOWNLOAD_CONCURRENCY, shouldStop, async (asset) => {
      const mintSafe = safeMintFilename(asset.mint);

      if (options.images) {
        if (!mintSafe) {
          partRecord.failures.push(mkFailure(asset, 'image', asset.image, 'invalid_url', 0));
          partRecord.failedImages++;
        } else {
          const result = await fetchAssetImage(asset.image, imageDestWithoutExt(imagesDir, mintSafe), signal, isDestinationAllowedOverride);
          if (result.ok) {
            partRecord.successfulImages++;
            partRecord.bytesDownloaded += result.bytesWritten;
            trackDiskBytes(result.bytesWritten);
          } else {
            partRecord.failures.push(mkFailure(asset, 'image', asset.image, result.code, result.retryCount));
            partRecord.failedImages++;
          }
        }
      }

      if (options.originalMetadata && !signal.aborted) {
        if (!mintSafe) {
          partRecord.failures.push(mkFailure(asset, 'original_metadata', asset.jsonUri, 'invalid_url', 0));
          partRecord.failedOriginalMetadata++;
        } else {
          const destPath = path.join(origMetaDir, `${mintSafe}.json`);
          const result = await fetchOriginalMetadata(asset.jsonUri, destPath, signal, isDestinationAllowedOverride);
          if (result.ok) {
            partRecord.successfulOriginalMetadata++;
            partRecord.bytesDownloaded += result.bytesWritten;
            trackDiskBytes(result.bytesWritten);
          } else {
            partRecord.failures.push(mkFailure(asset, 'original_metadata', asset.jsonUri, result.code, result.retryCount));
            partRecord.failedOriginalMetadata++;
          }
        }
      }

      processedCount++;
      publishAggregate(record, startedAt, onProgress);
    });

    return { processedCount, leftover };
  }
}

type ArchivePartOutcome =
  | { ok: true; zipPath: string; zipFilename: string; bytesWritten: number; sha256: string }
  | { ok: false; error: BundleErrorInfo };

async function archivePart(
  record: BundleJobRecord,
  partRecord: BundlePartRecord,
  sortedAssets: NormalizedAsset[],
  summary: ScanResultSummary,
  signal: AbortSignal,
): Promise<ArchivePartOutcome> {
  const { options } = record;
  const partAssets = sortedAssets.slice(partRecord.range.startIndex, partRecord.range.endIndex);
  const imagesDir = path.join(record.workDir, 'images');
  const origMetaDir = path.join(record.workDir, 'original-metadata');

  // Only files actually downloaded for THIS part's assets (identified by
  // filename, which is mint-based) are included — never another part's.
  const imageFiles = options.images
    ? await collectExistingFiles(imagesDir, partAssets, (mint, dir) => findByMintPrefix(dir, mint))
    : [];
  const originalMetaFiles = options.originalMetadata
    ? partAssets.filter((a) => safeMintFilename(a.mint)).map((a) => ({ mint: a.mint, filePath: path.join(origMetaDir, `${a.mint}.json`) }))
      .filter((e) => fs.existsSync(e.filePath))
    : [];

  const generatedAt = new Date().toISOString();
  const collectionFolderName = record.collectionDisplayName;
  const readmeText = buildReadmeText({
    collectionAddress: summary.collectionAddress,
    scanCompletedAt: summary.completedAt,
    exactAssetCount: summary.exactAssetCount,
    bundleGeneratedAt: generatedAt,
    options,
    successfulImages: partRecord.successfulImages,
    failedImages: partRecord.failedImages,
    successfulOriginalMetadata: partRecord.successfulOriginalMetadata,
    failedOriginalMetadata: partRecord.failedOriginalMetadata,
  });
  const partManifestJson = JSON.stringify(buildPartManifestEntry({
    collectionAddress: summary.collectionAddress,
    collectionDisplayName: record.collectionDisplayName,
    jobId: record.jobId,
    partNumber: partRecord.partNumber,
    totalParts: record.totalParts,
    firstMint: partRecord.range.firstMint,
    lastMint: partRecord.range.lastMint,
    assetsInPart: partRecord.range.assetCount,
    exactCollectionCount: summary.exactAssetCount,
    options,
    generatedAt,
  }), null, 2);

  const zipFilename = partZipFilename(record.collectionDisplayName, partRecord.partNumber, record.totalParts);
  const zipPath = path.join(record.workDir, zipFilename);

  try {
    const zipResult = await buildBundleZip({
      collectionFolderName,
      readmeText,
      partManifestJson,
      collectionSummaryJson: options.collectionSummary ? JSON.stringify(summary, null, 2) : undefined,
      assetsJson: options.assetsJson ? JSON.stringify(partAssets, null, 2) : undefined,
      assetsCsv: options.assetsCsv ? buildAssetsCsv(partAssets) : undefined,
      traitCountsJson: options.traitCounts ? JSON.stringify(summary.traitCategories, null, 2) : undefined,
      failedDownloadsJson: options.failureReport ? JSON.stringify(partRecord.failures, null, 2) : undefined,
      normalizedMetadataEntries: options.normalizedMetadata
        ? partAssets.filter((a) => safeMintFilename(a.mint)).map((a) => ({ mint: a.mint, json: JSON.stringify(a, null, 2) }))
        : undefined,
      imageFiles: options.images ? imageFiles : undefined,
      originalMetadataFiles: options.originalMetadata ? originalMetaFiles : undefined,
    }, zipPath, signal);

    if (zipResult.bytesWritten > BUNDLE_MAX_ZIP_BYTES) {
      await fs.promises.rm(zipPath, { force: true });
      return { ok: false, error: { code: 'total_size_exceeded', message: `Part ${partRecord.partNumber} archive exceeded the configured size limit.` } };
    }
    const digest = await sha256File(zipPath);
    return { ok: true, zipPath, zipFilename, bytesWritten: zipResult.bytesWritten, sha256: digest };
  } catch {
    if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Bundle job cancelled.' } };
    return { ok: false, error: { code: 'archive_creation_failed', message: `Failed to create part ${partRecord.partNumber}'s archive.` } };
  }
}

async function collectExistingFiles(
  dir: string,
  partAssets: NormalizedAsset[],
  finder: (mint: string, dir: string) => Promise<{ filePath: string; ext: string } | null>,
): Promise<Array<{ mint: string; filePath: string; ext: string }>> {
  const out: Array<{ mint: string; filePath: string; ext: string }> = [];
  for (const asset of partAssets) {
    const mintSafe = safeMintFilename(asset.mint);
    if (!mintSafe) continue;
    const found = await finder(mintSafe, dir);
    if (found) out.push({ mint: mintSafe, filePath: found.filePath, ext: found.ext });
  }
  return out;
}

/** Images are saved as `<mint>.<ext>` where `<ext>` is only known after
 *  content-sniffing (image-fetch.ts) — find whichever extension actually
 *  landed for this mint. */
async function findByMintPrefix(dir: string, mint: string): Promise<{ filePath: string; ext: string } | null> {
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    const p = path.join(dir, `${mint}.${ext}`);
    try { await fs.promises.access(p); return { filePath: p, ext }; } catch { /* try next */ }
  }
  return null;
}
