/**
 * Collection Analyzer Stage 3 — SSRF guard offline tests.
 *
 * Part 1: pure `isPublicAddress` classification (IPv4 + IPv6, no network).
 * Part 2: `downloadToFile` HTTP mechanics (retry/timeout/redirect/oversized/
 * cancellation) against a REAL local fixture server bound to 127.0.0.1 —
 * see test-server.ts's doc comment for why the `isDestinationAllowedOverride`
 * test hook is required (the real allowlist would otherwise correctly
 * reject loopback, by design). No live internet calls.
 *
 * Run: npm run test:collection-analyzer-ssrf
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPublicAddress, downloadToFile } from 'trait-extraction-core';
import { startTestServer, allowOnlyLoopback, type TestServerHandle } from './test-server';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

// ── Part 1: isPublicAddress ──────────────────────────────────────────────
console.log('\nisPublicAddress classification');
check('public IPv4 (1.1.1.1) -> true', () => assert.strictEqual(isPublicAddress('1.1.1.1'), true));
check('public IPv6 (Cloudflare DNS) -> true', () => assert.strictEqual(isPublicAddress('2606:4700:4700::1111'), true));
check('loopback IPv4 (127.0.0.1) -> false', () => assert.strictEqual(isPublicAddress('127.0.0.1'), false));
check('loopback IPv6 (::1) -> false', () => assert.strictEqual(isPublicAddress('::1'), false));
check('private 10.0.0.0/8 -> false', () => assert.strictEqual(isPublicAddress('10.1.2.3'), false));
check('private 172.16.0.0/12 -> false', () => assert.strictEqual(isPublicAddress('172.16.5.5'), false));
check('private 192.168.0.0/16 -> false', () => assert.strictEqual(isPublicAddress('192.168.1.1'), false));
check('link-local IPv4 169.254.x.x (cloud metadata range) -> false', () => assert.strictEqual(isPublicAddress('169.254.169.254'), false));
check('link-local IPv6 fe80::/10 -> false', () => assert.strictEqual(isPublicAddress('fe80::1'), false));
check('unique-local IPv6 fc00::/7 -> false', () => assert.strictEqual(isPublicAddress('fc00::1'), false));
check('carrier-grade NAT 100.64.0.0/10 -> false', () => assert.strictEqual(isPublicAddress('100.64.0.1'), false));
check('unspecified 0.0.0.0 -> false', () => assert.strictEqual(isPublicAddress('0.0.0.0'), false));
check('broadcast 255.255.255.255 -> false', () => assert.strictEqual(isPublicAddress('255.255.255.255'), false));
check('multicast 224.0.0.1 -> false', () => assert.strictEqual(isPublicAddress('224.0.0.1'), false));
check('IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) unwraps and is blocked', () => assert.strictEqual(isPublicAddress('::ffff:127.0.0.1'), false));
check('IPv4-mapped IPv6 private (::ffff:10.0.0.1) unwraps and is blocked', () => assert.strictEqual(isPublicAddress('::ffff:10.0.0.1'), false));
check('IPv4-mapped IPv6 public (::ffff:1.1.1.1) unwraps and passes', () => assert.strictEqual(isPublicAddress('::ffff:1.1.1.1'), true));
check('garbage string -> false, never throws', () => assert.strictEqual(isPublicAddress('not-an-ip'), false));

// ── Part 2: downloadToFile mechanics ────────────────────────────────────
async function main() {
  const server: TestServerHandle = await startTestServer();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vl-ssrf-test-'));
  const dest = () => path.join(tmpDir, `f-${Math.random().toString(36).slice(2)}`);

  console.log('\ndownloadToFile mechanics (local fixture server)');

  await checkAsync('successful download streams to disk, no retry', async () => {
    const d = dest();
    const { outcome, retryCount } = await downloadToFile(`${server.baseUrl}/ok-png`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(retryCount, 0);
    const stat = await fs.promises.stat(d);
    assert.ok(stat.size > 0);
  });

  await checkAsync('429 retried then succeeds', async () => {
    const d = dest();
    const { outcome, retryCount } = await downloadToFile(`${server.baseUrl}/retry-429-then-ok`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(retryCount, 2);
  });

  await checkAsync('transient 503 retried then succeeds', async () => {
    const d = dest();
    const { outcome, retryCount } = await downloadToFile(`${server.baseUrl}/retry-503-then-ok`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(retryCount, 2);
  });

  await checkAsync('permanent 404 fails immediately, no retry', async () => {
    const d = dest();
    const { outcome, retryCount } = await downloadToFile(`${server.baseUrl}/permanent-404`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'http_error');
    assert.strictEqual(retryCount, 0);
  });

  await checkAsync('sustained 429 exhausts retries -> retries_exhausted', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/always-429`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'retries_exhausted');
  });

  await checkAsync('oversized response aborted mid-stream, partial file removed', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/oversized-image`, {
      destPath: d, maxBytes: 10_000, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'oversized');
    await assert.rejects(fs.promises.stat(d)); // partial file must not be left behind
  });

  await checkAsync('per-resource timeout fires on a slow response', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/slow`, {
      destPath: d, maxBytes: 1024 * 1024, timeoutMs: 300, maxRedirects: 0,
      signal: new AbortController().signal, isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'timeout');
  });

  await checkAsync('redirect to an allowed same-origin destination succeeds', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/redirect-to-ok`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, true);
  });

  await checkAsync('redirect to a private destination is blocked (per-hop revalidation)', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/redirect-to-private`, {
      destPath: d, maxBytes: 1024 * 1024, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback, // allows the ORIGIN only, not 10.0.0.5
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'blocked_destination');
  });

  await checkAsync('too many redirects is rejected, not followed forever', async () => {
    const d = dest();
    const { outcome } = await downloadToFile(`${server.baseUrl}/redirect-loop`, {
      destPath: d, maxBytes: 1024 * 1024, maxRedirects: 3, signal: new AbortController().signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'too_many_redirects');
  });

  await checkAsync('explicit cancellation aborts an in-flight download', async () => {
    const d = dest();
    const controller = new AbortController();
    const p = downloadToFile(`${server.baseUrl}/slow`, {
      destPath: d, maxBytes: 1024 * 1024, timeoutMs: 10_000, signal: controller.signal,
      isDestinationAllowedOverride: allowOnlyLoopback,
    });
    setTimeout(() => controller.abort(), 100);
    const { outcome } = await p;
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'cancelled');
  });

  await checkAsync('literal private IPv4 destination is blocked without any override', async () => {
    const d = dest();
    const { outcome } = await downloadToFile('http://10.255.255.254/whatever', {
      destPath: d, maxBytes: 1024, timeoutMs: 500, signal: new AbortController().signal,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'blocked_destination');
  });

  await checkAsync('non-http(s) protocol is rejected', async () => {
    const d = dest();
    const { outcome } = await downloadToFile('file:///etc/passwd', {
      destPath: d, maxBytes: 1024, signal: new AbortController().signal,
    });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.code, 'unsupported_protocol');
  });

  await server.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
