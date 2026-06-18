/**
 * PRNT mint-pass detector — offline fixture tests.
 *
 * Proves the targeted PRNT branch of `detectLaunchpadMint`:
 *   1. accepts the reference PRNT mint-pass tx with the expected
 *      source / standard / asset / collection / minter, AND
 *   2. rejects a CMA Core mint that carries no SPL722 vesting leg, AND
 *   3. rejects an SPL722-only vesting tx that carries no Core Create, AND
 *   4. rejects a PRNT-shaped tx whose vesting-log asset does NOT equal
 *      the Core Create asset (the same-tx equality guard).
 *
 * Pure offline — fixtures captured from mainnet via getTransaction and
 * pre-merged with loaded addresses to mirror `fetchRawTx` output.
 * Runner: `npm run test:prnt-detector` (ts-node + Node assert, no network).
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectLaunchpadMint } from '../launchpad-detector';
import type { RawSolanaTx } from '../../me-raw/types';

const FIX = join(__dirname, 'fixtures');
function load(name: string): RawSolanaTx {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8')) as RawSolanaTx;
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 1. Reference PRNT mint-pass → accepted as PRNT.
check('reference tx classifies as PRNT', () => {
  const hit = detectLaunchpadMint(load('prnt_ref.json'));
  assert(hit, 'expected a launchpad hit');
  assert.strictEqual(hit!.source, 'PRNT');
  assert.strictEqual(hit!.standard, 'core');
  assert.strictEqual(hit!.mintAddress, '4NXCz5sTYTt7BbBZzJRemVNU4CY9UZxwHsRpNnnN8Q5B');
  assert.strictEqual(hit!.collectionAddress, '5eY82RX1Uv5JHb7Ar92AeXeJdm46iRGTSFW6AEDEfKiW');
  assert.strictEqual(hit!.minter, '4Y742UFgaDEpubSbNvTnzgXLhLeQ6ttsyZtzP4RTasQ2');
});

// 2. CMA Core mint without SPL722 → NOT PRNT.
//    `tx_mintx_no.json` is a MintX/CMA Core mint (CMAGAKJ + CMACYFEN +
//    mpl-core Create) but carries no SPL722 vesting program. The PRNT
//    gate must reject it. Reused from the mint-analyzer fixtures.
check('CMA mint without SPL722 is not PRNT', () => {
  const cma = JSON.parse(
    readFileSync(join(__dirname, '../../../mint-analyzer/__tests__/fixtures/tx_mintx_no.json'), 'utf8'),
  ).result as RawSolanaTx;
  const hit = detectLaunchpadMint(cma);
  assert(!hit || hit.source !== 'PRNT', 'CMA-only mint must not classify as PRNT');
});

// 3. SPL722-only vesting tx without a Core Create → NOT PRNT.
check('SPL722-only vesting tx without Core Create is not PRNT', () => {
  const hit = detectLaunchpadMint(load('spl722_no_core.json'));
  assert(!hit || hit.source !== 'PRNT', 'SPL722-only tx must not classify as PRNT');
});

// 4. Same-tx asset equality guard: mutate the vesting-log asset on the
//    reference tx so it no longer equals the Core Create asset. Must reject.
check('vesting-log asset != Core Create asset is rejected', () => {
  const tx = load('prnt_ref.json');
  const FAKE = 'So11111111111111111111111111111111111111112';
  tx.meta!.logMessages = (tx.meta!.logMessages as string[]).map((l) =>
    l.replace('4NXCz5sTYTt7BbBZzJRemVNU4CY9UZxwHsRpNnnN8Q5B', FAKE),
  );
  const hit = detectLaunchpadMint(tx);
  assert(!hit || hit.source !== 'PRNT', 'asset mismatch must not classify as PRNT');
});

console.log(`\nPRNT detector: ${passed}/4 checks passed`);
