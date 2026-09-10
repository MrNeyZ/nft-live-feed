/**
 * Candy Mint — backend safety regression suite.
 *
 *   npm run test:candy-mint
 *
 * No network, no RPC, no signing. Covers:
 *   - post-confirmation mint verification (H1) — CORRECTED semantics: an
 *     absent account is NEVER on its own proof of "no mint"; only the
 *     confirmed tx's own bot-tax log marker yields `tax_no_mint`
 *   - `verifyMintAsset` with injected account-read + tx-log readers
 *   - the dedicated send-tx limiter clearing a full 25-item batch (M1)
 *
 * The real-production-builder-output regression for the STRUCTURAL AUDITOR
 * lives on the frontend (audit.test.ts) against fixtures captured here by
 * `capture-fixtures.ts`.
 */
import assert from 'assert';
import { classifyMint, looksLikeBotTax, verifyMintAsset, expectedOwnersFor, type OneRead } from '../verify-asset';
import { extractPaymentGuards, canonicalGuardNames } from '../guard-config';
import { resolveMintArgs } from '../build';
import { rateLimit } from '../../server/rate-limit';
import { MAX_CANDY_MINT_BATCH } from '../../server/tools-candy-mint';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}
async function checkAsync(label: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

const CORE_OWNER = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TOKEN_OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// SYNTHETIC — a hand-built log slice with the Candy Guard bot-tax marker
// (could not capture a real bot-tax candy-guard tx in the verification
// window; the marker matches simulate.ts's production BOT_TAX_RE).
const SYNTH_BOT_TAX_LOGS = [
  'Program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ invoke [1]',
  'Program log: Instruction: Mint',
  'Program log: Botting is taxed at 0.01000000 SOL',
  'Program 11111111111111111111111111111111 invoke [2]',
  'Program 11111111111111111111111111111111 success',
  'Program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ success',
];
const SYNTH_CLEAN_MINT_LOGS = [
  'Program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ invoke [1]',
  'Program log: Instruction: Mint',
  'Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d invoke [2]',
  'Program log: Instruction: Create',
  'Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d success',
  'Program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ success',
];

// ── H1: mint verification (CORRECTED — absent account != "no mint") ──────────
console.log('looksLikeBotTax');
check('SYNTHETIC bot-tax log slice -> true', () => assert.strictEqual(looksLikeBotTax(SYNTH_BOT_TAX_LOGS), true));
check('clean mint log slice -> false', () => assert.strictEqual(looksLikeBotTax(SYNTH_CLEAN_MINT_LOGS), false));
check('null / empty logs -> false', () => {
  assert.strictEqual(looksLikeBotTax(null), false);
  assert.strictEqual(looksLikeBotTax([]), false);
});
check('matches "bot tax" wording variant too', () => assert.strictEqual(looksLikeBotTax(['Program log: bot tax applied']), true));

console.log('classifyMint (H1 corrected semantics)');

check('normal minted core asset — found + right owner -> minted', () => {
  const r = classifyMint([{ kind: 'found', owner: CORE_OWNER }], expectedOwnersFor('core'), null);
  assert.strictEqual(r.verdict, 'minted');
  assert.strictEqual(r.owner, CORE_OWNER);
});

check('legacy minted — found + SPL Token owner after one lag null -> minted', () => {
  const r = classifyMint([{ kind: 'absent' }, { kind: 'found', owner: TOKEN_OWNER }], expectedOwnersFor('legacy'), null);
  assert.strictEqual(r.verdict, 'minted');
  assert.strictEqual(r.attempts, 2);
});

check('found is trustworthy even after a prior error read -> minted', () => {
  const r = classifyMint([{ kind: 'error' }, { kind: 'found', owner: CORE_OWNER }], expectedOwnersFor('core'), null);
  assert.strictEqual(r.verdict, 'minted');
});

check('confirmed tx, asset absent across ALL clean reads, logs CLEAN -> not_observed (NOT tax_no_mint)', () => {
  const reads: OneRead[] = [{ kind: 'absent' }, { kind: 'absent' }, { kind: 'absent' }, { kind: 'absent' }];
  const r = classifyMint(reads, expectedOwnersFor('core'), SYNTH_CLEAN_MINT_LOGS);
  assert.strictEqual(r.verdict, 'not_observed');
});

check('confirmed tx, asset absent, logs COULD NOT be fetched (null) -> not_observed', () => {
  const r = classifyMint([{ kind: 'absent' }], expectedOwnersFor('legacy'), null);
  assert.strictEqual(r.verdict, 'not_observed');
  assert.strictEqual(r.logsInspected, false);
});

check('confirmed tx, asset absent, logs carry the bot-tax marker -> tax_no_mint (STRONG evidence)', () => {
  const r = classifyMint([{ kind: 'absent' }, { kind: 'absent' }], expectedOwnersFor('core'), SYNTH_BOT_TAX_LOGS);
  assert.strictEqual(r.verdict, 'tax_no_mint');
  assert.strictEqual(r.logsInspected, true);
});

check('asset absent + some reads errored + logs clean -> not_observed (never tax_no_mint without log evidence)', () => {
  const reads: OneRead[] = [{ kind: 'absent' }, { kind: 'error' }, { kind: 'absent' }];
  const r = classifyMint(reads, expectedOwnersFor('core'), SYNTH_CLEAN_MINT_LOGS);
  assert.strictEqual(r.verdict, 'not_observed');
});

check('every account read errored, logs clean -> not_observed', () => {
  const r = classifyMint([{ kind: 'error' }, { kind: 'error' }], expectedOwnersFor('core'), SYNTH_CLEAN_MINT_LOGS);
  assert.strictEqual(r.verdict, 'not_observed');
});

check('found but WRONG owner -> not_observed (something created, but not our mint)', () => {
  const r = classifyMint([{ kind: 'found', owner: '11111111111111111111111111111111' }], expectedOwnersFor('core'), null);
  assert.strictEqual(r.verdict, 'not_observed');
});

check('all-absent + clean logs is NEVER "minted", regardless of retry count', () => {
  for (const n of [1, 2, 4, 8]) {
    const reads: OneRead[] = Array.from({ length: n }, () => ({ kind: 'absent' as const }));
    assert.notStrictEqual(classifyMint(reads, expectedOwnersFor('core'), SYNTH_CLEAN_MINT_LOGS).verdict, 'minted');
    assert.notStrictEqual(classifyMint(reads, expectedOwnersFor('core'), SYNTH_CLEAN_MINT_LOGS).verdict, 'tax_no_mint');
  }
});

// verifyMintAsset — injected readers (audit's explicit scenarios)
console.log('verifyMintAsset — injected readers');

void (async () => {
  await checkAsync('normal minted asset -> minted, logsFn NOT called (short-circuit on found)', async () => {
    let logsCalls = 0;
    const r = await verifyMintAsset('core', 'A', 'SIG', {
      maxAttempts: 4, delayMs: 1,
      readFn: async () => ({ kind: 'found', owner: CORE_OWNER }),
      logsFn: async () => { logsCalls++; return null; },
    });
    assert.strictEqual(r.verdict, 'minted');
    assert.strictEqual(logsCalls, 0);
  });

  await checkAsync('temporary RPC failure then asset appears -> minted', async () => {
    let n = 0;
    const r = await verifyMintAsset('core', 'A', 'SIG', {
      maxAttempts: 4, delayMs: 1,
      readFn: async () => (++n < 2 ? { kind: 'error' } : { kind: 'found', owner: CORE_OWNER }),
    });
    assert.strictEqual(r.verdict, 'minted');
  });

  await checkAsync('temporary null then asset appears -> minted', async () => {
    let n = 0;
    const r = await verifyMintAsset('legacy', 'A', 'SIG', {
      maxAttempts: 4, delayMs: 1,
      readFn: async () => (++n < 3 ? { kind: 'absent' } : { kind: 'found', owner: TOKEN_OWNER }),
    });
    assert.strictEqual(r.verdict, 'minted');
  });

  await checkAsync('confirmed tx but asset remains absent (clean logs) -> not_observed, NEVER bumps', async () => {
    const r = await verifyMintAsset('core', 'A', 'SIG', {
      maxAttempts: 4, delayMs: 1,
      readFn: async () => ({ kind: 'absent' }),
      logsFn: async () => SYNTH_CLEAN_MINT_LOGS,
    });
    assert.strictEqual(r.verdict, 'not_observed');
  });

  await checkAsync('bot-tax-like confirmed tx (asset absent + bot-tax logs) -> tax_no_mint', async () => {
    const r = await verifyMintAsset('legacy', 'A', 'SIG', {
      maxAttempts: 2, delayMs: 1,
      readFn: async () => ({ kind: 'absent' }),
      logsFn: async () => SYNTH_BOT_TAX_LOGS,
    });
    assert.strictEqual(r.verdict, 'tax_no_mint');
  });

  await checkAsync('logsFn itself throws / returns null -> not_observed (not tax)', async () => {
    const r = await verifyMintAsset('core', 'A', 'SIG', {
      maxAttempts: 1, delayMs: 1,
      readFn: async () => ({ kind: 'absent' }),
      logsFn: async () => null,
    });
    assert.strictEqual(r.verdict, 'not_observed');
  });

  await checkAsync('never bump: no injected reader path ever yields "minted" from absence', async () => {
    for (const logs of [SYNTH_CLEAN_MINT_LOGS, SYNTH_BOT_TAX_LOGS, null]) {
      const r = await verifyMintAsset('core', 'A', 'SIG', {
        maxAttempts: 3, delayMs: 1, readFn: async () => ({ kind: 'absent' }), logsFn: async () => logs,
      });
      assert.notStrictEqual(r.verdict, 'minted');
    }
  });

  console.log(`\n${passed} checks passed`);
  if (process.exitCode) console.error('SOME CHECKS FAILED');
})();

// ── extractPaymentGuards — the shared payment-authorization extractor ───────
// Same fn feeds the inspect summary AND the builder's resolvedGuardPayment
// echo-back, so the frontend's EXACT payment check can't be fooled by the
// two diverging.
console.log('extractPaymentGuards');
const some = (value: unknown) => ({ __option: 'Some' as const, value });
const none = { __option: 'None' as const };

check('solPayment -> amount + destination', () => {
  const g = extractPaymentGuards({
    solPayment: some({ lamports: { basisPoints: 800000000n }, destination: 'DEST111' }),
    startDate: some({ date: 123n }),
  });
  assert.strictEqual(g.solPaymentLamports, '800000000');
  assert.strictEqual(g.solPaymentDestination, 'DEST111');
  assert.strictEqual(g.tokenPayment, null);
});
check('solFixedFee + addressGate surfaced', () => {
  const g = extractPaymentGuards({
    solFixedFee: some({ lamports: { basisPoints: 5000n }, destination: 'FEE222' }),
    addressGate: some({ address: 'GATE333' }),
  });
  assert.strictEqual(g.solFixedFeeLamports, '5000');
  assert.strictEqual(g.solFixedFeeDestination, 'FEE222');
  assert.strictEqual(g.addressGateAddress, 'GATE333');
});
check('token2022Payment -> {mint, amount, destinationAta, kind}', () => {
  const g = extractPaymentGuards({
    token2022Payment: some({ mint: 'MINT444', amount: 1500000n, destinationAta: 'ATA555' }),
  });
  assert.deepStrictEqual(g.tokenPayment, { mint: 'MINT444', amount: '1500000', destinationAta: 'ATA555', kind: 'token2022' });
});
check('None guards contribute nothing', () => {
  const g = extractPaymentGuards({ solPayment: none, tokenPayment: none, addressGate: none });
  assert.strictEqual(g.solPaymentLamports, null);
  assert.strictEqual(g.solPaymentDestination, null);
  assert.strictEqual(g.tokenPayment, null);
  assert.strictEqual(g.addressGateAddress, null);
});
check('u64 amount kept as an exact decimal string (no float)', () => {
  const g = extractPaymentGuards({ solPayment: some({ lamports: { basisPoints: 18446744073709551615n }, destination: 'D' }) });
  assert.strictEqual(g.solPaymentLamports, '18446744073709551615');
});

// ── canonicalGuardNames + build-path consistency (#4) ──────────────────────
// `resolvedEnabledGuards` MUST come from the SAME merged guard set the
// builder uses. In build.ts the SINGLE `mergedGuards` const is passed to BOTH
// `resolveMintArgs(mergedGuards)` (-> the mint instruction) AND, via
// finalizeTx, `canonicalGuardNames(mergedGuards)` (-> resolvedEnabledGuards).
// These pure tests prove the two functions read the same enabling predicate
// (`__option === 'Some'`) off the same object shape — no independent fetch,
// no request-data derivation possible.
console.log('canonicalGuardNames <-> resolveMintArgs consistency (#4)');

// A realistic merged base∪group guard set: Some + None, values are objects.
const mergedFixture = {
  solPayment: some({ lamports: { basisPoints: 100n }, destination: 'D' }),
  startDate:  some({ date: 1n }),
  mintLimit:  some({ id: 3, limit: 5 }),
  botTax:     some({ lamports: { basisPoints: 1n }, lastInstruction: true }),
  allowList:  none,     // disabled -> must not appear in either
  endDate:    none,
};

check('canonicalGuardNames is sorted + unique + all-Some', () => {
  assert.deepStrictEqual(
    canonicalGuardNames(mergedFixture),
    ['botTax', 'mintLimit', 'solPayment', 'startDate'],
  );
});
check('key iteration order does not matter (canonical)', () => {
  const shuffled = {
    startDate: mergedFixture.startDate, botTax: mergedFixture.botTax,
    solPayment: mergedFixture.solPayment, endDate: mergedFixture.endDate,
    mintLimit: mergedFixture.mintLimit, allowList: mergedFixture.allowList,
  };
  assert.deepStrictEqual(canonicalGuardNames(shuffled), canonicalGuardNames(mergedFixture));
});
check('resolveMintArgs keys ⊆ canonicalGuardNames, and EQUAL when every Some has a defined value (real guard state)', () => {
  const mintArgKeys = Object.keys(resolveMintArgs(mergedFixture as never)).sort();
  const enabled = canonicalGuardNames(mergedFixture);
  assert.ok(mintArgKeys.every((k) => enabled.includes(k)), 'mintArg keys are a subset of enabled guards');
  // real on-chain guard `Some` values are always objects (never undefined)
  assert.deepStrictEqual(mintArgKeys, enabled, 'same predicate on the same object -> same set');
});
check('a None guard is in NEITHER set', () => {
  assert.ok(!canonicalGuardNames(mergedFixture).includes('allowList'));
  assert.ok(!('allowList' in resolveMintArgs(mergedFixture as never)));
});
check('adding a guard to the merged set changes BOTH outputs identically', () => {
  const g2 = { ...mergedFixture, addressGate: some({ address: 'X' }) };
  assert.ok(canonicalGuardNames(g2).includes('addressGate'));
  assert.ok('addressGate' in resolveMintArgs(g2 as never));
});
check('the same GuardOption shape drives both (predicate = __option===Some)', () => {
  const onlySome = { a: some({}), b: { __option: 'Some' as const, value: undefined }, c: none };
  // canonicalGuardNames: a + b (both Some);  resolveMintArgs: a only (b has undefined value)
  assert.deepStrictEqual(canonicalGuardNames(onlySome), ['a', 'b']);
  assert.deepStrictEqual(Object.keys(resolveMintArgs(onlySome as never)).sort(), ['a']);
  // -> canonicalGuardNames is the SUPERSET (a Some guard IS enabled on-chain
  //    even in the pathological "no value" case); it never UNDER-reports the
  //    enabled set, so the frontend equality check can't be bypassed by a
  //    guard being present on-chain but absent from resolvedEnabledGuards.
});

// ── M1: dedicated send-tx limiter clears a full batch ───────────────────────
console.log('send-tx limiter (M1)');

function fakeReqRes() {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown = null;
  const req = { headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } } as never;
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (s: number) => { status = s; return res; },
    json: (j: unknown) => { body = j; return res; },
  } as never;
  return { req, res, get status() { return status; }, get body() { return body; } };
}

check(`MAX_CANDY_MINT_BATCH is ${MAX_CANDY_MINT_BATCH} (matches the frontend quantity cap)`, () => {
  assert.strictEqual(MAX_CANDY_MINT_BATCH, 25);
});

check('a 25-send batch does NOT hit the dedicated send limiter (unlike the shared 10/min MMM one)', () => {
  const limiter = rateLimit({ limit: MAX_CANDY_MINT_BATCH * 2 + 10, windowMs: 60_000, label: 'test/candy-mint/send-tx' });
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < MAX_CANDY_MINT_BATCH; i++) {
    const ctx = fakeReqRes();
    limiter(ctx.req, ctx.res, () => { allowed++; });
    if (ctx.status === 429) blocked++;
  }
  assert.strictEqual(allowed, 25, `expected all 25 sends allowed, got ${allowed}`);
  assert.strictEqual(blocked, 0);
});

check('the OLD shared 10/min limiter WOULD have 429d that same batch at send #11 (regression baseline)', () => {
  const shared = rateLimit({ limit: 10, windowMs: 60_000, label: 'test/mmm-pools' });
  let firstBlockAt = -1;
  for (let i = 0; i < MAX_CANDY_MINT_BATCH; i++) {
    const ctx = fakeReqRes();
    shared(ctx.req, ctx.res, () => {});
    if (ctx.status === 429 && firstBlockAt < 0) firstBlockAt = i;
  }
  assert.strictEqual(firstBlockAt, 10, `shared limiter should block at index 10, blocked at ${firstBlockAt}`);
});

check('dedicated limiter still has headroom for one batch + two "Retry unresolved" re-sends in a window', () => {
  const limiter = rateLimit({ limit: MAX_CANDY_MINT_BATCH * 2 + 10, windowMs: 60_000, label: 'test/cm/send2' });
  let allowed = 0;
  for (let i = 0; i < MAX_CANDY_MINT_BATCH + 25; i++) {
    const ctx = fakeReqRes();
    limiter(ctx.req, ctx.res, () => { allowed++; });
  }
  assert.ok(allowed >= MAX_CANDY_MINT_BATCH + 25, `expected >= ${MAX_CANDY_MINT_BATCH + 25} allowed, got ${allowed}`);
});

// final count is printed by the async IIFE above (after its awaits settle) so
// it includes every check, sync and async.
