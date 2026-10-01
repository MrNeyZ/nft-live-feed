/**
 * Regression test: USDC-priced Core buys (OpenSea Solana front-end).
 *
 *  1. TComp `buyCoreSpl` (disc ea1c257a72efe9d0) — was dropped as "no
 *     recognised Tensor sale instruction", so the sale never reached /feed.
 *     Fixture sig 5xdjAnm5…: buyer paid 0.102 USDC in total (0.1 to the seller
 *     + 0.0012 / 0.0008 to fee wallets); SOL delta is only fee + listing rent.
 *  2. OS2 `buyCoreSpl` — parsed, but priced off the SOL delta (tx fee,
 *     0.0000275 SOL). Fixture sig 2kPUbCga…: buyer paid 0.1 USDC.
 *
 * Run: ts-node --transpile-only src/ingestion/tensor-raw/__tests__/usdc-buy-core-spl.test.ts
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRawTensorTransaction } from '../parser';
import { parseRawOpenseaTransaction } from '../../opensea-raw/parser';
import type { RawSolanaTx } from '../types';

const load = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8')) as RawSolanaTx;

// ── TComp buyCoreSpl ─────────────────────────────────────────────────────────
{
  const r = parseRawTensorTransaction(load('tensor_opensea_buy_core_spl_usdc.json'));
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const e = r.event;
  assert.strictEqual(e.currency, 'USDC');
  assert.strictEqual(e.priceLamports, 102_000n);   // raw 6-decimal units
  assert.strictEqual(e.priceSol, 0.102);
  assert.strictEqual(e.buyer,  '5QjF7VV5WGJLBaGYZsVx5vhizDTLAHZV2pXq3TjYazWe');
  assert.strictEqual(e.seller, 'FpeU3wxuFuhgZqDGUC4s5azQhYbnE8nFfa2y9rpjFDYc');
  assert.strictEqual(e.mintAddress, '8LiMDBFpkJKfTWy4ewp8zQkMU8Bc7dL98QEP93tnJNpf');
  assert.strictEqual(e.nftType, 'core');
  assert.strictEqual(e.sellerNetLamports, null);
  console.log('  ok  TComp buyCoreSpl → 0.102 USDC');
}

// ── OS2 buyCoreSpl ───────────────────────────────────────────────────────────
{
  const r = parseRawOpenseaTransaction(load('os2_buy_core_spl_usdc.json'));
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const e = r.event;
  assert.strictEqual(e.marketplace, 'opensea');
  assert.strictEqual(e.currency, 'USDC');
  assert.strictEqual(e.priceLamports, 100_000n);
  assert.strictEqual(e.priceSol, 0.1);
  assert.strictEqual(e.buyer.slice(0, 8), 'G5aPPjNz');
  assert.strictEqual(e.seller.slice(0, 8), 'Eqz7HALz');
  assert.strictEqual(e.sellerNetLamports, null);
  console.log('  ok  OS2 buyCoreSpl → 0.1 USDC');
}
console.log('usdc-buy-core-spl: all passed');
