/**
 * Regression coverage for the running-holdings SELL badge counter
 * (migration 021 / `seller-holdings.ts`) — written against the 2026-07-15
 * correctness audit that preceded deploying this feature. Covers:
 *   1. first-observation semantics (no off-by-one)
 *   2. concurrent-sale atomicity (distinct descending counts, no lost updates)
 *   3. bounded reconciliation (TTL / low-count / N-decrements, fail-closed)
 *   4. restart recovery (trivial by construction — see below)
 *   5. independent seller/collection keys
 *   6. no merkle-tree keying (see note near the bottom)
 *
 * No live network / DB calls: `getOwnerCollectionDeepCount` (Helius) and
 * the three atomic DB primitives (`atomicDecrementSellerHolding`,
 * `seedSellerHolding`, `overwriteSellerHolding`) are monkey-patched on
 * their CommonJS module exports before `seller-holdings.ts` is required.
 *
 * The fake DB below deliberately does NOT rely on JS's run-to-completion
 * semantics to look "atomic" — each fake call awaits a randomized jitter
 * BEFORE touching the shared row, so concurrent calls' network-equivalent
 * delays interleave in an unpredictable order. The row mutation itself
 * (read-modify-write) happens with no `await` in between, modelling a
 * single atomic SQL statement (Postgres's real row-lock takes care of
 * this for the genuine implementation in db/insert.ts — this fake exists
 * to prove the CALLING code in seller-holdings.ts doesn't reintroduce a
 * race around that atomic primitive, not to re-prove Postgres itself is
 * atomic).
 *
 * Run: npx ts-node src/enrichment/seller-holdings.test.ts
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const dasModule    = require('./helius-das');
const insertModule = require('../db/insert');

function jitter(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
}

interface FakeRow { count: number; decrementsSinceScan: number; updatedAtMs: number; }
const fakeDb = new Map<string, FakeRow>();
// seller-holdings.ts's reconciliationDue() compares against the REAL
// Date.now() — this fake clock must track it (not an arbitrary counter)
// so "fresh" rows don't spuriously look TTL-stale against the real clock.
let clock = Date.now();

let scanCalls = 0;
let scanResult: number | null = 40;
dasModule.getOwnerCollectionDeepCount = async (_owner: string, _collection: string) => {
  await jitter();
  scanCalls++;
  return { count: scanResult, scanned: scanResult ?? 0 };
};

insertModule.atomicDecrementSellerHolding = async (seller: string, collection: string) => {
  await jitter();
  const k = `${seller}|${collection}`;
  const row = fakeDb.get(k);
  if (!row) return null;
  const prevUpdatedAtMs = row.updatedAtMs; // captured BEFORE this decrement — the bug this audit caught
  row.count = Math.max(0, row.count - 1);
  row.decrementsSinceScan += 1;
  row.updatedAtMs = ++clock;
  return { count: row.count, decrementsSinceScan: row.decrementsSinceScan, prevUpdatedAtMs };
};

insertModule.seedSellerHolding = async (seller: string, collection: string, count: number) => {
  await jitter();
  const k = `${seller}|${collection}`;
  if (fakeDb.has(k)) return null; // ON CONFLICT DO NOTHING
  fakeDb.set(k, { count, decrementsSinceScan: 0, updatedAtMs: ++clock });
  return count;
};

insertModule.overwriteSellerHolding = async (seller: string, collection: string, count: number) => {
  await jitter();
  const k = `${seller}|${collection}`;
  fakeDb.set(k, { count, decrementsSinceScan: 0, updatedAtMs: ++clock });
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getAndDecrementSellerHolding } = require('./seller-holdings');

let passed = 0, failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`✅ ${label}`); }
  else { failed++; console.log(`❌ ${label}`); }
}

async function main() {
  // ── 1. First-observation semantics — no off-by-one ─────────────────────
  {
    const seller = 'Seller1First1111111111111111111111111111';
    const coll   = 'Coll1First111111111111111111111111111111';
    scanResult = 29;
    const scanCallsBefore = scanCalls;
    const first = await getAndDecrementSellerHolding(seller, coll);
    check('first observation: returns the scanned post-sale count directly (29), no extra -1', first === 29);
    check('first observation: exactly one DAS scan performed', scanCalls === scanCallsBefore + 1);
    const second = await getAndDecrementSellerHolding(seller, coll);
    check('the NEXT sale (not the first) is the one that becomes 28', second === 28);
  }

  // ── 2. Concurrent sales — atomic, distinct, descending, no lost updates ─
  {
    const seller = 'Seller2Concurrent2222222222222222222222';
    const coll   = 'Coll2Concurrent22222222222222222222222';
    scanResult = 10;
    // Seed the pair first (single first-sight call) so all 3 concurrent
    // calls below hit the decrement path, not the seed-race path — this
    // isolates the decrement-atomicity property specifically.
    const seed = await getAndDecrementSellerHolding(seller, coll);
    check('concurrency setup: pair seeded at 10', seed === 10);

    const results = await Promise.all([
      getAndDecrementSellerHolding(seller, coll),
      getAndDecrementSellerHolding(seller, coll),
      getAndDecrementSellerHolding(seller, coll),
    ]);
    const sorted = [...results].sort((a: number, b: number) => b - a);
    check('3 concurrent sales: each gets a DISTINCT count', new Set(results).size === 3);
    check('3 concurrent sales: the set of counts is exactly {9,8,7} — no lost update, no duplicate', JSON.stringify(sorted) === JSON.stringify([9, 8, 7]));
    const finalRow = fakeDb.get(`${seller}|${coll}`);
    // Seed established the baseline at 10 (no decrement of its own); the 3
    // concurrent sales are the only decrements applied: 10 → 9 → 8 → 7.
    check('final persisted count reflects all 3 decrements since the seed (10 → 7)', finalRow?.count === 7);
    check('decrements_since_scan accounts for all 3 decrements since the seed', finalRow?.decrementsSinceScan === 3);
  }

  // ── 2b. Concurrent FIRST sales for a brand-new pair ─────────────────────
  {
    const seller = 'Seller2bConcurrentNew22222222222222222';
    const coll   = 'Coll2bConcurrentNew222222222222222222';
    scanResult = 15;
    const scanCallsBefore = scanCalls;
    const results = await Promise.all([
      getAndDecrementSellerHolding(seller, coll),
      getAndDecrementSellerHolding(seller, coll),
      getAndDecrementSellerHolding(seller, coll),
    ]);
    check('concurrent first-sight calls for a brand-new pair share exactly ONE DAS scan', scanCalls === scanCallsBefore + 1);
    const sorted = [...results].sort((a: number, b: number) => b - a);
    check('concurrent first-sight calls still get distinct descending counts (one seed winner + decrementing losers)',
      JSON.stringify(sorted) === JSON.stringify([15, 14, 13]));
  }

  // ── 4. Restart recovery is trivial by construction ──────────────────────
  // There is no in-process cache of the COUNT itself (only in-flight-scan
  // dedup maps, which start empty on any process boot). A "restarted"
  // process is therefore just a normal call against a row that already
  // exists in the DB — no special-cased recovery path exists or is needed.
  {
    const seller = 'Seller4Restart4444444444444444444444444';
    const coll   = 'Coll4Restart444444444444444444444444444';
    fakeDb.set(`${seller}|${coll}`, { count: 12, decrementsSinceScan: 3, updatedAtMs: ++clock });
    const scanCallsBefore = scanCalls;
    const result = await getAndDecrementSellerHolding(seller, coll);
    check('restart recovery: decrements the pre-existing persisted row with no re-scan', result === 11 && scanCalls === scanCallsBefore);
  }

  // ── 3. Reconciliation — TTL (both directions), low-count, N-decrements ──
  {
    const RECONCILE_TTL_MS = 6 * 60 * 60_000;

    // TTL, drift DOWNWARD (real holdings lower than the stale stored count).
    {
      const seller = 'Seller3TtlDown333333333333333333333333';
      const coll   = 'Coll3TtlDown3333333333333333333333333333';
      fakeDb.set(`${seller}|${coll}`, { count: 50, decrementsSinceScan: 1, updatedAtMs: clock - RECONCILE_TTL_MS - 1 });
      scanResult = 20; // real holdings dropped further than our decrement-only view knew about
      const scanCallsBefore = scanCalls;
      const result = await getAndDecrementSellerHolding(seller, coll);
      check('TTL reconciliation corrects DOWNWARD drift', result === 20 && scanCalls === scanCallsBefore + 1);
      check('TTL reconciliation resets decrements_since_scan', fakeDb.get(`${seller}|${coll}`)?.decrementsSinceScan === 0);
    }

    // TTL, drift UPWARD (seller bought more since we last observed).
    {
      const seller = 'Seller3TtlUp3333333333333333333333333333';
      const coll   = 'Coll3TtlUp33333333333333333333333333333333';
      fakeDb.set(`${seller}|${coll}`, { count: 5, decrementsSinceScan: 1, updatedAtMs: clock - RECONCILE_TTL_MS - 1 });
      scanResult = 18; // seller re-stocked
      const result = await getAndDecrementSellerHolding(seller, coll);
      check('TTL reconciliation corrects UPWARD drift', result === 18);
    }

    // Low-count trigger (<=3) forces reconciliation before the badge would hide.
    {
      const seller = 'Seller3LowCount333333333333333333333333';
      const coll   = 'Coll3LowCount3333333333333333333333333333';
      fakeDb.set(`${seller}|${coll}`, { count: 4, decrementsSinceScan: 1, updatedAtMs: clock }); // fresh, not TTL-due
      scanResult = 9; // the decrement-only view (→3) was wrong; real holdings are higher
      const scanCallsBefore = scanCalls;
      const result = await getAndDecrementSellerHolding(seller, coll);
      check('count<=3 after decrement forces reconciliation even when fresh (not TTL/N-decrement due)',
        scanCalls === scanCallsBefore + 1);
      check('reconciliation result (9) overrides the naive decremented value (3) before the badge would have hidden it',
        result === 9);
    }

    // N-decrements trigger.
    {
      const seller = 'Seller3NDecr333333333333333333333333333';
      const coll   = 'Coll3NDecr3333333333333333333333333333333';
      fakeDb.set(`${seller}|${coll}`, { count: 100, decrementsSinceScan: 24, updatedAtMs: clock }); // one short of the N=25 threshold
      scanResult = 70;
      const scanCallsBefore = scanCalls;
      const result = await getAndDecrementSellerHolding(seller, coll);
      check('the 25th decrement since the last scan forces reconciliation', scanCalls === scanCallsBefore + 1 && result === 70);
    }

    // Failed reconciliation fails closed — never surfaces the untrusted low count.
    {
      const seller = 'Seller3FailClosed33333333333333333333333';
      const coll   = 'Coll3FailClosed333333333333333333333333333';
      fakeDb.set(`${seller}|${coll}`, { count: 3, decrementsSinceScan: 1, updatedAtMs: clock }); // decrements to 2, <=3 → reconcile due
      scanResult = null; // DAS failure
      const result = await getAndDecrementSellerHolding(seller, coll);
      check('a failed reconciliation returns null (fail closed), never the untrusted stored count', result === null);
      // The atomic decrement always runs BEFORE the reconciliation check
      // (that's what keeps the common case a single cheap round trip) —
      // a failed reconcile leaves that already-applied decrement (3→2)
      // durably persisted rather than losing this sale's decrement or
      // rolling it back; the NEXT sale simply re-attempts reconciliation
      // from count=2, still <=3.
      check('a failed reconciliation still persists this sale\'s own decrement (3→2) rather than losing it', fakeDb.get(`${seller}|${coll}`)?.count === 2);
    }
  }

  // ── First-sight scan failure also fails closed (no row created) ────────
  {
    const seller = 'Seller5ScanFail555555555555555555555555';
    const coll   = 'Coll5ScanFail5555555555555555555555555555';
    scanResult = null;
    const failed1 = await getAndDecrementSellerHolding(seller, coll);
    check('a failed first-sight scan returns null', failed1 === null);
    check('a failed first-sight scan does not create a row', !fakeDb.has(`${seller}|${coll}`));
    scanResult = 7;
    const retried = await getAndDecrementSellerHolding(seller, coll);
    check('a later sale for the same never-seeded pair retries the scan', retried === 7);
  }

  // ── 5. Independent seller/collection keys ───────────────────────────────
  {
    const seller = 'Seller6Indep666666666666666666666666666';
    // Counts kept comfortably above the <=3 reconciliation threshold so
    // this test isolates key-independence without also exercising
    // reconciliation (covered separately above).
    scanResult = 13;
    const collA = 'Coll6IndepA6666666666666666666666666666666';
    const collB = 'Coll6IndepB6666666666666666666666666666666';
    const a1 = await getAndDecrementSellerHolding(seller, collA);
    scanResult = 20;
    const b1 = await getAndDecrementSellerHolding(seller, collB);
    const a2 = await getAndDecrementSellerHolding(seller, collA);
    check('two collections for the same seller track fully independent counters',
      a1 === 13 && b1 === 20 && a2 === 12);
  }

  // ── 6. No merkle-tree keying ─────────────────────────────────────────────
  // This module is key-agnostic — it decrements whatever (seller, collection)
  // string pair it's given. The actual guard against keying on a Bubblegum
  // merkle-tree placeholder lives one layer up, in src/server/sse.ts, where
  // `initialCollection` is computed as
  // `isMerkleTreeCollectionAddress(event) ? null : event.collectionAddress`
  // BEFORE it ever reaches this module (same guard bot-api/events.ts and
  // db/insert.ts already apply for identical reasons — see
  // isMerkleTreeCollectionAddress's doc comment in domain/sale-event-adapters.ts).
  // A cNFT sale therefore always falls through to `resolveCollectionForMint`
  // (a real per-mint DAS grouping lookup) instead of trusting the parser's
  // tree-address placeholder — verified by code review + tsc, not re-tested
  // here since it requires the full sse.ts SaleEvent pipeline (already
  // exercised for the general mechanism by bot-api.test.ts's "no
  // merkle-tree misattribution" cases).
  console.log('ℹ️  merkle-tree exclusion is enforced in sse.ts before this module is called — see comment above');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
