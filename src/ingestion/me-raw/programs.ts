import { createHash } from 'crypto';

// ─── Program addresses ────────────────────────────────────────────────────────

/** Magic Eden fixed-price marketplace. Handles legacy, pNFT/mip1, and Core sales. */
export const ME_V2_PROGRAM    = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
/** Magic Eden AMM (mmm pools). Open source: github.com/magiceden-oss/mmm */
export const ME_AMM_PROGRAM   = 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';

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
    //    coreAssetIdx=null → extractCoreAssetFromInnerIx(); buyer/seller → SOL flow.
    name: 'coreExecuteSaleV2',
    disc: anchorDisc('core_execute_sale_v2'),
    verified: true,
    coreAssetIdx: null,
  },
  {
    // ⚠️ Unverified: non-V2 Core execute sale; may exist for older ME Core listings.
    name: 'coreExecuteSale',
    disc: anchorDisc('core_execute_sale'),
    verified: false,
    coreAssetIdx: null,
  },
  {
    // ✅ Confirmed: discriminator seen in pNFT sale + pNFT lucky-buy (2026-04-14).
    name: 'mip1ExecuteSaleV2',
    disc: anchorDisc('mip1_execute_sale_v2'),  // eca3ccad4790eb76
    verified: true,
    coreAssetIdx: null,
  },
  {
    // ⚠️ Unverified: computed discriminator; no live tx observed yet.
    name: 'executeSaleV2',
    disc: anchorDisc('execute_sale_v2'),        // 5bdc31dfcc8135c1
    verified: false,
    coreAssetIdx: null,
  },
  {
    // ⚠️ Unverified: computed discriminator; no live tx observed yet.
    name: 'executeSale',
    disc: anchorDisc('execute_sale'),           // 254ad99d4f312306
    verified: false,
    coreAssetIdx: null,
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
   * For coreFulfillBuy the buyer is the pool owner, whose wallet is not a top-level
   * instruction account — use accounts[1] (pool state PDA) as a stable pool identifier.
   */
  buyerAcctIdx: number | null;
  /**
   * For MPL Core instructions: instruction-accounts index of the Core asset ID.
   * null for legacy / pNFT — derive the SPL mint from token-balance changes instead.
   */
  coreAssetIdx: number | null;
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
  },
  {
    // ✅ CONFIRMED — computed disc matches observed; layout verified on pNFT AMM buy-from-pool
    // accts[0]=buyer(fulfiller), accts[1]=pool-state-PDA, accts[5]=pool-owner(seller), accts[6]=mint
    // NOTE: raw 'json' encoding positions differ from jsonParsed — verified via raw instruction
    // accounts array [0,2,1,17,3,4,5,...] where pos[5]=rawIdx[4]=pool-owner wallet.
    name:          'solMip1FulfillSell',
    disc:          anchorDisc('sol_mip1_fulfill_sell'), // 3b0b496b286940d2
    direction:     'fulfillSell',
    sellerAcctIdx: 5,    // pool owner wallet — confirmed via raw json encoding + loadedAddresses expansion
    buyerAcctIdx:  0,
    coreAssetIdx:  null,
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
    buyerAcctIdx:  1,    // pool state PDA — best available pool identifier; not pool-owner wallet
    coreAssetIdx:  null, // use extractCoreAssetFromInnerIx — outer index unreliable for Core
  },
  {
    // ✅ CONFIRMED — discriminator observed in live Core buy-from-pool tx.
    // Actual Anchor name: sol_mpl_core_fulfill_sell (anchorDisc matches fce7c9b01ed57612).
    // Solscan displays this as "SolMplCoreFulfillSell" on MagicEden AMM.
    // accts[0]=buyer(fulfiller), accts[1]=pool-state-PDA, accts[5]=pool-owner(seller)
    // Core asset position varies across txs (idx 4 in some, idx 6 in others — confirmed
    // against two live txs 2026-04-15). Use coreAssetIdx=null → parser falls back to
    // extractCoreAssetFromInnerIx() which reads MPL Core inner-CPI accounts[0] (stable).
    name:          'coreFulfillSell',
    disc:          Buffer.from('fce7c9b01ed57612', 'hex'),  // observed, name unconfirmed
    direction:     'fulfillSell',
    sellerAcctIdx: 5,    // pool owner wallet — confirmed via SOL flow (+largest increase)
    buyerAcctIdx:  0,
    coreAssetIdx:  null, // variable position — extracted from MPL Core inner CPI instead
  },
  {
    // ✅ CONFIRMED — discriminator observed in 2 live Core sell-into-pool txs (2026-04-16)
    // Computed Anchor name does NOT match any known instruction; actual name unknown.
    // Account layout identical to coreFulfillBuy: [0]=seller(user), [1]=pool-state-PDA, [2]=ME-treasury
    // SOL flow: pool vault → user (+SOL) = pool buying NFT from user → fulfillBuy direction.
    // Core asset extracted from MPL Core inner CPI accounts[0] via extractCoreAssetFromInnerIx().
    name:          'coreFulfillBuyV2',
    disc:          Buffer.from('2a90cb9137290b8a', 'hex'),  // observed, name unconfirmed
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,    // pool state PDA — best available pool identifier
    coreAssetIdx:  null, // variable — extracted from MPL Core inner CPI accounts[0]
  },
  {
    // ⚠️ UNVERIFIED — computed discriminator; no live tx observed yet
    // Account positions not confirmed — parser will fall back to token-flow / SOL-flow.
    name:          'solFulfillSell',
    disc:          anchorDisc('sol_fulfill_sell'),   // a4b460c067e169e8
    direction:     'fulfillSell',
    sellerAcctIdx: null,
    buyerAcctIdx:  null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL-confirmed instruction (sol_ocp_fulfill_buy = 71e1aa41b5d40a21).
    // OCP = Open Creator Protocol; uses standard SPL token program → extractNftMint works.
    // fulfillBuy: user sells NFT into pool. Account layout mirrors solFulfillBuy:
    //   accounts[0] = seller (fulfiller), accounts[1] = pool-state PDA (buyer identifier).
    name:          'solOcpFulfillBuy',
    disc:          anchorDisc('sol_ocp_fulfill_buy'),  // 71e1aa41b5d40a21
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,
    coreAssetIdx:  null,
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
  },
  {
    // ⚠️ UNVERIFIED — IDL-confirmed instruction (sol_ext_fulfill_sell = 7913c7be30f0b673).
    // Ext pool sell: user buys NFT from pool. Account layout unconfirmed — null indices.
    name:          'solExtFulfillSell',
    disc:          anchorDisc('sol_ext_fulfill_sell'),  // 7913c7be30f0b673
    direction:     'fulfillSell',
    sellerAcctIdx: null,
    buyerAcctIdx:  null,
    coreAssetIdx:  null,
  },
  {
    // ✅ CONFIRMED — discriminator matches computed (ec529e7a0818af91); observed in live tx
    //    X86TRHjJ7EfEsArQ7BYvHpq4uqRQVKrFM1kTwzQpTwjKzKpyYZv18wkqwF7thA43L3hX8tJNFVChbDpKZXT73sN
    // tx also has ME V2 Mip1CancelSell (cancels old listing), followed by this fill.
    // SOL flow: pool vault (accts[16]) pays −1.138 SOL, accts[0] (signer/seller) receives +1.072 SOL.
    // Account layout mirrors other fulfillBuy instructions:
    //   accounts[0] = seller (user fulfiller / signer)
    //   accounts[1] = pool-state PDA (best available pool identifier)
    //   accounts[2] = ME treasury
    // Mint extracted from SPL token balance changes (pNFT = standard SPL token).
    name:          'solMip1FulfillBuy',
    disc:          anchorDisc('sol_mip1_fulfill_buy'), // ec529e7a0818af91
    direction:     'fulfillBuy',
    sellerAcctIdx: 0,
    buyerAcctIdx:  1,  // pool-state PDA — consistent with solFulfillBuy / coreFulfillBuy
    coreAssetIdx:  null,
  },
];

// ─── Combined lookup ──────────────────────────────────────────────────────────

/** Set of all ME-related program addresses. Used for fast "is this an ME tx?" check. */
export const ME_PROGRAMS = new Set([ME_V2_PROGRAM, ME_AMM_PROGRAM]);
