/**
 * Stage 2 replay test for the ME raw parser.
 *
 * Fetches the 8 ground-truth sale transactions from RPC and runs each one
 * through parseRawMeTransaction() to verify the normalized SaleEvent output.
 *
 * Expected outcome per transaction is documented inline.
 * Failures print the reason so you can see exactly which field went wrong.
 *
 * Run: npx ts-node src/ingestion/me-raw/replay-test.ts
 */
import 'dotenv/config';
import { parseRawMeTransaction } from './parser';
import { RawSolanaTx } from './types';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// ─── RPC ──────────────────────────────────────────────────────────────────────

async function getTx(sig: string): Promise<RawSolanaTx | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [sig, {
        // Use raw 'json' encoding so instructions keep programIdIndex (number) and
        // accounts as number[] — the format RawSolanaTx / decoder.ts expect.
        // With 'jsonParsed', custom-program instructions get programId (string) and
        // accounts as string[], which would break the decoder's index-based lookups.
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

  // Versioned (v0) transactions load accounts from address lookup tables.
  // With raw 'json' encoding these come back in meta.loadedAddresses rather
  // than in transaction.message.accountKeys.  All programIdIndex and accounts[]
  // values in instructions reference the FULL combined array:
  //   [static accountKeys, loadedAddresses.writable, loadedAddresses.readonly]
  //
  // We merge them here so every index-based lookup in the decoder works
  // correctly, whether the account is static or from a lookup table.
  // For legacy (non-versioned) transactions, loadedAddresses is absent/empty
  // and this is a no-op.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = (tx.meta as any)?.loadedAddresses ?? {};
  const loadedWritable: string[] = loaded.writable ?? [];
  const loadedReadonly:  string[] = loaded.readonly  ?? [];

  tx.transaction.message.accountKeys = [
    ...staticKeys.map((k: string | { pubkey: string }) =>
      typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : k
    ),
    ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true  })),
    ...loadedReadonly.map( (pk: string) => ({ pubkey: pk, signer: false, writable: false })),
  ];

  // getTransaction does not include signature at the top level — inject it.
  tx.signature = sig;
  return tx as RawSolanaTx;
}

// ─── Test cases ───────────────────────────────────────────────────────────────

interface TestCase {
  sig:          string;
  label:        string;
  expectOk:     boolean;
  // When expectOk=true, these are verified against the parsed event.
  expectMarketplace?: string;
  expectNftType?:     string;
  expectMint?:        string;
  expectSeller?:      string;
  expectBuyer?:       string;
  /** Min price in SOL (inclusive) for a range check. */
  expectPriceGte?: number;
  /** Max price in SOL (inclusive) for a range check. */
  expectPriceLte?: number;
  expectInstruction?: string;
}

const CASES: TestCase[] = [
  {
    sig:               '2XzShACVyFDvVuER4m1jwSB2XhA9eai4dHt8Jiyjai5cp9QHx4uwHbH28RyBLji8gui396jqpgsGxpT4XKFRE8w9',
    label:             'pNFT sale (ME v2 — mip1ExecuteSaleV2)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'pnft',
    expectMint:        'AjHfKN7Hctf77n5QmHysQoinwewvFwpw3eGJBzZHge7e',
    expectSeller:      '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix',
    expectBuyer:       '4KMMoffzUMnQZ1dP8WqPW6PB9L8cDEpVcUDPbhWh7q1t',
    expectPriceGte:    0.28,
    expectPriceLte:    0.31,
    expectInstruction: 'mip1ExecuteSaleV2',
  },
  {
    sig:               '5V2uBoC3aGMzgCzhjAUWrXTvStn5JaJevS8pJ5J1UtmCJVdFo1bvRAW7C6cAsQv51fenKeU9vKQNXcTLFGpNgTbi',
    label:             'pNFT lucky-buy (ME v2 — mip1ExecuteSaleV2 via LUCK57 wrapper)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'pnft',
    expectMint:        'FUREcNG6XfXxarYMtFLQYHaeMghJL8Y6LC2MpLmbsWqg',
    expectSeller:      '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix',
    expectBuyer:       '2vpDHF3TUMe6Jd4MkbKViDKdgkgwWz3GtWsHU25uUvEW',
    expectPriceGte:    0.01,
    expectPriceLte:    0.05,
    expectInstruction: 'mip1ExecuteSaleV2',
  },
  {
    sig:      'QTGPCUYbQW89JBtwq8YUSUGJKozGUDqmnDEanqMFsN3a9fHTL4Aqh6Gi86jh11aVAoBmV9dKPYMtzm52iPYQepX',
    label:    'Tensor Core sale — expect SKIP (no ME program)',
    expectOk: false,
  },
  {
    sig:               '4ppESjBcfkv66Nb4RZHECchAx8bCZpdfAyTD9sKM5jbhLYZ26U71YEx4Vu14dRuV6vxzTxneRdBaeg3X5yyTTVQx',
    label:             'Core bid-sale (MMM — coreFulfillBuy, sell into pool)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    expectMint:        '6iJacFapFHHEs9KZAwwRYhJuyztrN5XE8qqhBq9X8TjH',
    expectSeller:      '7VzKwP6CoW6QAhbVaWNjB1NTfgTVefbFAQhsvxVdGB7X',
    // Buyer = pool state PDA (accs[1]) — best available pool identifier
    expectBuyer:       'G9PjBZyNh7KfeYP8cQK3CTLWLZoWFqTC4UnwFimrxB21',
    expectPriceGte:    0.013,
    expectPriceLte:    0.016,
    expectInstruction: 'coreFulfillBuy',
  },
  {
    sig:               '4hcnU6GiUDkna95vNuVuGih945fcsXMMo8Fe5RQ2y8xitntx9whMrjYrrEPfLdCCYfm1fgr7XMCreBnqzM6t2oaQ',
    label:             'Legacy bid-sale (MMM — solFulfillBuy, sell into pool)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'legacy',
    expectMint:        '4juWhaivqQdvL5BzVqXGxZydUb2Ey7ceFAxHH5uciTHF',
    expectSeller:      'Gzbr5P6sJo5HtQzgdjMnNNfaTv2bervcTHFNQ8Yjjjsa',
    expectBuyer:       'K7eHUegTXSjMdyKX5E4DWJsbQgNccHjZVSXECZfYiTR',
    expectPriceGte:    0.80,
    expectPriceLte:    0.85,
    expectInstruction: 'solFulfillBuy',
  },
  {
    sig:               '5jTqq33sK9Fzay8m54pWpyDvFEGHZ4T7v4Nyzosqp1SVgSzkKnjumL1tiMMKv9SeLTFdxs79Uwmgg5N48QmR1LhJ',
    label:             'AMM Core — sell into pool (MMM — coreFulfillBuy)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    expectMint:        '7MFW4mNjWSaHfKK23wsb8pHtaVgh2JS4mXTJZjCFk4K8',
    expectSeller:      '39CaKopRVgVep24xd4tuV2jDE8h3VbMkfqb6sLUMKiN3',
    // Buyer = pool state PDA (accs[1])
    expectBuyer:       '6Fvwa3cPPQPhPBFx5vqr9QJ3qJJ7e1Ai21vDP1FBrDHc',
    expectPriceGte:    0.08,
    expectPriceLte:    0.09,
    expectInstruction: 'coreFulfillBuy',
  },
  {
    sig:               '348yTcaTcZFq1FrQmkfQdT2fM6XcMPFXCryVNUPBtwGNoSFwLo6hA7KTK843D4PCNmzfGpDzoxqZMhybLo7YDbWY',
    label:             'AMM Core — buy from pool (MMM — coreFulfillSell)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    // Mint corrected 2026-04-15: previous value ('Gimuhf...') came from the unverified
    // coreAssetIdx=4 assumption. Actual Core asset from MPL Core inner-CPI accounts[0].
    expectMint:        '3DdC5TKo9JGBkJEG4zi9hk3TVh2QnuETx31i22sJsPAe',
    expectBuyer:       '4UViG3skM7BAcLRQNrm3nJ6PLH7Ajb7ZQRRhJVdjKsUC',
    expectSeller:      'BUGzCKSywTEAFz1W1YYRCjYtuVNWk6YAR5HBGWdnRerh',
    expectPriceGte:    0.33,
    expectPriceLte:    0.36,
    expectInstruction: 'coreFulfillSell',
  },
  {
    sig:               '2rg9XUPcR4DLJ7cCfPf1wdxUZCAso8eMNhptqResaQWqG6Kne5L7SZEBJcJ6faJsXhRfFGemZj9fkMTvcGLkxeiX',
    label:             'AMM pNFT — buy from pool (MMM — solMip1FulfillSell)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'pnft',
    expectMint:        '7ia4RCikRVWztyXKfb6qP6z52hs3E6k4sxS14K3mMB3X',
    expectBuyer:       '5VHFDHwwnrJTf3z2zAVFFjqFZ8YH4bULb7CVn9bkJVyC',
    expectSeller:      'JAHgvPJCZu6SyGjHrtW3KJfuxxDjkf5p6JbYB5kbUsk2',
    expectPriceGte:    0.06,
    expectPriceLte:    0.07,
    expectInstruction: 'solMip1FulfillSell',
  },
  // ── 2026-04-15: coreExecuteSaleV2 — terminal action selection verified ────────
  // These txs contain Deposit + BuyV2 + CoreExecuteSaleV2.
  // The parser now correctly selects coreExecuteSaleV2 (terminal) and suppresses
  // the intermediate buyV2. Discriminator anchorDisc('core_execute_sale_v2') confirmed
  // live (2026-04-15). Mint via MPL Core inner CPI; buyer/seller via SOL flow.
  {
    sig:               '2KTu5TRKipTz58HxwnzfkJ8qM36qzJn83pxepWt5XvQZWRRdDdMSctZTYeaFNpfeN9b5v3r13bw1wRskTThKmgJs',
    label:             'Core listing purchase (ME v2 — coreExecuteSaleV2, tx1)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'core',
    expectMint:        '7tRkMhuuP7wjBMuV4cZ43XT9bRpCDGuRHRwvKNLJiWeQ',
    expectBuyer:       '9yhGC6RBMqeCVTDWRky2AmQJkC1HuYxnewD3aLrKB7iu',
    expectSeller:      'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectPriceGte:    0.006,
    expectPriceLte:    0.009,
    expectInstruction: 'coreExecuteSaleV2',
  },
  {
    sig:               '2bZoCmoKCiQ7qsp9tMfURxEY3RkPoMUnVxBf7sCFpzg5yFdEWaMYnVztKfSDY7yKJnHeYpv6MrXCAA3igRNs98vE',
    label:             'Core listing purchase (ME v2 — coreExecuteSaleV2, tx2)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'core',
    expectMint:        'CFNsqZqaTPsjLECKBXeigMW3vNLGRXKJVVY4UMQcvRSo',
    expectBuyer:       '9yhGC6RBMqeCVTDWRky2AmQJkC1HuYxnewD3aLrKB7iu',
    expectSeller:      '4osKgRS9yp5n2yDW8H7UgLsvmuFge3kA9xANJSJwSckM',
    expectPriceGte:    0.008,
    expectPriceLte:    0.012,
    expectInstruction: 'coreExecuteSaleV2',
  },
  {
    sig:               'nTgwSDwXUxRChV8gdJDzRaDiyq23ZqJD36Zm2NnDhneYusu6YR68UL1RcH4SrDKop8jxrdXEHHHuEtJ7AL7E9ni',
    label:             'Core AMM pool buy (MMM — coreFulfillSell, inner-ix asset extraction)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    // Core asset ID extracted from MPL Core inner-ix[0] accounts[0] (accounts[6] of outer ix)
    expectMint:        'CN1Vn9JfJbMgqtg2vfWSzGMn883pprqRt8xKBNqeaXEh',
    expectBuyer:       'HGnmeRB2gb3wEAjvDVTBSHvUiWPEr1naq1m5sw21Lj8m',
    expectSeller:      '9USXkk7U1mTaxjy4WpFTwL7rCE3iJBQAJ52EAXc14QCV',
    expectPriceGte:    0.004,
    expectPriceLte:    0.006,
    expectInstruction: 'coreFulfillSell',
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
  console.log('ME Raw Parser — Replay Test');
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

    const result = parseRawMeTransaction(tx);

    console.log(`${'─'.repeat(72)}`);
    console.log(`${result.ok ? '✅' : '❌'} ${tc.label}`);
    console.log(`   sig: ${tc.sig.slice(0, 32)}...`);

    if (!tc.expectOk) {
      if (!result.ok) {
        console.log(`   → correctly skipped: ${result.reason}`);
        pass++;
      } else {
        console.log(`  ✗ expected skip but got OK event — marketplace=${result.event.marketplace}`);
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
