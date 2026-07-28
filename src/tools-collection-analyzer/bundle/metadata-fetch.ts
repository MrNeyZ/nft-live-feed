/**
 * Collection Analyzer - Stage 3 original off-chain metadata download.
 *
 * Downloads one asset's `jsonUri` (already resolved by Stage 1/2 - no
 * re-scan) through the SSRF-safe downloader, then validates the content is
 * actually parseable JSON. The response `Content-Type` header is NOT relied
 * on for acceptance (many IPFS/Arweave gateways serve JSON with a generic
 * `application/octet-stream` or `text/plain` type) - `JSON.parse` is the
 * authoritative gate, matching the spec's "accept valid JSON only".
 *
 * Normalized metadata (Stage 2's NormalizedAsset) never depends on this
 * succeeding - it's derived entirely from already-completed scan data and
 * is written independently by `bundle-zip.ts`.
 */
import * as fs from 'fs';
import { downloadToFile, type AddressValidator } from 'trait-extraction-core';
import { BUNDLE_MAX_METADATA_BYTES } from './bundle-limits';
import type { DownloadFailureCode } from './bundle-types';

export interface MetadataFetchResult {
  ok: true;
  finalPath: string;
  bytesWritten: number;
  retryCount: number;
}
export interface MetadataFetchFailure {
  ok: false;
  code: DownloadFailureCode;
  retryCount: number;
}

export async function fetchOriginalMetadata(
  jsonUri: string | null,
  destPath: string,
  signal: AbortSignal,
  /** TEST-ONLY — see ssrf-guard.ts `DownloadOptions.isDestinationAllowedOverride`. */
  isDestinationAllowedOverride?: AddressValidator,
): Promise<MetadataFetchResult | MetadataFetchFailure> {
  if (!jsonUri) return { ok: false, code: 'no_source_url', retryCount: 0 };

  const tempPath = `${destPath}.tmp`;
  const { outcome, retryCount } = await downloadToFile(jsonUri, {
    destPath: tempPath,
    maxBytes: BUNDLE_MAX_METADATA_BYTES,
    signal,
    isDestinationAllowedOverride,
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, retryCount };

  let raw: string;
  try {
    raw = await fs.promises.readFile(tempPath, 'utf8');
  } catch {
    await unlinkQuiet(tempPath);
    return { ok: false, code: 'network_error', retryCount };
  }

  try {
    JSON.parse(raw); // validation only - the raw bytes are stored as-is below
  } catch {
    await unlinkQuiet(tempPath);
    return { ok: false, code: 'malformed_json', retryCount };
  }

  await fs.promises.rename(tempPath, destPath);
  return { ok: true, finalPath: destPath, bytesWritten: outcome.bytesWritten, retryCount };
}

async function unlinkQuiet(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort */ }
}
