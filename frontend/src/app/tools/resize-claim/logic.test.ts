// Standalone (the frontend has no test framework) verification of the
// Resize Claim page's pure state-machine logic. Compile + run via
// `npm run test:resize-claim-frontend` (see package.json for the exact
// tsc + node invocation, same convention as ../candy-mint/logic.test.ts and
// ../ghostbid/logic.test.ts).

import assert from 'assert';
import {
  classifyStatus, shouldKeepPolling, reconcileUnresolved, hasBlockhashHeadroom, planPostSignBroadcast,
  retryDecision, planRetry, uiLabel, CONFIRMATION_BUDGET_MS, BLOCKHASH_SAFETY_MARGIN_BLOCKS,
  type TxOutcome,
} from './logic';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

// ── classifyStatus ────────────────────────────────────────────────────────
console.log('classifyStatus');
check('confirmed + err null -> success', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'confirmed', err: null }), 'success');
});
check('finalized + err null -> success', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'finalized', err: null }), 'success');
});
check('confirmed + err non-null -> failed', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 18 }] } }), 'failed');
});
check('finalized + err non-null -> failed', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 201 }] } }), 'failed');
});
check('processed (seen but not yet confirmed) -> pending', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'processed', err: null }), 'pending');
});
check('null (RPC has no record) -> pending', () => {
  assert.strictEqual(classifyStatus(null), 'pending');
});
check('confirmationStatus null but entry present (defensive) -> pending', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: null, err: null }), 'pending');
});

// ── shouldKeepPolling ─────────────────────────────────────────────────────
console.log('shouldKeepPolling');
check('within budget -> true', () => {
  assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS - 1), true);
});
check('exactly at budget -> false', () => {
  assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS), false);
});
check('well past budget -> false', () => {
  assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS + 60_000), false);
});
check('budget is within the spec-required 30-45s band', () => {
  assert.ok(CONFIRMATION_BUDGET_MS >= 30_000 && CONFIRMATION_BUDGET_MS <= 45_000, `${CONFIRMATION_BUDGET_MS}ms outside 30-45s`);
});

// ── reconcileUnresolved (spec §3 A/B/C/D + blockheight-lookup-failure) ────
console.log('reconcileUnresolved');
const LV = 1_000;
check('A: confirmed err null -> still_success', () => {
  assert.strictEqual(reconcileUnresolved({ confirmationStatus: 'confirmed', err: null }, 2_000, LV), 'still_success');
});
check('B: confirmed err non-null -> still_failed', () => {
  assert.strictEqual(reconcileUnresolved({ confirmationStatus: 'finalized', err: { InstructionError: [0, {}] } }, 2_000, LV), 'still_failed');
});
check('C: entry null, blockheight still <= lastValidBlockHeight -> still_unresolved (NOT safe to retry)', () => {
  assert.strictEqual(reconcileUnresolved(null, LV, LV), 'still_unresolved');
  assert.strictEqual(reconcileUnresolved(null, LV - 100, LV), 'still_unresolved');
});
check('D: entry null AND blockheight PROVABLY past lastValidBlockHeight -> safe_to_rebuild', () => {
  assert.strictEqual(reconcileUnresolved(null, LV + 1, LV), 'safe_to_rebuild');
});
check('processed (seen), even with an expired blockheight, is NEVER safe_to_rebuild — it was seen, so it might still land', () => {
  assert.strictEqual(reconcileUnresolved({ confirmationStatus: 'processed', err: null }, LV + 500, LV), 'still_unresolved');
});
check('blockheight lookup failure (null) fails CLOSED regardless of how stale the blockhash looks', () => {
  assert.strictEqual(reconcileUnresolved(null, null, LV), 'still_unresolved');
  assert.notStrictEqual(reconcileUnresolved(null, null, LV), 'safe_to_rebuild');
});

// ── hasBlockhashHeadroom ──────────────────────────────────────────────────
console.log('hasBlockhashHeadroom');
check('plenty of headroom -> true', () => {
  assert.strictEqual(hasBlockhashHeadroom(1000, 800), true);
});
check('exactly at the margin -> true (>=, not >)', () => {
  assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS, 1000), true);
});
check('one block short of the margin -> false', () => {
  assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS - 1, 1000), false);
});
check('already past lastValidBlockHeight -> false', () => {
  assert.strictEqual(hasBlockhashHeadroom(900, 1000), false);
});

// ── planPostSignBroadcast (post-sign blockhash-lifecycle fix) ────────────
console.log('planPostSignBroadcast');

check('A: pre-sign fresh, post-sign headroom < 18 -> NOT sendable (stale_before_broadcast territory)', () => {
  const current = 1000;
  const items = [{ lastValidBlockHeight: current + BLOCKHASH_SAFETY_MARGIN_BLOCKS - 1 }]; // 17 remaining
  assert.deepStrictEqual(planPostSignBroadcast(items, current), [false]);
});

check('B: post-sign headroom >= 18 -> sendable', () => {
  const current = 1000;
  const items = [{ lastValidBlockHeight: current + BLOCKHASH_SAFETY_MARGIN_BLOCKS }]; // exactly 18
  assert.deepStrictEqual(planPostSignBroadcast(items, current), [true]);
});

check('C: mixed batch — tx1 headroom 21, tx2 headroom 17, tx3 headroom 25 -> [true, false, true], order preserved, none shifted', () => {
  const current = 1000;
  const items = [
    { lastValidBlockHeight: current + 21 },
    { lastValidBlockHeight: current + 17 },
    { lastValidBlockHeight: current + 25 },
  ];
  assert.deepStrictEqual(planPostSignBroadcast(items, current), [true, false, true]);
});

check('D: blockheight lookup failure (null) -> fails CLOSED, every item in the batch becomes non-sendable', () => {
  const items = [
    { lastValidBlockHeight: 10_000 }, // would be plenty fresh if height were known
    { lastValidBlockHeight: 20 },     // would already be stale regardless
  ];
  assert.deepStrictEqual(planPostSignBroadcast(items, null), [false, false]);
});

check('result length/order always mirrors input length/order exactly (safe to zip against a parallel signed[]/stillFresh[] array)', () => {
  const items = Array.from({ length: 5 }, (_, k) => ({ lastValidBlockHeight: 1000 + k }));
  const out = planPostSignBroadcast(items, 990);
  assert.strictEqual(out.length, items.length);
});

check('E: a post-sign-stale (stale_before_broadcast) item is retry-eligible only via the existing revalidate-then-rebuild path, same as any other never-sent item', () => {
  assert.strictEqual(retryDecision({ kind: 'stale_before_broadcast' }), 'rebuild_after_revalidate');
});

check('F: stale_before_broadcast carries no signature — structurally cannot enter exact-signature reconciliation (never reached sendTransaction)', () => {
  const outcome: TxOutcome = { kind: 'stale_before_broadcast' };
  assert.strictEqual('signature' in outcome, false);
  // uiLabel must not imply anything was submitted:
  assert.strictEqual(uiLabel(outcome), 'Not sent (blockhash went stale)');
});

// ── retryDecision (exhaustive over TxOutcome kinds) ───────────────────────
console.log('retryDecision');
check('confirmed_success -> exclude_confirmed', () => {
  assert.strictEqual(retryDecision({ kind: 'confirmed_success', signature: 's' }), 'exclude_confirmed');
});
check('unresolved -> not_yet_retryable', () => {
  assert.strictEqual(retryDecision({ kind: 'unresolved', signature: 's' }), 'not_yet_retryable');
});
for (const outcome of [
  { kind: 'audit_failed', reason: 'x' },
  { kind: 'simulation_failed', err: null },
  { kind: 'stale_before_broadcast' },
  { kind: 'send_failed', reason: 'x' },
  { kind: 'confirmed_failure', signature: 's', err: null },
  { kind: 'expired_no_signature_seen', signature: 's' },
] as TxOutcome[]) {
  check(`${outcome.kind} -> rebuild_after_revalidate`, () => {
    assert.strictEqual(retryDecision(outcome), 'rebuild_after_revalidate');
  });
}

// ── planRetry (spec §18 batch scenarios) ──────────────────────────────────
console.log('planRetry');

check('scenario: tx1 confirmed, tx2 send-failed, tx3 unresolved — none silently lost, each bucketed correctly', () => {
  // Models: "tx1 submitted + confirmed / tx2 send throws before signature /
  // tx3 already signed but (per this app's continue-independently policy,
  // see page.tsx) still gets its own send attempt and its own outcome" —
  // the data-model guarantee this proves is that three DISTINCT tracked
  // outcomes survive intact side by side; page.tsx's broadcast loop itself
  // (never aborting early on one item's failure) is verified by code
  // reading, not unit-testable without a browser harness.
  const plan = planRetry([
    { mints: ['A'], outcome: { kind: 'confirmed_success', signature: 'sigA' } },
    { mints: ['B'], outcome: { kind: 'send_failed', reason: 'network blip' } },
    { mints: ['C'], outcome: { kind: 'unresolved', signature: 'sigC' } },
  ]);
  assert.deepStrictEqual([...plan.confirmedMints], ['A']);
  assert.deepStrictEqual([...plan.retryCandidateMints], ['B']);
  assert.deepStrictEqual([...plan.blockedMints], ['C']);
});

check('scenario: tx1 submitted unknown -> retry does NOT rebuild tx1', () => {
  const plan = planRetry([{ mints: ['A'], outcome: { kind: 'unresolved', signature: 'sig1' } }]);
  assert.strictEqual(plan.retryCandidateMints.has('A'), false);
  assert.strictEqual(plan.blockedMints.has('A'), true);
});

check('scenario: tx1 confirmed success -> retry excludes it permanently', () => {
  const plan = planRetry([{ mints: ['A'], outcome: { kind: 'confirmed_success', signature: 'sig1' } }]);
  assert.strictEqual(plan.confirmedMints.has('A'), true);
  assert.strictEqual(plan.retryCandidateMints.has('A'), false);
  assert.strictEqual(plan.blockedMints.has('A'), false);
});

check('scenario: tx1 confirmed failure -> candidate for rebuild (revalidation itself happens at the network/page level, not here)', () => {
  const plan = planRetry([{ mints: ['A'], outcome: { kind: 'confirmed_failure', signature: 'sig1', err: { InstructionError: [0, { Custom: 18 }] } } }]);
  assert.strictEqual(plan.retryCandidateMints.has('A'), true);
});

check('scenario: partial claim batch + resize batch keep fully independent outcomes (no cross-contamination)', () => {
  const plan = planRetry([
    { mints: ['CLAIM_MINT_1'], outcome: { kind: 'confirmed_success', signature: 's1' } },
    { mints: ['RESIZE_MINT_1', 'RESIZE_MINT_2'], outcome: { kind: 'send_failed', reason: 'x' } },
  ]);
  assert.strictEqual(plan.confirmedMints.has('CLAIM_MINT_1'), true);
  assert.strictEqual(plan.retryCandidateMints.has('RESIZE_MINT_1'), true);
  assert.strictEqual(plan.retryCandidateMints.has('RESIZE_MINT_2'), true);
  assert.strictEqual(plan.retryCandidateMints.has('CLAIM_MINT_1'), false);
  assert.strictEqual(plan.confirmedMints.has('RESIZE_MINT_1'), false);
});

check('a resize tx outcome applies to ALL its packed mints uniformly (one atomic transaction)', () => {
  const plan = planRetry([{ mints: ['X', 'Y', 'Z'], outcome: { kind: 'confirmed_success', signature: 's' } }]);
  assert.deepStrictEqual([...plan.confirmedMints].sort(), ['X', 'Y', 'Z']);
});

// ── uiLabel (§14 UI truthfulness) ─────────────────────────────────────────
console.log('uiLabel');
check('unresolved is NEVER labeled Failed', () => {
  assert.notStrictEqual(uiLabel({ kind: 'unresolved', signature: 's' }), 'Failed');
});
check('a bare submitted signature is never reachable as "Confirmed" — only confirmed_success is', () => {
  assert.strictEqual(uiLabel({ kind: 'confirmed_success', signature: 's' }), 'Confirmed');
  assert.notStrictEqual(uiLabel({ kind: 'unresolved', signature: 's' }), 'Confirmed');
});
check('confirmed_failure -> Failed', () => {
  assert.strictEqual(uiLabel({ kind: 'confirmed_failure', signature: 's', err: null }), 'Failed');
});
check('every TxOutcome kind maps to a distinct, non-empty label', () => {
  const outcomes: TxOutcome[] = [
    { kind: 'audit_failed', reason: 'x' },
    { kind: 'simulation_failed', err: null },
    { kind: 'stale_before_broadcast' },
    { kind: 'send_failed', reason: 'x' },
    { kind: 'unresolved', signature: 's' },
    { kind: 'confirmed_success', signature: 's' },
    { kind: 'confirmed_failure', signature: 's', err: null },
    { kind: 'expired_no_signature_seen', signature: 's' },
  ];
  const labels = outcomes.map(uiLabel);
  assert.strictEqual(new Set(labels).size, labels.length, 'expected all distinct labels');
  for (const l of labels) assert.ok(l.length > 0);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
