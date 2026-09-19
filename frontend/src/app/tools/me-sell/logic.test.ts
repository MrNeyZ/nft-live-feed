// Standalone (the frontend has no test framework) verification of the ME
// Sell page's pure state-machine logic. Compile + run via
// `npm run test:me-sell-frontend` (see package.json for the exact tsc +
// node invocation, same convention as ../resize-claim/logic.test.ts and
// ../ghostbid/logic.test.ts).

import assert from 'assert';
import {
  classifyStatus, shouldKeepPolling, reconcileUnresolved, hasBlockhashHeadroom, planPostSignBroadcast,
  retryDecision, canRebuild, uiLabel, makeGenerationGuard, solToExactLamports,
  CONFIRMATION_BUDGET_MS, BLOCKHASH_SAFETY_MARGIN_BLOCKS,
  type TxOutcome,
} from './logic';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

// ── solToExactLamports (must stay identical to the backend's copy) ───────
console.log('solToExactLamports');
check('9.065 -> 9065000000 (no float drift)', () => { assert.strictEqual(solToExactLamports(9.065), '9065000000'); });
check('4.98 -> 4980000000', () => { assert.strictEqual(solToExactLamports(4.98), '4980000000'); });
check('smallest unit: 0.000000001 -> 1', () => { assert.strictEqual(solToExactLamports(0.000000001), '1'); });

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
check('processed (seen but not yet confirmed) -> pending', () => {
  assert.strictEqual(classifyStatus({ confirmationStatus: 'processed', err: null }), 'pending');
});
check('null (RPC has no record) -> pending', () => {
  assert.strictEqual(classifyStatus(null), 'pending');
});

// ── shouldKeepPolling ─────────────────────────────────────────────────────
console.log('shouldKeepPolling');
check('within budget -> true', () => {
  assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS - 1), true);
});
check('exactly at budget -> false', () => {
  assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS), false);
});
check('budget is within the spec-required 30-45s band', () => {
  assert.ok(CONFIRMATION_BUDGET_MS >= 30_000 && CONFIRMATION_BUDGET_MS <= 45_000, `${CONFIRMATION_BUDGET_MS}ms outside 30-45s`);
});

// ── reconcileUnresolved ────────────────────────────────────────────────────
console.log('reconcileUnresolved');
const LV = 1_000;
check('confirmed err null -> still_success', () => {
  assert.strictEqual(reconcileUnresolved({ confirmationStatus: 'confirmed', err: null }, 2_000, LV), 'still_success');
});
check('confirmed err non-null -> still_failed', () => {
  assert.strictEqual(reconcileUnresolved({ confirmationStatus: 'finalized', err: { InstructionError: [0, {}] } }, 2_000, LV), 'still_failed');
});
check('entry null, blockheight still <= lastValidBlockHeight -> still_unresolved (NOT safe to retry)', () => {
  assert.strictEqual(reconcileUnresolved(null, LV, LV), 'still_unresolved');
  assert.strictEqual(reconcileUnresolved(null, LV - 100, LV), 'still_unresolved');
});
check('entry null AND blockheight PROVABLY past lastValidBlockHeight -> safe_to_rebuild', () => {
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

// ── planPostSignBroadcast ──────────────────────────────────────────────────
console.log('planPostSignBroadcast');
check('post-sign headroom < margin -> NOT sendable', () => {
  const current = 1000;
  const items = [{ lastValidBlockHeight: current + BLOCKHASH_SAFETY_MARGIN_BLOCKS - 1 }];
  assert.deepStrictEqual(planPostSignBroadcast(items, current), [false]);
});
check('post-sign headroom >= margin -> sendable', () => {
  const current = 1000;
  const items = [{ lastValidBlockHeight: current + BLOCKHASH_SAFETY_MARGIN_BLOCKS }];
  assert.deepStrictEqual(planPostSignBroadcast(items, current), [true]);
});
check('blockheight lookup failure (null) -> fails CLOSED', () => {
  const items = [{ lastValidBlockHeight: 10_000 }];
  assert.deepStrictEqual(planPostSignBroadcast(items, null), [false]);
});
check('a post-sign-stale outcome is retry-eligible only via rebuild_after_revalidate, same as any other never-sent item', () => {
  assert.strictEqual(retryDecision({ kind: 'stale_before_broadcast' }), 'rebuild_after_revalidate');
});
check('stale_before_broadcast carries no signature — structurally cannot enter exact-signature reconciliation (never reached sendRawTransaction)', () => {
  const outcome: TxOutcome = { kind: 'stale_before_broadcast' };
  assert.strictEqual('signature' in outcome, false);
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

// ── canRebuild (single-item collapse of retryDecision) ─────────────────────
console.log('canRebuild');
check('no previous attempt -> true', () => {
  assert.strictEqual(canRebuild(null), true);
});
check('previous unresolved -> false (must not double-sell while a signature might still land)', () => {
  assert.strictEqual(canRebuild({ kind: 'unresolved', signature: 's' }), false);
});
check('previous confirmed_success -> true (retryDecision says exclude_confirmed, not not_yet_retryable — Build Accept is re-enabled but a real rebuild would need a fresh Load Offer since the NFT is already sold)', () => {
  assert.strictEqual(canRebuild({ kind: 'confirmed_success', signature: 's' }), true);
});
check('previous confirmed_failure/send_failed/stale/audit_failed/simulation_failed/expired -> true', () => {
  for (const outcome of [
    { kind: 'confirmed_failure', signature: 's', err: null },
    { kind: 'send_failed', reason: 'x' },
    { kind: 'stale_before_broadcast' },
    { kind: 'audit_failed', reason: 'x' },
    { kind: 'simulation_failed', err: null },
    { kind: 'expired_no_signature_seen', signature: 's' },
  ] as TxOutcome[]) {
    assert.strictEqual(canRebuild(outcome), true, outcome.kind);
  }
});

// ── uiLabel ──────────────────────────────────────────────────────────────
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

// ── makeGenerationGuard (stale-request race guard, MS-3) ───────────────────
console.log('makeGenerationGuard');
check('a fresh guard starts with generation 1 on first bump', () => {
  const g = makeGenerationGuard();
  assert.strictEqual(g.bump(), 1);
});
check('a later bump invalidates an earlier token', () => {
  const g = makeGenerationGuard();
  const t1 = g.bump();
  const t2 = g.bump();
  assert.strictEqual(g.isCurrent(t1), false);
  assert.strictEqual(g.isCurrent(t2), true);
});
check('an out-of-order resolve (t1 resolves after t2 already bumped) is correctly detected as stale', () => {
  const g = makeGenerationGuard();
  const tOld = g.bump(); // e.g. loadInfo() call #1 starts
  const tNew = g.bump(); // operator edits the mint field and re-submits before #1 returns -> call #2 starts
  // call #2 finishes first:
  assert.strictEqual(g.isCurrent(tNew), true);
  // call #1 finishes late -> must be rejected, must not paint over call #2's result:
  assert.strictEqual(g.isCurrent(tOld), false);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
