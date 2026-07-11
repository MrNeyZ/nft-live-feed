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
import { extractCnftAssetId, extractCnftLeafTransferParties } from './price';
import { RawSolanaTx, RawInnerInstructionGroup, RawAccountKey } from './types';

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
  // ── TComp: bid accept (cNFT) — takeBidFullMeta ──────────────────────────────
  // Verified 2026-06-27 with the SOL-delta buyer/seller path; RE-VERIFIED and
  // CORRECTED 2026-07-11. The original expectSeller/expectBuyer below were
  // themselves the bug this fixture family exists to catch — they were the
  // tree_authority PDA and Tensor's bid-state PDA (largest SOL mover), not
  // real wallets. Confirmed on-chain via the inner Bubblegum `transfer` CPI:
  //   accounts[1] (leaf_owner)     = 8hGxFBBx...  (real seller)
  //   accounts[3] (new_leaf_owner) = HNXzkeUz...  (real buyer)
  // Old (wrong) values for reference: seller=4JdzLtiv96HEnpmpyN7ZdkupvZpZfSFRV6im7HUnsEXT
  // (tree_authority, 0 SOL delta), buyer=bc13nZZqVJN1XnwzzM5FGpdgo8M1d4htruAovvT1Td2
  // (bid-state PDA, -0.887 SOL delta — the largest decrease, not the bidder).
  {
    sig:               'Fd9Zr1Ah86L9fTSxBskWq864ZhxSrKoo42ge9HbihoZtYHCCTkmCnav8omLLT4QrLAoGEHs2uhqxwfLKdwNgVqA',
    label:             'TComp bid accept (cNFT) — takeBidFullMeta',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'cnft',
    expectSeller:      '8hGxFBBxuAUUx4Y3VshZ9ZfApv66RKZ4iZwD5uRqX6NM',
    expectBuyer:       'HNXzkeUzhsuBacwQm2V9HMYUxuYxNwT9RAFiSYAeSfwd',
    expectPriceGte:    0.886,
    expectPriceLte:    0.888,
    expectInstruction: 'takeBidFullMeta',
  },
  // ── TComp: bid accept (cNFT) — takeBidFullMeta — buyer attribution regression ──
  // Bug reported 2026-07-11 (asset CaixMh97YuL8jwLYRNqZyDsTckdaCqGgXKgMEFj6cYDC,
  // sold into a Tensor bid). UI/DB showed AtU1x2k6Tye7hauqEqQcFyGn6osmgVDHn2yNYVWPEdbx
  // as buyer — confirmed on-chain to be Tensor's TCMP-owned bid-state PDA
  // (426-byte account, -0.011 SOL delta = the largest decrease in the tx),
  // not the real bidder. Real buyer F7BDq8Ys... has a 0 SOL delta in THIS
  // transaction (funds were locked in an earlier place-bid tx) — the exact
  // reason SOL-balance-delta cannot be used for cNFT party identity.
  // Seller was also wrong (BNbqc6d85rgtBVSAoEfHkih7H4gZ7UPetHPAiW8y6xp6 —
  // the Bubblegum tree_authority PDA, same value repeats across every sale
  // from this tree; sellerAcctIdx=1 was pointing at the wrong account).
  // Root-caused via the inner Bubblegum `transfer` CPI: accounts[1]=seller,
  // accounts[3]=buyer, accounts[4]=merkle_tree (independently confirmed
  // on-chain against getAccountInfo ownership for all four accounts).
  {
    sig:               '2zA1R7rpdNZ1W18oLEYyESJvXGsuahUSu8fPfWPEJXxDqgXHQqToqkoUycQLkEq3ftxMNqg4TaLUgBszrGfJZmyT',
    label:             'TComp bid accept (cNFT) — takeBidFullMeta — buyer attribution regression',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'cnft',
    expectMint:        'CaixMh97YuL8jwLYRNqZyDsTckdaCqGgXKgMEFj6cYDC',
    expectSeller:      '9EvPPjNeSnR6xSNuJvMBTscn7PQrk1h86eW8KrcuwiBt',
    expectBuyer:       'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectPriceGte:    0.0109,
    expectPriceLte:    0.0111,
    expectInstruction: 'takeBidFullMeta',
  },
  // ── TComp: bid accept (cNFT) — same bug, different mint ─────────────────────
  // Second fixture proving the fix generalizes across mints sharing one bid/
  // tree, not just the one reported asset above — same real buyer/seller pair
  // (same standing bid filled against a different cNFT from the same tree in
  // a separate, near-simultaneous transaction), verified independently
  // on-chain against this signature's own Bubblegum transfer CPI.
  {
    sig:               'YrkiUx25KXfsnfJB958Kje4gD6517oFxSNmjyitu7ArFQk9MWK6xNkpvAwd861WZ7YvjVuP1vu6P3PemZMqoMsq',
    label:             'TComp bid accept (cNFT) — same bug, different mint',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'cnft',
    expectMint:        '31baL9RtKArFV4Qn7JA2csVNeXogHihLUt9XkHBP512v',
    expectSeller:      '9EvPPjNeSnR6xSNuJvMBTscn7PQrk1h86eW8KrcuwiBt',
    expectBuyer:       'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectPriceGte:    0.0109,
    expectPriceLte:    0.0111,
    expectInstruction: 'takeBidFullMeta',
  },
  // ── TComp: bid accept (cNFT) — takeBidMetaHash spot-check ───────────────────
  // Spot-checked 2026-07-11 to confirm the Bubblegum transfer account
  // mapping (accounts[1]=seller, accounts[3]=buyer) generalizes to the
  // takeBidMetaHash variant, not just takeBidFullMeta. Confirmed on-chain:
  // accounts[1]=4osDV9Qi... is the tx signer and receives the sale proceeds
  // (real seller); accounts[3]=GZCBDaMz... is a real System-owned wallet
  // with an existing balance (real buyer — receives only a small residual
  // credit here, the closed bid-state account's rent refund flowing back to
  // whoever funded it, consistent with the buyer having pre-funded the bid
  // earlier). The OLD stored buyer (8vLa347c...) is the SOL-delta "largest
  // decrease" pick — now a closed/deallocated account on-chain (getAccountInfo
  // returns null), consistent with it being the transient bid-state PDA, not
  // a wallet. tree_authority (accounts[0]=BNbqc6d85..., same PDA as the
  // takeBidFullMeta fixtures above) confirmed NOT the seller.
  {
    sig:               '5Z2tH8WnUCE3bQ2fFehTx2YGpLm2NJzzrvWKTB9TRFn6Q5VpPxkM6GXf4K9zN3bTPUq1H4tC2uvDjTA2sueZzHff',
    label:             'TComp bid accept (cNFT) — takeBidMetaHash',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'cnft',
    expectMint:        '8MPxmvR76pZCBa2pQu2FG4iRiXZs94jhMP2YnxGjAH5S',
    expectSeller:      '4osDV9QiKS4RFj3R7uNfHtLoo4GNwryWh9edmzzy8MTJ',
    expectBuyer:       'GZCBDaMzksdddbQQ3wgQMtNw4mpaBENUnDGK24aiouQc',
    expectPriceGte:    0.0737,
    expectPriceLte:    0.0740,
    expectInstruction: 'takeBidMetaHash',
  },
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
    expectInstruction: 'buyCore',
  },
  // ── TComp: bid accept (Metaplex Core) ───────────────────────────────────────
  // Verified 2026-04-14. Seller accepts an open bid on a Core NFT.
  // disc=fa29f8143da11b8d  seller=accounts[1]  buyer=accounts[3]  asset=accounts[8]
  {
    sig:               'P7w6yhSsAfLatJtCK8YWNWXXoxnpgsRP52vUS5uZ4Hx8gLVuLxUtj7NKqeQNNFVFpd4bs1XQNbDz25pGwnCyx8Y',
    label:             'TComp bid accept (Core) — original verified case',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'core',
    expectMint:        '5jDzkZ4bAi7cSXD77DFH5EyEatDEhFJ6Dtjn9dVGwJkS',
    expectSeller:      'sCeb9SPntztuJhWdgS2EV1zQ4yPzSV2MREoV42CQ1pq',
    expectBuyer:       'FbWci5AjRYAnfDxQ4LLrxyMohMkhqKDeaTN2XGHcZxkG',
    expectPriceGte:    0.001,
    expectPriceLte:    0.003,
    expectInstruction: 'takeBidCore',
  },
  // ── TComp: bid accept (Metaplex Core) — buyer attribution regression ────────
  // Bug sig reported 2026-06-27: UI displayed CF35yA75… (bid state PDA) as
  // buyer instead of 9QoTY9uz… (human bidder at accounts[3]).
  // Root cause: buyerAcctIdx was null → SOL-delta fallback → bid-state PDA wins
  // because it drains the largest SOL chunk. Fixed by setting buyerAcctIdx=3.
  {
    sig:               '3vPjmnhQeDvLeoNKZp1Vf3CnbWWRyar8BDXV7VYDAPhZT8iyxTT5hd9c4kaunSprtr4cnf4S9dhYs6tcsUE7Cvf5',
    label:             'TComp bid accept (Core) — buyer attribution regression',
    expectOk:          true,
    expectMarketplace: 'tensor',
    expectNftType:     'core',
    expectMint:        '21kiYZGcPw8Yvp2N1zmZ3TW4XJ5mQz1pgcrXrDtmNFiJ',
    expectSeller:      '8eL17LMY4XkxcLia8f7hk1Hq2gxsgS7UbzddoCCPwmD4',
    expectBuyer:       '9QoTY9uzSp6GfQUbgsFEW9ykRRNV8YqL4vRKjxLtD5Z4',
    expectPriceGte:    0.047,
    expectPriceLte:    0.049,
    expectInstruction: 'takeBidCore',
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
    // Pool owner at accounts[0] — updated from stale accounts[7] value when
    // sellerAcctIdx was corrected from 7→0 on 2026-05-28.
    expectSeller:      'FQ7Rut6csuvCAMa2y8omHtpmUw7D8KVJJcMTdoNHWEiD',
    expectPriceGte:    0.26,
    expectPriceLte:    0.28,
    expectInstruction: 'buy',
  },
];

// ─── Synthetic fail-closed checks (no RPC — malformed/missing Bubblegum
//     transfer must never crash extractCnftAssetId / extractCnftLeafTransferParties) ──

function minimalTx(accountKeys: RawAccountKey[], innerInstructions: RawInnerInstructionGroup[]): RawSolanaTx {
  return {
    signature: 'synthetic',
    blockTime: 1_700_000_000,
    slot: 1,
    transaction: {
      signatures: ['synthetic'],
      message: { accountKeys, instructions: [] },
    },
    meta: {
      err: null,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions,
    },
  };
}

function runSyntheticChecks(): boolean {
  console.log(`${'─'.repeat(72)}`);
  console.log('Synthetic fail-closed checks (malformed/missing Bubblegum transfer)');
  let ok = true;

  // No inner instructions at all.
  const txNoInner = minimalTx([], []);
  ok = check('extractCnftAssetId(no inner ix)', extractCnftAssetId(txNoInner), null) && ok;
  ok = check('extractCnftLeafTransferParties(no inner ix)', extractCnftLeafTransferParties(txNoInner), null) && ok;

  // Bubblegum programId present but data too short to be a `transfer` ix.
  const txShortData = minimalTx(
    [{ pubkey: 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', signer: false, writable: false }],
    [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [0, 0, 0, 0, 0, 0, 0, 0], data: 'ab' }] }],
  );
  ok = check('extractCnftAssetId(malformed data)', extractCnftAssetId(txShortData), null) && ok;
  ok = check('extractCnftLeafTransferParties(malformed data)', extractCnftLeafTransferParties(txShortData), null) && ok;

  console.log(ok ? '  ✅ all synthetic checks passed\n' : '  ✗ synthetic checks failed\n');
  return ok;
}

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

  if (!runSyntheticChecks()) fail++; else pass++;

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
