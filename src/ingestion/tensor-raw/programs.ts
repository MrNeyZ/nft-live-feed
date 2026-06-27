import { createHash } from 'crypto';

// ─── Program addresses ────────────────────────────────────────────────────────
//
// Verification status (2026-04-14):
//   TCOMP_PROGRAM  ✅ confirmed from live tx (all 4 ground-truth sigs involve this program)
//   TAMM_PROGRAM   ✅ confirmed from live tx (sigs 3+4 are TAMM pool trades)
//   BUBBLEGUM_PROGRAM ✅ confirmed: well-known Metaplex program (not in Core txs)
//   TENSOR_FEE_ACCOUNT ✅ confirmed: observed as fee recipient in all 4 ground-truth txs

/** Tensor fixed-price marketplace + cNFT + Core listings (TComp). */
export const TCOMP_PROGRAM = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';

/**
 * Tensor AMM pool program (TAMM).
 * ✅ Confirmed from live Core NFT AMM transactions (sigs 3 and 4).
 * Note: TSwap (TSWAPaqy...) does NOT appear in these transactions and is
 * NOT the TAMM program — do not confuse them.
 */
export const TAMM_PROGRAM = 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg';

/** Metaplex Bubblegum — invoked by TComp for cNFT transfers (not present in Core txs). */
export const BUBBLEGUM_PROGRAM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';

/**
 * Tensor fee / treasury account.
 * ✅ Confirmed from all 4 ground-truth txs: observed as consistent SOL recipient.
 */
export const TENSOR_FEE_ACCOUNT = 'DrFkK9QyDPDHHAgRi5jkAFkqeNDf4wkcyDtAv2CeL9tk';

/** MPL Core program address (for classifying Core NFT transactions). */
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

// ─── Anchor discriminator helper ─────────────────────────────────────────────

/** Computes the 8-byte Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDisc(instructionName: string): Buffer {
  return createHash('sha256')
    .update(`global:${instructionName}`)
    .digest()
    .subarray(0, 8);
}

// ─── TComp instruction definitions ────────────────────────────────────────────
//
// TComp handles:
//   - Fixed-price NFT listings (legacy, pNFT, Core, cNFT)
//
// Verification (2026-04-14): all discriminators confirmed from live transactions.
//   buy:     sig 1 (listing buy, Core NFT)
//   takeBid: sig 2 (bid accept, Core NFT)

export interface TcompIxDef {
  name: string;
  disc: Buffer;
  /** true = confirmed from a live completed-sale tx. */
  verified: boolean;
  /** Direction from the human counterparty's perspective. */
  direction: 'buy' | 'takeBid';
  /** Instruction-accounts index for the human buyer. null = not present in this flow. */
  buyerAcctIdx: number | null;
  /** Instruction-accounts index for the human seller. null = not present in this flow. */
  sellerAcctIdx: number | null;
  /**
   * Instruction-accounts index for the Core NFT asset address.
   * Applies only when nftType='core'. null if not applicable.
   */
  coreAssetIdx: number | null;
}

export const TCOMP_SALE_INSTRUCTIONS: TcompIxDef[] = [
  // ─── Core NFT paths ───────────────────────────────────────────────────────────
  {
    // ✅ VERIFIED — confirmed from sig 1 (listing buy, Core NFT).
    // IDL name: buyCore. Discriminator: a9 e3 57 ff 4c 56 ff 19
    // Buyer  = accounts[4], Seller = accounts[6], Core asset = accounts[2]
    name:          'buyCore',
    disc:          Buffer.from('a9e357ff4c56ff19', 'hex'),
    verified:      true,
    direction:     'buy',
    buyerAcctIdx:  4,
    sellerAcctIdx: 6,
    coreAssetIdx:  2,
  },
  {
    // ✅ VERIFIED — confirmed from sig 2 (bid accept, Core NFT).
    // IDL name: takeBidCore. Discriminator: fa 29 f8 14 3d a1 1b 8d
    // Seller = accounts[1], Core asset = accounts[8], Buyer = accounts[3].
    //
    // accounts[3] is the TComp `owner` / bidder wallet — the human who placed
    // the bid. accounts[2] is the bidState PDA (holds escrowed SOL); it drains
    // on accept and would be mistakenly picked as "buyer" by the SOL-delta
    // heuristic (largest negative delta). Set buyerAcctIdx=3 so the parser
    // reads the bidder directly and never falls through to the delta fallback.
    // Verified from two live txs (different collections, same account layout):
    //   P7w6yhS… (0.002 SOL, buyer=FbWci5Aj…)
    //   3vPjmnh… (0.048 SOL, buyer=9QoTY9uz…, was wrongly CF35yA75… before fix)
    name:          'takeBidCore',
    disc:          Buffer.from('fa29f8143da11b8d', 'hex'),
    verified:      true,
    direction:     'takeBid',
    buyerAcctIdx:  3,
    sellerAcctIdx: 1,
    coreAssetIdx:  8,
  },

  // ─── Legacy / pNFT paths ──────────────────────────────────────────────────────
  {
    // ✅ VERIFIED — confirmed from live tx (takeBidLegacy, legacy SPL bid accept).
    // Discriminator: bc 23 74 6c 00 e9 ed c9  = anchorDisc('take_bid_legacy')
    // ix.accounts[1] = seller wallet (+147M lamports confirmed). Buyer via token flow.
    name:          'takeBidLegacy',
    disc:          Buffer.from('bc23746c00e9edc9', 'hex'),
    verified:      true,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: 1,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: buy (generic listing purchase for legacy/pNFT NFTs).
    // Discriminator: 66063d1201daebea = anchorDisc('buy')
    // Account layout unconfirmed — buyer/seller resolved via SOL+token flow.
    name:          'buy',
    disc:          Buffer.from('66063d1201daebea', 'hex'),
    verified:      false,
    direction:     'buy',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: buyLegacy (legacy SPL listing purchase).
    // Discriminator: 447f2b08d41ff972 = anchorDisc('buy_legacy')
    // Account layout unconfirmed — buyer/seller resolved via SOL+token flow.
    name:          'buyLegacy',
    disc:          Buffer.from('447f2b08d41ff972', 'hex'),
    verified:      false,
    direction:     'buy',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: takeBidFullMeta (pNFT/Core bid accept with full metadata).
    // Discriminator: f2c2cbe1ea350a60 = anchorDisc('take_bid_full_meta')
    // Seller likely accounts[1] (same pattern as takeBidCore/takeBidLegacy). Buyer via flow.
    // Core asset extracted via extractCoreAssetFromInnerIx when nftType=core.
    name:          'takeBidFullMeta',
    disc:          Buffer.from('f2c2cbe1ea350a60', 'hex'),
    verified:      false,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: 1,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: takeBidMetaHash (cNFT bid accept via metadata hash).
    // Discriminator: 55e3ca462dd70ac1 = anchorDisc('take_bid_meta_hash')
    // cNFT — asset ID extraction from Bubblegum inner CPI needed; falls to unknown_candidate.
    name:          'takeBidMetaHash',
    disc:          Buffer.from('55e3ca462dd70ac1', 'hex'),
    verified:      false,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },

  // ─── Token-2022 paths ─────────────────────────────────────────────────────────
  {
    // ⚠️ UNVERIFIED — IDL name: buyT22 (Token-2022 NFT listing purchase).
    // Discriminator: 5162e3abc969b4d8 = anchorDisc('buy_t22')
    // T22 token balances appear in pre/postTokenBalances same as SPL — extractNftMint works.
    name:          'buyT22',
    disc:          Buffer.from('5162e3abc969b4d8', 'hex'),
    verified:      false,
    direction:     'buy',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: takeBidT22 (Token-2022 NFT bid accept).
    // Discriminator: 12fa71f21ff41396 = anchorDisc('take_bid_t22')
    name:          'takeBidT22',
    disc:          Buffer.from('12fa71f21ff41396', 'hex'),
    verified:      false,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },

  // ─── WNS (Wormhole Name Service / Metaplex WNS) paths ────────────────────────
  {
    // ⚠️ UNVERIFIED — IDL name: buyWns (WNS NFT listing purchase).
    // Discriminator: a82bb3d92c3b23f4 = anchorDisc('buy_wns')
    // WNS tokens use standard SPL token program — extractNftMint works.
    name:          'buyWns',
    disc:          Buffer.from('a82bb3d92c3b23f4', 'hex'),
    verified:      false,
    direction:     'buy',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — IDL name: takeBidWns (WNS NFT bid accept).
    // Discriminator: 58057a58fa8b23d8 = anchorDisc('take_bid_wns')
    name:          'takeBidWns',
    disc:          Buffer.from('58057a58fa8b23d8', 'hex'),
    verified:      false,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
];

// ─── TAMM instruction definitions ────────────────────────────────────────────
//
// TAMM handles AMM pool trades (both Core and standard NFTs).
//
// Direction semantics:
//   sell → user SELLS NFT into pool (pool receives NFT, user receives SOL)
//   buy  → user BUYS NFT from pool (user receives NFT, pool receives SOL)
//
// Verification (2026-04-14): all discriminators confirmed from live transactions.
//   sell: sig 3 (user sells Core NFT into pool)
//   buy:  sig 4 (user buys Core NFT from pool)

export interface TammIxDef {
  name: string;
  disc: Buffer;
  verified: boolean;
  direction: 'buy' | 'sell';
  /** Instruction-accounts index for the human buyer. */
  buyerAcctIdx: number | null;
  /** Instruction-accounts index for the human seller. */
  sellerAcctIdx: number | null;
  /**
   * Instruction-accounts index for the Core NFT asset address.
   * Applies when nftType='core'. null if not applicable.
   */
  coreAssetIdx: number | null;
}

export const TAMM_SALE_INSTRUCTIONS: TammIxDef[] = [
  {
    // ✅ VERIFIED — confirmed from sig 3 (user sells Core NFT into AMM pool).
    // Discriminator observed: 25 cd 8d 35 56 f5 2d 4e
    // Seller = accounts[1], Buyer (pool owner) = accounts[7], Core asset = accounts[14]
    name:          'sell',
    disc:          Buffer.from('25cd8d3556f52d4e', 'hex'),
    verified:      true,
    direction:     'sell',
    buyerAcctIdx:  7,
    sellerAcctIdx: 1,
    coreAssetIdx:  14,
  },
  {
    // ✅ VERIFIED — Core pool-buy. Pool owner correction 2026-05-28:
    // accounts[7] is a TSWAP-owned escrow PDA (owner=TSWAPaqyCSx…, data_len=192),
    // NOT the human pool owner. The original "confirmed via SOL flow"
    // heuristic was misleading — that PDA receives the largest SOL chunk
    // first and forwards it to the owner. The actual owner is at
    // accounts[0]: System-owned wallet (data_len=0), constant across
    // multiple sales of the same pool, distinct across pools. Verified
    // by direct getAccountInfo across 4 BuyNft samples / 3 distinct pools.
    name:          'buy',
    disc:          Buffer.from('a3663a6bb804a979', 'hex'),
    verified:      true,
    direction:     'buy',
    buyerAcctIdx:  1,
    sellerAcctIdx: 0,    // pool owner (human wallet) — was 7 (TSWAP escrow PDA)
    coreAssetIdx:  14,
  },

  // ─── TAMM V2 trade-pool paths ──────────────────────────────────────────────
  // Newer TAMM instructions observed in live txs (log prefix `BuyV2` /
  // `SellV2`, dispatch name `sell_nft_trade_pool` / `buy_nft_trade_pool`).
  // Account layouts not yet verified — parser will resolve seller/buyer via
  // SOL-flow + token-flow fallbacks, and the Core asset via the existing
  // MPL Core inner-CPI scan (`extractCoreAssetFromInnerIx`).

  {
    // ⚠️ UNVERIFIED — discriminator observed live (sig
    //    2NFRJdpDckSaD3rV9FVDLjVfiFqdYXJApV4f2vXde8r6m9cG2VWCPSyRkJ3eG3k2WmzKZk8UnQXKtw5eepEhRFR4).
    // IDL name: sell_nft_trade_pool (Anchor disc sha256("global:sell_nft_trade_pool")[:8]).
    // Direction: user sells NFT into trade pool — pool receives NFT, user receives SOL.
    name:          'sellNftTradePool',
    disc:          Buffer.from('83527d4d0d9d245a', 'hex'),
    verified:      false,
    direction:     'sell',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ⚠️ UNVERIFIED — computed Anchor discriminator for buy_nft_trade_pool.
    // Paired counterpart to sell_nft_trade_pool; user buys NFT from trade pool.
    name:          'buyNftTradePool',
    disc:          Buffer.from('1b4ad9d65fe0e4a7', 'hex'),
    verified:      false,
    direction:     'buy',
    buyerAcctIdx:  null,
    sellerAcctIdx: null,
    coreAssetIdx:  null,
  },
  {
    // ✅ VERIFIED 2026-05-28 — TAMM legacy SPL-NFT "buy NFT from token pool".
    // Anchor disc sha256("global:buy_nft")[:8] = 60 00 1c be 31 6b 53 de.
    // accounts[1] = buyer (signer, receives the NFT).
    // accounts[0] = POOL OWNER (System-owned human wallet) — confirmed
    //   via getAccountInfo across 4 BuyNft samples / 3 distinct pools.
    // Previous sellerAcctIdx=7 was a TSWAP-owned escrow PDA (owner=
    //   TSWAPaqyCSx…, data_len=192) — exactly the pool-PDA-as-seller
    //   bug the operator reported. accounts[4] is the TAMM-owned pool
    //   STATE PDA (data_len=596). nftType resolves to 'legacy'.
    name:          'buyNft',
    disc:          Buffer.from('60001cbe316b53de', 'hex'),
    verified:      true,
    direction:     'buy',
    buyerAcctIdx:  1,
    sellerAcctIdx: 0,    // pool owner (human wallet) — was 7 (TSWAP escrow PDA)
    coreAssetIdx:  null,
  },
];

// ─── Combined lookup ──────────────────────────────────────────────────────────

/** All Tensor program addresses. Used for fast pre-filter. */
export const TENSOR_PROGRAMS = new Set([TCOMP_PROGRAM, TAMM_PROGRAM]);
