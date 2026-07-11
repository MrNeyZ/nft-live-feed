/**
 * Focused regression for the ME `/v2/tokens/{mint}` and `/v2/collections/{slug}`
 * consolidation: verifies the shared helpers (me-token-cache.ts,
 * me-collection-cache.ts) actually cache, dedup in-flight requests, and
 * respect the process-wide ME cooldown — the exact properties the
 * consolidation was meant to add. No live network calls: `global.fetch` is
 * mocked so this runs offline and deterministically.
 *
 * Run: npx ts-node src/enrichment/me-cache-consolidation.test.ts
 */

// Mock fetch BEFORE importing the modules under test (they read
// `globalThis.fetch` per-call, so assigning before import is not strictly
// required, but keeps setup obviously ordered).
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const callCounts = new Map<string, number>();
const queues: Map<string, Array<() => FakeResponse | Promise<FakeResponse>>> = new Map();

function queueResponse(urlToken: string, fn: () => FakeResponse | Promise<FakeResponse>): void {
  const q = queues.get(urlToken) ?? [];
  q.push(fn);
  queues.set(urlToken, q);
}

function ok(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number): FakeResponse {
  return { ok: false, status, json: async () => ({}) };
}

(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
  // Match by the last path segment before any query string (mint or slug).
  const token = url.split('?')[0].split('/').filter(Boolean).pop() ?? url;
  callCounts.set(token, (callCounts.get(token) ?? 0) + 1);
  const q = queues.get(token);
  if (!q || q.length === 0) return err(404);
  const next = q.shift()!;
  return next() as unknown as ReturnType<typeof fetch>;
}) as typeof fetch;

/* eslint-disable @typescript-eslint/no-var-requires */
import { getMeTokenData } from './me-token-cache';
import { getMeCollectionData } from './me-collection-cache';
import { meCooldownActive } from '../me-api-cooldown';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

async function main() {
  // ── 1. Cache hit: second call for the same mint does not re-fetch ────────
  const MINT_A = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  queueResponse(MINT_A, () => ok({ collection: 'slugA', collectionName: 'Collection A', name: 'NFT #1', image: 'https://img/a.png' }));
  const a1 = await getMeTokenData(MINT_A);
  const a2 = await getMeTokenData(MINT_A);
  check('token: cache hit avoids second fetch', callCounts.get(MINT_A) === 1,
    `fetch calls=${callCounts.get(MINT_A)}`);
  check('token: cached result matches', a1.slug === 'slugA' && a2.slug === 'slugA' && a2.nftName === 'NFT #1',
    `a1=${JSON.stringify(a1)} a2=${JSON.stringify(a2)}`);

  // ── 2. In-flight dedup: concurrent calls collapse into one fetch ─────────
  const MINT_B = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
  queueResponse(MINT_B, () => new Promise(res => setTimeout(() => res(ok({ collection: 'slugB', name: 'NFT B' })), 40)));
  const [b1, b2] = await Promise.all([getMeTokenData(MINT_B), getMeTokenData(MINT_B)]);
  check('token: concurrent calls dedup to one fetch', callCounts.get(MINT_B) === 1,
    `fetch calls=${callCounts.get(MINT_B)}`);
  check('token: both concurrent callers get the same data', b1.slug === 'slugB' && b2.slug === 'slugB',
    `b1=${JSON.stringify(b1)} b2=${JSON.stringify(b2)}`);

  // ── 3. Negative (miss) caching: a 404 is cached so a second call doesn't refetch ──
  const MINT_C = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3';
  queueResponse(MINT_C, () => err(404));
  const c1 = await getMeTokenData(MINT_C);
  const c2 = await getMeTokenData(MINT_C);
  check('token: 404 miss is cached (single fetch)', callCounts.get(MINT_C) === 1,
    `fetch calls=${callCounts.get(MINT_C)}`);
  check('token: miss returns EMPTY-shaped result', c1.slug === null && c2.slug === null,
    `c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)}`);

  // ── 4. Retry on transient 5xx recovers on the second attempt ──────────────
  const MINT_D = 'MintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4';
  queueResponse(MINT_D, () => err(500));
  queueResponse(MINT_D, () => ok({ collection: 'slugD', name: 'NFT D' }));
  const d1 = await getMeTokenData(MINT_D);
  check('token: transient 5xx retried once then succeeds', callCounts.get(MINT_D) === 2 && d1.slug === 'slugD',
    `fetch calls=${callCounts.get(MINT_D)} d1=${JSON.stringify(d1)}`);

  // ── 5. Collection helper: same guarantees, distinct endpoint/key space ───
  const SLUG_A = 'collectionA';
  queueResponse(SLUG_A, () => ok({ symbol: SLUG_A, name: 'Collection A', twitter: 'https://twitter.com/a' }));
  const g1 = await getMeCollectionData(SLUG_A);
  const g2 = await getMeCollectionData(SLUG_A);
  check('collection: cache hit avoids second fetch', callCounts.get(SLUG_A) === 1,
    `fetch calls=${callCounts.get(SLUG_A)}`);
  check('collection: cached result matches', g1.name === 'Collection A' && g2.slug === SLUG_A,
    `g1=${JSON.stringify(g1)} g2=${JSON.stringify(g2)}`);

  const SLUG_B = 'collectionB';
  queueResponse(SLUG_B, () => new Promise(res => setTimeout(() => res(ok({ symbol: SLUG_B, name: 'B' })), 40)));
  const [h1, h2] = await Promise.all([getMeCollectionData(SLUG_B), getMeCollectionData(SLUG_B)]);
  check('collection: concurrent calls dedup to one fetch', callCounts.get(SLUG_B) === 1,
    `fetch calls=${callCounts.get(SLUG_B)}`);
  check('collection: both concurrent callers get the same data', h1.name === 'B' && h2.name === 'B',
    `h1=${JSON.stringify(h1)} h2=${JSON.stringify(h2)}`);

  // ── 6. 429 sets the process-wide cooldown and gates a DIFFERENT mint ─────
  // Run LAST: this flips the real, process-wide meCooldownActive() flag for
  // 60s, which would otherwise gate every later scenario in this file too
  // (both getMeTokenData and getMeCollectionData check it up front).
  const MINT_E = 'MintEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5';
  const MINT_F = 'MintFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF6';
  queueResponse(MINT_E, () => err(429));
  const e1 = await getMeTokenData(MINT_E);
  check('token: 429 returns EMPTY without throwing', e1.slug === null, `e1=${JSON.stringify(e1)}`);
  check('token: 429 sets the shared cooldown', meCooldownActive(), `meCooldownActive()=${meCooldownActive()}`);
  const f1 = await getMeTokenData(MINT_F);
  check('token: cooldown gates an unrelated mint (no fetch fired)', !callCounts.has(MINT_F) && f1.slug === null,
    `fetch calls=${callCounts.get(MINT_F) ?? 0} f1=${JSON.stringify(f1)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
