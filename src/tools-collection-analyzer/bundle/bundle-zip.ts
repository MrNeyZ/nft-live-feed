/**
 * Collection Analyzer - Stage 3 deterministic ZIP archive builder.
 *
 * Streams directly to disk via yazl - never buffers the whole archive in
 * memory. Structure (fixed, deterministic order):
 *
 *   <collectionFolderName>/
 *     README.txt
 *     collection-summary.json      (if selected)
 *     assets.json                  (if selected)
 *     assets.csv                   (if selected)
 *     trait-counts.json            (if selected)
 *     failed-downloads.json        (if selected)
 *     part-manifest.json           (Stage 4 — always present, describes
 *                                    this part's place in the whole job;
 *                                    trivial single-part-of-1 for Stage 3
 *                                    style single-ZIP jobs)
 *     images/<mint>.<ext>          (if selected, sorted by mint)
 *     metadata/<mint>.json         (if selected, sorted by mint)
 *     original-metadata/<mint>.json (if selected, sorted by mint)
 */
import * as fs from 'fs';
import { ZipFile } from 'yazl';

export interface BundleZipEntry {
  mint: string;
  filePath: string;
  ext?: string; // required for images, omitted (defaults to "json") for metadata
}

export interface BundleZipInputs {
  collectionFolderName: string;
  readmeText: string;
  collectionSummaryJson?: string;
  assetsJson?: string;
  assetsCsv?: string;
  traitCountsJson?: string;
  failedDownloadsJson?: string;
  partManifestJson: string;
  /** Normalized metadata is generated in-memory from Stage 2 data (never
   *  downloaded), so it's passed as ready-made JSON strings, not file paths. */
  normalizedMetadataEntries?: Array<{ mint: string; json: string }>;
  imageFiles?: BundleZipEntry[];
  originalMetadataFiles?: BundleZipEntry[];
}

export interface BundleZipResult {
  bytesWritten: number;
}

function byMint<T extends { mint: string }>(a: T, b: T): number {
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/** Builds the archive at `outputZipPath`. Resolves once the file is fully
 *  flushed to disk; rejects on any write/archive error or cancellation. */
export function buildBundleZip(inputs: BundleZipInputs, outputZipPath: string, signal: AbortSignal): Promise<BundleZipResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }

    const zip = new ZipFile();
    const root = inputs.collectionFolderName;

    zip.addBuffer(Buffer.from(inputs.readmeText, 'utf8'), `${root}/README.txt`);
    if (inputs.collectionSummaryJson !== undefined) {
      zip.addBuffer(Buffer.from(inputs.collectionSummaryJson, 'utf8'), `${root}/collection-summary.json`);
    }
    if (inputs.assetsJson !== undefined) {
      zip.addBuffer(Buffer.from(inputs.assetsJson, 'utf8'), `${root}/assets.json`);
    }
    if (inputs.assetsCsv !== undefined) {
      zip.addBuffer(Buffer.from(inputs.assetsCsv, 'utf8'), `${root}/assets.csv`);
    }
    if (inputs.traitCountsJson !== undefined) {
      zip.addBuffer(Buffer.from(inputs.traitCountsJson, 'utf8'), `${root}/trait-counts.json`);
    }
    if (inputs.failedDownloadsJson !== undefined) {
      zip.addBuffer(Buffer.from(inputs.failedDownloadsJson, 'utf8'), `${root}/failed-downloads.json`);
    }
    zip.addBuffer(Buffer.from(inputs.partManifestJson, 'utf8'), `${root}/part-manifest.json`);

    for (const img of [...(inputs.imageFiles ?? [])].sort(byMint)) {
      zip.addFile(img.filePath, `${root}/images/${img.mint}.${img.ext ?? 'bin'}`);
    }
    for (const md of [...(inputs.normalizedMetadataEntries ?? [])].sort(byMint)) {
      zip.addBuffer(Buffer.from(md.json, 'utf8'), `${root}/metadata/${md.mint}.json`);
    }
    for (const om of [...(inputs.originalMetadataFiles ?? [])].sort(byMint)) {
      zip.addFile(om.filePath, `${root}/original-metadata/${om.mint}.json`);
    }

    zip.end();

    const writeStream = fs.createWriteStream(outputZipPath);
    let bytesWritten = 0;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      writeStream.destroy();
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    zip.outputStream.on('data', (chunk: Buffer) => { bytesWritten += chunk.length; });
    zip.outputStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    writeStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ bytesWritten });
    });

    zip.outputStream.pipe(writeStream);
  });
}
