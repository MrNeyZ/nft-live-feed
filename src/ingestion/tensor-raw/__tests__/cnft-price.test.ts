/**
 * Offline regression fixture test for Tensor cNFT sale price extraction.
 *
 * Verifies that the parser returns the correct seller-principal price (190,000
 * lamports) for a cNFT buy transaction where an unrelated SOL transfer
 * (listing-escrow closure) would otherwise inflate the "max negative delta"
 * to 3,097,200 lamports.
 *
 * Fixture: mainnet tx
 *   3xZAvr4oW2TAZ6VCMYK8k7So9Pw6tjoXkJprabdUKUkDSwN4A4QLMEkzuVCbdGK1iV3bFMffTYiStnQpz3eG31WF
 *
 * Run: npm run test:tensor-cnft-price
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

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ─── Fixture: cNFT listing buy ────────────────────────────────────────────────
// Mint: EJQGxnpoYRNzDUZecYwe25jgzZ2nSHcMo6tU38PepRXE
// Listing escrow closure produces a large spurious -3,097,200 SOL delta that
// the old unbounded max-negative-delta heuristic would return as the price.
// The TComp `buy` instruction encodes maxAmount=213,750 lamports; the seller
// receives the principal of 190,000 lamports.

check('cNFT buy fixture parses as ok', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok, `expected ok but got: ${!result.ok ? result.reason : ''}`);
});

check('cNFT buy: marketplace = tensor', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok);
  assert.strictEqual(result.event.marketplace, 'tensor');
});

check('cNFT buy: nft_type = cnft', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok);
  assert.strictEqual(result.event.nftType, 'cnft');
});

check('cNFT buy: sale_type = list_buy (instruction = buy)', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok);
  const raw = result.event.rawData as Record<string, unknown>;
  assert.strictEqual(raw._instruction, 'buy');
  assert.strictEqual(raw._direction, 'buy');
});

check('cNFT buy: price_lamports = 190000 (not 3097200)', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok);
  assert.strictEqual(result.event.priceLamports, 190000n,
    `expected 190000 but got ${result.event.priceLamports}`);
  assert.notStrictEqual(result.event.priceLamports, 3097200n,
    'wrong: returned the escrow-closure delta (3097200) as price');
});

check('cNFT buy: price_sol = 0.00019', () => {
  const tx = load('tensor_cnft_buy.json');
  const result = parseRawTensorTransaction(tx);
  assert(result.ok);
  assert.strictEqual(result.event.priceSol, 0.00019,
    `expected 0.00019 but got ${result.event.priceSol}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nTensor cNFT price regression — ${passed} checks passed`);
