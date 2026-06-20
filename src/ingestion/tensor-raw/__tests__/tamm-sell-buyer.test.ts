/**
 * Regression test: TAMM pool-sell buyer attribution.
 *
 * When a user sells an NFT into a TAMM pool, the pool owner (not the TAMM
 * program address) should be attributed as the buyer.  Newer TAMM pool
 * layouts dropped the TSwap singleton from the front of the instruction
 * account list, causing instruction slot 7 (historically the pool owner) to
 * resolve to the TAMM program itself.  The fix falls back to slot 0 when
 * slot 7 is the program.
 *
 * Fixture: mainnet tx
 *   48JScBH31jYft9PXpG4mghXdbJAXQaUqZkG6fBXgNC13XQ3U5vAGFMyw2Y4WqUtemseVZdw8z7Z6AaWFj7oa6arx
 *
 * Run: npm run test:tamm-sell-buyer
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRawTensorTransaction } from '../parser';
import type { RawSolanaTx } from '../types';

const FIX = join(__dirname, 'fixtures');
function load(name: string): RawSolanaTx {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8')) as RawSolanaTx;
}

const TAMM_PROGRAM = 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg';
const EXPECTED_BUYER = 'FsLwGq9ivo3F3WDvaiRSineeZqky5i7U5hfEKD153yuN';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ─── Fixture: TAMM pool sell (new layout, pool owner at slot 0) ──────────────
// Seller: HEBDdJt5KfWg5F446FXDXhJoeF35uJ1TzqMeiwHmx6jr (NFT seller)
// Pool owner / buyer: FsLwGq9ivo3F3WDvaiRSineeZqky5i7U5hfEKD153yuN
// Bug: instruction slot 7 resolved to TAMM program → buyer showed as TAMM address.

check('tamm sell fixture parses as ok', () => {
  const tx = load('tamm_sell_pool_new_layout.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok, `expected ok but got: ${!result.ok ? result.reason : ''}`);
});

check('tamm sell: marketplace = tensor_amm', () => {
  const result = parseRawTensorTransaction(load('tamm_sell_pool_new_layout.json'));
  assert(result.ok);
  assert.strictEqual(result.event.marketplace, 'tensor_amm');
});

check('tamm sell: buyer = pool owner (not TAMM program)', () => {
  const result = parseRawTensorTransaction(load('tamm_sell_pool_new_layout.json'));
  assert(result.ok);
  assert.strictEqual(result.event.buyer, EXPECTED_BUYER,
    `expected buyer ${EXPECTED_BUYER} but got ${result.event.buyer}`);
  assert.notStrictEqual(result.event.buyer, TAMM_PROGRAM,
    'buyer must not be the TAMM program address');
  assert(
    !result.event.buyer?.startsWith('TAMM'),
    `buyer must not start with TAMM, got ${result.event.buyer}`
  );
});

check('tamm sell: price unchanged (9550000 lamports)', () => {
  const result = parseRawTensorTransaction(load('tamm_sell_pool_new_layout.json'));
  assert(result.ok);
  assert.strictEqual(result.event.priceLamports, 9550000n,
    `expected 9550000 but got ${result.event.priceLamports}`);
});

check('tamm sell: instruction = sell (direction = sell)', () => {
  const result = parseRawTensorTransaction(load('tamm_sell_pool_new_layout.json'));
  assert(result.ok);
  const raw = result.event.rawData as Record<string, unknown>;
  assert.strictEqual(raw._instruction, 'sell');
  assert.strictEqual(raw._direction, 'sell');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nTAMM pool-sell buyer regression — ${passed} checks passed`);
