// Standalone (the frontend has no test framework) verification of the Candy
// Mint correctness-pass logic. Compile + run:
//   npx tsc src/app/tools/candy-mint/logic.ts src/app/tools/candy-mint/logic.test.ts \
//     --outDir /tmp/cm --module commonjs --target es2020 --esModuleInterop \
//     --strict --skipLibCheck && node /tmp/cm/logic.test.js

import assert from 'assert';
import {
  classifyConfirmation,
  outcomeFromPolls,
  normalizeMintErr,
  pickInitialGroup,
  inspectDisabled,
  formatTokenAmount,
  buildPriceLabel,
  tokenCostLabel,
  shortMint,
  runBounded,
  partitionRebuildResults,
  hasBlockhashHeadroom,
  BLOCKHASH_SAFETY_MARGIN_BLOCKS,
  retryOnce,
  CONFIRMATION_BUDGET_MS,
  CONFIRMATION_POLL_INTERVAL_MS,
  shouldKeepPolling,
  classifyReconcile,
  reconcileAllowsRebuild,
  hasUnresolvedTxns,
  foldReconcileResults,
  type ConfirmClass,
  type RebuildOutcome,
  type ReconcileDisposition,
  type UnresolvedTx,
  type OneReconcileResult,
} from './logic';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}
async function checkAsync(label: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

// ── classifyConfirmation ──────────────────────────────────────────────────
console.log('classifyConfirmation');
check('confirmed + err null -> success', () => {
  assert.strictEqual(classifyConfirmation({ ok: true, found: true, confirmationStatus: 'confirmed', err: null }), 'success');
});
check('finalized + err null -> success', () => {
  assert.strictEqual(classifyConfirmation({ ok: true, found: true, confirmationStatus: 'finalized', err: null }), 'success');
});
check('confirmed + err non-null -> failed', () => {
  assert.strictEqual(
    classifyConfirmation({ ok: true, found: true, confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6024 }] } }),
    'failed',
  );
});
check('finalized + err non-null -> failed', () => {
  assert.strictEqual(
    classifyConfirmation({ ok: true, found: true, confirmationStatus: 'finalized', err: { InstructionError: [0, 'ProgramFailedToComplete'] } }),
    'failed',
  );
});
check('processed (not yet confirmed) -> pending', () => {
  assert.strictEqual(classifyConfirmation({ ok: true, found: true, confirmationStatus: 'processed', err: null }), 'pending');
});
check('found=false -> pending', () => {
  assert.strictEqual(classifyConfirmation({ ok: true, found: false, confirmationStatus: null, err: null }), 'pending');
});
check('null / RPC miss -> pending', () => {
  assert.strictEqual(classifyConfirmation(null), 'pending');
  assert.strictEqual(classifyConfirmation(undefined), 'pending');
  assert.strictEqual(classifyConfirmation({ ok: false }), 'pending');
});
check('err = 0 (falsy but present) still fails — only null/undefined pass', () => {
  // Solana never emits err:0, but the guard is `== null` so 0 would be treated
  // as an error, not a success. Lock that in.
  assert.strictEqual(classifyConfirmation({ ok: true, found: true, confirmationStatus: 'confirmed', err: 0 }), 'failed');
});

// ── outcomeFromPolls (timeout / unknown contract) ─────────────────────────
console.log('outcomeFromPolls');
check('all pending -> unknown (timeout)', () => {
  assert.strictEqual(outcomeFromPolls(['pending', 'pending', 'pending']), 'unknown');
});
check('empty poll list -> unknown', () => {
  assert.strictEqual(outcomeFromPolls([]), 'unknown');
});
check('first terminal wins: pending, success -> success', () => {
  assert.strictEqual(outcomeFromPolls(['pending', 'success']), 'success');
});
check('first terminal wins: pending, failed -> failed', () => {
  assert.strictEqual(outcomeFromPolls(['pending', 'failed', 'success'] as ConfirmClass[]), 'failed');
});

// ── normalizeMintErr ─────────────────────────────────────────────────────
console.log('normalizeMintErr');
check('null -> generic', () => {
  assert.ok(/failed on-chain/i.test(normalizeMintErr(null)));
});
check('6024 -> stage ended', () => {
  assert.ok(/ended/i.test(normalizeMintErr({ InstructionError: [1, { Custom: 6024 }] })));
});
check('6023 -> not live yet', () => {
  assert.ok(/not live/i.test(normalizeMintErr({ InstructionError: [1, { Custom: 6023 }] })));
});
check('unknown err -> truncated dump, no throw', () => {
  const out = normalizeMintErr({ InstructionError: [3, { Custom: 1770 }] });
  assert.ok(out.length > 0 && out.length < 220);
});

// ── pickInitialGroup ─────────────────────────────────────────────────────
console.log('pickInitialGroup');
check('no groups -> undefined', () => {
  assert.strictEqual(pickInitialGroup([]), undefined);
});
check('1 supported group -> that group', () => {
  assert.strictEqual(pickInitialGroup([{ label: 'public', supported: true }]), 'public');
});
check('1 unsupported group -> still that group (so the reason renders)', () => {
  assert.strictEqual(pickInitialGroup([{ label: 'wl', supported: false }]), 'wl');
});
check('1 unsupported root group -> null (root is selectable)', () => {
  assert.strictEqual(pickInitialGroup([{ label: null, supported: false }]), null);
});
check('multi, one supported -> first supported', () => {
  assert.strictEqual(
    pickInitialGroup([{ label: 'wl', supported: false }, { label: 'public', supported: true }]),
    'public',
  );
});
check('multi, first is supported -> it', () => {
  assert.strictEqual(
    pickInitialGroup([{ label: 'a', supported: true }, { label: 'b', supported: true }]),
    'a',
  );
});
check('multi, none supported -> first group (reason still shown)', () => {
  assert.strictEqual(
    pickInitialGroup([{ label: 'wl1', supported: false }, { label: 'wl2', supported: false }]),
    'wl1',
  );
});

// ── inspectDisabled ──────────────────────────────────────────────────────
console.log('inspectDisabled');
check('busy + text -> disabled', () => { assert.strictEqual(inspectDisabled(true, 'abc'), true); });
check('idle + empty -> disabled', () => { assert.strictEqual(inspectDisabled(false, ''), true); });
check('idle + whitespace only -> disabled', () => { assert.strictEqual(inspectDisabled(false, '   \n'), true); });
check('idle + text -> enabled', () => { assert.strictEqual(inspectDisabled(false, ' sig '), false); });
check('busy + empty -> disabled', () => { assert.strictEqual(inspectDisabled(true, ''), true); });

// ── formatTokenAmount ────────────────────────────────────────────────────
console.log('formatTokenAmount');
check('1e6 raw, 6 dp -> 1', () => { assert.strictEqual(formatTokenAmount('1000000', 6), '1'); });
check('1.5e6 raw, 6 dp -> 1.5', () => { assert.strictEqual(formatTokenAmount('1500000', 6), '1.5'); });
check('sub-unit 500 raw, 6 dp -> 0.0005', () => { assert.strictEqual(formatTokenAmount('500', 6), '0.0005'); });
check('0 raw -> 0', () => { assert.strictEqual(formatTokenAmount('0', 6), '0'); });
check('0 dp -> integer unchanged', () => { assert.strictEqual(formatTokenAmount('123', 0), '123'); });
check('unresolved decimals (null) -> raw integer', () => { assert.strictEqual(formatTokenAmount('123456789', null), '123456789'); });
check('trailing zeros trimmed', () => { assert.strictEqual(formatTokenAmount('1200000', 6), '1.2'); });
check('big u64 keeps precision (no float)', () => {
  assert.strictEqual(formatTokenAmount('18446744073709551615', 0), '18446744073709551615');
});

// ── buildPriceLabel ──────────────────────────────────────────────────────
console.log('buildPriceLabel');
check('sol only', () => { assert.strictEqual(buildPriceLabel('50000000', null), '0.050 SOL'); });
check('free mint -> 0 SOL', () => { assert.strictEqual(buildPriceLabel('0', null), '0 SOL'); });
check('token only -> not dropped', () => {
  assert.strictEqual(
    buildPriceLabel(null, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '5000000', decimals: 6 }),
    '5 EPjF…Dt1v',
  );
});
check('sol + token joined', () => {
  const out = buildPriceLabel('10000000', { mint: 'So11111111111111111111111111111111111111112', amount: '250', decimals: 2 });
  assert.strictEqual(out, '0.010 SOL + 2.5 So11…1112');
});
check('no payment at all -> null', () => { assert.strictEqual(buildPriceLabel(null, null), null); });
check('token, unresolved decimals -> raw amount + short mint', () => {
  assert.strictEqual(
    buildPriceLabel(null, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '5000000', decimals: null }),
    '5000000 EPjF…Dt1v',
  );
});

// ── tokenCostLabel (pre-signature token leg) ─────────────────────────────
console.log('tokenCostLabel');
check('null payment -> null', () => { assert.strictEqual(tokenCostLabel(null), null); });
check('resolved -> amount + short mint', () => {
  assert.strictEqual(
    tokenCostLabel({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1500000', decimals: 6 }),
    '1.5 EPjF…Dt1v',
  );
});
check('unresolved decimals -> raw amount + short mint', () => {
  assert.strictEqual(
    tokenCostLabel({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1500000', decimals: null }),
    '1500000 EPjF…Dt1v',
  );
});

// ── shortMint ───────────────────────────────────────────────────────────
console.log('shortMint');
check('long mint truncated', () => {
  assert.strictEqual(shortMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'EPjF…Dt1v');
});
check('short string untouched', () => { assert.strictEqual(shortMint('abc'), 'abc'); });

// ── runBounded (rebuild-wave concurrency) ─────────────────────────────────
async function runBoundedChecks() {
  console.log('runBounded');
  await checkAsync('preserves result order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1, 15];
    const out = await runBounded(delays, 3, async (ms, idx) => {
      await new Promise((r) => setTimeout(r, ms));
      return idx;
    });
    assert.deepStrictEqual(out, [0, 1, 2, 3, 4]);
  });
  await checkAsync('respects the concurrency cap', async () => {
    let inFlight = 0; let maxInFlight = 0;
    await runBounded(Array.from({ length: 12 }, (_, i) => i), 4, async (i) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    assert.ok(maxInFlight <= 4, `maxInFlight=${maxInFlight} exceeded cap of 4`);
  });
  await checkAsync('limit >= length runs everything (effectively full parallel)', async () => {
    let maxInFlight = 0; let inFlight = 0;
    const out = await runBounded([1, 2, 3], 100, async (n) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    assert.deepStrictEqual(out, [2, 4, 6]);
    assert.strictEqual(maxInFlight, 3);
  });
  await checkAsync('limit=1 runs strictly sequentially', async () => {
    let concurrent = 0; let sawOverlap = false;
    await runBounded([1, 2, 3, 4], 1, async (n) => {
      concurrent++; if (concurrent > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 2));
      concurrent--;
      return n;
    });
    assert.strictEqual(sawOverlap, false);
  });
  await checkAsync('empty input resolves to empty output', async () => {
    const out = await runBounded([], 5, async (n) => n);
    assert.deepStrictEqual(out, []);
  });
}

// ── partitionRebuildResults (rebuild item mapping + mint identity) ───────
function partitionChecks() {
  console.log('partitionRebuildResults');
  check('all succeed: signable list matches readyIndexes order, mint per item preserved', () => {
    const readyIndexes = [2, 5, 7];
    const outcomes: RebuildOutcome[] = [
      { itemIndex: 5, ok: true, transactionBase64: 'tx5', mint: 'MINT5', lastValidBlockHeight: 100 },
      { itemIndex: 2, ok: true, transactionBase64: 'tx2', mint: 'MINT2', lastValidBlockHeight: 100 },
      { itemIndex: 7, ok: true, transactionBase64: 'tx7', mint: 'MINT7', lastValidBlockHeight: 100 },
    ];
    const { signableItemIndexes, signableTxs, failed } = partitionRebuildResults(readyIndexes, outcomes);
    assert.deepStrictEqual(signableItemIndexes, [2, 5, 7]); // original submission order, not outcome order
    assert.deepStrictEqual(signableTxs, ['tx2', 'tx5', 'tx7']); // txs line up positionally with signableItemIndexes
    assert.strictEqual(failed.length, 0);
    // each position's tx corresponds to the outcome carrying ITS OWN mint —
    // never a different item's, never phase 1's (which never enters this fn)
    const byIndex = new Map(outcomes.map((o) => [o.itemIndex, o]));
    signableItemIndexes.forEach((itemIndex, pos) => {
      assert.strictEqual(signableTxs[pos], byIndex.get(itemIndex)!.transactionBase64);
    });
  });
  check('mixed success/failure: failed items excluded from signable, present in failed', () => {
    const readyIndexes = [0, 1, 2];
    const outcomes: RebuildOutcome[] = [
      { itemIndex: 0, ok: true, transactionBase64: 'tx0', mint: 'MINT0', lastValidBlockHeight: 50 },
      { itemIndex: 1, ok: false, error: 'candy_machine_closed' },
      { itemIndex: 2, ok: true, transactionBase64: 'tx2', mint: 'MINT2', lastValidBlockHeight: 50 },
    ];
    const { signableItemIndexes, signableTxs, failed } = partitionRebuildResults(readyIndexes, outcomes);
    assert.deepStrictEqual(signableItemIndexes, [0, 2]);
    assert.deepStrictEqual(signableTxs, ['tx0', 'tx2']);
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].itemIndex, 1);
  });
  check('ok:true with no transactionBase64 is treated as failed (defensive)', () => {
    const outcomes: RebuildOutcome[] = [{ itemIndex: 3, ok: true }];
    const { signableItemIndexes, failed } = partitionRebuildResults([3], outcomes);
    assert.deepStrictEqual(signableItemIndexes, []);
    assert.strictEqual(failed.length, 1);
  });
  check('missing outcome for a ready index (should not happen, but is handled) is silently dropped from both lists', () => {
    const { signableItemIndexes, failed } = partitionRebuildResults([0, 1], [{ itemIndex: 0, ok: true, transactionBase64: 'tx0' }]);
    assert.deepStrictEqual(signableItemIndexes, [0]);
    assert.strictEqual(failed.length, 0); // index 1 has no outcome at all — neither signable nor failed
  });
}

// ── hasBlockhashHeadroom (post-sign guard: sufficient vs insufficient) ───
function headroomChecks() {
  console.log('hasBlockhashHeadroom');
  check('plenty of headroom -> true', () => {
    assert.strictEqual(hasBlockhashHeadroom(1000, 800, BLOCKHASH_SAFETY_MARGIN_BLOCKS), true);
  });
  check('exactly at the margin -> true (>=, not >)', () => {
    assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS, 1000, BLOCKHASH_SAFETY_MARGIN_BLOCKS), true);
  });
  check('one block short of the margin -> false', () => {
    assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS - 1, 1000, BLOCKHASH_SAFETY_MARGIN_BLOCKS), false);
  });
  check('already past lastValidBlockHeight -> false', () => {
    assert.strictEqual(hasBlockhashHeadroom(900, 1000, BLOCKHASH_SAFETY_MARGIN_BLOCKS), false);
  });
  check('default margin applies when omitted', () => {
    assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS, 1000), true);
    assert.strictEqual(hasBlockhashHeadroom(1000 + BLOCKHASH_SAFETY_MARGIN_BLOCKS - 1, 1000), false);
  });
  check('partial batch: mixed headroom across a batch skips only the short ones', () => {
    const currentHeight = 1000;
    const items = [
      { itemIndex: 0, lastValidBlockHeight: 1030 }, // 30 headroom -> send
      { itemIndex: 1, lastValidBlockHeight: 1010 }, // 10 headroom -> skip
      { itemIndex: 2, lastValidBlockHeight: 1025 }, // 25 headroom -> send
      { itemIndex: 3, lastValidBlockHeight: 995 },  // already past -> skip
    ];
    const decisions = items.map((it) => ({ itemIndex: it.itemIndex, send: hasBlockhashHeadroom(it.lastValidBlockHeight, currentHeight) }));
    assert.deepStrictEqual(decisions, [
      { itemIndex: 0, send: true },
      { itemIndex: 1, send: false },
      { itemIndex: 2, send: true },
      { itemIndex: 3, send: false },
    ]);
  });
}

// ── retryOnce (block-height guard's retry-after-one-blip contract) ───────
async function retryOnceChecks() {
  console.log('retryOnce');
  await checkAsync('first attempt succeeds -> no second call, no delay paid', async () => {
    let calls = 0;
    const t0 = Date.now();
    const out = await retryOnce(async () => { calls++; return 42; }, 300);
    assert.strictEqual(out, 42);
    assert.strictEqual(calls, 1);
    assert.ok(Date.now() - t0 < 100, 'should not have waited for the retry delay');
  });
  await checkAsync('first null, second succeeds -> exactly 2 calls, first non-null wins', async () => {
    let calls = 0;
    const out = await retryOnce(async () => { calls++; return calls === 1 ? null : 7; }, 10);
    assert.strictEqual(out, 7);
    assert.strictEqual(calls, 2);
  });
  await checkAsync('both null -> null, exactly 2 calls (not more)', async () => {
    let calls = 0;
    const out = await retryOnce(async () => { calls++; return null; }, 10);
    assert.strictEqual(out, null);
    assert.strictEqual(calls, 2);
  });
  await checkAsync('both throw -> null, not rejected (caller need not try/catch)', async () => {
    let calls = 0;
    const out = await retryOnce(async () => { calls++; throw new Error('boom'); }, 10);
    assert.strictEqual(out, null);
    assert.strictEqual(calls, 2);
  });
  await checkAsync('first throws, second succeeds -> recovers', async () => {
    let calls = 0;
    const out = await retryOnce(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 99;
    }, 10);
    assert.strictEqual(out, 99);
    assert.strictEqual(calls, 2);
  });
  await checkAsync('actually waits ~delayMs between attempts (not immediate)', async () => {
    const t0 = Date.now();
    await retryOnce(async () => null, 120);
    assert.ok(Date.now() - t0 >= 110, `expected >=110ms elapsed, got ${Date.now() - t0}ms`);
  });
}

// ── confirmation polling budget (M3) — must not silently regress ─────────
function confirmationBudgetChecks() {
  console.log('confirmation budget (M3)');
  check('budget is ~30-45s (not the accidental ~4s ceiling)', () => {
    assert.ok(CONFIRMATION_BUDGET_MS >= 30_000 && CONFIRMATION_BUDGET_MS <= 45_000,
      `CONFIRMATION_BUDGET_MS=${CONFIRMATION_BUDGET_MS} outside 30_000..45_000`);
  });
  check('poll interval is brisk (300-750ms)', () => {
    assert.ok(CONFIRMATION_POLL_INTERVAL_MS >= 300 && CONFIRMATION_POLL_INTERVAL_MS <= 750);
  });
  check('shouldKeepPolling true while within budget', () => {
    assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS - 1), true);
  });
  check('shouldKeepPolling false once budget elapsed', () => {
    assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS), false);
    assert.strictEqual(shouldKeepPolling(1_000, 1_000 + CONFIRMATION_BUDGET_MS + 5_000), false);
  });
  check('a timeout is NOT a failure — outcomeFromPolls(all pending) is still unknown', () => {
    assert.strictEqual(outcomeFromPolls(['pending', 'pending', 'pending', 'pending']), 'unknown');
  });
}

// ── exact-signature reconciliation state machine (H2) ───────────────────
function reconcileChecks() {
  console.log('classifyReconcile (H2 A/B/C/D/E)');
  const LV = 1000;
  check('A: landed ok -> landed_ok', () => {
    assert.strictEqual(classifyReconcile({ statusClass: 'success', currentBlockHeight: 900, lastValidBlockHeight: LV }), 'landed_ok');
  });
  check('B: landed with err -> landed_failed', () => {
    assert.strictEqual(classifyReconcile({ statusClass: 'failed', currentBlockHeight: 1200, lastValidBlockHeight: LV }), 'landed_failed');
  });
  check('C: not landed, height <= lastValid -> still_valid_ambiguous (DO NOT rebuild)', () => {
    assert.strictEqual(classifyReconcile({ statusClass: 'pending', currentBlockHeight: LV, lastValidBlockHeight: LV }), 'still_valid_ambiguous');
    assert.strictEqual(classifyReconcile({ statusClass: 'pending', currentBlockHeight: LV - 50, lastValidBlockHeight: LV }), 'still_valid_ambiguous');
  });
  check('D: not landed, height > lastValid -> expired_safe_to_retry', () => {
    assert.strictEqual(classifyReconcile({ statusClass: 'pending', currentBlockHeight: LV + 1, lastValidBlockHeight: LV }), 'expired_safe_to_retry');
  });
  check('E: block-height read failed -> unresolved_blockheight_unknown (fail closed)', () => {
    assert.strictEqual(classifyReconcile({ statusClass: 'pending', currentBlockHeight: null, lastValidBlockHeight: LV }), 'unresolved_blockheight_unknown');
  });
  check('E takes priority over C/D — a null height NEVER resolves to expired', () => {
    // even if we "think" it might be expired, without a height we cannot prove it
    assert.notStrictEqual(classifyReconcile({ statusClass: 'pending', currentBlockHeight: null, lastValidBlockHeight: 1 }), 'expired_safe_to_retry');
  });

  console.log('reconcileAllowsRebuild');
  const rebuildOk: ReconcileDisposition[] = ['landed_failed', 'expired_safe_to_retry'];
  const rebuildNo: ReconcileDisposition[] = ['landed_ok', 'still_valid_ambiguous', 'unresolved_blockheight_unknown'];
  for (const d of rebuildOk) check(`${d} -> rebuild allowed`, () => assert.strictEqual(reconcileAllowsRebuild(d), true));
  for (const d of rebuildNo) check(`${d} -> rebuild NOT allowed`, () => assert.strictEqual(reconcileAllowsRebuild(d), false));

  console.log('hasUnresolvedTxns (duplicate-prevention gate)');
  const u: UnresolvedTx = { signature: 'S', lastValidBlockHeight: 1, asset: 'A', family: 'core' };
  check('an item with an unresolved record -> gate closed', () => {
    assert.strictEqual(hasUnresolvedTxns([{ unresolved: u }, { unresolved: null }]), true);
  });
  check('no unresolved records -> gate open', () => {
    assert.strictEqual(hasUnresolvedTxns([{ unresolved: null }, {}]), false);
  });
  check('empty -> gate open', () => {
    assert.strictEqual(hasUnresolvedTxns([]), false);
  });

  // The concrete duplicate scenario the audit calls out:
  check('unknown-before-expiry: gate stays closed, rebuild refused', () => {
    const disp = classifyReconcile({ statusClass: 'pending', currentBlockHeight: 999, lastValidBlockHeight: 1000 });
    assert.strictEqual(disp, 'still_valid_ambiguous');
    assert.strictEqual(reconcileAllowsRebuild(disp), false);
  });
  check('unknown-after-expiry: gate opens, rebuild allowed', () => {
    const disp = classifyReconcile({ statusClass: 'pending', currentBlockHeight: 1001, lastValidBlockHeight: 1000 });
    assert.strictEqual(disp, 'expired_safe_to_retry');
    assert.strictEqual(reconcileAllowsRebuild(disp), true);
  });
  check('blockHeight read failure keeps gate closed even long past lastValid', () => {
    const disp = classifyReconcile({ statusClass: 'pending', currentBlockHeight: null, lastValidBlockHeight: 1000 });
    assert.strictEqual(reconcileAllowsRebuild(disp), false);
  });
}

// ── foldReconcileResults — H2/H1 idempotency (verification #6) ──────────
function reconcileFoldChecks() {
  console.log('foldReconcileResults (reconcile idempotency)');
  const u = (sig: string, lvbh = 1000): UnresolvedTx => ({ signature: sig, lastValidBlockHeight: lvbh, asset: `ASSET_${sig}`, family: 'core' });
  const R = (o: OneReconcileResult): OneReconcileResult => o;

  check('landed_ok + minted -> one bump, drops from stillUnresolved', () => {
    const f = foldReconcileResults([R({ u: u('S1'), disp: 'landed_ok', mintVerdict: 'minted' })]);
    assert.deepStrictEqual(f.bumps, ['S1']);
    assert.strictEqual(f.stillUnresolved.length, 0);
  });
  check('landed_ok + not_observed -> NO bump, STAYS unresolved (never minted without asset)', () => {
    const f = foldReconcileResults([R({ u: u('S1'), disp: 'landed_ok', mintVerdict: 'not_observed' })]);
    assert.strictEqual(f.bumps.length, 0);
    assert.strictEqual(f.stillUnresolved.length, 1);
  });
  check('landed_ok + tax_no_mint -> NO bump, resolved (safe to retry)', () => {
    const f = foldReconcileResults([R({ u: u('S1'), disp: 'landed_ok', mintVerdict: 'tax_no_mint' })]);
    assert.strictEqual(f.bumps.length, 0);
    assert.deepStrictEqual(f.resolvedFailed, ['S1']);
    assert.strictEqual(f.stillUnresolved.length, 0);
  });
  check('still_valid_ambiguous / blockheight-unknown -> NO bump, STAYS unresolved', () => {
    const f = foldReconcileResults([
      R({ u: u('S1'), disp: 'still_valid_ambiguous' }),
      R({ u: u('S2'), disp: 'unresolved_blockheight_unknown' }),
    ]);
    assert.strictEqual(f.bumps.length, 0);
    assert.strictEqual(f.stillUnresolved.length, 2);
  });
  check('IDEMPOTENT: re-checking a not_observed then minted bumps exactly once total', () => {
    // pass 1: not_observed -> stays unresolved, 0 bumps
    const p1 = foldReconcileResults([R({ u: u('S1'), disp: 'landed_ok', mintVerdict: 'not_observed' })]);
    assert.strictEqual(p1.bumps.length, 0);
    // pass 2 (same sig, asset now visible): minted -> 1 bump, resolved
    const p2 = foldReconcileResults([R({ u: p1.stillUnresolved[0], disp: 'landed_ok', mintVerdict: 'minted' })]);
    assert.deepStrictEqual(p2.bumps, ['S1']);
    assert.strictEqual(p2.stillUnresolved.length, 0);
    // pass 3: the caller now has NO unresolved to feed -> fold of [] -> 0 bumps
    const p3 = foldReconcileResults([]);
    assert.strictEqual(p3.bumps.length, 0);
  });
  check('IDEMPOTENT: a batch of mixed sigs — each bumps at most once', () => {
    const f = foldReconcileResults([
      R({ u: u('A'), disp: 'landed_ok', mintVerdict: 'minted' }),
      R({ u: u('B'), disp: 'landed_ok', mintVerdict: 'minted' }),
      R({ u: u('C'), disp: 'landed_ok', mintVerdict: 'not_observed' }),
      R({ u: u('D'), disp: 'landed_failed' }),
    ]);
    assert.deepStrictEqual(f.bumps.sort(), ['A', 'B']);
    assert.deepStrictEqual(f.stillUnresolved.map((x) => x.signature), ['C']);
    assert.deepStrictEqual(f.resolvedFailed, ['D']);
  });
  check('each unresolved record keeps its OWN asset/sig/lvbh (batch independence)', () => {
    const a = u('A', 111); const b = u('B', 222);
    assert.strictEqual(a.asset, 'ASSET_A'); assert.strictEqual(b.asset, 'ASSET_B');
    assert.strictEqual(a.lastValidBlockHeight, 111); assert.strictEqual(b.lastValidBlockHeight, 222);
    const f = foldReconcileResults([R({ u: a, disp: 'still_valid_ambiguous' }), R({ u: b, disp: 'still_valid_ambiguous' })]);
    assert.deepStrictEqual(f.stillUnresolved, [a, b]); // exact records preserved
  });
  check('empty input -> nothing to do', () => {
    const f = foldReconcileResults([]);
    assert.deepStrictEqual(f, { stillUnresolved: [], bumps: [], resolvedFailed: [], notes: [] });
  });
}

partitionChecks();
headroomChecks();
confirmationBudgetChecks();
reconcileChecks();
reconcileFoldChecks();

runBoundedChecks()
  .then(retryOnceChecks)
  .then(() => {
    console.log(`\n${passed} checks passed`);
    if (process.exitCode) { console.error('SOME CHECKS FAILED'); }
  });
