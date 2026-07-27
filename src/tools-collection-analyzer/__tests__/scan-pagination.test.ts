/**
 * Collection Analyzer Stage 2 — pagination walker offline tests.
 *
 * ts-node + node:assert, NO real network — `global.fetch` is replaced with a
 * canned-response queue per test. Uses small `ScanWalkOptions` overrides
 * (tiny page/maxPages/backoff) so every scenario runs in milliseconds
 * without touching the real env-derived production constants.
 *
 * Run: npm run test:collection-analyzer-scan
 */
import assert from 'assert';
import { walkFullCollection } from '../scan-fetch';

process.env.HELIUS_API_KEY = 'test-key-not-used-network-mocked';

let failures = 0;
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

interface FakeItem { id: string; burnt?: boolean; content?: { metadata?: { name?: string; attributes?: unknown } } }
function item(id: string): FakeItem { return { id, content: { metadata: { name: `NFT ${id}` } } }; }

type MockResponse = { status: number; body?: unknown };
function fakeResponse(mock: MockResponse) {
  return {
    ok: mock.status >= 200 && mock.status < 300,
    status: mock.status,
    json: async () => mock.body ?? {},
  };
}

/** Installs a queue-driven fetch mock; each call pops the next entry (or
 *  the last entry repeatedly if the queue is exhausted, for tests that
 *  don't care about extra calls beyond what they assert on). */
function installFetchQueue(queue: MockResponse[], onCall?: (callIndex: number) => void): { callCount: () => number } {
  let calls = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    const idx = calls;
    calls++;
    onCall?.(idx);
    const entry = queue[Math.min(idx, queue.length - 1)];
    return fakeResponse(entry) as unknown as Response;
  }) as typeof fetch;
  return { callCount: () => calls };
}

const dasPage = (items: FakeItem[]) => ({ status: 200, body: { result: { total: items.length, items } } });
const FAST_OPTS = { pageTimeoutMs: 2_000, retryBaseMs: 1, retryMaxWaitMs: 3, totalTimeoutMs: 60_000 };

async function main() {
  console.log('\nFull-scan pagination');

  await check('multi-page pagination collects all pages until a short final page', async () => {
    installFetchQueue([
      dasPage([item('a'), item('b')]),
      dasPage([item('c'), item('d')]),
      dasPage([item('e')]), // short — 1 < pageLimit(2)
    ]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 2, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.assets.length, 5);
    assert.strictEqual(result.pagesFetched, 3);
    assert.strictEqual(result.duplicatesSkipped, 0);
  });

  await check('short final page on the very first page stops after 1 fetch', async () => {
    installFetchQueue([dasPage([item('a'), item('b'), item('c')])]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.pagesFetched, 1);
    assert.strictEqual(result.assets.length, 3);
  });

  await check('empty collection (first page returns zero items)', async () => {
    installFetchQueue([dasPage([])]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.pagesFetched, 1);
    assert.strictEqual(result.assets.length, 0);
  });

  await check('repeated identical page stops pagination with a warning', async () => {
    installFetchQueue([
      dasPage([item('a'), item('b')]), // full page (2 == pageLimit)
      dasPage([item('a'), item('b')]), // IDENTICAL — provider pagination loop
    ]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 2, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.assets.length, 2);
    assert.strictEqual(result.pagesFetched, 2);
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes('repeated')));
  });

  await check('duplicate asset id across non-identical pages is deduped and counted', async () => {
    installFetchQueue([
      dasPage([item('a'), item('b'), item('c')]), // full (3 == pageLimit)
      dasPage([item('c'), item('d')]),            // short (2 < 3), 'c' repeats
    ]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 3, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.assets.length, 4); // a,b,c,d
    assert.strictEqual(result.duplicatesSkipped, 1);
    assert.strictEqual(result.pagesFetched, 2);
  });

  await check('safety cap: full page still coming back at the last allowed page -> collection_too_large', async () => {
    installFetchQueue([
      dasPage([item('a'), item('b')]),
      dasPage([item('c'), item('d')]), // still full at maxPages=2
    ]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 2, maxPages: 2, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'error');
    if (result.outcome !== 'error') return;
    assert.strictEqual(result.code, 'collection_too_large');
    assert.strictEqual(result.pagesFetched, 2);
  });

  await check('429 retried then succeeds', async () => {
    const q = installFetchQueue([
      { status: 429 },
      dasPage([item('a')]),
    ]);
    const retryTicks: Array<{ httpStatus: number | null } | null> = [];
    const result = await walkFullCollection('COLL', new AbortController().signal, {
      onProgress: (tick) => retryTicks.push(tick.retryState),
    }, { pageLimit: 5, maxPages: 5, maxRetriesPerPage: 3, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(q.callCount(), 2);
    assert.ok(retryTicks.some((t) => t?.httpStatus === 429));
  });

  await check('transient 5xx retried then succeeds', async () => {
    const q = installFetchQueue([
      { status: 503 },
      { status: 502 },
      dasPage([item('a'), item('b')]),
    ]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, maxRetriesPerPage: 3, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.strictEqual(result.assets.length, 2);
    assert.strictEqual(q.callCount(), 3);
  });

  await check('retries exhausted on sustained 429 -> fatal rpc_error, no infinite loop', async () => {
    const q = installFetchQueue([{ status: 429 }]); // every call returns 429
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, maxRetriesPerPage: 2, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'error');
    if (result.outcome !== 'error') return;
    assert.strictEqual(result.code, 'rpc_error');
    assert.strictEqual(q.callCount(), 3); // 1 initial + 2 retries
  });

  await check('fatal RPC error (DAS json-rpc error code) is NOT retried', async () => {
    const q = installFetchQueue([{ status: 200, body: { error: { code: -32000, message: 'Invalid params' } } }]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'error');
    if (result.outcome !== 'error') return;
    assert.strictEqual(result.code, 'rpc_error');
    assert.strictEqual(q.callCount(), 1); // never retried
  });

  await check('fatal 400 (not 429/5xx) is NOT retried', async () => {
    const q = installFetchQueue([{ status: 400 }]);
    const result = await walkFullCollection('COLL', new AbortController().signal, { onProgress: () => {} }, { pageLimit: 5, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'error');
    assert.strictEqual(q.callCount(), 1);
  });

  await check('cancellation mid-scan stops before the next page fetch', async () => {
    const controller = new AbortController();
    // Mock that aborts the controller as a side effect of resolving page 1,
    // simulating a client disconnect arriving mid-flight. The walker only
    // rechecks `externalSignal.aborted` at the top of the NEXT iteration, so
    // this asserts it stops BEFORE fetching page 2, not mid-page-1.
    (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
      controller.abort();
      return fakeResponse(dasPage([item('a'), item('b')])) as unknown as Response; // full page -> loop would continue if not cancelled
    }) as typeof fetch;
    const result = await walkFullCollection('COLL', controller.signal, { onProgress: () => {} }, { pageLimit: 2, maxPages: 5, ...FAST_OPTS });
    assert.strictEqual(result.outcome, 'cancelled');
  });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
