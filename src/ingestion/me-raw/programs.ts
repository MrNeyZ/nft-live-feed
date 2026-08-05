import { createHash } from 'crypto';

// ─── Program addresses ────────────────────────────────────────────────────────

/** Magic Eden fixed-price marketplace. Handles legacy, pNFT/mip1, and Core sales. */
export const ME_V2_PROGRAM    = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
/** Magic Eden AMM (mmm pools). Open source: github.com/magiceden-oss/mmm */
export const ME_AMM_PROGRAM   = 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';
/** Magic Eden cNFT marketplace (separate program from ME v2 — handles
 *  Bubblegum compressed-NFT direct listings). The on-chain `buy_now`
 *  instruction CPIs into Bubblegum's leaf-replace path and emits the
 *  standard cNFT activity that ME's UI surfaces as a normal sale.
 *  Confirmed via the `wegens` collection coverage gap audit:
 *  7/8 recent sales (e.g. 3RggSHw8…, 2S8tP67Y…, 3iTTPC5B…) routed
 *  through this program and were invisible to our listener until it
 *  was added to the subscription list.  */
export const ME_CNFT_PROGRAM  = 'M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1';

// Supporting programs — used to classify asset type from inner instruction chain
export const TOKEN_METADATA_PROGRAM  = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const TOKEN_AUTH_RULES_PROGRAM = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
export const MPL_CORE_PROGRAM        = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const SPL_TOKEN_PROGRAM       = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SYSTEM_PROGRAM          = '11111111111111111111111111111111';
export const ATA_PROGRAM             = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bC';

/**
 * Magic Eden treasury / fee account.
 * Confirmed via live transaction inspection: appears at accounts[2] in all
 * MMM fill instructions, and accounts[3] in mip1ExecuteSaleV2.
 */
export const ME_TREASURY = 'NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd';

/**
 * Magic Eden "Lucky Buy" raffle program. Wraps a normal ME v2 sale ix
 * (Mip1ExecuteSaleV2 etc.) inside a `FulfillM2Mip1` top-level call: the
 * winner receives the NFT but only paid a small entry fee, while the
 * lucky-buy pool covers the listing settlement. Detected by presence
 * of this program in the tx's account keys; combined with a matched
 * ME v2 sale instruction, the signal is deterministic.
 *
 * Confirmed live (2026-04-30): tx
 * zqFqu45Xc...wM has LUCK57… as the only top-level instruction and
 * CPIs into ME v2's BuyV2 + Mip1ExecuteSaleV2.
 */
export const LUCKY_BUY_PROGRAM = 'LUCK57mxzZiRGF2PdHAY79P6tZ8Apsi381tKvBrTdqk';

/**
 * Magic Eden Packs program (`PCKj…`). Wraps a regular MMM
 * `solFulfillSell` (or sibling) inside its own `FulfillMmm` ix when a
 * user opens a Pack and one of the contained NFT cards is delivered
 * to them. We detect Pack-sourced sales the same way as Lucky Buy
 * — by program presence in the tx's account universe — and tag them
 * with `_subtype = 'pack_open'`. Confirmed against
 *   44QViqq6UiS3VX6jmM1QUN4crUJ3yAtXHYCnvqmgvtGvPatMoYNd9RjBBUg93jaJFDCmKqBwHZSG4G3vGaMm1x2R
 * (top-level ix = PCKj…, `Instruction: FulfillMmm`, CPIs into
 * MMM `SolFulfillSell`).
 */
export const ME_PACKS_PROGRAM = 'PCKjSaQaZb3AcmjTcb2fcLanh9Mky9ZvuaKqTBxsqWE';

// ─── Anchor discriminator helper ─────────────────────────────────────────────

/** Computes the 8-byte Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDisc(instructionName: string): Buffer {
  return createHash('sha256')
    .update(`global:${instructionName}`)
    .digest()
    .subarray(0, 8);
}

// ─── ME v2 instructions ───────────────────────────────────────────────────────

export interface MeV2IxDef {
  name: string;
  disc: Buffer;
  /**
   * true  = discriminator confirmed against a live completed-sale transaction.
   * false = discriminator computed but not yet seen in a verified sale tx.
   */
  verified: boolean;
  /**
   * For MPL Core instructions: instruction-accounts index of the Core asset ID.
   * null for legacy / pNFT — derive mint from SPL token-balance changes instead.
   */
  coreAssetIdx: number | null;
  /**
   * Instruction-accounts index of the human buyer wallet, for variants where
   * token-flow (extractPartiesFromTokenFlow) structurally cannot resolve a
   * buyer — i.e. MPL Core sales, which have no SPL token-balance entries at
   * all. null = not verified for this variant; parser falls back to the
   * legacy SOL-flow heuristic (extractPaymentInfo — "largest SOL decrease").
   *
   * 2026-08-05 bug (reported live, sigs 5S3SApzu…/2TS9ugwN…/t9WL1dm2…):
   * ME v2's `Deposit → BuyV2 → CoreExecuteSaleV2` flow lets a buyer draw
   * from a PERSONAL ESCROW PDA that can carry a standing balance across
   * transactions. When the escrow's single-instruction outflow (a
   * near-constant ~3.56M-lamport figure observed across samples) exceeds
   * the signer's own fresh top-up in THIS tx, "largest SOL decrease" picks
   * the escrow PDA — a program-owned account with no signing authority of
   * its own — instead of the real buyer. See parser.ts's `resolveCoreBuyer`
   * for the fix and its safety gating (excludes Lucky-Buy-style relayed
   * transactions, where accounts[0] is ME's own treasury, not the buyer;
   * requires the candidate to independently verify as a real tx signer).
   */
  buyerAcctIdx: number | null;
}

// ─── Instruction priority ─────────────────────────────────────────────────────
//
// Only TERMINAL sale instructions are listed here.  Intermediate / offer-style
// actions (buyV2 deposit, etc.) are intentionally omitted — they are not real
// completed sales and must not produce sale events.
//
//  1. coreExecuteSaleV2  — Core NFT listing purchase (terminal)
//  2. mip1ExecuteSaleV2  — pNFT/mip1 listing purchase (terminal)
//  3. executeSaleV2      — legacy listing purchase v2 (terminal)
//  4. executeSale        — legacy listing purchase v1 (terminal)
//
// buyV2 is NOT here: it is a deposit/offer step, never a completed sale.
//
// ─────────────────────────────────────────────────────────────────────────────

export const ME_V2_SALE_INSTRUCTIONS: MeV2IxDef[] = [
  {
    // ✅ Confirmed live (2026-04-15): anchorDisc matches observed txs.
    //    coreAssetIdx=null → extractCoreAssetFromInnerIx().
    // ✅ buyerAcctIdx=0 confirmed 2026-08-05, but ONLY for the buyer-initiated
    // `Deposit → BuyV2 → CoreExecuteSaleV2` flow — accounts[0] there is the
    // tx signer/fee-payer AND the true buyer, cross-checked against 15+
    // independent live transactions (14/15 direct matches; the one mismatch
    // was itself a bug fixture below). Confirmed bug fixtures where the OLD
    // SOL-flow heuristic picked the escrow PDA and accounts[0] resolves the
    // true buyer instead:
    //   5S3SApzuL3iSCwg6nG28QHwVW3rFjT6wh5DnaG76Hy98RDyTHpPpSnK5Q6WNbmDh1iFtHvUdzYW3PDDYu7SbueLn
    //   5Nsxwxf4BGmtivwy85k15K3Nh3daX1VvgbRPh6ekY1gsFk1FaUFFuFjt2a5kds2oar3brU77MzZstyTXp7QESQtj
    // IMPORTANT — accounts[0] is NOT universally the buyer for this
    // instruction: a SELLER-initiated `CoreSell → CoreExecuteSaleV2` flow
    // (filling an existing standing bid) ALSO matches this discriminator,
    // with accounts[0] = the LISTING SELLER instead (confirmed live on sig
    // t9WL1dm2juFBecShy7ZbeReZYHz7PQRjofq743eUyA43bzHLTUdWvSNA7jpVjovMWy6hAkYhNcCrPVhasY75EbY,
    // where accounts[0] received +0.1995 SOL). parser.ts's `resolveCoreBuyer`
    // guards against this — see its doc for the full gating (excludes Lucky
    // Buy relays; requires a real signer; requires a net non-positive SOL
    // delta on the candidate, which is what actually distinguishes the two
    // flows without needing to detect the preceding CoreSell/BuyV2 ix).
    name: 'coreExecuteSaleV2',
    disc: anchorDisc('core_execute_sale_v2'),
    verified: true,
    coreAssetIdx: null,
    buyerAcctIdx: 0,
  },
  {
    // ⚠️ Unverified: non-V2 Core execute sale; may exist for older ME Core listings.
    // buyerAcctIdx left null — no live example to confirm the layout matches
    // coreExecuteSaleV2's; falls back to the SOL-flow heuristic (fail closed).
    name: 'coreExecuteSale',
    disc: anchorDisc('core_execute_sale'),
    verified: false,
    coreAssetIdx: null,
    buyerAcctIdx: null,
  },
  {
    // ✅ Confirmed: discriminator seen in pNFT sale + pNFT lucky-buy (2026-04-14).
    // buyerAcctIdx left null — NOT needed: pNFT/mip1 sales have real SPL
    // token-balance entries, so `tkBuyer` (token-flow, already the primary
    // signal ahead of the SOL-flow fallback) resolves them correctly. The
    // 2026-08-05 bug is specific to MPL Core, which has no token balances.
    name: 'mip1ExecuteSaleV2',
    disc: anchorDisc('mip1_execute_sale_v2'),  // eca3ccad4790eb76
    verified: true,
    coreAssetIdx: null,
    buyerAcctIdx: null,
  },
  {
    // ⚠️ Unverified: computed discriminator; no live tx observed yet.
    name: 'executeSaleV2',
    disc: anchorDisc('execute_sale_v2'),        // 5bdc31dfcc8135c1
    verified: false,
    coreAssetIdx: null,
    buyerAcctIdx: null,   // legacy SPL — token-flow already resolves buyer
  },
  {
    // ⚠️ Unverified: computed discriminator; no live tx observed yet.
    name: 'executeSale',
    disc: anchorDisc('execute_sale'),           // 254ad99d4f312306
    verified: false,
    coreAssetIdx: null,
    buyerAcctIdx: null,   // legacy SPL — token-flow already resolves buyer
  },
];

// ─── ME AMM (mmm) instructions ────────────────────────────────────────────────
//
// Verification status (2026-04-14):
//   solFulfillBuy      ✅ discriminator matches computed; account layout confirmed
//   solMip1FulfillSell ✅ discriminator matches computed; account layout confirmed
//   coreFulfillBuy     ✅ discriminator observed in live tx; computed name DOES NOT match
//   coreFulfillSell    ✅ discriminator observed in live tx; computed name DOES NOT match
//   solFulfillSell     ⚠️ discriminator computed but NOT yet observed in live tx
//   solMip1FulfillBuy  ⚠️ discriminator computed but NOT yet observed in live tx
//
// Direction semantics:
//   fulfillBuy  = user SELLS NFT into the pool  (pool is the buyer)
//   fulfillSell = user BUYS NFT from the pool   (pool is the seller)

export interface MmmIxDef {
  name: string;
  disc: Buffer;
  direction: 'fulfillBuy' | 'fulfillSell';
  /**
   * Verified instruction-accounts index for the human seller.
   * null = not confirmed from live data; parser falls back to token-flow / SOL-flow.
   */
  sellerAcctIdx: number | null;
  /**
   * Verified instruction-accounts index for the human buyer.
   * null = not confirmed from live data; parser falls back to token-flow / SOL-flow.
   * For the fulfillBuy variants buyerAcctIdx points to the pool owner / bidder
   * wallet: accounts[1] IS that real buyer wallet (verified — it equals the
   * pool-state account's owner field, and is System-owned), NOT the pool PDA.
   * The pool state PDA is a separate instruction account.
   */
  buyerAcctIdx: number | null;
  /**
   * For MPL Core instructions: instruction-accounts index of the Core asset ID.
   * null for legacy / pNFT — derive the SPL mint from token-balance changes instead.
   */
  coreAssetIdx: number | null;
  /**
   * Instruction-accounts index of the MMM **pool state PDA** — the account
   * ME's own `/mmm/pools` API keys by `poolKey` (NOT the pool owner's
   * wallet — that's `buyerAcctIdx`/`sellerAcctIdx` above, a different
   * account). Independently verified 2026-07-11 by fetching a real
   * confirmed transaction for each instruction and checking which
   * outer-ix account is owned by the MMM AMM program
   * (`mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc`) with data length 849
   * (`POOL_SIZE` in `tools-mmm-pools.ts`) — NOT assumed from the
   * buyer/seller comments above, several of which mislabel a wallet
   * account as "pool-state-PDA" (e.g. this file's old solMip1FulfillSell
   * comment claimed accts[1]; live evidence shows accts[1] is a plain
   * System-owned wallet and the real pool account is at accts[4]).
   * null = not independently verified for this variant — the parser
   * leaves `poolAddress` null rather than guess, so it fails closed
   * (no AMM badge) instead of risking a wrong classification.
   */
  poolAcctIdx: number | null;
}

export const MMM_SALE_INSTRUCTIONS: MmmIxDef[] = [
  {
    // ✅ CONFIRMED — computed disc matches observed; layout verified on legacy bid-sale
    // accts[0]=seller(fulfiller), accts[1]=pool-owner(buyer), accts[2]=ME-treasury
    name:          'solFulfillBuy',
    disc:          anchorDisc('sol_fulfill_buy'),    // 5c10e24f1ff23576
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 3RfLtZA2g2ecoMT2zLsPP2kNG1ksThQs16mvgmi5hDChTjZXoP2FQ4KaEV9dKeLgtQeh238WvJpJXdJeFRAijT8G
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[13]).
    poolAcctIdx:   4,
  },
  {
    // ⚠️ SELLER CORRECTED 2026-07-15 — accts[1] is the REAL seller/depositor,
    // NOT accts[5]. The previous "accts[5]=pool-owner(seller)" call was the
    // same "largest SOL increase" heuristic mistake as coreFulfillSell below:
    // accts[5] is the pool's SOL-payout wallet, which can differ from
    // whoever actually deposited/listed the specific NFT that sold. Confirmed
    // against Magic Eden's own `/v2/tokens/{mint}/activities` API (ground
    // truth `seller` field) on 3 independent live transactions — ME reports
    // accts[1] as `seller` every time, never accts[5]:
    //   ZgCBkuiEkuP3LXKLHH3P7mSjvcxQsx7eR8USMcER3DBGWhEfYQtrRpw6MLEHXHArWKqQe7LpH9Aza9qNusznvAk
    //   2ZzFvYk1711fDGPpu2f3h4gjakVqbDdh6tpaVzzNHigPJJ55CLqeHQTdfDbsnHQc5mV9apYekkPHDR6gjsTXWpAu
    //   2ddbchfELQZUvhRPuBLYDCTB1ebvQEWZfRwCtD1CSHhdAC8GxQELW1mudfNjATLtMPHy6qq5tbHcDLJUnV8itvrL
    // accts[5]'s rent-refund-sized delta (a closed per-listing state account,
    // always exactly 3,285,120 lamports) lands on accts[1], confirming accts[1]
    // is the account that created that listing — i.e. the depositor.
    // accts[0]=buyer(fulfiller), accts[6]=mint.
    name:          'solMip1FulfillSell',
    disc:          anchorDisc('sol_mip1_fulfill_sell'), // 3b0b496b286940d2
    direction:     'fulfillSell',
    sellerAcctIdx: 1,    // real seller/depositor — confirmed via ME activities API (see above)
    buyerAcctIdx:  0,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 1sr1i1ckSZWgJGfLX2Wrned2CpvmDnq7rsmiL2Xqon4v3pxNUoARowDDzJWoq1gGzEpqCHuRHhVtotf2bwtUJeM
    // — this file's own "accts[1]=pool-state-PDA" comment above is WRONG: accts[1] is
    // System-owned/0-byte (a wallet — the real seller, see above), accts[4] is
    // mmm-program-owned/849B (the real pool account; a second MMM-owned 344B
    // sell-state account sat at accts[12]).
    poolAcctIdx:   4,
  },
  {
    // ✅ CONFIRMED — discriminator observed in live Core sell-into-pool txs.
    // Actual Anchor name: sol_mpl_core_fulfill_buy (anchorDisc matches aba722c170158e59).
    // Solscan displays this instruction as "SolMplCoreFulfillBuy" on MagicEden AMM.
    // Core asset position varies across txs — extracted from MPL Core inner CPI accounts[0]
    // via extractCoreAssetFromInnerIx() (same approach as coreFulfillSell).
    name:          'coreFulfillBuy',
    disc:          Buffer.from('aba722c170158e59', 'hex'),  // = anchorDisc('sol_mpl_core_fulfill_buy')
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,    // accs[1] = pool OWNER / bidder wallet (verified: equals pool-state owner@121, System-owned). NOT the pool PDA — the PDA is a separate ix account.
    coreAssetIdx:  null, // use extractCoreAssetFromInnerIx — outer index unreliable for Core
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on the reported regression tx
    // 63ovbxZ7RBbAh9XRXhk6QGuoUBpbA7LVhRPzj52AvnZxSAqNKeRHrhfRTaKCm7ymF3PtBHaAS9KNufYPN3U69YUc
    // (accts[4]=J3NNjFntEWw3512jUpXgB6dj9wCWmXmQXfEj3gW5K8dJ, owner=mmm program, dataLen=849).
    poolAcctIdx:   4,
  },
  {
    // ✅ CONFIRMED — discriminator observed in live Core buy-from-pool tx.
    // Actual Anchor name: sol_mpl_core_fulfill_sell (anchorDisc matches fce7c9b01ed57612).
    // Solscan displays this as "SolMplCoreFulfillSell" on MagicEden AMM.
    // Core asset position varies across txs (idx 4 in some, idx 6 in others — confirmed
    // against two live txs 2026-04-15). Use coreAssetIdx=null → parser falls back to
    // extractCoreAssetFromInnerIx() which reads MPL Core inner-CPI accounts[0] (stable).
    //
    // ⚠️ SELLER CORRECTED 2026-07-15 — reported regression: a real sale (sig
    //   4azix1bFd5SJ5MwfGpyRyX5SySs6QjSHy355Ktrzn2wdcRk4UuwFmAxuTPzQJzHtmiU9xRsQdduqC3sjbeKjFPf9)
    // showed the wrong seller on /feed. Root cause: this entry's OLD
    // "sellerAcctIdx=5, confirmed via SOL flow (+largest increase)" was a bad
    // heuristic — accts[5] is the AMM pool's SOL-payout wallet, which receives
    // the largest chunk of a sale's proceeds regardless of who deposited the
    // specific NFT that sold. In a shared/aggregated pool that payout wallet
    // is NOT the same identity as the depositor. The largest SOL recipient in
    // an AMM fulfillSell is a payout destination, not necessarily a seller.
    // Correct seller is accts[1] — confirmed against Magic Eden's own
    // `/v2/tokens/{mint}/activities` API (ground truth `seller` field) on 4
    // independent live transactions, including the reported one:
    //   4azix1bFd5SJ5MwfGpyRyX5SySs6QjSHy355Ktrzn2wdcRk4UuwFmAxuTPzQJzHtmiU9xRsQdduqC3sjbeKjFPf9 (reported)
    //   3soVWUoSGwrgcbAtL7KtZhnkBymb85vHvJyfZmBUsn8J2Kc5FZC38TXwT9MSQ2BiusksoQWWZxD65kxMqnooa1E8
    //   5VBQgXr1GgJGsqH4TeHn6qeh921TNi2pu89VamJftFMHs49LUtu5atHPmdG1wF4jvEsaHrAgRm56p4sbtdewhe7
    //   4M8exthohdZ6ksJMmL9AUvtFoYXmArjBrDoEhYjoj5otC6vG2bA1XUVXSQaHov8FNAD7YDMigWUjCfiaYinzea1o
    // accts[5]'s rent-refund-sized delta (a closed per-listing state account,
    // always exactly 3,285,120 lamports) lands on accts[1] in every sample,
    // confirming accts[1] created that listing — i.e. the depositor.
    // accts[0]=buyer(fulfiller), accts[1]=seller(real depositor).
    name:          'coreFulfillSell',
    disc:          Buffer.from('fce7c9b01ed57612', 'hex'),  // observed, name unconfirmed
    direction:     'fulfillSell',
    sellerAcctIdx: 1,    // real seller/depositor — confirmed via ME activities API (see above)
    buyerAcctIdx:  0,
    coreAssetIdx:  null, // variable position — extracted from MPL Core inner CPI instead
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 2pwXPPv3DhDEhynVmaCDTLqrKei2vqNHuipJUy3KUo1b3bULQkkBKKavA6yaeGNpcEGjEBtvZ5P7GmwEBiyyMFrL
    // (accts[4] owner=mmm program, dataLen=849; NOTE this contradicts this entry's own
    // "accts[1]=pool-state-PDA" comment above, which pre-dates this verification).
    poolAcctIdx:   4,
  },
  {
    // ✅ CONFIRMED — discriminator observed in 2 live Core sell-into-pool txs (2026-04-16)
    // Computed Anchor name does NOT match any known instruction; actual name unknown.
    // Account layout identical to coreFulfillBuy: [0]=seller(user), [1]=pool OWNER/bidder wallet, [2]=ME-treasury
    // SOL flow: pool vault → user (+SOL) = pool buying NFT from user → fulfillBuy direction.
    // Core asset extracted from MPL Core inner CPI accounts[0] via extractCoreAssetFromInnerIx().
    name:          'coreFulfillBuyV2',
    disc:          Buffer.from('2a90cb9137290b8a', 'hex'),  // observed, name unconfirmed
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,    // accs[1] = pool OWNER / bidder wallet (mirrors coreFulfillBuy; NOT the pool PDA)
    coreAssetIdx:  null, // variable — extracted from MPL Core inner CPI accounts[0]
    // ⚠️ NOT independently verified — no live sale of this exact instruction was found
    // in our own ingested sale_events history to check against (2026-07-11 pass covered
    // 10 of 12 MMM variants). Left null rather than assumed from the coreFulfillBuy/
    // coreFulfillBuyV2 layout similarity — poolAddress stays null for this variant
    // (fail closed, no AMM badge) until confirmed against a real transaction.
    poolAcctIdx:   null,
  },
  {
    // ⚠️ SELLER CORRECTED 2026-07-15 — the 2026-05-29 "accts[5] = pool owner
    // wallet ... took the largest SOL increase" verification was the same bad
    // heuristic as coreFulfillSell/solMip1FulfillSell above: the largest SOL
    // recipient in an AMM fulfillSell is the pool's payout wallet, which is
    // NOT necessarily who deposited the specific NFT that sold. Re-verified
    // against Magic Eden's own `/v2/tokens/{mint}/activities` API (ground
    // truth `seller` field) on 3 independent live transactions, INCLUDING the
    // original 2026-05-29 fixture — ME reports accts[1] as `seller` every
    // time, never accts[5]:
    //   4F79Zo1amYnuL5oZ1sMaAdbo4qjyTcriK4sumJT1jcvrH67txkikzSWy5C7mTvaojh2uQmQQS2Bs3gh4Hez3guMJ (aggregator-routed: outer = LUCK57…, inner CPI = MMM SolFulfillSell)
    //   3tvj7TcFyinD8fSr2PYRP2do1BtvVeBAY6V1b4vWiGqUBRCWR3EfK2Ky6yD7pXTsbXiXE6QHdWZ535kRpTJsC9sP
    //   3f6QRrz8vxyajxMrCAK7YtWSCbP7RwnMxEbYw3gLeaDvtw8WBp5GMRyAzzaV2x3qPZ9D7CE5asTh41y9UgAibRJ8
    // accts[1] is System-owned (a wallet, not a PDA) in all 3. Without this,
    // fulfillSell direction + sellerAcctIdx=null triggers poolSellAmbiguous
    // and the parser drops the sale ("could not determine parties"). Buyer
    // left null — token-flow fallback correctly resolves the end recipient
    // wallet in both direct and aggregator flows.
    name:          'solFulfillSell',
    disc:          anchorDisc('sol_fulfill_sell'),   // a4b460c067e169e8
    direction:     'fulfillSell',
    sellerAcctIdx: 1,    // real seller/depositor — confirmed via ME activities API (see above)
    buyerAcctIdx:  null,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig TBgaYDpxVyMAEUxmWGFAeBMio9c1poP8qfmi7V6cPaNyQ81DcuDeL8CDE291hLvtTNnb2KyLZDRgWNiWhsc4pJm
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[12]).
    poolAcctIdx:   4,
  },
  {
    // ⚠️ UNVERIFIED — IDL-confirmed instruction (sol_ocp_fulfill_buy = 71e1aa41b5d40a21).
    // OCP = Open Creator Protocol; uses standard SPL token program → extractNftMint works.
    // fulfillBuy: user sells NFT into pool. Account layout mirrors solFulfillBuy:
    //   accounts[0] = seller (fulfiller), accounts[1] = pool OWNER / bidder wallet (the real buyer).
    name:          'solOcpFulfillBuy',
    disc:          anchorDisc('sol_ocp_fulfill_buy'),  // 71e1aa41b5d40a21
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 35eU1hNQ3Mi8m9Pu8ZBU9NyVTmDiQ5M6kSFTeQSR6AiVGuRC5kYTU9kcyF5We4ZSjF8Pw4wNJwNeAyxWw7LooWsm
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[12]).
    // Buyer/seller layout for this instruction remains otherwise unverified (see above).
    poolAcctIdx:   4,
  },
  {
    // ⚠️ UNVERIFIED — IDL-confirmed instruction (sol_ocp_fulfill_sell = d5283a63816df593).
    // OCP pool sell: user buys NFT from pool. Account layout unconfirmed — using null
    // indices so the parser falls back to SOL+token flow for buyer/seller resolution.
    name:          'solOcpFulfillSell',
    disc:          anchorDisc('sol_ocp_fulfill_sell'),  // d5283a63816df593
    direction:     'fulfillSell',
    sellerAcctIdx: null,
    buyerAcctIdx:  null,
    coreAssetIdx:  null,
    // ⚠️ NOT independently verified — no live sale of this exact instruction was found
    // in our own ingested sale_events history (2026-07-11 pass). Left null; fails closed.
    poolAcctIdx:   null,
  },
  {
    // ⚠️ UNVERIFIED — IDL-confirmed instruction (sol_ext_fulfill_buy = 9d5a7ad45a795378).
    // Ext = extended token standard (e.g. Token-2022, programmable); standard SPL balances.
    // fulfillBuy account layout mirrors solFulfillBuy.
    name:          'solExtFulfillBuy',
    disc:          anchorDisc('sol_ext_fulfill_buy'),  // 9d5a7ad45a795378
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 2FC96Ls1TvERmCZqNm3tjbGJ9xyBjmgE2SBb55oaVaQfWRp6Qw99nJQbnuTyN35p1ucDfH7vKXcjxW7xnBGjwZhD
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[11]).
    poolAcctIdx:   4,
  },
  {
    // ✅ SELLER CONFIRMED 2026-07-15 — same account layout as the other
    // fulfillSell variants above (accts[0]=buyer, accts[1]=seller/depositor,
    // accts[4]=pool state PDA, accts[5]=pool payout wallet). Before this fix
    // sellerAcctIdx was null, and — because direction==='fulfillSell' —
    // parser.ts's `poolSellAmbiguous` guard deliberately left `seller` null
    // rather than risk defaulting to the pool payout wallet (accts[5]) or,
    // worse, the pool state PDA itself (observed happening via a stale
    // token-flow fallback on historical rows). Net effect: every
    // solExtFulfillSell sale was SILENTLY DROPPED (parser returns
    // ok:false, "could not determine parties") — zero solExtFulfillSell
    // rows since 2026-05-24. Confirmed against Magic Eden's own
    // `/v2/tokens/{mint}/activities` API (ground truth `seller` field) on 3
    // independent live transactions — ME reports accts[1] as `seller` every
    // time:
    //   7HZaumrvZzPAT41oqVcFKhMcTYcKG6RFZTQ3dSQVSG7pFGMSf6CpVs93PcBV9RRCyoaKYfJprjfsvK3PHmZhfko
    //   5JpaYP3XSHsi2cTXZ1LNRoZDmfGzqBsGemXfjnvs5yN1fLHaooqH1RVUsBR2pitcAKKKfpj7ZRA8oqDJ5gME6mqU
    //   3f3oD7CthuH4TS7EPfUatsH2u8R2k5yCwgCW3bAfa12YEJHeyeuAQwzBuKuzqMKbTpoAw5n2zPJzZvx6FzaoM3kZ
    name:          'solExtFulfillSell',
    disc:          anchorDisc('sol_ext_fulfill_sell'),  // 7913c7be30f0b673
    direction:     'fulfillSell',
    sellerAcctIdx: 1,    // real seller/depositor — confirmed via ME activities API (see above)
    buyerAcctIdx:  0,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 7HZaumrvZzPAT41oqVcFKhMcTYcKG6RFZTQ3dSQVSG7pFGMSf6CpVs93PcBV9RRCyoaKYfJprjfsvK3PHmZhfko
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[9]).
    poolAcctIdx:   4,
  },
  {
    // ✅ CONFIRMED — discriminator matches computed (ec529e7a0818af91); observed in live tx
    //    X86TRHjJ7EfEsArQ7BYvHpq4uqRQVKrFM1kTwzQpTwjKzKpyYZv18wkqwF7thA43L3hX8tJNFVChbDpKZXT73sN
    // tx also has ME V2 Mip1CancelSell (cancels old listing), followed by this fill.
    // SOL flow: pool vault (accts[16]) pays −1.138 SOL, accts[0] (signer/seller) receives +1.072 SOL.
    // Account layout mirrors other fulfillBuy instructions:
    //   accounts[0] = seller (user fulfiller / signer)
    //   accounts[1] = pool OWNER / bidder wallet (the real buyer; not the pool PDA)
    //   accounts[2] = ME treasury
    // Mint extracted from SPL token balance changes (pNFT = standard SPL token).
    name:          'solMip1FulfillBuy',
    disc:          anchorDisc('sol_mip1_fulfill_buy'), // ec529e7a0818af91
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,  // accs[1] = pool OWNER / bidder wallet — consistent with solFulfillBuy / coreFulfillBuy (NOT the pool PDA)
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig 5gzzR6pyhNDzHSDAvNFBDXKjdR3jaKeQWvPxZDHzEXhtMQ9MvMj8SJUyE3DghhZBWs85yM65gNGhjaR7jEcBZeTr
    // (takeBid-reclassified fulfillBuy; accts[4] owner=mmm program, dataLen=849).
    poolAcctIdx:   4,
  },
  {
    // ✅ CONFIRMED — discriminator computed via anchorDisc('cnft_fulfill_buy')
    // matches observed disc 91ade944244cc309 in live tx
    //   3UwKaN58uyh2PBZ7atv1ACmDHpSG1n1xyNWjQvdAxKqcLZ3vubggv6BYweSb7yEPtPddNsFGxoR1R5p3ERWVso6w
    // (cNFT bid acceptance, post-log `post_sol_cnft_fulfill_buy`).
    // Account layout mirrors other fulfillBuy ixs:
    //   accounts[0] = seller (signer/fulfiller)
    //   accounts[1] = owner (pool owner = bidder = real buyer)
    //   accounts[2] = cosigner (NTYeYJ…)
    // SOL flow: accs[14] (pool vault) pays out, accs[0] receives proceeds.
    // cNFT asset has NO regular mint pubkey — `mint` flows as null on
    // the wire and the row anchors on collection address (accs[7] for
    // this fixture). Parser caller must accept `mint=null` for cNFT.
    name:          'cnftFulfillBuy',
    disc:          anchorDisc('cnft_fulfill_buy'), // 91ade944244cc309
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,
    coreAssetIdx:  null,
    // ✅ poolAcctIdx=4 verified live 2026-07-11 on sig GzD8n1Mvt2rAjLU9xjWBD3eYfGwjnBk81HkHyFqxk7Qopq7n5NkFwEWoq7xrDR3ErbXbshg8dfnWvXEZqxjZjEk
    // (accts[4] owner=mmm program, dataLen=849; a second MMM-owned 344B sell-state account sat at accts[11]).
    poolAcctIdx:   4,
  },
];

// ─── ME cNFT marketplace instructions ─────────────────────────────────────────
//
// Magic Eden's standalone Bubblegum / cNFT marketplace (`M3mxk5W2…`).
// Distinct on-chain program from ME v2; same surface in the ME UI.
// One sale instruction observed in the live audit: `buy_now` (Anchor
// disc f22ab84d859876cc, computed via anchorDisc('buy_now')).
//
// Account layout (verified against the 7 wegens fixtures listed in the
// coverage-gap audit, e.g. 3RggSHw8…):
//   accounts[0]  = buyer (signer, fee payer)            ← SOL outflow
//   accounts[1]  = seller                                ← SOL inflow
//   accounts[2]  = ME cosigner (NTYeYJ…)
//   accounts[3]  = referral / fee receiver
//   accounts[4]  = notary
//   accounts[5]  = merkle tree (cNFT collection-equivalent group anchor)
//                  — verified against DAS `compression.tree` for four
//                  wegens fixtures; all four resolve to the shared
//                  `88fLq9b2Hk1TLj3H9MQiGL1x5n8BAdvqk8SGMgbzmfSH` tree
//   accounts[6]  = noop program (SPL)
//   accounts[7]  = Bubblegum program
//   accounts[8]  = system program
//   accounts[9]  = SPL account-compression program
//   accounts[10] = per-listing PDA (varies per tx — NOT the tree)
//   accounts[11..15] = tree-config / leaf-delegate / hash-buf
//   accounts[16+] = merkle proof leaves
//
// Data layout:  [8 disc][8 price u64 LE][...remainder = root/data-hash/
//               creator-hash/nonce/index — not consumed by the parser].
// Confirmed price extraction: `f22ab84d859876cc` + bytes[8..16] u64 LE
// = 109_000_000 = 0.109 SOL on fixture 3RggSHw8… (matches ME activity).

export interface MeCnftIxDef {
  name: string;
  disc: Buffer;
  verified: boolean;
  /** outer-ix account index of the buyer. */
  buyerAcctIdx:  number;
  /** outer-ix account index of the seller. */
  sellerAcctIdx: number;
  /** outer-ix account index of the merkle tree — used both as the
   *  collection-equivalent group key (cNFTs have no per-asset mint
   *  account) and as the `mint_address` placeholder downstream, same
   *  shape MMM `cnftFulfillBuy` uses. */
  merkleTreeIdx: number;
  /** byte offset in the instruction data where the price u64 LE
   *  starts. 8 for every Anchor ix that takes price as the first arg. */
  priceOffset:   number;
}

export const ME_CNFT_SALE_INSTRUCTIONS: MeCnftIxDef[] = [
  {
    // ✅ CONFIRMED — discriminator computed (= anchorDisc('buy_now'))
    //    and observed in 6 live wegens fixtures (2026-05-18).
    name:          'buy_now',
    disc:          anchorDisc('buy_now'),  // f22ab84d859876cc
    verified:      true,
    buyerAcctIdx:  0,
    sellerAcctIdx: 1,
    merkleTreeIdx: 5,
    priceOffset:   8,
  },
];

// ─── Combined lookup ──────────────────────────────────────────────────────────

/** Set of all ME-related program addresses. Used for fast "is this an ME tx?" check. */
export const ME_PROGRAMS = new Set([ME_V2_PROGRAM, ME_AMM_PROGRAM, ME_CNFT_PROGRAM]);
