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
  type ConfirmClass,
} from './logic';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
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

console.log(`\n${passed} checks passed`);
if (process.exitCode) { console.error('SOME CHECKS FAILED'); }
