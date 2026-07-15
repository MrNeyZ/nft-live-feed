/**
 * Regression coverage for the seller-remaining-count fast path
 * (`getOwnerCollectionCountVerbose` → `searchAssets`) against the exact
 * Helius DAS API-contract break that made it return null on every call:
 * sending `burnt: false` alongside `tokenType: 'all'` now trips Helius's
 * own validation (`-32000 Validation Error: burnt is not supported for
 * this token_type`). No live network calls: `global.fetch` is mocked to
 * reproduce Helius's real validation rule so a future regression (someone
 * re-adding `burnt`, or any other now-incompatible param) fails this test
 * the same way it broke production — silently returning null — instead of
 * requiring a live API call to notice.
 *
 * Run: npx ts-node src/enrichment/helius-das-seller-count.test.ts
 */

process.env.HELIUS_API_KEY = 'test-key';

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

interface CapturedRequest { params: Record<string, unknown>; }
const capturedRequests: CapturedRequest[] = [];

/** Reproduces Helius's real searchAssets validation: `burnt` is rejected
 *  whenever `tokenType` is present in params. This is the exact rule that
 *  broke the fast path — mocking it here (rather than just returning a
 *  canned success) means the test fails again if the request shape
 *  regresses, without needing a live Helius call. */
function heliusSearchAssetsMock(params: Record<string, unknown>): FakeResponse {
  if ('tokenType' in params && 'burnt' in params) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'seller-count-search',
        error: { code: -32000, message: 'Validation Error: `burnt` is not supported for this `token_type`' },
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'seller-count-search',
      result: { total: 4, limit: 1, page: 1, items: [] },
    }),
  };
}

let forceErrorResponse: FakeResponse | null = null;

(global as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { params?: Record<string, unknown> };
  const params = body.params ?? {};
  capturedRequests.push({ params });
  if (forceErrorResponse) return forceErrorResponse as unknown as ReturnType<typeof fetch>;
  return heliusSearchAssetsMock(params) as unknown as ReturnType<typeof fetch>;
}) as typeof fetch;

/* eslint-disable @typescript-eslint/no-var-requires */
import { getOwnerCollectionCountVerbose } from './helius-das';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

async function main() {
  const OWNER = 'SellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const COLLECTION = 'CollectionBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';

  // ── 1. Current request shape must not trip Helius's real validation ──────
  const r1 = await getOwnerCollectionCountVerbose(OWNER, COLLECTION);
  check('fast path: resolves a real count against the live validation rule',
    r1.count === 4 && r1.method === 'searchAssets',
    `count=${r1.count} method=${r1.method}`);

  const sentParams = capturedRequests[capturedRequests.length - 1].params;
  check('fast path: request never sends `burnt` (the field Helius rejects alongside tokenType)',
    !('burnt' in sentParams),
    `params=${JSON.stringify(sentParams)}`);
  check('fast path: request still sends tokenType=all (must keep covering MPL Core/pNFT/legacy)',
    sentParams.tokenType === 'all',
    `tokenType=${sentParams.tokenType}`);

  // ── 2. Simulated Helius validation error is now logged, not swallowed ────
  // Directly assert the exact code path this fix touched: a DasSearchResponse
  // carrying `error` must produce a `[seller-count-fast-error]` log line and
  // degrade to method:'failed', count:null (unchanged graceful-degradation
  // contract) instead of silently vanishing.
  forceErrorResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'seller-count-search',
      error: { code: -32000, message: 'Validation Error: `burnt` is not supported for this `token_type`' },
    }),
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  let r2: Awaited<ReturnType<typeof getOwnerCollectionCountVerbose>>;
  try {
    r2 = await getOwnerCollectionCountVerbose(OWNER, COLLECTION);
  } finally {
    console.log = originalLog;
  }
  check('error path: degrades to null/failed (unchanged contract)',
    r2.count === null && r2.method === 'failed',
    `count=${r2.count} method=${r2.method}`);
  check('error path: Helius validation error is logged instead of silently dropped',
    logs.some(l => l.includes('[seller-count-fast-error]') && l.includes('-32000') && l.includes('burnt')),
    `logs=${JSON.stringify(logs)}`);
  forceErrorResponse = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
