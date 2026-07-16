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
  /** Upper bound (inclusive, SOL) for the DISPLAYED price the feed renders:
   *  `sellerNetPriceSol ?? priceSol` (see frontend price-mode.ts / from-backend.ts).
   *  Regression guard for the listing-escrow rent-refund overcount — seller-net
   *  must not exceed gross, else it surfaces a price inflated by reclaimed rent. */
  expectDisplayPriceLte?: number;
  /**
   * Tri-state AMM-fill regression guard (see parser.ts "Synchronous AMM-fill
   * classification" + sale-event-adapters.ts ammFillFromRawData):
   *   true    → rawData._ammFill must be exactly `true`  (confirmed AMM fill, lp_fee>0)
   *   false   → rawData._ammFill must be exactly `false` (confirmed lp_fee===0 bid accept)
   *   'absent' → rawData._ammFill key must be MISSING entirely (no lp_fee evidence —
   *              e.g. fulfillSell direction, or cNFT which never emits an lp_fee log)
   */
  expectAmmFill?: true | false | 'absent';
  /**
   * MMM pool sniper regression guard (2026-07-16): the exact MMM pool
   * state PDA (`programs.ts`'s `poolAcctIdx`), or `null` for a non-MMM
   * sale / an unverified instruction variant. Must come straight from the
   * verified parser output — never derived from `buyer`.
   */
  expectPoolAddress?: string | null;
}

const CASES: TestCase[] = [
  {
    sig:               '2XzShACVyFDvVuER4m1jwSB2XhA9eai4dHt8Jiyjai5cp9QHx4uwHbH28RyBLji8gui396jqpgsGxpT4XKFRE8w9',
    label:             'pNFT sale (ME v2 — mip1ExecuteSaleV2)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'pnft',
    expectMint:        'AjHfKN7Hctf77n5QmHysQoinwewvFwpw3eGJBzZHge7e',
    // Seller updated 2026-06-27: old expectation was '1BWutmT…' — the ME V2
    // program-owned escrow returned by the stale token-flow path. Current
    // SOL-flow path returns the human seller wallet (largest SOL increase).
    expectSeller:      '5vRZm79bLvWBfC8D5EHnQ3gFs8JamgDe8x1ga6gj73HT',
    expectBuyer:       '4KMMoffzUMnQZ1dP8WqPW6PB9L8cDEpVcUDPbhWh7q1t',
    // Canonical ME log price = 0.27 SOL exactly. Previous range [0.28, 0.31]
    // tracked the buyer GROSS outflow (0.290961512 = price + royalty + fee +
    // network fee); the parser now reads the explicit `"price":270000000` log.
    expectPriceGte:    0.2699,
    expectPriceLte:    0.2701,
    expectInstruction: 'mip1ExecuteSaleV2',
  },
  {
    sig:               '5V2uBoC3aGMzgCzhjAUWrXTvStn5JaJevS8pJ5J1UtmCJVdFo1bvRAW7C6cAsQv51fenKeU9vKQNXcTLFGpNgTbi',
    label:             'pNFT lucky-buy (ME v2 — mip1ExecuteSaleV2 via LUCK57 wrapper)',
    expectOk:          true,
    expectMarketplace: 'magic_eden',
    expectNftType:     'pnft',
    expectMint:        'FUREcNG6XfXxarYMtFLQYHaeMghJL8Y6LC2MpLmbsWqg',
    // Seller updated 2026-06-27: same stale '1BWutmT…' ME escrow issue as tx1.
    // SOL-flow returns the human seller wallet.
    expectSeller:      '6yrqo2X4udNDdxDYmHnMy291Kxg6z8ZV66nNvaem8e7g',
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
    // Mint updated 2026-06-27: old value '6iJacFap…' was from a stale global
    // account-index assumption. extractCoreAssetFromInnerIx returns accounts[0]
    // of the first MPL Core inner CPI — the actual on-chain Core asset ID.
    expectMint:        '275SXu4SBhvn7a1L12imggsD9UaMDbUrUvp2yG5g9vyE',
    expectSeller:      '7VzKwP6CoW6QAhbVaWNjB1NTfgTVefbFAQhsvxVdGB7X',
    // Buyer = accts[1] = pool OWNER wallet (verified — System-owned,
    // equals the pool-state account's own `owner` field), NOT the pool
    // PDA itself — see programs.ts's MmmIxDef.buyerAcctIdx doc comment.
    // Corrects this comment's prior "pool state PDA" claim (2026-07-16) —
    // that was exactly the buyer/pool-account conflation the MMM pool
    // sniper audit flagged. The actual pool account is `expectPoolAddress`
    // below (accts[4], independently verified live 2026-07-11).
    expectBuyer:       'G9PjBZyNh7KfeYP8cQK3CTLWLZoWFqTC4UnwFimrxB21',
    expectPoolAddress: '6iJacFapFHHEs9KZAwwRYhJuyztrN5XE8qqhBq9X8TjH',
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
    expectPoolAddress: 'MubTKw97Ez5qzASEfLqQSaSMEJSX4rYskYLDaSJyQs4',
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
    // Mint updated 2026-06-27: same stale index issue as coreFulfillBuy tx1.
    // Correct value from extractCoreAssetFromInnerIx (MPL Core inner CPI).
    expectMint:        '8uXKrSUTpJBgxmSHLTYaogToY86uVPGpVeFcVNYwG3oe',
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
    // Price range updated 2026-06-27: old [0.33, 0.36] was incorrect.
    // Actual = 0.312885 SOL (pool vault receipt, largest positive SOL delta).
    expectPriceGte:    0.31,
    expectPriceLte:    0.32,
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
    // Price range updated 2026-06-27: old [0.06, 0.07] was incorrect.
    // Actual = 0.054475 SOL (pool owner SOL receipt, largest positive delta).
    expectPriceGte:    0.054,
    expectPriceLte:    0.056,
    expectInstruction: 'solMip1FulfillSell',
    // Unaffected fulfillSell variant: _ammFill is only computed for the
    // fulfillBuy direction (see parser.ts) — fulfillSell must never carry
    // the key, confirming the AMM-fill fix doesn't touch pool-buy sales.
    expectAmmFill:     'absent',
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
  // ── 2026-06-13: listing-escrow rent-refund overcount regression ──────────────
  // Reported: feed showed 0.013 SOL; true listing/sale price is 0.0099 SOL.
  // Root cause: seller's listing PDA is closed in-tx and its ~0.003564 SOL
  // rent/deposit is refunded to the seller wallet, inflating the raw seller
  // lamport delta (0.013465) above the real proceeds. The parser drops
  // seller-net when it exceeds the canonical price, so the displayed price
  // (sellerNet ?? priceSol) falls back to priceSol.
  // 2026-06-13 (log-price fix): priceSol is now the explicit ME log price
  // (`"price":9900000` = 0.0099), not the buyer GROSS (0.010111873 = price +
  // taker fee 198000 + network fee). Both render "not 0.013"; 0.0099 is the
  // true on-chain list price. The prior [0.0100,0.0102] band tracked gross.
  {
    sig:                 '3WkwA8QBgnqKwhfpnUBCrSjFXYY7LS2dQh1LNJsSG6wogv1nFDqJLJK245sgnVQVe4Stc2a3YvK7sXrEqD4ia3mm',
    label:               'Core listing purchase — rent-refund overcount (ME v2 — coreExecuteSaleV2)',
    expectOk:            true,
    expectMarketplace:   'magic_eden',
    expectNftType:       'core',
    expectSeller:        'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectBuyer:         '9YDQ9MYusBAdjhEEAzR8uRdUQrc8S6oaPfWfgGFUpiTy',
    expectPriceGte:      0.0098,
    expectPriceLte:      0.0100,
    expectDisplayPriceLte: 0.0100, // before fix: 0.013465 (seller-net) → FAIL
    expectInstruction:   'coreExecuteSaleV2',
  },
  // ── 2026-06-13: log-price fix — buyer-gross fallback overcount ────────────────
  // Reported: feed showed 0.015 SOL; true ME list/sale price is 0.014.
  // Root cause: seller's listing PDA rent (~0.003564) refunded in-tx inflated
  // seller-net to 0.017563520 > price, so the rent-refund guard dropped it and
  // the display fell back to the buyer GROSS (0.015279685 = price 14000000 +
  // royalty 966000 + taker fee 280000 + network fee 33685) → 0.015. The parser
  // now reads the explicit ME settlement log `"price":14000000` → priceSol
  // 0.014, and the dropped seller-net falls back to that canonical price.
  {
    sig:                 '21V7qFKDykbnTLaaPU556Hrii2PEuEnrXgxwpcUGHjdCManefpG3zBpotN8zW7a35Y7zKvna6jmpykNMH33nT5pu',
    label:               'Core listing purchase — gross-fallback overcount (ME v2 — coreExecuteSaleV2)',
    expectOk:            true,
    expectMarketplace:   'magic_eden',
    expectNftType:       'core',
    expectSeller:        '9oBbApTGE65kLPiU17m5mCPqmQxgegssktUjkhvJwyDL',
    expectBuyer:         '6wFyqABzLpmVun7cBExwdAxTEpjicSbxVNYH5JNqXfmX',
    expectPriceGte:      0.01399,
    expectPriceLte:      0.01401,
    expectDisplayPriceLte: 0.01401, // before fix: 0.015279685 (gross) → FAIL
    expectInstruction:   'coreExecuteSaleV2',
  },
  // ── 2026-07-11: MMM bundled CancelSell rent-refund overcount regression ──────
  // Reported: feed showed ~0.0116 SOL; true MMM sale price (program log
  // total_price) is 0.00826 SOL. Root cause: an unrelated ME v2 `CancelSell`
  // (delisting a stale listing on the same NFT) is bundled in the same tx as
  // the MMM `solFulfillBuy`, closing two PDAs and refunding their rent
  // (~0.0056 SOL combined) to the seller's wallet. computeSellerNetLamports
  // read the seller's whole-tx balance delta (0.011642646), which the MMM
  // parser previously used unclamped. Same rent-refund guard as the
  // coreExecuteSaleV2 case above (`cleanSellerNet`) now applies here too:
  // seller-net above the canonical priceLamports (MMM log total_price) is
  // dropped, so the display falls back to the correct gross price.
  {
    sig:                 '4XtV5LU5zfRkmKavGvrLGfXF9J19P7ZytUfguSovf8XDv2yahefqte9kQ6VmeV6hq3gcir9jy6cnzfjNwE4iEPn3',
    label:               'Legacy bid-sale — bundled CancelSell rent-refund overcount (MMM — solFulfillBuy)',
    expectOk:            true,
    expectMarketplace:   'magic_eden_amm',
    expectNftType:       'legacy',
    expectSeller:        'HSqg6QEjbK5e2hpAGsC4nBqNZxq4ZRaPc15RVK3ciB3M',
    expectBuyer:         'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectPriceGte:      0.00825,
    expectPriceLte:      0.00827,
    expectDisplayPriceLte: 0.00827, // before fix: 0.011642646 (contaminated seller-net) → FAIL
    expectInstruction:   'solFulfillBuy',
  },
  // ── 2026-07-15: false plain-SELL badge on MMM fulfillBuy AMM fills ───────────
  // Root cause: the AMM badge depended solely on mmm-pool-type-resolver's
  // async ME `/mmm/pools` lookup (poolType==='two_sided'), which is a) never
  // exposed to REST/reload reads at all, and b) can be wrong/stale/unknown
  // even for live SSE. Both signatures below are REAL fulfillBuy AMM pool
  // fills (lp_fee > 0 on-chain, independently confirmed 2026-07-15 — see
  // parser.ts) that a plain poolType lookup mis- or under-classified:
  //   3VYqF8s6… — ME's own API DID classify this pool `two_sided` (so the
  //               old rule happened to work here, by luck of ME's lookup).
  //   5G5YJiVf… — ME's API could NOT classify this pool at all (not found /
  //               invalid / lookup failure) — the old rule would show plain
  //               SELL despite this being a genuine AMM fill.
  // Fix: `_ammFill` is derived synchronously from the on-chain lp_fee log at
  // parse time, independent of whether (or how) ME's API classifies the pool.
  {
    sig:               '3VYqF8s6XKK9bSuhFF82A4MztYZAvVwNvat5Z6dG71KfAF3iEAN7MZNK3zWMqp4cmDpDY2madNYauD8DhkNp7mEa',
    label:             'REPORTED REGRESSION: AMM fill, pool ME classified two_sided (MMM — solMip1FulfillBuy)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'pnft',
    expectSeller:      'Ft6UZYLKh3AZAUij3sdM4ZTT1ibvxbW23CyhcrsPZFc3',
    expectBuyer:       '6Fvwa3cPPQPhPBFx5vqr9QJ3qJJ7e1Ai21vDP1FBrDHc',
    expectPoolAddress: '83Suja4NhNANKdYy3F47yuyV7V5TuGv7NByQ23dvbMCx',
    expectInstruction: 'solMip1FulfillBuy',
    expectAmmFill:     true,
  },
  {
    sig:               '5G5YJiVfFxBzeHNJCNgv5JH3fEajxaf9iPJFvT7iNRobATBrN9CeUqPG3kepmyyL9KoB8RvuyufG9huczHiEQN3P',
    label:             'REPORTED REGRESSION: AMM fill, pool unresolvable via ME poolType (MMM — coreFulfillBuy)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    expectSeller:      'Ft6UZYLKh3AZAUij3sdM4ZTT1ibvxbW23CyhcrsPZFc3',
    expectBuyer:       'H6B1xriQkPSgpKAfLrTexDWtnuNGga77wGNnuJzwnY3G',
    expectInstruction: 'coreFulfillBuy',
    expectAmmFill:     true,
  },
  // ── Ordinary bid acceptances (lp_fee===0) — must render plain SELL, never AMM ──
  {
    sig:               '57uuQJLbQRZfXoSnueSKEQtR4G4nWTHBN3PCtNajm1PdVjzWQCHa8yn33xQD4ieow3AL996tVoigyYokkNx3kB3s',
    label:             'Ordinary bid acceptance #1 (MMM — solFulfillBuy, trait-filtered, lp_fee=0)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'legacy',
    expectBuyer:       'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',
    expectInstruction: 'solFulfillBuy',
    expectAmmFill:     false,
  },
  {
    sig:               '2cdam8rLjxCCAmW53ZTcFU4E9orPstjyP4oJtVhydT3z6anszEwripjf1mf5zUCqPz5HMeViNoEDLfvcow5ULdi5',
    label:             'Ordinary bid acceptance #2 (MMM — coreFulfillBuy, lp_fee=0)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'core',
    expectSeller:      'FRNfEknDZekTSMDQXQiLLwPDgx23ywPEx4zsxJXGv2Fu',
    expectBuyer:       '7VzKwP6CoW6QAhbVaWNjB1NTfgTVefbFAQhsvxVdGB7X',
    expectInstruction: 'coreFulfillBuy',
    expectAmmFill:     false,
  },
  // ── Malformed/missing lp_fee — fail-closed, never throws ─────────────────────
  // cnftFulfillBuy never emits an lp_fee log line at all (confirmed live
  // 2026-07-15) — this is the real-world "missing evidence" case: `_ammFill`
  // must be entirely absent (not false) so the frontend still allows a
  // poolType fallback rather than asserting a false negative.
  {
    sig:               'GzD8n1Mvt2rAjLU9xjWBD3eYfGwjnBk81HkHyFqxk7Qopq7n5NkFwEWoq7xrDR3ErbXbshg8dfnWvXEZqxjZjEk',
    label:             'Missing lp_fee evidence — fail-closed (MMM — cnftFulfillBuy)',
    expectOk:          true,
    expectMarketplace: 'magic_eden_amm',
    expectNftType:     'cnft',
    expectInstruction: 'cnftFulfillBuy',
    expectAmmFill:     'absent',
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
    if (tc.expectDisplayPriceLte !== undefined) {
      // Mirror the feed's render value: sellerNetPriceSol ?? priceSol.
      const displayPrice = e.sellerNetPriceSol ?? e.priceSol;
      ok = checkRange('displayPrice', displayPrice, 0, tc.expectDisplayPriceLte) && ok;
    }
    if (tc.expectAmmFill !== undefined) {
      const raw = e.rawData as Record<string, unknown>;
      if (tc.expectAmmFill === 'absent') {
        ok = check('_ammFill (absent)', '_ammFill' in raw, false) && ok;
      } else {
        ok = check('_ammFill', raw._ammFill, tc.expectAmmFill) && ok;
      }
    }
    if (tc.expectPoolAddress !== undefined) {
      ok = check('poolAddress', e.poolAddress ?? null, tc.expectPoolAddress) && ok;
    }
    // Universal regression guard (2026-07-16): every successfully parsed
    // event must carry parserReceivedAt — see parseRawMeTransaction's
    // `stamp()` helper. Not gated behind a per-case flag since it applies
    // unconditionally, unlike the sale-family-specific fields above.
    ok = check('parserReceivedAt is set', e.parserReceivedAt instanceof Date, true) && ok;

    if (ok) {
      console.log(`   marketplace: ${e.marketplace}  nftType: ${e.nftType}`);
      console.log(`   mint:   ${e.mintAddress}`);
      console.log(`   seller: ${e.seller}`);
      console.log(`   buyer:  ${e.buyer}`);
      console.log(`   price:  ${e.priceSol.toFixed(6)} SOL (${e.priceLamports} lamports)`);
      console.log(`   ix:     ${(e.rawData as Record<string,unknown>)._instruction}`);
      console.log(`   pool:   ${e.poolAddress ?? 'null'}`);
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
