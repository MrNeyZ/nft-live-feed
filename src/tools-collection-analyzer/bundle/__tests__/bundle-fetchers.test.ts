/**
 * Collection Analyzer Stage 3 — image/metadata fetcher offline tests.
 *
 * Exercises `fetchAssetImage` / `fetchOriginalMetadata` (download + content
 * validation) against the shared local fixture server. No live internet
 * calls.
 *
 * Run: npm run test:collection-analyzer-fetchers
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { fetchAssetImage } from '../image-fetch';
import { fetchOriginalMetadata } from '../metadata-fetch';
import { startTestServer, allowOnlyLoopback, type TestServerHandle } from './test-server';

let failures = 0;
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

async function main() {
  const server: TestServerHandle = await startTestServer();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vl-fetchers-test-'));
  const dest = (name: string) => path.join(tmpDir, name);

  console.log('\nfetchAssetImage');

  await checkAsync('valid PNG downloads, gets a real .png extension from content sniffing', async () => {
    const result = await fetchAssetImage(`${server.baseUrl}/ok-png`, dest('img1'), new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.ok(result.finalPath.endsWith('.png'));
      const meta = await sharp(result.finalPath).metadata();
      assert.strictEqual(meta.format, 'png');
    }
  });

  await checkAsync('mislabeled Content-Type but non-image bytes -> unsupported_content_type, temp file removed', async () => {
    const destPath = dest('img2');
    const result = await fetchAssetImage(`${server.baseUrl}/not-an-image`, destPath, new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'unsupported_content_type');
    await assert.rejects(fs.promises.stat(`${destPath}.tmp`));
    await assert.rejects(fs.promises.stat(`${destPath}.png`));
  });

  await checkAsync('oversized image is rejected before content validation ever runs', async () => {
    const result = await fetchAssetImage(`${server.baseUrl}/oversized-image`, dest('img3'), new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'oversized');
  });

  await checkAsync('null image URL -> no_source_url, never attempts a request', async () => {
    const result = await fetchAssetImage(null, dest('img4'), new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'no_source_url');
  });

  await checkAsync('SSRF-blocked image URL (no override) is rejected', async () => {
    const result = await fetchAssetImage('http://169.254.169.254/latest/meta-data/', dest('img5'), new AbortController().signal);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'blocked_destination');
  });

  console.log('\nfetchOriginalMetadata');

  await checkAsync('valid JSON downloads and is stored as-is', async () => {
    const destPath = dest('meta1.json');
    const result = await fetchOriginalMetadata(`${server.baseUrl}/ok-json`, destPath, new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      const raw = await fs.promises.readFile(result.finalPath, 'utf8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.name, 'Test NFT #1');
    }
  });

  await checkAsync('malformed JSON is rejected, temp file removed', async () => {
    const destPath = dest('meta2.json');
    const result = await fetchOriginalMetadata(`${server.baseUrl}/malformed-json`, destPath, new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'malformed_json');
    await assert.rejects(fs.promises.stat(destPath));
    await assert.rejects(fs.promises.stat(`${destPath}.tmp`));
  });

  await checkAsync('oversized metadata response is rejected', async () => {
    const destPath = dest('meta3.json');
    const result = await fetchOriginalMetadata(`${server.baseUrl}/oversized-metadata`, destPath, new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'oversized');
  });

  await checkAsync('null jsonUri -> no_source_url', async () => {
    const result = await fetchOriginalMetadata(null, dest('meta4.json'), new AbortController().signal, allowOnlyLoopback);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.code, 'no_source_url');
  });

  await server.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
