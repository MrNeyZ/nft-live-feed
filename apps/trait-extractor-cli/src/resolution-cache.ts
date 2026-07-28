/**
 * trait-extractor-cli - persistent input-resolution cache.
 *
 * Closes the one offline-mode gap `docs/known-limitations.md` documented:
 * `resolveInputToCollectionAddress` (shared backend code, not modified)
 * ALWAYS makes a network call, even for address-shaped input (it checks
 * whether the address is actually an individual mint via DAS). Stage 5.4
 * originally only let `--offline` skip that call when the raw
 * `--collection` input literally equaled a collection address that
 * already had its own cached scan - which never worked for a mint or
 * marketplace-URL input, since those don't equal their resolved
 * collection address as a string.
 *
 * This module persists the FULL resolution result (not just the address -
 * `inputKind`/`extraWarnings` too, so an offline replay's log output and
 * eligibility/warnings match what an online run would have shown) keyed
 * by a hash of the RAW input string, under the shared global cache root's
 * `resolutions/` directory (see cache-paths.ts). Once any online run has
 * resolved a given mint/URL/address once, every later run using that
 * EXACT SAME raw input - online or offline - skips the network call
 * entirely.
 *
 * No staleness/max-age check: unlike a collection's asset list (which
 * changes as new mints happen), a mint's or marketplace listing's
 * collection membership is an immutable on-chain/marketplace fact once
 * observed - it does not need to be re-verified periodically. `--fresh`
 * still bypasses the cache entirely, same as the scan cache.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import { resolutionsDir } from './cache-paths';
import { readJsonQuiet, unlinkQuiet, writeAtomic } from './fs-atomic';

export type ResolutionInputKind = 'collection' | 'mint' | 'tensor_url' | 'magiceden_url';

export interface PersistedResolution {
  inputKind: ResolutionInputKind;
  collectionAddress: string;
  extraWarnings: string[];
}

interface ResolutionCacheFile {
  rawInput: string;
  resolvedAt: string;
  checksum: string;
  resolution: PersistedResolution;
}

function resolutionPath(cacheRoot: string, rawInput: string): string {
  const key = crypto.createHash('sha256').update(rawInput).digest('hex').slice(0, 32);
  return path.join(resolutionsDir(cacheRoot), `${key}.json`);
}

function computeChecksum(resolution: PersistedResolution): string {
  return crypto.createHash('sha256').update(JSON.stringify(resolution)).digest('hex');
}

/** Returns null (never throws) for: no cached entry, corrupt/unparsable
 *  JSON, a checksum mismatch, or a rawInput mismatch (defensive tamper/
 *  hash-collision check, same pattern as manifest.ts's checkpoint key
 *  verification) - all mean "cannot safely reuse this," never "crash." */
export async function loadResolutionCache(cacheRoot: string, rawInput: string): Promise<PersistedResolution | null> {
  const file = await readJsonQuiet<ResolutionCacheFile>(resolutionPath(cacheRoot, rawInput));
  if (!file || file.rawInput !== rawInput) return null;
  if (computeChecksum(file.resolution) !== file.checksum) return null;
  return file.resolution;
}

export async function saveResolutionCache(cacheRoot: string, rawInput: string, resolution: PersistedResolution): Promise<void> {
  const file: ResolutionCacheFile = {
    rawInput,
    resolvedAt: new Date().toISOString(),
    checksum: computeChecksum(resolution),
    resolution,
  };
  await writeAtomic(resolutionPath(cacheRoot, rawInput), JSON.stringify(file));
}

export async function clearResolutionCacheEntry(cacheRoot: string, rawInput: string): Promise<void> {
  await unlinkQuiet(resolutionPath(cacheRoot, rawInput));
}
