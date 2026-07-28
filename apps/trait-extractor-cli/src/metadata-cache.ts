/**
 * trait-extractor-cli - persistent DAS scan-result cache (Stage 5.4
 * section 2 / section 5).
 *
 * Stage 5.3 re-walked the ENTIRE collection via Helius DAS on every run,
 * including a pure resume that only needed to keep processing already-
 * discovered targets - the most rate-limited, credit-costly step was
 * exactly the one that never benefited from resumability. This caches the
 * completed `walkFullCollection` result, keyed by `collectionAddress`,
 * under the shared global cache root's `scans/` directory (see
 * cache-paths.ts).
 *
 * Only a *completed* scan is ever cached - a crash/cancel mid-scan has
 * nothing to save here (walkFullCollection itself has no page-cursor
 * persistence, and that file is shared backend code this project must not
 * modify), so a crash during an in-progress scan still fully re-walks on
 * the next run. What this DOES fix is the spec's own example scenario
 * once the scan has actually finished at least once: no subsequent run
 * (fresh retry after a later crash, a second `--output` dir, an
 * `--estimate`/`--list-categories` call) ever re-walks a collection whose
 * scan already completed and is still fresh.
 */
import type { NormalizedAsset } from 'trait-extraction-core';
import * as crypto from 'crypto';
import * as path from 'path';
import type { AttributeIssue } from '../../../src/tools-collection-analyzer/scan-normalize';
import { scansDir } from './cache-paths';
import { readJsonQuiet, unlinkQuiet, writeAtomic } from './fs-atomic';

export interface CachedScanResult {
  assets: NormalizedAsset[];
  perAssetIssues: AttributeIssue[][];
  pagesFetched: number;
  duplicatesSkipped: number;
  warnings: string[];
}

interface ScanCacheFile {
  collectionAddress: string;
  scannedAt: string;
  checksum: string;
  result: CachedScanResult;
}

function scanPath(cacheRoot: string, collectionAddress: string): string {
  // Collection addresses are already filesystem-safe base58 strings, but a
  // hash keeps this robust against any future non-address input landing
  // here (e.g. a URL slug) without a separate sanitization pass.
  const key = crypto.createHash('sha256').update(collectionAddress).digest('hex').slice(0, 32);
  return path.join(scansDir(cacheRoot), `${key}.json`);
}

function computeChecksum(result: CachedScanResult): string {
  return crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

/** Returns null (never throws) for: no cached entry, corrupt/unparsable
 *  JSON, a checksum mismatch (disk corruption / manual tampering), or an
 *  entry older than `maxAgeMs` - all mean "cannot safely reuse this,"
 *  never "crash the CLI." `maxAgeMs = Infinity` (e.g. `--offline`) accepts
 *  any age. */
export async function loadCachedScan(cacheRoot: string, collectionAddress: string, maxAgeMs: number): Promise<CachedScanResult | null> {
  const file = await readJsonQuiet<ScanCacheFile>(scanPath(cacheRoot, collectionAddress));
  if (!file || file.collectionAddress !== collectionAddress) return null;
  if (computeChecksum(file.result) !== file.checksum) return null;
  const ageMs = Date.now() - new Date(file.scannedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) return null;
  return file.result;
}

export async function saveCachedScan(cacheRoot: string, collectionAddress: string, result: CachedScanResult): Promise<void> {
  const file: ScanCacheFile = {
    collectionAddress,
    scannedAt: new Date().toISOString(),
    checksum: computeChecksum(result),
    result,
  };
  await writeAtomic(scanPath(cacheRoot, collectionAddress), JSON.stringify(file));
}

/** Exposed for `--clear-cache`'s scan-only variant and tests; the common
 *  `--clear-cache` path just wipes the whole cache root (cache-paths.ts's
 *  `clearCache`), this is for anything narrower. */
export async function clearCachedScan(cacheRoot: string, collectionAddress: string): Promise<void> {
  await unlinkQuiet(scanPath(cacheRoot, collectionAddress));
}
