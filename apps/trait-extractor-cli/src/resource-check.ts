/**
 * trait-extractor-cli - preflight resource safeguards (Stage 5.3 section 6).
 *
 * Runs BEFORE any download starts: output directory is writable, there is
 * plausibly enough free disk for the estimated temp footprint, and the
 * caller gets a rough image-count estimate to sanity-check against
 * `--download-concurrency` before committing to a long-running job.
 *
 * Disk-space checking uses `fs.promises.statfs`, available cross-platform
 * (including Windows) since Node 18.15. If the current Node/OS combination
 * doesn't support it, the check is skipped (reported, not fatal) rather
 * than blocking every environment on one optional signal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TE_MAX_TEMP_DISK_BYTES, TE_MAX_UNIQUE_IMAGE_DOWNLOADS, TE_MIN_FREE_DISK_BYTES } from 'trait-extraction-core';
import type { ExtractionPresetLimits } from 'trait-extraction-core';
import type { ValueTarget } from 'trait-extraction-core';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimatedUniqueImages: number;
  estimatedTempBytes: number;
  freeDiskBytes: number | null;
}

async function checkWritable(dir: string): Promise<string | null> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.unlink(probe);
    return null;
  } catch (err) {
    return `Output directory "${dir}" is not writable: ${(err as Error).message}`;
  }
}

async function freeDiskBytes(dir: string): Promise<number | null> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bsize: number; bavail: number }> }).statfs;
  if (!statfs) return null;
  try {
    const stats = await statfs(dir);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/** Rough order-of-magnitude estimate, not exact: each target attempts up
 *  to `maxComparisonPairsPerValue` pairs, each pair touching up to 2
 *  distinct images, capped by the job-wide unique-download ceiling and by
 *  how many distinct source assets even exist to compare against. */
export function estimateUniqueImages(targets: ValueTarget[], limits: ExtractionPresetLimits): number {
  const roughPerTarget = limits.maxComparisonPairsPerValue * 2;
  return Math.min(TE_MAX_UNIQUE_IMAGE_DOWNLOADS, targets.length * roughPerTarget);
}

export async function runPreflightChecks(outputDir: string, targets: ValueTarget[], limits: ExtractionPresetLimits): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const writableError = await checkWritable(outputDir);
  if (writableError) errors.push(writableError);

  const estimatedUniqueImages = estimateUniqueImages(targets, limits);
  // Average compressed source image assumed ~1-2MB (PNG/WEBP pfp art);
  // this is a generous per-image budget for the "is there plausibly enough
  // disk" check, not a byte-accurate prediction.
  const estimatedTempBytes = Math.min(TE_MAX_TEMP_DISK_BYTES, estimatedUniqueImages * 2 * 1024 * 1024);

  const freeBytes = await freeDiskBytes(outputDir);
  if (freeBytes === null) {
    warnings.push('Could not determine free disk space on this platform/Node version - proceeding without a disk-space guarantee.');
  } else if (freeBytes < Math.max(estimatedTempBytes, TE_MIN_FREE_DISK_BYTES)) {
    errors.push(`Only ${Math.round(freeBytes / 1024 / 1024)}MB free at "${outputDir}", estimated need is ~${Math.round(estimatedTempBytes / 1024 / 1024)}MB (minimum floor ${Math.round(TE_MIN_FREE_DISK_BYTES / 1024 / 1024)}MB).`);
  }

  return { ok: errors.length === 0, errors, warnings, estimatedUniqueImages, estimatedTempBytes, freeDiskBytes: freeBytes };
}
