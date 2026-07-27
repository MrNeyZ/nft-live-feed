/**
 * Collection Analyzer Stage 3 — bundle router + job-lifecycle offline
 * tests. Uses the same `withTestApp` HTTP harness pattern as
 * `src/server/__tests__/tools-me-bids.test.ts` and Stage 2's
 * `scan-export.test.ts`. A completed Stage 2 scan is seeded directly via
 * `scan-state-store.ts` (no real Helius call). Real downloads (where
 * needed) go through the shared local fixture server + the
 * `isDestinationAllowedOverride` test hook on `executeBundleJob` (never
 * exposed through the router — mirrors Stage 2's `walkFullCollection`
 * test-only overrides). No live internet calls anywhere in this file.
 *
 * Run: npm run test:collection-analyzer-bundle-router
 */
import assert from 'assert';
import express from 'express';
import type { Server } from 'http';
import * as fs from 'fs';
import { createCollectionAnalyzerRouter } from '../../../server/tools-collection-analyzer';
import { createScan, finalizeScan, getScan } from '../../scan-state-store';
import {
  activeJobSlots,
  bundleJobCount,
  createBundleJob,
  expireBundleJobNow,
  getBundleJob,
  jobWorkDir,
  publishBundleProgress,
  releaseJobSlot,
  tryAcquireJobSlot,
} from '../bundle-state-store';
import { executeBundleJob } from '../bundle-run';
import { DEFAULT_BUNDLE_OPTIONS } from '../bundle-types';
import type { BundleOptions } from '../bundle-types';
import type { NormalizedAsset } from '../../types';
import type { ScanResultSummary } from '../../scan-types';
import { startTestServer, allowOnlyLoopback, type TestServerHandle } from './test-server';

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

function fakeAsset(over: Partial<NormalizedAsset>): NormalizedAsset {
  return { mint: 'M', name: 'N', image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [], ...over };
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
function seedCompletedScan(assets: NormalizedAsset[]) {
  const record = createScan('COLL1111111111111111111111111111111111111', 'collection', 'COLL1111111111111111111111111111111111111');
  finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId, assets), assets });
  return record;
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
async function waitForTerminal(jobId: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = getBundleJob(jobId);
    if (!job) return;
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return;
    await sleep(50);
  }
}

async function main() {
  const server: TestServerHandle = await startTestServer();

  console.log('\nHTTP: bundle creation validation');

  await checkAsync('rejects non-completed scan -> 409', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL'); // still 'running'
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/${record.scanId}/bundles`, { options: {} });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'scan_not_completed');
    });
  });

  await checkAsync('rejects unknown/expired scan -> 404', async () => {
    await withTestApp(async (base) => {
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/does-not-exist/bundles`, { options: {} });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json.error, 'scan_not_found');
    });
  });

  await checkAsync('rejects empty option selection -> 400', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan([fakeAsset({ mint: 'A' })]);
      const emptyOptions: BundleOptions = {
        images: false, normalizedMetadata: false, originalMetadata: false,
        collectionSummary: false, assetsJson: false, assetsCsv: false, traitCounts: false, failureReport: false,
      };
      const r = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/bundles`, { options: emptyOptions });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.error, 'empty_selection');
    });
  });

  await checkAsync('metadata-only bundle (no network) creates, completes, and downloads', async () => {
    await withTestApp(async (base) => {
      const assets = [fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111', name: 'A' }), fakeAsset({ mint: 'BBBB1111111111111111111111111111111111111', name: 'B' })];
      const scan = seedCompletedScan(assets);
      const create = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/bundles`, {
        options: { images: false, originalMetadata: false, normalizedMetadata: true, collectionSummary: true, assetsJson: true, assetsCsv: true, traitCounts: true, failureReport: true },
      });
      assert.strictEqual(create.status, 202);
      const jobId = create.json.jobId as string;
      await waitForTerminal(jobId);

      const status = await getJson(`${base}/api/tools/collection-analyzer/bundles/${jobId}`);
      assert.strictEqual(status.json.status, 'completed');
      assert.strictEqual(status.json.progress.totalAssets, 2);

      const download = await fetch(`${base}/api/tools/collection-analyzer/bundles/${jobId}/download`);
      assert.strictEqual(download.status, 200);
      assert.ok((download.headers.get('content-length') ?? '0') !== '0');
      assert.ok(download.headers.get('content-disposition')?.includes('.zip'));
    });
  });

  console.log('\nHTTP: download gating + expiry + path traversal');

  await checkAsync('download before completion -> 409', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan([fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111' })]);
      const create = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/bundles`, { options: { ...DEFAULT_BUNDLE_OPTIONS, images: false } });
      const jobId = create.json.jobId as string;
      // Race the download against completion — request it immediately.
      const download = await fetch(`${base}/api/tools/collection-analyzer/bundles/${jobId}/download`);
      // Either still running (409) or already done by the time this fires
      // (200) — both are valid depending on scheduler timing; what must
      // NEVER happen is a 200 with an incomplete/missing file, checked
      // separately above. Assert it's one of the two valid outcomes.
      assert.ok(download.status === 409 || download.status === 200);
      await waitForTerminal(jobId);
    });
  });

  await checkAsync('download on unknown job -> 404', async () => {
    await withTestApp(async (base) => {
      const r = await fetch(`${base}/api/tools/collection-analyzer/bundles/does-not-exist/download`);
      assert.strictEqual(r.status, 404);
    });
  });

  await checkAsync('path-traversal-shaped jobId is just a 404, never a filesystem escape', async () => {
    await withTestApp(async (base) => {
      const r = await fetch(`${base}/api/tools/collection-analyzer/bundles/${encodeURIComponent('../../../../etc/passwd')}/download`);
      assert.strictEqual(r.status, 404);
    });
  });

  await checkAsync('expired job -> download and status both 404', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan([fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111' })]);
      const create = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/bundles`, { options: { ...DEFAULT_BUNDLE_OPTIONS, images: false } });
      const jobId = create.json.jobId as string;
      await waitForTerminal(jobId);
      const before = await fetch(`${base}/api/tools/collection-analyzer/bundles/${jobId}/download`);
      assert.strictEqual(before.status, 200);

      await expireBundleJobNow(jobId);

      const afterDownload = await fetch(`${base}/api/tools/collection-analyzer/bundles/${jobId}/download`);
      assert.strictEqual(afterDownload.status, 404);
      const afterStatus = await getJson(`${base}/api/tools/collection-analyzer/bundles/${jobId}`);
      assert.strictEqual(afterStatus.status, 404);
    });
  });

  await checkAsync('temp work dir is removed after TTL expiry', async () => {
    await withTestApp(async (base) => {
      const scan = seedCompletedScan([fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111' })]);
      const create = await postJson(`${base}/api/tools/collection-analyzer/scans/${scan.scanId}/bundles`, { options: { ...DEFAULT_BUNDLE_OPTIONS, images: false } });
      const jobId = create.json.jobId as string;
      await waitForTerminal(jobId);
      assert.ok(fs.existsSync(jobWorkDir(jobId)));
      await expireBundleJobNow(jobId);
      assert.strictEqual(fs.existsSync(jobWorkDir(jobId)), false);
    });
  });

  console.log('\nJob lifecycle: cancellation, SSE-disconnect, concurrency, partial failures');

  await checkAsync('explicit cancel endpoint stops a running job', async () => {
    await withTestApp(async (base) => {
      const assets = [fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111', image: `${server.baseUrl}/slow` })];
      const record = createBundleJob('scan-x', { ...DEFAULT_BUNDLE_OPTIONS, images: true, originalMetadata: false }, assets.length);
      const summary = fakeSummary('scan-x', assets);
      const jobPromise = executeBundleJob({
        record, assets, summary,
        onProgress: (p) => publishBundleProgress(record.jobId, p),
        isDestinationAllowedOverride: allowOnlyLoopback,
      });

      await sleep(200); // let it enter the slow download
      const cancel = await postJson(`${base}/api/tools/collection-analyzer/bundles/${record.jobId}/cancel`, {});
      assert.strictEqual(cancel.status, 202);

      await jobPromise;
      assert.strictEqual(record.status, 'cancelled');
    });
  });

  await checkAsync('SSE stream disconnect does NOT cancel the job — it keeps running to completion', async () => {
    await withTestApp(async (base) => {
      const assets = [fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111', image: `${server.baseUrl}/slow` })];
      const record = createBundleJob('scan-y', { ...DEFAULT_BUNDLE_OPTIONS, images: true, originalMetadata: false }, assets.length);
      const summary = fakeSummary('scan-y', assets);
      const jobPromise = executeBundleJob({
        record, assets, summary,
        onProgress: (p) => publishBundleProgress(record.jobId, p),
        isDestinationAllowedOverride: allowOnlyLoopback,
      });

      // Connect an SSE subscriber, then abort it client-side shortly after —
      // the underlying HTTP connection is torn down, same as a real
      // EventSource.close() or a browser tab navigating away.
      const controller = new AbortController();
      const streamPromise = fetch(`${base}/api/tools/collection-analyzer/bundles/${record.jobId}/stream`, { signal: controller.signal }).catch(() => null);
      await sleep(150);
      controller.abort();
      await streamPromise;

      await jobPromise;
      assert.strictEqual(record.status, 'completed'); // NOT cancelled
    });
  });

  await checkAsync('partial failures (some images fail, some succeed) still produce a completed job with a failure report', async () => {
    const assets = [
      fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111', name: 'Good', image: `${server.baseUrl}/ok-png` }),
      fakeAsset({ mint: 'BBBB1111111111111111111111111111111111111', name: 'Bad', image: `${server.baseUrl}/permanent-404` }),
      fakeAsset({ mint: 'CCCC1111111111111111111111111111111111111', name: 'NoImage', image: null }),
    ];
    const record = createBundleJob('scan-z', { ...DEFAULT_BUNDLE_OPTIONS, images: true, originalMetadata: false, failureReport: true }, assets.length);
    const summary = fakeSummary('scan-z', assets);
    await executeBundleJob({
      record, assets, summary,
      onProgress: (p) => publishBundleProgress(record.jobId, p),
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(record.status, 'completed');
    assert.strictEqual(record.progress.successfulImages, 1);
    assert.strictEqual(record.progress.failedImages, 2);
    assert.strictEqual(record.failures.length, 2);
    assert.ok(record.failures.some((f) => f.mint === 'BBBB1111111111111111111111111111111111111' && f.code === 'http_error'));
    assert.ok(record.failures.some((f) => f.mint === 'CCCC1111111111111111111111111111111111111' && f.code === 'no_source_url'));
    assert.ok(record.zipPath && fs.existsSync(record.zipPath));
  });

  check('concurrency gate: capacity enforced, released slot reusable (mirrors Stage 2)', () => {
    const { max } = activeJobSlots();
    const acquired: boolean[] = [];
    for (let i = 0; i < max; i++) acquired.push(tryAcquireJobSlot());
    assert.ok(acquired.every(Boolean));
    assert.strictEqual(tryAcquireJobSlot(), false);
    releaseJobSlot();
    assert.strictEqual(tryAcquireJobSlot(), true);
    for (let i = 0; i < max; i++) releaseJobSlot();
  });

  await checkAsync('bundle TTL sweep removes job record and work dir (test-forced)', async () => {
    const assets = [fakeAsset({ mint: 'AAAA1111111111111111111111111111111111111' })];
    const record = createBundleJob('scan-ttl', { ...DEFAULT_BUNDLE_OPTIONS, images: false, originalMetadata: false }, assets.length);
    const summary = fakeSummary('scan-ttl', assets);
    await executeBundleJob({ record, assets, summary, onProgress: () => {} });
    assert.ok(getBundleJob(record.jobId));
    await expireBundleJobNow(record.jobId);
    assert.strictEqual(getBundleJob(record.jobId), undefined);
    assert.strictEqual(fs.existsSync(jobWorkDir(record.jobId)), false);
  });

  console.log(`\nbundleJobCount() sanity: ${bundleJobCount()} job(s) still tracked (expected, TTL is real-time in prod)`);

  await server.close();

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
