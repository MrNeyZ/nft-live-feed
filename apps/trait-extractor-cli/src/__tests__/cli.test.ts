/**
 * trait-extractor-cli - offline regression tests (Stage 5.3 step 8).
 *
 * No live network, no Solana RPC - a local synthetic-image fixture server
 * (same pattern as te-router.test.ts) stands in for real NFT art, and a
 * request counter proves cache-hit / no-retry-on-permanent-failure
 * behavior instead of just trusting it. Covers: config-hash determinism,
 * manifest/checkpoint persistence (incl. the Buffer round-trip bug found
 * during manual validation), corrupt-checkpoint rejection, the local
 * image cache's resumability contract, and core-vs-adapter equivalence
 * (LocalImageCache vs the website's ImageDecodeCache must produce
 * byte-identical results for identical input).
 *
 * Run: npm run test:trait-extractor-cli
 */
import assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { ImageDecodeCache, runTraitExtraction } from 'trait-extraction-core';
import type { NormalizedAsset, TraitExtractionConfig } from 'trait-extraction-core';
import {
  CACHE_FORMAT_VERSION, checkpointFilePathForTests, checkpointKeyFor, computeConfigHash,
  initManifest, loadCheckpoint, loadManifest, saveCheckpoint, saveManifest,
} from '../manifest';
import type { ManifestConfig } from '../manifest';
import { LocalImageCache } from '../local-image-cache';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── Synthetic fixture server (same shape as te-router.test.ts) ─────────
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

interface FixtureServerHandle { baseUrl: string; requestCounts: Map<string, number>; close: () => Promise<void> }
async function startFixtureServer(): Promise<FixtureServerHandle> {
  const pngCache = new Map<string, Buffer>();
  const requestCounts = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
    if (url === '/flaky-500') { res.writeHead(500); res.end(); return; }
    if (url === '/not-an-image.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not a png'); return; }
    const m = url.match(/^\/nft\/(A1|A2|A3|A4)\.png$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    let buf = pngCache.get(m[1]);
    if (!buf) {
      buf = m[1] === 'A1' ? await synthPng(BLUE_BG, LASER_COLOR)
        : m[1] === 'A2' ? await synthPng(RED_BG, LASER_COLOR)
        : m[1] === 'A3' ? await synthPng(BLUE_BG, NORMAL_COLOR)
        : await synthPng(RED_BG, NORMAL_COLOR);
      pngCache.set(m[1], buf);
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(buf);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestCounts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function traitCollectionAssets(baseUrl: string): NormalizedAsset[] {
  const a = (mint: string, bg: string, eyes: string): NormalizedAsset => ({
    mint, name: mint, image: `${baseUrl}/nft/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy',
    attributes: [{ trait_type: 'Background', value: bg }, { trait_type: 'Eyes', value: eyes }],
  });
  return [a('A1', 'Blue', 'Laser'), a('A2', 'Red', 'Laser'), a('A3', 'Blue', 'Normal'), a('A4', 'Red', 'Normal')];
}

const allowOnlyLoopback = (ip: string): boolean => ip === '127.0.0.1';

async function main() {
  console.log('\nconfig hash determinism');
  const baseConfig: ManifestConfig = { collectionAddress: 'COLL1', preset: 'balanced', selections: [{ traitType: 'Background' }], coreVersion: '1.0.0' };

  check('identical config produces the identical hash', () => {
    assert.strictEqual(computeConfigHash(baseConfig), computeConfigHash({ ...baseConfig }));
  });
  check('key order does not affect the hash (stable serialization)', () => {
    const reordered: ManifestConfig = { coreVersion: baseConfig.coreVersion, selections: baseConfig.selections, preset: baseConfig.preset, collectionAddress: baseConfig.collectionAddress };
    assert.strictEqual(computeConfigHash(baseConfig), computeConfigHash(reordered));
  });
  check('different preset changes the hash', () => {
    assert.notStrictEqual(computeConfigHash(baseConfig), computeConfigHash({ ...baseConfig, preset: 'thorough' }));
  });
  check('different selections change the hash', () => {
    assert.notStrictEqual(computeConfigHash(baseConfig), computeConfigHash({ ...baseConfig, selections: [{ traitType: 'Eyes' }] }));
  });
  check('different core version changes the hash', () => {
    assert.notStrictEqual(computeConfigHash(baseConfig), computeConfigHash({ ...baseConfig, coreVersion: '1.0.1' }));
  });

  console.log('\nmanifest persistence');
  await checkAsync('initManifest + loadManifest round-trips exactly', async () => {
    const dir = tmpDir('te-cli-manifest-');
    const m = await initManifest(dir, baseConfig, 5);
    const loaded = await loadManifest(dir);
    assert.ok(loaded);
    assert.strictEqual(loaded!.configHash, m.configHash);
    assert.strictEqual(loaded!.totalTargets, 5);
    assert.deepStrictEqual(loaded!.completedTargetKeys, []);
  });
  await checkAsync('missing job.json -> loadManifest returns null, not a throw', async () => {
    const dir = tmpDir('te-cli-manifest-');
    assert.strictEqual(await loadManifest(dir), null);
  });
  await checkAsync('cacheFormatVersion mismatch -> loadManifest returns null (forces fresh start, never misreads)', async () => {
    const dir = tmpDir('te-cli-manifest-');
    const m = await initManifest(dir, baseConfig, 5);
    await saveManifest(dir, { ...m, cacheFormatVersion: CACHE_FORMAT_VERSION + 1 });
    assert.strictEqual(await loadManifest(dir), null);
  });
  await checkAsync('corrupt job.json (truncated) -> loadManifest returns null', async () => {
    const dir = tmpDir('te-cli-manifest-');
    await initManifest(dir, baseConfig, 5);
    await fs.promises.writeFile(path.join(dir, 'job.json'), '{ "cacheFormatVersion": 1, "truncated'); // invalid JSON
    assert.strictEqual(await loadManifest(dir), null);
  });

  console.log('\ncheckpoint persistence (including the Buffer round-trip bug found in manual validation)');
  await checkAsync('a resolved-shaped checkpoint with real PNG Buffers round-trips byte-identical', async () => {
    const dir = tmpDir('te-cli-checkpoint-');
    const pngBytes = await synthPng(BLUE_BG, LASER_COLOR);
    const key = checkpointKeyFor('Background', 'Blue');
    const fakeResult: any = {
      kind: 'resolved',
      candidatePngForSheet: pngBytes,
      zipFiles: { traitType: 'Background', outputDirKey: 'blue--abc123', candidate: pngBytes, candidateExpanded: null, changeMask: null, uncertaintyMask: null, preview: null, evidenceJson: '{}' },
      pairsAttempted: 2,
      searchDiagnostics: { adaptiveStopReason: 'no_more_candidates' },
      evidence: { traitType: 'Background', traitValue: 'Blue' },
    };
    await saveCheckpoint(dir, key, fakeResult);
    const loaded = await loadCheckpoint(dir, key);
    assert.ok(loaded);
    const loadedAny = loaded as any;
    assert.ok(Buffer.isBuffer(loadedAny.candidatePngForSheet), 'candidatePngForSheet must deserialize back into a real Buffer, not a plain {type,data} object');
    assert.ok(pngBytes.equals(loadedAny.candidatePngForSheet), 'round-tripped PNG bytes must be byte-identical to the original');
    assert.ok(Buffer.isBuffer(loadedAny.zipFiles.candidate));
    assert.ok(pngBytes.equals(loadedAny.zipFiles.candidate));
  });
  await checkAsync('checkpoint for an unrequested key -> null (missing file)', async () => {
    const dir = tmpDir('te-cli-checkpoint-');
    assert.strictEqual(await loadCheckpoint(dir, checkpointKeyFor('Nope', 'Nope')), null);
  });
  await checkAsync('corrupt checkpoint file (invalid JSON) is rejected, not thrown', async () => {
    const dir = tmpDir('te-cli-checkpoint-');
    const key = checkpointKeyFor('Background', 'Red');
    await saveCheckpoint(dir, key, { kind: 'unresolved', reason: 'x', pairsAttempted: 0 } as any);
    const p = checkpointFilePathForTests(dir, key);
    await fs.promises.writeFile(p, '{not valid json');
    assert.strictEqual(await loadCheckpoint(dir, key), null);
  });
  await checkAsync('checkpoint file whose recorded key does not match the requested key is rejected (defensive tamper check)', async () => {
    const dir = tmpDir('te-cli-checkpoint-');
    const key = checkpointKeyFor('Background', 'Red');
    const p = checkpointFilePathForTests(dir, key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, JSON.stringify({ checkpointKey: 'wrong key', result: { kind: 'unresolved', reason: 'x', pairsAttempted: 0 } }));
    assert.strictEqual(await loadCheckpoint(dir, key), null);
  });

  console.log('\nLocalImageCache resumability contract');
  const fixture = await startFixtureServer();

  await checkAsync('a cold get() downloads once; a second get() for the same URL is a cache hit (no re-download)', async () => {
    const cacheDir = tmpDir('te-cli-imgcache-');
    const controller = new AbortController();
    const cache1 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const url = `${fixture.baseUrl}/nft/A1.png`;
    const before = fixture.requestCounts.get('/nft/A1.png') ?? 0;
    const first = await cache1.get(url);
    assert.ok(first.ok);
    const afterFirst = fixture.requestCounts.get('/nft/A1.png') ?? 0;
    assert.strictEqual(afterFirst, before + 1);

    // A brand-new process-lifetime instance (simulates a resumed CLI run)
    // pointed at the SAME cache dir must not hit the network again.
    const cache2 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const second = await cache2.get(url);
    assert.ok(second.ok);
    const afterSecond = fixture.requestCounts.get('/nft/A1.png') ?? 0;
    assert.strictEqual(afterSecond, afterFirst, 'a resumed run must not re-download an already-cached URL');
    assert.ok((first as any).image.data.equals((second as any).image.data), 'decoded pixels must be identical across the cache boundary');
  });

  await checkAsync('an unsupported content type is a PERMANENT failure - remembered, never retried', async () => {
    const cacheDir = tmpDir('te-cli-imgcache-');
    const controller = new AbortController();
    const url = `${fixture.baseUrl}/not-an-image.txt`;
    const before = fixture.requestCounts.get('/not-an-image.txt') ?? 0;
    const cache1 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const r1 = await cache1.get(url);
    assert.strictEqual(r1.ok, false);
    const cache2 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const r2 = await cache2.get(url);
    assert.strictEqual(r2.ok, false);
    const after = fixture.requestCounts.get('/not-an-image.txt') ?? 0;
    assert.strictEqual(after, before + 1, 'a permanently-invalid URL must only ever be fetched once, even across cache instances');
  });

  await checkAsync('a transient download failure (HTTP 500) is NOT cached - a resumed run retries it', async () => {
    // downloadToFile (ssrf-guard) already retries 5xx internally on its
    // own, so even ONE top-level get() generates multiple wire requests -
    // this only proves the SECOND top-level call generates fresh requests
    // too (i.e. LocalImageCache didn't short-circuit it as a remembered
    // permanent failure), not an exact request count.
    const cacheDir = tmpDir('te-cli-imgcache-');
    const controller = new AbortController();
    const url = `${fixture.baseUrl}/flaky-500`;
    const cache1 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    await cache1.get(url);
    const afterFirstCall = fixture.requestCounts.get('/flaky-500') ?? 0;
    assert.ok(afterFirstCall > 0);
    const cache2 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    await cache2.get(url);
    const afterSecondCall = fixture.requestCounts.get('/flaky-500') ?? 0;
    assert.ok(afterSecondCall > afterFirstCall, 'a resumed run must genuinely retry a transient failure, not silently skip it as a remembered permanent one');
  });

  console.log('\ncore-vs-adapter equivalence (website ImageDecodeCache vs CLI LocalImageCache)');
  await checkAsync('runTraitExtraction produces identical evidence/unresolved output regardless of which ImageAcquirer is injected', async () => {
    const assets = traitCollectionAssets(fixture.baseUrl);
    const config: TraitExtractionConfig = { scanId: 'test-scan', selections: [{ traitType: 'Background' }, { traitType: 'Eyes' }], preset: 'balanced' };
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const workDirA = tmpDir('te-cli-equiv-a-');
    const workDirB = tmpDir('te-cli-equiv-b-');

    const websiteResult = await runTraitExtraction({
      jobId: 'job-a', scanId: 'test-scan', assets, collectionAddress: 'COLL', exactScannedAssetCount: assets.length,
      config, workDir: workDirA, signal: controllerA.signal,
      imageAcquirer: new ImageDecodeCache(workDirA, controllerA.signal, allowOnlyLoopback),
      onProgress: () => {},
    });
    const cliResult = await runTraitExtraction({
      jobId: 'job-b', scanId: 'test-scan', assets, collectionAddress: 'COLL', exactScannedAssetCount: assets.length,
      config, workDir: workDirB, signal: controllerB.signal,
      imageAcquirer: new LocalImageCache(path.join(workDirB, 'cache'), controllerB.signal, allowOnlyLoopback),
      onProgress: () => {},
    });

    assert.strictEqual(websiteResult.status, 'completed');
    assert.strictEqual(cliResult.status, 'completed');
    assert.strictEqual(websiteResult.evidence.length, cliResult.evidence.length);
    assert.strictEqual(websiteResult.unresolvedValues.length, cliResult.unresolvedValues.length);

    // searchTimeMs/indexBuildTimeMs are wall-clock measurements, not
    // algorithm output - they legitimately vary run-to-run regardless of
    // which ImageAcquirer is used, so they're excluded from the equality
    // check (everything ELSE in searchDiagnostics is deterministic).
    const normalize = (ev: typeof websiteResult.evidence) => ev
      .map((e) => ({
        ...e,
        outputFiles: undefined,
        outputDirKey: undefined,
        searchDiagnostics: { ...e.searchDiagnostics, searchTimeMs: undefined, indexBuildTimeMs: undefined },
      }))
      .sort((a, b) => `${a.traitType} ${a.traitValue}`.localeCompare(`${b.traitType} ${b.traitValue}`));
    assert.deepStrictEqual(normalize(websiteResult.evidence), normalize(cliResult.evidence), 'confidence scores, pixel counts, and consensus stats must be identical byte-for-byte regardless of which ImageAcquirer downloaded the images');

    // Read back the actual candidate.png bytes from each run's ZIP and
    // confirm the images themselves - not just the numeric evidence - are
    // pixel-identical between the two acquirer implementations.
    const { extractZipEntryBySuffix } = await import('trait-extraction-core');
    const sortedKeys = [...new Set(websiteResult.evidence.map((e) => e.outputDirKey))].sort();
    for (const key of sortedKeys) {
      const a = await extractZipEntryBySuffix(websiteResult.zipPath!, `${key}/candidate.png`);
      const b = await extractZipEntryBySuffix(cliResult.zipPath!, `${key}/candidate.png`);
      if (a === null && b === null) continue;
      assert.ok(a && b, `candidate.png presence must match for ${key}`);
      assert.ok(a!.equals(b!), `candidate.png bytes must be identical for ${key}`);
    }
  });

  await fixture.close();

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
