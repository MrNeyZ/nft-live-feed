/**
 * Collection Analyzer Stage 4 — genuine asset-count-driven multi-part
 * split, exercised end-to-end through the real orchestrator.
 *
 * BUNDLE_MAX_ASSETS_PER_PART is set BEFORE any project module is imported
 * (verified: this project's ts-node/CommonJS emit preserves source order,
 * so a plain statement ahead of `import` runs first and the env-driven
 * constant in bundle-limits.ts picks it up at module-load time). This lets
 * a small, fast, deterministic asset count (12) genuinely trigger a
 * multi-part split without waiting on thousands of fake assets.
 *
 * Run: npm run test:collection-analyzer-multipart-split
 */
process.env.BUNDLE_MAX_ASSETS_PER_PART = '5';
process.env.HELIUS_API_KEY = 'test-key-not-used-network-mocked';

import assert from 'assert';
import yauzl from 'yauzl';
import { createBundleJob, publishBundleProgress } from '../bundle-state-store';
import { executeBundleJob } from '../bundle-run';
import { DEFAULT_BUNDLE_OPTIONS } from '../bundle-types';
import type { NormalizedAsset } from '../../types';
import type { ScanResultSummary } from '../../scan-types';

let failures = 0;
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function fakeAsset(mint: string, name: string): NormalizedAsset {
  return { mint, name, image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [] };
}
function fakeSummary(scanId: string, assets: NormalizedAsset[]): ScanResultSummary {
  return {
    scanId, collectionAddress: 'COLL1111111111111111111111111111111111111', inputKind: 'collection', inputValue: 'COLL1111111111111111111111111111111111111',
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100,
    pagesFetched: 1, exactAssetCount: assets.length, duplicatesSkipped: 0,
    quality: {
      totalAssets: assets.length, assetsWithValidMetadata: assets.length, assetsMissingAttributes: 0, assetsMissingImage: 0,
      assetsMissingName: 0, compressedCount: 0, regularCount: assets.length, malformedAttributesSkipped: 0,
      duplicateIdenticalAttributePairsCollapsed: 0, conflictingDuplicateTraitTypeAssets: 0,
      nullValueAttributes: 0, emptyStringValueAttributes: 0, nonStringTraitTypeCoerced: 0,
    },
    traitCategories: [], duplicateMetadataGroups: [], duplicateImageGroups: [], traitsPerNftDistribution: [],
    oneOfOneHighlights: [], oneOfOneHighlightsTruncated: false, warnings: [],
  };
}
function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { reject(err); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => { names.push(entry.fileName); zipfile.readEntry(); });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
    });
  });
}
function readZipEntryText(zipPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { reject(err); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) { reject(err2); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
      });
      zipfile.on('error', reject);
    });
  });
}

async function main() {
  console.log('\nGenuine multi-part split (BUNDLE_MAX_ASSETS_PER_PART=5, 12 assets -> 3 parts)');

  // 12 assets, mints deliberately NOT pre-sorted, to also prove the
  // orchestrator sorts before planning.
  const mints = ['M009', 'M001', 'M011', 'M003', 'M000', 'M007', 'M004', 'M010', 'M002', 'M006', 'M005', 'M008'];
  const assets = mints.map((m) => fakeAsset(`MINT${m}A1111111111111111111111111111111111`, `Frogana ${m}`));

  const record = createBundleJob('scan-real-split', { ...DEFAULT_BUNDLE_OPTIONS, images: false, originalMetadata: false }, assets.length);
  const summary = fakeSummary('scan-real-split', assets);
  await executeBundleJob({ record, assets, summary, onProgress: (p) => publishBundleProgress(record.jobId, p) });

  await checkAsync('job completes with exactly 3 parts (ceil(12/5))', async () => {
    assert.strictEqual(record.status, 'completed');
    assert.strictEqual(record.totalParts, 3);
    assert.strictEqual(record.parts.length, 3);
  });

  await checkAsync('part sizes are 5/5/2, contiguous, mint-sorted boundaries', async () => {
    assert.deepStrictEqual(record.parts.map((p) => p.range.assetCount), [5, 5, 2]);
    const sortedMints = [...assets].map((a) => a.mint).sort();
    assert.strictEqual(record.parts[0].range.firstMint, sortedMints[0]);
    assert.strictEqual(record.parts[0].range.lastMint, sortedMints[4]);
    assert.strictEqual(record.parts[1].range.firstMint, sortedMints[5]);
    assert.strictEqual(record.parts[1].range.lastMint, sortedMints[9]);
    assert.strictEqual(record.parts[2].range.firstMint, sortedMints[10]);
    assert.strictEqual(record.parts[2].range.lastMint, sortedMints[11]);
  });

  await checkAsync('every part completed with a filename following <collection>-part-NNN-of-003.zip', async () => {
    for (const p of record.parts) {
      assert.strictEqual(p.status, 'completed');
      assert.ok(p.zipFilename?.match(/-part-00\d-of-003\.zip$/), `unexpected filename: ${p.zipFilename}`);
      assert.ok(p.sha256 && /^[0-9a-f]{64}$/.test(p.sha256));
    }
  });

  await checkAsync('each part\'s assets.json contains ONLY that part\'s assets (no cross-part leakage)', async () => {
    const entries0 = await listZipEntries(record.parts[0].zipPath!);
    const assetsJsonEntry = entries0.find((e) => e.endsWith('/assets.json'))!;
    const assetsJson = JSON.parse(await readZipEntryText(record.parts[0].zipPath!, assetsJsonEntry));
    assert.strictEqual(assetsJson.length, 5);
    const part0Mints = new Set(assetsJson.map((a: { mint: string }) => a.mint));
    assert.strictEqual(part0Mints.has(record.parts[1].range.firstMint), false);
  });

  await checkAsync('collection-summary.json (collection-wide) is present in every part and reports the GLOBAL exact count, not the part count', async () => {
    for (const p of record.parts) {
      const entries = await listZipEntries(p.zipPath!);
      const summaryEntry = entries.find((e) => e.endsWith('/collection-summary.json'))!;
      const parsed = JSON.parse(await readZipEntryText(p.zipPath!, summaryEntry));
      assert.strictEqual(parsed.exactAssetCount, 12); // global, not this part's 5/5/2
    }
  });

  await checkAsync('part-manifest.json inside each part correctly identifies its own part number vs the global total', async () => {
    for (const p of record.parts) {
      const entries = await listZipEntries(p.zipPath!);
      const manifestEntry = entries.find((e) => e.endsWith('/part-manifest.json'))!;
      const manifest = JSON.parse(await readZipEntryText(p.zipPath!, manifestEntry));
      assert.strictEqual(manifest.partNumber, p.partNumber);
      assert.strictEqual(manifest.totalParts, 3);
      assert.strictEqual(manifest.assetsInPart, p.range.assetCount);
      assert.strictEqual(manifest.exactCollectionCount, 12);
    }
  });

  await checkAsync('top-level manifest lists all 3 parts with distinct checksums', async () => {
    assert.strictEqual(record.manifestStatus, 'completed');
    const fs = await import('fs');
    const manifest = JSON.parse(await fs.promises.readFile(record.manifestPath!, 'utf8'));
    assert.strictEqual(manifest.totalParts, 3);
    assert.strictEqual(manifest.parts.length, 3);
    const checksums = new Set(manifest.parts.map((p: { sha256: string }) => p.sha256));
    assert.strictEqual(checksums.size, 3); // all distinct (different content per part)
    assert.ok(manifest.parts.every((p: { downloadAvailable: boolean }) => p.downloadAvailable === true));
  });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
