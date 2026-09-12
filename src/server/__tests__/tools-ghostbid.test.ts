/**
 * Ghost Bid — offline test suite for the pure logic behind the audit's
 * GB-2/GB-4/GB-5 findings: profit/clamp/drain/grouping math, and the two
 * small validators (`isListId`, `isValidPubkey`) and the error-response
 * sanitizer (`toClientError`) used at the route boundary.
 *
 * No live network calls, no Express router mounted — `requireAuth`,
 * `rateLimit`, and the Helius-hitting balance/activity fetchers all live
 * outside the functions tested here (that route/RPC-integration layer is a
 * stated limitation below, not silently skipped).
 *
 * Convention matches src/mint-analyzer/__tests__/analyze.test.ts: ts-node +
 * Node's built-in `assert`, a running failure counter.
 *
 * Run: `npm run test:ghostbid`.
 */
import assert from 'assert';
import {
  isListId, isValidPubkey, toClientError, toGhostRows, computeSharedGroups,
  type BaseRow, type GhostBidRow,
} from '../tools-ghostbid';

let failures = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}

// ── fixtures ──────────────────────────────────────────────────────────────
function row(overrides: Partial<BaseRow>): BaseRow {
  return {
    mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    nft: 'Test NFT',
    image: null,
    owner: 'OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    buyer: 'BuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    offerAccount: null,
    marketplace: 'ME',
    bidSol: 10,
    floorSol: 2,
    royaltyBp: 0,
    feeBp: 0,
    lastActiveAt: null,
    sns: null, matrica: null, discord: null, twitter: null, pumpfun: null, me: null, galxe: null,
    listingStatus: null,
    ...overrides,
  };
}
function findRow(rows: GhostBidRow[], mint: string): GhostBidRow {
  const r = rows.find(x => x.mint === mint);
  if (!r) throw new Error(`fixture row ${mint} missing from output`);
  return r;
}

// ── isListId ──────────────────────────────────────────────────────────────
console.log('isListId');
check('1-8 are valid', () => { for (let i = 1; i <= 8; i++) assert.strictEqual(isListId(i), true, `list ${i}`); });
check('0 is invalid', () => { assert.strictEqual(isListId(0), false); });
check('9 is invalid', () => { assert.strictEqual(isListId(9), false); });
check('negative is invalid', () => { assert.strictEqual(isListId(-1), false); });
check('non-integer number is invalid', () => { assert.strictEqual(isListId(1.5), false); });
check('string is invalid (must be a number, not numeric string)', () => { assert.strictEqual(isListId('1' as unknown), false); });
check('NaN is invalid', () => { assert.strictEqual(isListId(NaN), false); });
check('undefined is invalid', () => { assert.strictEqual(isListId(undefined), false); });

// ── isValidPubkey ─────────────────────────────────────────────────────────
console.log('isValidPubkey');
check('valid base58 pubkey -> true', () => {
  assert.strictEqual(isValidPubkey('11111111111111111111111111111111'), true); // System Program
});
check('empty string -> false', () => { assert.strictEqual(isValidPubkey(''), false); });
check('too short -> false', () => { assert.strictEqual(isValidPubkey('abc'), false); });
check('contains invalid base58 chars (0/O/I/l) -> false', () => { assert.strictEqual(isValidPubkey('0OIl11111111111111111111111111'), false); });
check('sql-injection-shaped garbage -> false, not thrown', () => { assert.strictEqual(isValidPubkey("'; DROP TABLE--"), false); });

// ── toClientError (GB-5) ──────────────────────────────────────────────────
console.log('toClientError (GB-5 — no raw error detail to the client)');
check('Error object -> fixed generic string, message not included', () => {
  const out = toClientError(new Error('/root/nft-live-feed/data/ghostbid.json ENOENT secret-path'));
  assert.strictEqual(out, 'internal_error');
  assert.ok(!out.includes('ENOENT'));
  assert.ok(!out.includes('secret-path'));
});
check('plain string thrown -> same fixed string', () => {
  assert.strictEqual(toClientError('some internal detail'), 'internal_error');
});
check('object thrown -> same fixed string, no leakage via String() coercion', () => {
  const out = toClientError({ apiKey: 'HELIUS_SECRET_KEY_VALUE' });
  assert.strictEqual(out, 'internal_error');
  assert.ok(!out.includes('HELIUS_SECRET_KEY_VALUE'));
});
check('is deterministic (stable message the frontend/tests can rely on)', () => {
  assert.strictEqual(toClientError('a'), toClientError('b'));
});

// ── toGhostRows: profit formula ───────────────────────────────────────────
console.log('toGhostRows — profit formula');
check('net = bid * (1 - royaltyBp/10000 - feeBp/10000); profit = net - floor', () => {
  const rows = [row({ mint: 'M1', bidSol: 100, floorSol: 10, royaltyBp: 500, feeBp: 200 })]; // 5% + 2%
  const out = toGhostRows(rows, null, null);
  const net = 100 * (1 - 0.05 - 0.02); // 93
  assert.strictEqual(out[0].profitSol, Math.round((net - 10) * 1e6) / 1e6); // 83
});
check('floorSol null -> profitSol null (undetermined, not disproven)', () => {
  const rows = [row({ mint: 'M1', floorSol: null })];
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(out[0].profitSol, null);
});
check('royaltyBp+feeBp summing to 10000 -> net is exactly 0, not negative', () => {
  const rows = [row({ mint: 'M1', bidSol: 50, floorSol: 0, royaltyBp: 8000, feeBp: 2000 })];
  const out = toGhostRows(rows, null, null);
  // `===` (not strictEqual/Object.is) on purpose: net-floor can legitimately
  // land on IEEE-754 -0 here, and -0 === 0 is exactly the right notion of
  // "not negative" for this check — it renders and compares as zero
  // everywhere this value is used (fmtSol, the `> 0` gold/red color test).
  assert.ok(out[0].profitSol === 0, `expected 0 (or -0), got ${out[0].profitSol}`);
});

// ── toGhostRows: live-bid clamp + drained ─────────────────────────────────
console.log('toGhostRows — escrow clamp + drained flag');
check('liveBalances lower than bidSol -> liveBidSol clamped down, drained=true', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'BUYER1', bidSol: 100, floorSol: 1 })];
  const out = toGhostRows(rows, new Map([['BUYER1', 30]]), null);
  const r = findRow(out, 'M1');
  assert.strictEqual(r.liveBidSol, 30);
  assert.strictEqual(r.drained, true);
});
check('liveBalances >= bidSol -> liveBidSol unchanged, drained=false (never clamps upward)', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'BUYER1', bidSol: 100, floorSol: 1 })];
  const out = toGhostRows(rows, new Map([['BUYER1', 500]]), null);
  const r = findRow(out, 'M1');
  assert.strictEqual(r.liveBidSol, 100);
  assert.strictEqual(r.drained, false);
});
check('no live balance for this row\'s key -> falls back to original bidSol, drained=false', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'BUYER_UNRESOLVED', bidSol: 100, floorSol: 1 })];
  const out = toGhostRows(rows, new Map([['SOME_OTHER_BUYER', 5]]), null);
  const r = findRow(out, 'M1');
  assert.strictEqual(r.liveBidSol, 100);
  assert.strictEqual(r.drained, false);
});
check('Solanart row keys off offerAccount, not buyer', () => {
  const rows = [row({ mint: 'M1', marketplace: 'Solanart', buyer: 'IRRELEVANT', offerAccount: 'OFFER1', bidSol: 40, floorSol: 1 })];
  const out = toGhostRows(rows, new Map([['OFFER1', 15]]), null);
  const r = findRow(out, 'M1');
  assert.strictEqual(r.liveBidSol, 15);
  assert.strictEqual(r.drained, true);
});
check('static snapshot pass (liveBalances=null) never clamps or drains', () => {
  const rows = [row({ mint: 'M1', bidSol: 100, floorSol: 1 })];
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(out[0].liveBidSol, 100);
  assert.strictEqual(out[0].drained, false);
});

// ── toGhostRows: unprofitable-after-clamp filtering ───────────────────────
console.log('toGhostRows — unprofitable-row dropping (live-checked pass only)');
check('live-checked pass drops a row whose clamped profit is <= 0', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'B1', bidSol: 100, floorSol: 50 })];
  // clamp escrow down to 10 -> net=10, profit=10-50=-40 -> must be dropped
  const out = toGhostRows(rows, new Map([['B1', 10]]), null);
  assert.strictEqual(out.length, 0);
});
check('static snapshot pass (liveBalances=null) keeps unprofitable rows too — nothing has been re-checked yet', () => {
  const rows = [row({ mint: 'M1', bidSol: 1, floorSol: 50 })]; // already unprofitable even unclamped
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(out.length, 1);
});
check('profitSol == null (no floor) is always kept on a live-checked pass too', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'B1', bidSol: 100, floorSol: null })];
  const out = toGhostRows(rows, new Map([['B1', 1]]), null);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].profitSol, null);
});

// ── computeSharedGroups (via toGhostRows' sharedEscrowGroup) ─────────────
console.log('computeSharedGroups — ME buyer grouping, Solanart excluded');
check('2+ ME rows sharing one buyer -> both get sharedEscrowGroup set to that buyer', () => {
  const rows = [
    row({ mint: 'M1', marketplace: 'ME', buyer: 'SHARED', floorSol: 0 }),
    row({ mint: 'M2', marketplace: 'ME', buyer: 'SHARED', floorSol: 0 }),
  ];
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(findRow(out, 'M1').sharedEscrowGroup, 'SHARED');
  assert.strictEqual(findRow(out, 'M2').sharedEscrowGroup, 'SHARED');
});
check('1 ME row for a buyer -> sharedEscrowGroup null (no group of one)', () => {
  const rows = [row({ mint: 'M1', marketplace: 'ME', buyer: 'SOLO', floorSol: 0 })];
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(findRow(out, 'M1').sharedEscrowGroup, null);
});
check('Solanart rows are NEVER grouped, even if 2+ share the same buyer value', () => {
  const rows = [
    row({ mint: 'M1', marketplace: 'Solanart', buyer: 'SHARED', offerAccount: 'O1', floorSol: 0 }),
    row({ mint: 'M2', marketplace: 'Solanart', buyer: 'SHARED', offerAccount: 'O2', floorSol: 0 }),
  ];
  const out = toGhostRows(rows, null, null);
  assert.strictEqual(findRow(out, 'M1').sharedEscrowGroup, null);
  assert.strictEqual(findRow(out, 'M2').sharedEscrowGroup, null);
});
check('a Solanart buyer value equal to an ME buyer value does not leak Solanart into the ME group', () => {
  const rows = [
    row({ mint: 'M1', marketplace: 'ME', buyer: 'X', floorSol: 0 }),
    row({ mint: 'M2', marketplace: 'Solanart', buyer: 'X', offerAccount: 'O1', floorSol: 0 }),
  ];
  const out = toGhostRows(rows, null, null);
  // only 1 ME row for buyer X -> not a group (need 2+ ME rows specifically)
  assert.strictEqual(findRow(out, 'M1').sharedEscrowGroup, null);
  assert.strictEqual(findRow(out, 'M2').sharedEscrowGroup, null);
});
check('computeSharedGroups exported directly: counts only marketplace===ME', () => {
  const rows = [
    row({ mint: 'M1', marketplace: 'ME', buyer: 'B' }),
    row({ mint: 'M2', marketplace: 'ME', buyer: 'B' }),
    row({ mint: 'M3', marketplace: 'Solanart', buyer: 'B', offerAccount: 'O' }),
  ];
  const groups = computeSharedGroups(rows);
  assert.strictEqual(groups.get('B'), 'B');
  assert.strictEqual(groups.size, 1);
});

// ── ranking ───────────────────────────────────────────────────────────────
console.log('toGhostRows — sort order');
check('rows sorted by profitSol descending, nulls last', () => {
  const rows = [
    row({ mint: 'LOW', bidSol: 10, floorSol: 5 }),   // profit 5
    row({ mint: 'HIGH', bidSol: 100, floorSol: 5 }), // profit 95
    row({ mint: 'NOFLOOR', floorSol: null }),
  ];
  const out = toGhostRows(rows, null, null);
  assert.deepStrictEqual(out.map(r => r.mint), ['HIGH', 'LOW', 'NOFLOOR']);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
