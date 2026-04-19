/**
 * Stage 2 replay test for the Tensor raw parser.
 *
 * Fetches ground-truth sale transactions from RPC and runs each one through
 * parseRawTensorTransaction() to verify the normalized SaleEvent output.
 *
 * ⚠️ CASES IS EMPTY — awaiting ground-truth signatures from user.
 *    Add entries to CASES following the pattern below, then run:
 *      npx ts-node src/ingestion/tensor-raw/replay-test.ts
 *
 * Each case should cover a distinct instruction type:
 *   TComp:
 *     - cNFT buy         (instruction: buy,              Bubblegum involved)
 *     - cNFT takeBid     (instruction: takeBidFullMeta or takeBidMetaHash)
 *     - standard NFT buy (instruction: buy,              no Bubblegum)
 *   TSwap:
 *     - buyNft            (user buys from pool)
 *     - buySingleListing  (user buys fixed-price listing)
 *     - sellNftTokenPool  (user sells into token pool)
 *     - sellNftTradePool  (user sells into trade pool)
 */
import 'dotenv/config';
import { parseRawTensorTransaction } from './parser';
import { RawSolanaTx } from './types';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// ─── RPC fetch (identical to me-raw/replay-test.ts) ──────────────────────────

async function getTx(sig: string): Promise<RawSolanaTx | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [sig, {
        encoding: 'json',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: any; error?: { message: string } };
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  if (!json.result) return null;

  const tx = json.result;

  // Expand loadedAddresses for versioned (v0) transactions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = (tx.meta as any)?.loadedAddresses ?? {};
  const loadedWritable: string[] = loaded.writable ?? [];
  const loadedReadonly: string[] = loaded.readonly  ?? [];

  tx.transaction.message.accountKeys = [
    ...staticKeys.map((k: string | { pubkey: string }) =>
      typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : k
    ),
    ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true  })),
    ...loadedReadonly.map( (pk: string) => ({ pubkey: pk, signer: false, writable: false })),
  ];

  tx.signature = sig;
  return tx as RawSolanaTx;
}

// ─── Test cases ───────────────────────────────────────────────────────────────

interface TestCase {
  sig:          string;
  label:        string;
  expectOk:     boolean;
  expectMarketplace?: string;
  expectNftType?:     string;
  expectMint?:        string;
  expectSeller?:      string;
  expectBuyer?:       string;
  expectPriceGte?: number;
  expectPriceLte?: number;
  expectInstruction?: string;
}

// ⚠️ Add ground-truth cases here once the user provides signatures.
// Example shape (do not run as-is — sig is a placeholder):
//
// {
//   sig:               '<TCOMP_BUY_SIG>',
//   label:             'TComp cNFT buy',
//   expectOk:          true,
//   expectMarketplace: 'tensor',
//   expectNftType:     'cnft',
//   expectMint:        '<ASSET_ID>',
//   expectSeller:      '<SELLER>',
//   expectBuyer:       '<BUYER>',
//   expectPriceGte:    0.1,
//   expectPriceLte:    0.5,
//   expectInstruction: 'buy',
// },

const CASES: TestCase[] = [
  // ── TComp: listing buy (Metaplex Core) ──────────────────────────────────────
  // Verified 2026-04-14. Buyer purchases a Core NFT from a fixed-price listing.
  // disc=a9e357ff4c56ff19  buyer=accounts[4]  seller=accounts[6]  asset=accounts[2]
  {
    sig:               '587eAobQmnWvGiqtYABdKut8rqvcXXGG2KUzvW56mY7kn55H3SSDdQwacRV2JGJ8XHuzjqzmcyzxVYv3toss6j5G',
    label:             'TComp listing buy (Core)',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'core',
    expectMint:        '7LSi1q2g4qPx3uY1wmosxFxVRdQWZCaxu866i87fEpsB',
    expectBuyer:       'DkS2i4X5krcBkwpdHgzHwFVGrfzxuzTQyUHLW1Ph5Y71',
    expectSeller:      'AEv2yiEGLmmzrgXJJ5P85iN6eW9GeDcWUwwDxwqQRHNt',
    expectPriceGte:    3.20,
    expectPriceLte:    3.22,
    expectInstruction: 'buy',
  },
  // ── TComp: bid accept (Metaplex Core) ───────────────────────────────────────
  // Verified 2026-04-14. Seller accepts an open bid on a Core NFT.
  // disc=fa29f8143da11b8d  seller=accounts[1]  buyer=SOL-delta fallback  asset=accounts[8]
  {
    sig:               'P7w6yhSsAfLatJtCK8YWNWXXoxnpgsRP52vUS5uZ4Hx8gLVuLxUtj7NKqeQNNFVFpd4bs1XQNbDz25pGwnCyx8Y',
    label:             'TComp bid accept (Core)',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'core',
    expectMint:        '5jDzkZ4bAi7cSXD77DFH5EyEatDEhFJ6Dtjn9dVGwJkS',
    expectSeller:      'sCeb9SPntztuJhWdgS2EV1zQ4yPzSV2MREoV42CQ1pq',
    expectPriceGte:    0.001,
    expectPriceLte:    0.003,
    expectInstruction: 'takeBid',
  },
  // ── TAMM: sell into pool (Metaplex Core) ────────────────────────────────────
  // Verified 2026-04-14. Seller deposits Core NFT into AMM pool, receives SOL.
  // disc=25cd8d3556f52d4e  seller=accounts[1]  buyer=accounts[7]  asset=accounts[14]
  {
    sig:               '2F1BkqCqCcmyWfH1yFXe2qJLPxMdpRNfdyaFFnBNWqWwM1C9DHgGGi3Vyt6qC8zrPjiJDyS8exB3rFA129yRRdAp',
    label:             'TAMM sell into pool (Core)',
    expectOk:          true,
    expectMarketplace: 'tensor_amm',
    expectNftType:     'core',
    expectMint:        'A8VnUuYreLaAWpnYu78vPiRXxR1HULEoQN2RGPiYnkN5',
    expectSeller:      'qDYNYPYcMiBy4R5yvjrpQvpdkBQuB8q3aehmSr7EoBt',
    expectBuyer:       'DUQbSM6AC6ctjAJDw1jQQfAaNP3ENZ8ZGBeHPiZXSfR4',
    expectPriceGte:    0.004,
    expectPriceLte:    0.007,
    expectInstruction: 'sell',
  },
  // ── TAMM: buy from pool (Metaplex Core) ─────────────────────────────────────
  // Verified 2026-04-14. Buyer takes Core NFT out of AMM pool, pays SOL.
  // disc=a3663a6bb804a979  buyer=accounts[1]  seller=accounts[7]  asset=accounts[14]
  {
    sig:               '5zVed96S1QmUsfxCvVeQE7ZSxmgqy5DWtjmjmQrdxSZ1b4KdB9JjPTtFy9qRK1Ugut86YXPW1WdvgA1mJ7NxMFFw',
    label:             'TAMM buy from pool (Core)',
    expectOk:          true,
    expectMarketplace: 'tensor_amm',
    expectNftType:     'core',
    expectMint:        'E4frUvx8yik5mVELp7Zes5QoZdhNzCFHRkYPRLD6cVNz',
    expectBuyer:       '9RnYWodYKYEX8V3y9xSMvRNgwYH7akjdF5skVdLt7QgL',
    expectSeller:      'J8XPtqi8i2tkQePe1p7zQsewS9BmkHPkrxPP4Jnwp2E7',
    expectPriceGte:    0.26,
    expectPriceLte:    0.28,
    expectInstruction: 'buy',
  },
];

// ─── Checker ──────────────────────────────────────────────────────────────────

function check(name: string, actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  console.log(`  ✗ ${name}: expected=${JSON.stringify(expected)}  got=${JSON.stringify(actual)}`);
  return false;
}

function checkRange(name: string, actual: number, gte: number, lte: number): boolean {
  if (actual >= gte && actual <= lte) return true;
  console.log(`  ✗ ${name}: expected [${gte}, ${lte}]  got=${actual}`);
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (CASES.length === 0) {
    console.log('Tensor Raw Parser — Replay Test');
    console.log('No test cases defined yet. Add ground-truth signatures to CASES[].');
    console.log('\nRequired coverage (one sig per instruction type):');
    console.log('  TComp: buy (cNFT), buy (standard NFT), takeBidFullMeta, takeBidMetaHash');
    console.log('  TSwap: buyNft, buySingleListing, sellNftTokenPool, sellNftTradePool');
    process.exit(0);
  }

  console.log('Tensor Raw Parser — Replay Test');
  console.log('Fetching and parsing ground-truth sale transactions\n');

  let pass = 0;
  let fail = 0;

  for (const tc of CASES) {
    const tx = await getTx(tc.sig);
    if (!tx) {
      console.log(`FETCH ERROR: ${tc.label}`);
      console.log(`  null response for sig ${tc.sig.slice(0, 24)}...\n`);
      fail++;
      continue;
    }

    const result = parseRawTensorTransaction(tx);

    console.log(`${'─'.repeat(72)}`);
    console.log(`${result.ok ? '✅' : '❌'} ${tc.label}`);
    console.log(`   sig: ${tc.sig.slice(0, 32)}...`);

    if (!tc.expectOk) {
      if (!result.ok) {
        console.log(`   → correctly skipped: ${result.reason}`);
        pass++;
      } else {
        console.log(`  ✗ expected skip but got OK — marketplace=${result.event.marketplace}`);
        fail++;
      }
      console.log();
      continue;
    }

    if (!result.ok) {
      console.log(`  ✗ parse failed: ${result.reason}`);
      fail++;
      console.log();
      continue;
    }

    const e = result.event;
    let ok = true;

    if (tc.expectMarketplace) ok = check('marketplace',  e.marketplace, tc.expectMarketplace) && ok;
    if (tc.expectNftType)     ok = check('nftType',      e.nftType,     tc.expectNftType)     && ok;
    if (tc.expectMint)        ok = check('mint',         e.mintAddress, tc.expectMint)        && ok;
    if (tc.expectSeller)      ok = check('seller',       e.seller,      tc.expectSeller)      && ok;
    if (tc.expectBuyer)       ok = check('buyer',        e.buyer,       tc.expectBuyer)       && ok;
    if (tc.expectPriceGte !== undefined && tc.expectPriceLte !== undefined) {
      ok = checkRange('priceSol', e.priceSol, tc.expectPriceGte, tc.expectPriceLte) && ok;
    }
    if (tc.expectInstruction) {
      ok = check('instruction', (e.rawData as Record<string,unknown>)._instruction, tc.expectInstruction) && ok;
    }

    if (ok) {
      console.log(`   marketplace: ${e.marketplace}  nftType: ${e.nftType}`);
      console.log(`   mint:   ${e.mintAddress}`);
      console.log(`   seller: ${e.seller}`);
      console.log(`   buyer:  ${e.buyer}`);
      console.log(`   price:  ${e.priceSol.toFixed(6)} SOL (${e.priceLamports} lamports)`);
      console.log(`   ix:     ${(e.rawData as Record<string,unknown>)._instruction}`);
      pass++;
    } else {
      fail++;
    }
    console.log();
  }

  console.log(`${'═'.repeat(72)}`);
  console.log(`RESULT: ${pass} passed  ${fail} failed  (${CASES.length} total)`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
