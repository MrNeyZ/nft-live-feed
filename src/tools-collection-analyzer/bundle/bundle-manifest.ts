/**
 * Collection Analyzer - Stage 4 manifest + checksum helpers.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import type {
  BundleManifest,
  BundleManifestPartEntry,
  BundleOptions,
  BundlePartRecord,
  PartManifestEntry,
} from './bundle-types';

/** Streams the file through SHA-256 rather than reading it fully into
 *  memory - archives can be sizable. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Deterministic per-part ZIP filename: `<collection>-part-001-of-003.zip`.
 *  Zero-padded to the width of `totalParts` (minimum 3 digits) so
 *  filenames sort correctly regardless of part count. Single-part jobs
 *  (totalParts === 1) instead get the plain Stage-3-style filename with no
 *  "-part-" suffix, preserving the exact old download experience. */
export function partZipFilename(collectionDisplayName: string, partNumber: number, totalParts: number): string {
  if (totalParts <= 1) return `${collectionDisplayName}.zip`;
  const width = Math.max(3, String(totalParts).length);
  const pad = (n: number) => String(n).padStart(width, '0');
  return `${collectionDisplayName}-part-${pad(partNumber)}-of-${pad(totalParts)}.zip`;
}

export function manifestFilename(collectionDisplayName: string): string {
  return `${collectionDisplayName}-manifest.json`;
}

export function buildPartManifestEntry(args: {
  collectionAddress: string;
  collectionDisplayName: string;
  jobId: string;
  partNumber: number;
  totalParts: number;
  firstMint: string;
  lastMint: string;
  assetsInPart: number;
  exactCollectionCount: number;
  options: BundleOptions;
  generatedAt: string;
}): PartManifestEntry {
  return { ...args };
}

export function buildTopLevelManifest(args: {
  jobId: string;
  scanId: string;
  collectionAddress: string;
  collectionDisplayName: string;
  generatedAt: string;
  exactAssetCount: number;
  options: BundleOptions;
  parts: BundlePartRecord[];
}): BundleManifest {
  const parts: BundleManifestPartEntry[] = args.parts.map((p) => ({
    filename: p.zipFilename ?? partZipFilename(args.collectionDisplayName, p.partNumber, args.parts.length),
    partNumber: p.partNumber,
    assetCount: p.range.assetCount,
    firstMint: p.range.firstMint,
    lastMint: p.range.lastMint,
    archiveBytes: p.archiveBytesWritten,
    sha256: p.sha256,
    status: p.status,
    downloadAvailable: p.status === 'completed' && !!p.zipPath,
  }));
  return {
    jobId: args.jobId,
    scanId: args.scanId,
    collectionAddress: args.collectionAddress,
    collectionDisplayName: args.collectionDisplayName,
    generatedAt: args.generatedAt,
    exactAssetCount: args.exactAssetCount,
    totalParts: args.parts.length,
    options: args.options,
    parts,
  };
}
