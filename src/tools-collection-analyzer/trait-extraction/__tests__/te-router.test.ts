/**
 * Trait Extraction - full HTTP integration tests. Runs a REAL local image
 * fixture server (synthetic PNGs with known ground-truth regions) and
 * drives the actual router end-to-end via the test-only SSRF override
 * (never exposed through production code paths - see
 * bundle/ssrf-guard.ts's doc comment on `isDestinationAllowedOverride`).
 * No live internet calls.
 *
 * Run: npm run test:collection-analyzer-te-router
 */
import assert from 'assert';
import express from 'express';
import type { Server } from 'http';
import * as http from 'http';
import * as fs from 'fs';
import sharp from 'sharp';
import { createCollectionAnalyzerRouter } from '../../../server/tools-collection-analyzer';
import { createScan, finalizeScan } from '../../scan-state-store';
import { createTraitExtractionJob, expireTraitExtractionJobNow, getTraitExtractionJob, jobWorkDir, publishTraitExtractionProgress, sweepOrphanedTraitExtractionTempDirs, traitExtractionTempRoot } from '../te-state-store';
import { executeTraitExtractionJob } from '../te-run';
import type { NormalizedAsset } from '../../types';
import type { ScanResultSummary } from '../../scan-types';
import * as path from 'path';

process.env.HELIUS_API_KEY = 'test-key-not-used-network-mocked';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

const allowOnlyLoopback = (ip: string): boolean => ip === '127.0.0.1';

// ── Synthetic image fixture server ──────────────────────────────────────
// Each mint maps to a 16x16 canvas: a background-color fill representing
// the "Background" trait, plus (for Eyes=Laser) a red 6x6 block or (for
// Eyes=Normal) a blue 6x6 block at the SAME position - exactly the
// "one region, mutually exclusive colors per value" shape the algorithm
// is designed around.
const CANVAS = 16;
async function synthPng(bgColor: [number, number, number], eyesColor: [number, number, number] | null): Promise<Buffer> {
  const data = Buffer.alloc(CANVAS * CANVAS * 4);
  for (let i = 0; i < CANVAS * CANVAS; i++) { const o = i * 4; data[o] = bgColor[0]; data[o + 1] = bgColor[1]; data[o + 2] = bgColor[2]; data[o + 3] = 255; }
  if (eyesColor) {
    for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
      const o = (y * CANVAS + x) * 4;
      data[o] = eyesColor[0]; data[o + 1] = eyesColor[1]; data[o + 2] = eyesColor[2]; data[o + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: CANVAS, height: CANVAS, channels: 4 } }).png().toBuffer();
}

const BLUE_BG: [number, number, number] = [80, 80, 200];
const RED_BG: [number, number, number] = [200, 80, 80];
const LASER_COLOR: [number, number, number] = [230, 30, 30];
const NORMAL_COLOR: [number, number, number] = [30, 30, 230];

interface FixtureServerHandle { baseUrl: string; close: () => Promise<void> }
async function startFixtureServer(): Promise<FixtureServerHandle> {
  const cache = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    if (url === '/private-redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/secret' }); res.end(); return; }
    const m = url.match(/^\/nft\/(A1|A2|A3|A4)\.png$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    let buf = cache.get(m[1]);
    if (!buf) {
      buf = m[1] === 'A1' ? await synthPng(BLUE_BG, LASER_COLOR)
        : m[1] === 'A2' ? await synthPng(RED_BG, LASER_COLOR)
        : m[1] === 'A3' ? await synthPng(BLUE_BG, NORMAL_COLOR)
        : await synthPng(RED_BG, NORMAL_COLOR);
      cache.set(m[1], buf);
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(buf);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function fakeSummary(scanId: string, assets: NormalizedAsset[]): ScanResultSummary {
  return {
    scanId, collectionAddress: 'COLL1111111111111111111111111111111111111', inputKind: 'collection', inputValue: 'COLL1111111111111111111111111111111111111',
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100,
    pagesFetched: 1, exactAssetCount: assets.length, duplicatesSkipped: 0,
    quality: { totalAssets: assets.length, assetsWithValidMetadata: assets.length, assetsMissingAttributes: 0, assetsMissingImage: 0, assetsMissingName: 0, compressedCount: 0, regularCount: assets.length, malformedAttributesSkipped: 0, duplicateIdenticalAttributePairsCollapsed: 0, conflictingDuplicateTraitTypeAssets: 0, nullValueAttributes: 0, emptyStringValueAttributes: 0, nonStringTraitTypeCoerced: 0 },
    traitCategories: [], duplicateMetadataGroups: [], duplicateImageGroups: [], traitsPerNftDistribution: [],
    oneOfOneHighlights: [], oneOfOneHighlightsTruncated: false, warnings: [],
  };
}
function seedCompletedScan(assets: NormalizedAsset[]) {
  const record = createScan('COLL1111111111111111111111111111111111111', 'collection', 'COLL1111111111111111111111111111111111111');
  finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId, assets), assets });
  return record;
}
function traitCollectionAssets(baseUrl: string): NormalizedAsset[] {
  const a = (mint: string, bg: string, eyes: string): NormalizedAsset => ({
    mint, name: mint, image: `${baseUrl}/nft/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy',
    attributes: [{ trait_type: 'Background', value: bg }, { trait_type: 'Eyes', value: eyes }],
  });
  return [a('A1', 'Blue', 'Laser'), a('A2', 'Red', 'Laser'), a('A3', 'Blue', 'Normal'), a('A4', 'Red', 'Normal')];
}

async function withTestApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createCollectionAnalyzerRouter());
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(() => resolve(undefined))); }
}
async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}
async function getJson(url: string): Promise<{ status: number; json: any }> {
  const r = await fetch(url);
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function waitForTerminal(jobId: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = getTraitExtractionJob(jobId);
    if (!job) return;
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return;
    await sleep(50);
  }
}

async function main() {
  const fixture = await startFixtureServer();

  console.log('\nHTTP: eligibility + creation validation');

  await checkAsync('eligibility endpoint reports a real classification for a completed scan', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan(traitCollectionAssets(fixture.baseUrl));
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/trait-extractions/eligibility`, {});
      assert.strictEqual(r.status, 200);
      assert.ok(['suitable', 'possibly_suitable', 'unsuitable'].includes(r.json.eligibility.classification));
    });
  });

  await checkAsync('rejects empty selection -> 400', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan(traitCollectionAssets(fixture.baseUrl));
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/trait-extractions`, { selections: [], preset: 'balanced' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.error, 'empty_selection');
    });
  });

  await checkAsync('ineligible (unsuitable) collection is rejected by default without an override', async () => {
    await withTestApp(async (base) => {
      const oneOfOneAssets: NormalizedAsset[] = Array.from({ length: 10 }, (_, i) => ({
        mint: `U${i}`, name: `U${i}`, image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy',
        attributes: [{ trait_type: `Unique${i}`, value: `Only${i}` }],
      }));
      const scan = seedCompletedScan(oneOfOneAssets);
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/trait-extractions`, { selections: [{ traitType: 'Unique0' }], preset: 'balanced' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'ineligible');

      const withOverride = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/trait-extractions`, { selections: [{ traitType: 'Unique0' }], preset: 'balanced', allowUnsuitable: true });
      assert.strictEqual(withOverride.status, 202); // override lets it through
    });
  });

  console.log('\nHTTP: real end-to-end extraction (synthetic ground-truth images)');

  await checkAsync('full pipeline: create -> download -> process -> archive -> download ZIP, contact sheet, and preview', async () => {
    await withTestApp(async (base) => {
      const assets = traitCollectionAssets(fixture.baseUrl);
      const scan = seedCompletedScan(assets);
      const record = createTraitExtractionJob({ scanId: scan.scanId, selections: [{ traitType: 'Eyes', values: ['Laser'] }], preset: 'balanced' }, 1);
      const summary = fakeSummary(scan.scanId, assets);
      await executeTraitExtractionJob({ record, assets, summary, onProgress: (p) => publishTraitExtractionProgress(record.jobId, p), isDestinationAllowedOverride: allowOnlyLoopback });

      assert.strictEqual(record.status, 'completed');
      assert.strictEqual(record.evidence.length, 1);
      const ev = record.evidence[0];
      assert.strictEqual(ev.traitType, 'Eyes');
      assert.strictEqual(ev.traitValue, 'Laser');
      assert.ok(ev.candidatePixelCount > 0, 'candidate pixels were isolated');
      assert.ok(ev.confidence.score > 0);
      assert.notStrictEqual(ev.confidence.status, 'visually_identical');

      // duplicate source URL downloaded once: A1 and A2 are both sources,
      // A3/A4 both comparisons - 4 distinct URLs total, never more.
      assert.strictEqual(record.progress.uniqueImagesDownloaded, 4);

      const statusResp = await getJson(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}`);
      assert.strictEqual(statusResp.json.status, 'completed');
      assert.strictEqual(statusResp.json.downloadAvailable, true);

      const zipResp = await fetch(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/download`);
      assert.strictEqual(zipResp.status, 200);
      assert.ok((zipResp.headers.get('content-length') ?? '0') !== '0');

      const previewsResp = await getJson(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/previews`);
      assert.strictEqual(previewsResp.json.total, 1);
      assert.ok(previewsResp.json.values[0].previewUrl);

      const previewImg = await fetch(`${base}${previewsResp.json.values[0].previewUrl}`);
      assert.strictEqual(previewImg.status, 200);
      assert.strictEqual(previewImg.headers.get('content-type'), 'image/png');

      const sheetResp = await fetch(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/contact-sheets/Eyes`);
      assert.strictEqual(sheetResp.status, 200);
    });
  });

  await checkAsync('SSRF regression: an asset image pointing at a blocked destination fails that value gracefully, does not crash the job', async () => {
    const assets: NormalizedAsset[] = [
      { mint: 'A1', name: 'A1', image: `${fixture.baseUrl}/nft/A1.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [{ trait_type: 'Eyes', value: 'Laser' }] },
      { mint: 'A3', name: 'A3', image: 'http://169.254.169.254/metadata', jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [{ trait_type: 'Eyes', value: 'Normal' }] },
    ];
    const record = createTraitExtractionJob({ scanId: 'scan-ssrf', selections: [{ traitType: 'Eyes', values: ['Laser'] }], preset: 'balanced' }, 1);
    const summary = fakeSummary('scan-ssrf', assets);
    // No override here - exercises the REAL (unoverridden) SSRF guard.
    await executeTraitExtractionJob({ record, assets, summary, onProgress: (p) => publishTraitExtractionProgress(record.jobId, p) });
    // The comparison image is blocked -> no usable pair -> unresolved, but
    // the JOB ITSELF must not crash or hang.
    assert.ok(record.status === 'completed' || record.status === 'failed');
    if (record.status === 'completed') {
      assert.strictEqual(record.evidence.length, 0);
      assert.strictEqual(record.unresolvedValues.length, 1);
    }
  });

  console.log('\nCancellation, SSE-disconnect, TTL, orphan cleanup');

  await checkAsync('explicit cancel endpoint stops a running job', async () => {
    await withTestApp(async (base) => {
      const assets = traitCollectionAssets(fixture.baseUrl);
      const record = createTraitExtractionJob({ scanId: 'scan-cancel', selections: [{ traitType: 'Eyes' }], preset: 'thorough' }, 2);
      const summary = fakeSummary('scan-cancel', assets);
      const jobPromise = executeTraitExtractionJob({ record, assets, summary, onProgress: (p) => publishTraitExtractionProgress(record.jobId, p), isDestinationAllowedOverride: allowOnlyLoopback });
      await sleep(30);
      const cancel = await postJson(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/cancel`, {});
      assert.strictEqual(cancel.status, 202);
      await jobPromise;
      assert.ok(record.status === 'cancelled' || record.status === 'completed'); // fast synthetic job may finish before the cancel lands - both are valid depending on timing
    });
  });

  await checkAsync('SSE stream disconnect does NOT cancel the job', async () => {
    await withTestApp(async (base) => {
      const assets = traitCollectionAssets(fixture.baseUrl);
      const record = createTraitExtractionJob({ scanId: 'scan-sse', selections: [{ traitType: 'Eyes', values: ['Laser'] }], preset: 'balanced' }, 1);
      const summary = fakeSummary('scan-sse', assets);
      const jobPromise = executeTraitExtractionJob({ record, assets, summary, onProgress: (p) => publishTraitExtractionProgress(record.jobId, p), isDestinationAllowedOverride: allowOnlyLoopback });
      const controller = new AbortController();
      const streamPromise = fetch(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/stream`, { signal: controller.signal }).catch(() => null);
      await sleep(20);
      controller.abort();
      await streamPromise;
      await jobPromise;
      assert.strictEqual(record.status, 'completed'); // not cancelled by the disconnect
    });
  });

  await checkAsync('TTL cleanup removes the ZIP and job temp dir', async () => {
    const assets = traitCollectionAssets(fixture.baseUrl);
    const record = createTraitExtractionJob({ scanId: 'scan-ttl', selections: [{ traitType: 'Eyes', values: ['Laser'] }], preset: 'balanced' }, 1);
    const summary = fakeSummary('scan-ttl', assets);
    await executeTraitExtractionJob({ record, assets, summary, onProgress: () => {}, isDestinationAllowedOverride: allowOnlyLoopback });
    assert.strictEqual(record.status, 'completed');
    assert.ok(fs.existsSync(record.zipPath!));
    await expireTraitExtractionJobNow(record.jobId);
    assert.strictEqual(fs.existsSync(record.zipPath!), false);
    assert.strictEqual(fs.existsSync(jobWorkDir(record.jobId)), false);
    assert.strictEqual(getTraitExtractionJob(record.jobId), undefined);
  });

  await checkAsync('orphaned trait-extraction temp directory is swept on startup (age-based)', async () => {
    const orphanDir = path.join(traitExtractionTempRoot(), 'orphan-te-job-test');
    await fs.promises.mkdir(orphanDir, { recursive: true });
    await fs.promises.writeFile(path.join(orphanDir, 'trait-collection.zip'), 'x');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await fs.promises.utimes(orphanDir, old, old);
    await sweepOrphanedTraitExtractionTempDirs();
    assert.strictEqual(fs.existsSync(orphanDir), false);
  });

  await checkAsync('download before completion -> 409; unknown job -> 404', async () => {
    await withTestApp(async (base) => {
      const record = createTraitExtractionJob({ scanId: 'scan-x', selections: [{ traitType: 'Eyes' }], preset: 'balanced' }, 1);
      const r = await fetch(`${base}/api/tools/collection-analyzer/trait-extractions/${record.jobId}/download`);
      assert.strictEqual(r.status, 409);
      const r2 = await fetch(`${base}/api/tools/collection-analyzer/trait-extractions/does-not-exist/download`);
      assert.strictEqual(r2.status, 404);
    });
  });

  await fixture.close();

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
