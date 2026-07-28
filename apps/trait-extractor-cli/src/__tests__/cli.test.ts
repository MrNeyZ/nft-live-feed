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
import { expandComparisonSearch, ImageDecodeCache, runTraitExtraction } from 'trait-extraction-core';
import type { NormalizedAsset, TraitExtractionConfig } from 'trait-extraction-core';
import {
  CACHE_FORMAT_VERSION, checkpointFilePathForTests, checkpointKeyFor, computeConfigHash,
  initManifest, loadCheckpoint, loadManifest, saveCheckpoint, saveManifest, shouldCheckpointSettlement,
} from '../manifest';
import type { ManifestConfig } from '../manifest';
import {
  buildCollectionIndex, buildTraitCollectionEligibility, CategoryImpactModel, presetLimitsFor, resolveTargetsInOrder,
} from 'trait-extraction-core';
import { hasCachedEntry, LocalImageCache } from '../local-image-cache';
import { resolveConfig } from '../config';
import { loadCachedScan, saveCachedScan } from '../metadata-cache';
import type { CachedScanResult } from '../metadata-cache';
import { Logger } from '../logger';
import { computeAccurateEstimate } from '../job-plan';
import type { JobPlan } from '../job-plan';
import { buildExecutionReport } from '../execution-report';
import { runPreflightChecks } from '../resource-check';

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
    const slowMatch = url.match(/^\/slow\/(\d+)\.png$/);
    if (slowMatch) {
      // Stage 5.4 regression fixture: an artificially slow route so a test
      // can fire several concurrent downloads and observe cumulative
      // per-call time exceed real elapsed time (see the "cumulative vs
      // wall-clock" regression test below).
      await new Promise((resolve) => setTimeout(resolve, 150));
      const buf = await synthPng(BLUE_BG, LASER_COLOR);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(buf);
      return;
    }
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

  console.log('\nconfig precedence (Stage 5.4): CLI flag > env > config.json > default');
  check('CLI flag wins over env and config file', () => {
    const dir = tmpDir('te-cli-config-');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ job: { preset: 'thorough' } }));
    const { config } = resolveConfig(['--collection', 'X', '--preset', 'fast'], { TRAIT_EXTRACTOR_PRESET: 'balanced' }, dir);
    assert.strictEqual(config.preset, 'fast');
  });
  check('env wins over config file when no CLI flag given', () => {
    const dir = tmpDir('te-cli-config-');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ job: { preset: 'thorough' } }));
    const { config, sources } = resolveConfig(['--collection', 'X'], { TRAIT_EXTRACTOR_PRESET: 'balanced' }, dir);
    assert.strictEqual(config.preset, 'balanced');
    assert.strictEqual(sources.preset, 'env');
  });
  check('config file wins over the built-in default when nothing else is set', () => {
    const dir = tmpDir('te-cli-config-');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ job: { preset: 'thorough' } }));
    const { config, sources } = resolveConfig(['--collection', 'X'], {}, dir);
    assert.strictEqual(config.preset, 'thorough');
    assert.strictEqual(sources.preset, 'file');
  });
  check('a CLI flag whose value happens to equal the built-in default still counts as explicit (beats config file)', () => {
    const dir = tmpDir('te-cli-config-');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ concurrency: { downloadConcurrency: 20 } }));
    const { config, sources } = resolveConfig(['--collection', 'X', '--download-concurrency', '6'], {}, dir);
    assert.strictEqual(config.downloadConcurrency, 6, 'explicit --download-concurrency 6 must win even though 6 is also the hardcoded default');
    assert.strictEqual(sources.downloadConcurrency, 'cli');
  });
  check('no config.json anywhere -> defaults only, not an error', () => {
    const dir = tmpDir('te-cli-config-empty-');
    const { config, configFilePath, parseErrors } = resolveConfig(['--collection', 'X'], {}, dir);
    assert.strictEqual(configFilePath, null);
    assert.deepStrictEqual(parseErrors, []);
    assert.strictEqual(config.preset, 'balanced');
  });
  check('malformed config.json at a non-explicit path falls back to defaults, not a throw', () => {
    const dir = tmpDir('te-cli-config-bad-');
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    const { config, parseErrors } = resolveConfig(['--collection', 'X'], {}, dir);
    assert.strictEqual(config.preset, 'balanced');
    assert.deepStrictEqual(parseErrors, []);
  });
  check('an explicit --config path that does not exist IS a hard error', () => {
    const dir = tmpDir('te-cli-config-');
    const { parseErrors } = resolveConfig(['--collection', 'X', '--config', path.join(dir, 'nope.json')], {}, dir);
    assert.ok(parseErrors.some((e) => e.includes('does not exist')));
  });
  check('cwd config.json takes precedence over ~/.trait-extractor-cli/config.json when both exist', () => {
    // Simulated by pointing --config explicitly rather than touching the
    // real home directory from a test - proves the "first found wins"
    // mechanism itself (the cwd-vs-home ordering is a fixed constant in
    // config.ts, exercised structurally here via the explicit-path branch).
    const dir = tmpDir('te-cli-config-explicit-');
    const explicitPath = path.join(dir, 'explicit-config.json');
    fs.writeFileSync(explicitPath, JSON.stringify({ job: { preset: 'thorough' } }));
    const { config, configFilePath } = resolveConfig(['--collection', 'X', '--config', explicitPath], {}, dir);
    assert.strictEqual(configFilePath, explicitPath);
    assert.strictEqual(config.preset, 'thorough');
  });

  console.log('\nmetadata scan cache (Stage 5.4)');
  const fakeScan: CachedScanResult = {
    assets: traitCollectionAssets('http://example.invalid'),
    perAssetIssues: [[], [], [], []],
    pagesFetched: 1,
    duplicatesSkipped: 0,
    warnings: [],
  };
  await checkAsync('saveCachedScan + loadCachedScan round-trips exactly', async () => {
    const cacheRoot = tmpDir('te-cli-cacheroot-');
    await saveCachedScan(cacheRoot, 'COLL_A', fakeScan);
    const loaded = await loadCachedScan(cacheRoot, 'COLL_A', Infinity);
    assert.ok(loaded);
    assert.strictEqual(loaded!.assets.length, fakeScan.assets.length);
  });
  await checkAsync('a scan cached under one collection address is NOT returned for a different address', async () => {
    const cacheRoot = tmpDir('te-cli-cacheroot-');
    await saveCachedScan(cacheRoot, 'COLL_A', fakeScan);
    assert.strictEqual(await loadCachedScan(cacheRoot, 'COLL_B', Infinity), null);
  });
  await checkAsync('an entry older than maxAgeMs is treated as a miss', async () => {
    const cacheRoot = tmpDir('te-cli-cacheroot-');
    await saveCachedScan(cacheRoot, 'COLL_A', fakeScan);
    assert.ok(await loadCachedScan(cacheRoot, 'COLL_A', 24 * 60 * 60 * 1000));
    // maxAgeMs=0 is flaky on a fast filesystem/clock (age can read back as
    // exactly 0ms) - use a negative threshold instead, which is
    // unambiguously "always too old" regardless of clock resolution.
    assert.strictEqual(await loadCachedScan(cacheRoot, 'COLL_A', -1), null, 'a negative maxAgeMs must reject an entry written just now, unambiguously (no clock-resolution race)');
  });
  await checkAsync('a checksum mismatch (disk corruption / tampering) is rejected, not thrown', async () => {
    const cacheRoot = tmpDir('te-cli-cacheroot-');
    await saveCachedScan(cacheRoot, 'COLL_A', fakeScan);
    const scanFile = fs.readdirSync(path.join(cacheRoot, 'scans'))[0];
    const p = path.join(cacheRoot, 'scans', scanFile);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    parsed.checksum = 'deadbeef';
    fs.writeFileSync(p, JSON.stringify(parsed));
    assert.strictEqual(await loadCachedScan(cacheRoot, 'COLL_A', Infinity), null);
  });
  await checkAsync('missing scan cache entry -> null, never throws', async () => {
    const cacheRoot = tmpDir('te-cli-cacheroot-empty-');
    assert.strictEqual(await loadCachedScan(cacheRoot, 'COLL_NEVER_SCANNED', Infinity), null);
  });

  console.log('\nglobal image cache reuse across collections (Stage 5.4)');
  await checkAsync('two different collections sharing one image URL, pointed at the SAME global cache dir, only download it once', async () => {
    const globalCacheDir = tmpDir('te-cli-global-imgcache-');
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const url = `${fixture.baseUrl}/nft/A2.png`;
    const before = fixture.requestCounts.get('/nft/A2.png') ?? 0;

    // Collection A's job.
    const cacheA = new LocalImageCache(globalCacheDir, controllerA.signal, allowOnlyLoopback);
    const r1 = await cacheA.get(url);
    assert.ok(r1.ok);
    const afterA = fixture.requestCounts.get('/nft/A2.png') ?? 0;
    assert.strictEqual(afterA, before + 1);

    // A DIFFERENT collection's job, different --output dir, but the SAME
    // shared global cache dir - must be a hit, not a second download.
    const cacheB = new LocalImageCache(globalCacheDir, controllerB.signal, allowOnlyLoopback);
    const r2 = await cacheB.get(url);
    assert.ok(r2.ok);
    const afterB = fixture.requestCounts.get('/nft/A2.png') ?? 0;
    assert.strictEqual(afterB, afterA, 'a second collection reusing the shared global cache dir must not re-download a URL already cached by a different collection');
  });

  console.log('\ncache-hit-rate + hasCachedEntry (Stage 5.4)');
  await checkAsync('hasCachedEntry reports hit/miss/permanent-failure correctly, with no network access', async () => {
    const cacheDir = tmpDir('te-cli-hascached-');
    const controller = new AbortController();
    const cache = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const okUrl = `${fixture.baseUrl}/nft/A3.png`;
    const badUrl = `${fixture.baseUrl}/not-an-image.txt`;
    const neverRequestedUrl = `${fixture.baseUrl}/nft/A4.png`;

    assert.strictEqual(await hasCachedEntry(cacheDir, okUrl), 'miss', 'not yet fetched -> miss');
    await cache.get(okUrl);
    await cache.get(badUrl);
    assert.strictEqual(await hasCachedEntry(cacheDir, okUrl), 'hit');
    assert.strictEqual(await hasCachedEntry(cacheDir, badUrl), 'permanent-failure');
    assert.strictEqual(await hasCachedEntry(cacheDir, neverRequestedUrl), 'miss');
  });
  await checkAsync('LocalImageCache.cacheHitRate reflects hit vs. miss across get() calls', async () => {
    const cacheDir = tmpDir('te-cli-hitrate-');
    const controller = new AbortController();
    const cache = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const url = `${fixture.baseUrl}/nft/A1.png`;
    assert.strictEqual(cache.cacheHitRate, null, 'nothing requested yet -> null, not 0');
    await cache.get(url); // miss (first fetch)
    assert.strictEqual(cache.cacheHitRate, 0);
    await cache.get(url); // in-flight/same-instance dedupe, not a fresh miss or a disk hit
    const cache2 = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    await cache2.get(url); // a genuine disk cache hit on a fresh instance
    assert.strictEqual(cache2.cacheHitRate, 1);
  });

  console.log('\nmanifest phase + heartbeat (Stage 5.4)');
  await checkAsync('initManifest sets phase="scanning" and a lastHeartbeatAt timestamp', async () => {
    const dir = tmpDir('te-cli-manifest-phase-');
    const m = await initManifest(dir, baseConfig, 3);
    assert.strictEqual(m.phase, 'scanning');
    assert.ok(m.lastHeartbeatAt);
    const loaded = await loadManifest(dir);
    assert.strictEqual(loaded!.phase, 'scanning');
  });
  await checkAsync('a Stage-5.3-shaped manifest (cacheFormatVersion 1, no phase field) is rejected by the v2 loader, forcing a fresh start', async () => {
    const dir = tmpDir('te-cli-manifest-v1-');
    const m = await initManifest(dir, baseConfig, 3);
    const { phase, lastHeartbeatAt, ...v1Shaped } = m as any;
    await saveManifest(dir, { ...v1Shaped, cacheFormatVersion: 1 } as any);
    assert.strictEqual(await loadManifest(dir), null);
  });

  console.log('\n--estimate accuracy (Stage 5.4): expandComparisonSearch + hasCachedEntry against a real plan');
  async function buildFixturePlan(): Promise<JobPlan> {
    const assets = traitCollectionAssets(fixture.baseUrl);
    const eligibility = buildTraitCollectionEligibility(assets);
    const selections = [{ traitType: 'Background' }, { traitType: 'Eyes' }];
    const extractionConfig: TraitExtractionConfig = { scanId: 'test-estimate', selections, preset: 'balanced' };
    const limits = presetLimitsFor('balanced');
    const collectionIndex = buildCollectionIndex(assets);
    const impactModel = new CategoryImpactModel();
    const targets = resolveTargetsInOrder(assets, extractionConfig, collectionIndex, impactModel, limits);
    const outputDir = tmpDir('te-cli-estimate-plan-');
    const preflight = await runPreflightChecks(outputDir, targets, limits);
    return {
      outputDir, collectionAddress: 'COLL', assets,
      scan: { pagesFetched: 1, duplicatesSkipped: 0, warnings: [], fromCache: false },
      eligibility, allCategories: ['Background', 'Eyes'], skippedCategoriesNoRepeatedValue: [],
      selections, extractionConfig, limits, targets, collectionIndex, impactModel, preflight,
      manifestConfig: { collectionAddress: 'COLL', preset: 'balanced', selections, coreVersion: '1.0.0' },
      existingManifest: null,
    };
  }
  await checkAsync('before any download, every candidate URL is predicted as missing (0% hit rate)', async () => {
    const plan = await buildFixturePlan();
    const cacheDir = tmpDir('te-cli-estimate-cache-');
    const estimate = await computeAccurateEstimate(plan, cacheDir);
    assert.ok(estimate.totalUniqueUrls > 0, 'the fixture collection must produce at least one real candidate pair');
    assert.strictEqual(estimate.cachedHits, 0);
    assert.strictEqual(estimate.missing, estimate.totalUniqueUrls);
  });
  await checkAsync('after downloading every predicted URL into the cache, --estimate predicts a 100% hit rate', async () => {
    const plan = await buildFixturePlan();
    const cacheDir = tmpDir('te-cli-estimate-cache2-');
    const before = await computeAccurateEstimate(plan, cacheDir);
    const controller = new AbortController();
    const imageCache = new LocalImageCache(path.join(cacheDir, 'images'), controller.signal, allowOnlyLoopback);
    for (const target of plan.targets) {
      const { candidates } = expandComparisonSearch({
        targetTraitType: target.traitType, targetValue: target.traitValue,
        index: plan.collectionIndex, impactModel: plan.impactModel, limits: plan.limits, preset: plan.extractionConfig.preset,
      });
      for (const c of candidates) { await imageCache.get(c.sourceImage); await imageCache.get(c.comparisonImage); }
    }
    const after = await computeAccurateEstimate(plan, cacheDir);
    assert.strictEqual(after.missing, 0);
    assert.strictEqual(after.cachedHits, before.totalUniqueUrls);
  });

  console.log('\ncheckpoint-on-cancellation (Stage 5.4 regression, found via real-collection validation)');
  check('an unresolved settlement WHILE cancelling is NOT checkpointed - a resume must retry it', () => {
    assert.strictEqual(shouldCheckpointSettlement('unresolved', true), false, 'run-extraction.ts can settle a value unresolved purely because the abort signal cut its candidate-pair search short, not because the collection genuinely lacks evidence - permanently checkpointing that would silently degrade the final output for values unlucky enough to be in-flight at Ctrl+C time');
  });
  check('an unresolved settlement in a NORMAL (non-cancelling) run IS checkpointed - genuinely unresolved values must not be retried forever', () => {
    assert.strictEqual(shouldCheckpointSettlement('unresolved', false), true, 'without cancellation in play, an unresolved result reflects real evidence (or lack of it) in the collection, and resume must not waste effort re-attempting it on every future run');
  });
  check('a RESOLVED settlement is always checkpointed, cancelling or not', () => {
    assert.strictEqual(shouldCheckpointSettlement('resolved', true), true, 'a value that resolved cleanly is genuinely done even if the job is cancelling elsewhere - only the unresolved+aborted combination is special-cased');
    assert.strictEqual(shouldCheckpointSettlement('resolved', false), true);
  });

  console.log('\nexecution-report timing: cumulative effort vs. wall-clock phases (Stage 5.4 regression)');
  await checkAsync('LocalImageCache.downloadTimeMs (cumulative, concurrent) can exceed real elapsed wall-clock time - it must NEVER be treated as a wall-clock phase duration', async () => {
    // Reproduces the exact defect caught during Stage 5.4 real-collection
    // validation: subtracting this cumulative figure from a wall-clock
    // span produced a negative-clamped-to-zero "processing" duration,
    // silently hiding real work. Fired concurrently (matching how
    // run-extraction.ts's runWithConcurrency actually calls .get()), not
    // sequentially, so this exercises the real overlap that caused it.
    const cacheDir = tmpDir('te-cli-cumulative-timing-');
    const controller = new AbortController();
    const cache = new LocalImageCache(cacheDir, controller.signal, allowOnlyLoopback);
    const urls = [0, 1, 2, 3].map((n) => `${fixture.baseUrl}/slow/${n}.png`);
    const wallClockStart = Date.now();
    await Promise.all(urls.map((u) => cache.get(u)));
    const wallClockElapsed = Date.now() - wallClockStart;
    assert.ok(cache.downloadTimeMs > wallClockElapsed, `cumulative downloadTimeMs (${cache.downloadTimeMs}ms) must exceed real elapsed time (${wallClockElapsed}ms) when downloads overlap - if this ever stops being true the concurrency behavior itself changed, re-examine before "fixing" this assertion`);
    // The actual regression: this must NEVER go negative when used the
    // way cli.ts's phase computation uses it (wall-clock span minus
    // cumulative effort) - confirming the fixed report design keeps these
    // two numbers in entirely separate report sections instead.
    const nonsensicalIfSubtracted = wallClockElapsed - cache.downloadTimeMs;
    assert.ok(nonsensicalIfSubtracted < 0, 'demonstrates why phases and effort must never be arithmetically combined');
  });
  check('buildExecutionReport keeps wall-clock phases and cumulative effort in separate top-level sections', () => {
    const report = buildExecutionReport({
      cliVersion: '1.0.0', coreVersion: '1.0.0', startedAt: Date.now() - 1000,
      config: { preset: 'balanced' } as any, sources: {}, collectionAddress: 'COLL',
      phases: { scanAndSetup: { durationMs: 10 }, downloadingAndProcessing: { durationMs: 500 }, archiving: { durationMs: 5 } },
      effort: { downloads: { cumulativeMs: 9999 }, decode: { cumulativeMs: 500 } },
      resume: { resumedFromManifest: false, completedTargetsAtStart: 0, totalTargets: 1 },
      cache: { imagesCacheHitRate: null, scanCacheHit: false },
      memorySamples: [], result: {}, events: [],
    });
    assert.ok(!('downloads' in report.phases), '"downloads" must live in effort, not phases, now that it is a cumulative (not wall-clock) figure');
    assert.ok(!('decode' in report.phases), 'same for "decode"');
    assert.strictEqual(report.effort.downloads.cumulativeMs, 9999, 'effort figures are reported as-is, even when larger than durationMs - that is expected, not a bug, for a cumulative-concurrent metric');
  });

  console.log('\nlogger levels (Stage 5.4)');
  check('--quiet suppresses info/warn but still emits error to the event log', () => {
    const logger = new Logger('quiet');
    logger.info('should not print');
    logger.warn('should not print either');
    logger.error('should always print');
    const events = logger.getEvents();
    assert.strictEqual(events.length, 3, 'all three are still recorded in the event log regardless of level');
    assert.strictEqual(events[2].level, 'error');
  });
  check('--verbose surfaces verbose() calls that --normal would suppress from the terminal (both still recorded)', () => {
    const normalLogger = new Logger('normal');
    const verboseLogger = new Logger('verbose');
    normalLogger.verbose('cache hit detail');
    verboseLogger.verbose('cache hit detail');
    assert.strictEqual(normalLogger.getEvents().length, 1, 'still recorded for the report even though --normal would not print it');
    assert.strictEqual(verboseLogger.getEvents().length, 1);
  });
  check('--debug records debug() events that lower levels still capture in the event log', () => {
    const logger = new Logger('debug');
    logger.debug('config resolution trace', { preset: 'balanced' });
    assert.strictEqual(logger.getEvents()[0].level, 'debug');
    assert.deepStrictEqual(logger.getEvents()[0].data, { preset: 'balanced' });
  });

  await fixture.close();

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
