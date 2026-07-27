/**
 * Collection Analyzer Stage 2 — CSV export + scan-state lifecycle offline
 * tests.
 *
 * Part 1: pure CSV builder tests (escaping, deterministic columns).
 * Part 2: HTTP-level tests against a minimal Express app hosting just
 * `createCollectionAnalyzerRouter()` (same harness pattern as
 * `src/server/__tests__/tools-me-bids.test.ts`) — exercises export/assets/
 * status access control across running / completed / expired scan states,
 * driving scan state directly via `scan-state-store.ts` rather than running
 * a real DAS scan.
 *
 * Run: npm run test:collection-analyzer-export
 */
import assert from 'assert';
import express from 'express';
import type { Server } from 'http';
import { csvEscape, buildCsvColumns, buildAssetsCsv } from '../scan-csv';
import { createScan, finalizeScan, expireScanNow, tryAcquireScanSlot, releaseScanSlot, activeScanSlots } from '../scan-state-store';
import { createCollectionAnalyzerRouter } from '../../server/tools-collection-analyzer';
import type { NormalizedAsset } from '../types';
import type { ScanResultSummary } from '../scan-types';

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

// ── Part 1: CSV builder ─────────────────────────────────────────────────
console.log('\nCSV escaping + columns');

check('plain value passes through unescaped', () => assert.strictEqual(csvEscape('Blue'), 'Blue'));
check('comma-containing value is quoted', () => assert.strictEqual(csvEscape('Blue, Red'), '"Blue, Red"'));
check('quote-containing value is quoted and doubled', () => assert.strictEqual(csvEscape('5" tall'), '"5"" tall"'));
check('newline-containing value is quoted', () => assert.strictEqual(csvEscape('line1\nline2'), '"line1\nline2"'));
check('CR-containing value is quoted', () => assert.strictEqual(csvEscape('a\rb'), '"a\rb"'));

function asset(over: Partial<NormalizedAsset>): NormalizedAsset {
  return { mint: 'M', name: 'N', image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [], ...over };
}

check('columns: fixed identity fields first, then trait categories sorted alphabetically', () => {
  const assets: NormalizedAsset[] = [
    asset({ attributes: [{ trait_type: 'Zebra', value: '1' }, { trait_type: 'Apple', value: '2' }] }),
  ];
  const cols = buildCsvColumns(assets);
  assert.deepStrictEqual(cols, ['mint', 'name', 'image', 'jsonUri', 'collectionAddress', 'compressed', 'Apple', 'Zebra']);
});

check('column set is the UNION across all assets, stable regardless of per-asset trait presence', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', attributes: [{ trait_type: 'Background', value: 'Blue' }] }),
    asset({ mint: '2', attributes: [{ trait_type: 'Eyes', value: 'Green' }] }),
  ];
  const csv = buildAssetsCsv(assets);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'mint,name,image,jsonUri,collectionAddress,compressed,Background,Eyes');
  // row 1 has Background filled, Eyes empty; row 2 the reverse.
  assert.ok(lines[1].endsWith(',Blue,'));
  assert.ok(lines[2].endsWith(',,Green'));
});

check('values needing escaping are escaped inside a real CSV row', () => {
  const assets: NormalizedAsset[] = [
    asset({ mint: '1', name: 'Foo, "Bar"', attributes: [] }),
  ];
  const csv = buildAssetsCsv(assets);
  const rowLine = csv.split('\r\n')[1];
  assert.ok(rowLine.includes('"Foo, ""Bar"""'));
});

check('concurrency gate: capacity enforced, released slot is reusable', () => {
  const { max } = activeScanSlots();
  const acquired: boolean[] = [];
  for (let i = 0; i < max; i++) acquired.push(tryAcquireScanSlot());
  assert.ok(acquired.every(Boolean), 'all slots up to max should acquire');
  assert.strictEqual(tryAcquireScanSlot(), false, 'one past max should be rejected');
  releaseScanSlot();
  assert.strictEqual(tryAcquireScanSlot(), true, 'a released slot should be reusable');
  // Restore to empty for subsequent tests/process lifetime.
  for (let i = 0; i < max; i++) releaseScanSlot();
});

// ── Part 2: HTTP-level access control ───────────────────────────────────

async function withTestApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api', createCollectionAnalyzerRouter());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

function fakeSummary(scanId: string): ScanResultSummary {
  return {
    scanId, collectionAddress: 'COLL', inputKind: 'collection', inputValue: 'COLL',
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 100,
    pagesFetched: 1, exactAssetCount: 2, duplicatesSkipped: 0,
    quality: {
      totalAssets: 2, assetsWithValidMetadata: 2, assetsMissingAttributes: 0, assetsMissingImage: 0,
      assetsMissingName: 0, compressedCount: 0, regularCount: 2, malformedAttributesSkipped: 0,
      duplicateIdenticalAttributePairsCollapsed: 0, conflictingDuplicateTraitTypeAssets: 0,
      nullValueAttributes: 0, emptyStringValueAttributes: 0, nonStringTraitTypeCoerced: 0,
    },
    traitCategories: [{ traitType: 'Background', values: [{ value: 'Blue', count: 2, percent: 100, oneOfOne: false }], missingCount: 0, missingPercent: 0 }],
    duplicateMetadataGroups: [], duplicateImageGroups: [], traitsPerNftDistribution: [{ traitsCount: 1, nftCount: 2 }],
    oneOfOneHighlights: [], oneOfOneHighlightsTruncated: false, warnings: [],
  };
}

async function main() {
  console.log('\nHTTP: export/assets/status access control');

  await checkAsync('export before completion (running scan) -> 409 scan_not_completed', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      const r = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/assets.json`);
      assert.strictEqual(r.status, 409);
      const body = await r.json() as any;
      assert.strictEqual(body.error, 'scan_not_completed');
      assert.strictEqual(body.status, 'running');
    });
  });

  await checkAsync('export on unknown scanId -> 404 scan_not_found', async () => {
    await withTestApp(async (base) => {
      const r = await fetch(`${base}/api/tools/collection-analyzer/scan/does-not-exist/export/assets.json`);
      assert.strictEqual(r.status, 404);
    });
  });

  await checkAsync('all four export formats available + correctly shaped for a completed scan', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      const assets: NormalizedAsset[] = [
        asset({ mint: 'A', attributes: [{ trait_type: 'Background', value: 'Blue' }] }),
        asset({ mint: 'B', attributes: [{ trait_type: 'Background', value: 'Blue' }] }),
      ];
      finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId), assets });

      const rSummary = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/collection-summary.json`);
      assert.strictEqual(rSummary.status, 200);
      assert.ok(rSummary.headers.get('content-disposition')?.includes('collection-summary.json'));
      const summaryBody = await rSummary.json() as any;
      assert.strictEqual(summaryBody.exactAssetCount, 2);

      const rAssets = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/assets.json`);
      assert.strictEqual(rAssets.status, 200);
      const assetsBody = await rAssets.json() as any;
      assert.strictEqual(assetsBody.length, 2);

      const rCsv = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/assets.csv`);
      assert.strictEqual(rCsv.status, 200);
      assert.ok(rCsv.headers.get('content-type')?.includes('text/csv'));
      const csvBody = await rCsv.text();
      assert.ok(csvBody.startsWith('mint,name,image,jsonUri,collectionAddress,compressed,Background'));

      const rTraits = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/trait-counts.json`);
      assert.strictEqual(rTraits.status, 200);
      const traitsBody = await rTraits.json() as any;
      assert.strictEqual(traitsBody[0].traitType, 'Background');

      const rUnknown = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/nope.txt`);
      assert.strictEqual(rUnknown.status, 404);
    });
  });

  await checkAsync('export after TTL expiration -> 404 scan_not_found (same as never existed)', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId), assets: [asset({ mint: 'A' })] });
      // Confirm it's reachable BEFORE expiry, to prove the 404 below is really
      // caused by expiry and not a setup mistake.
      const before = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/assets.json`);
      assert.strictEqual(before.status, 200);

      expireScanNow(record.scanId);

      const after = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/export/assets.json`);
      assert.strictEqual(after.status, 404);
      const afterStatus = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/status`);
      assert.strictEqual(afterStatus.status, 404);
    });
  });

  await checkAsync('paginated assets endpoint respects offset/limit and total', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      const assets: NormalizedAsset[] = Array.from({ length: 10 }, (_, i) => asset({ mint: `M${i}` }));
      finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId), assets });

      const r = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/assets?offset=3&limit=4`);
      assert.strictEqual(r.status, 200);
      const body = await r.json() as any;
      assert.strictEqual(body.total, 10);
      assert.strictEqual(body.offset, 3);
      assert.strictEqual(body.limit, 4);
      assert.strictEqual(body.assets.length, 4);
      assert.strictEqual(body.assets[0].mint, 'M3');
    });
  });

  await checkAsync('assets endpoint on a running (not-yet-completed) scan -> 409', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      const r = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/assets`);
      assert.strictEqual(r.status, 409);
    });
  });

  await checkAsync('status endpoint reflects running then completed', async () => {
    await withTestApp(async (base) => {
      const record = createScan('COLL', 'collection', 'COLL');
      const r1 = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/status`);
      const b1 = await r1.json() as any;
      assert.strictEqual(b1.status, 'running');

      finalizeScan(record, 'completed', { summary: fakeSummary(record.scanId), assets: [asset({ mint: 'A' })] });
      const r2 = await fetch(`${base}/api/tools/collection-analyzer/scan/${record.scanId}/status`);
      const b2 = await r2.json() as any;
      assert.strictEqual(b2.status, 'completed');
      assert.strictEqual(b2.summary.exactAssetCount, 2); // from fakeSummary, unaffected by the 1-asset array above
    });
  });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
