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
  {
    // ✅ VERIFIED — confirmed from sig 1 (listing buy, Core NFT).
    // Discriminator observed: a9 e3 57 ff 4c 56 ff 19
    // Buyer  = accounts[4], Seller = accounts[6], Core asset = accounts[2]
    name:          'buy',
    disc:          Buffer.from('a9e357ff4c56ff19', 'hex'),
    verified:      true,
    direction:     'buy',
    buyerAcctIdx:  4,
    sellerAcctIdx: 6,
    coreAssetIdx:  2,
  },
  {
    // ✅ VERIFIED — confirmed from sig 2 (bid accept, Core NFT).
    // Discriminator observed: fa 29 f8 14 3d a1 1b 8d
    // Seller = accounts[1], Buyer = embedded in bid account (resolved via payment flow)
    // Core asset = accounts[8]
    name:          'takeBid',
    disc:          Buffer.from('fa29f8143da11b8d', 'hex'),
    verified:      true,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: 1,
    coreAssetIdx:  8,
  },
  {
    // ✅ VERIFIED — confirmed from live tx:
    //   4TRJQBsrB6DnEe6crYsWT41BRWJkL658wSYjK4kPD28HyMhp4Wu8ypxk93VELLxaFR3c2muthxvJucBn6PmQ8XkC
    // Bid accept for standard SPL (legacy) NFTs. Distinct from takeBid (Core).
    // Discriminator observed: bc 23 74 6c 00 e9 ed c9  = anchorDisc('take_bid_legacy') ✅
    // SOL flow: bid escrow (ix.accounts[2]) pays, seller (ix.accounts[1]) receives.
    // ix.accounts[1] = seller wallet (confirmed: +147M lamports in the live tx).
    // Buyer not present as a fixed index — resolved from SPL token-flow (TransferChecked CPIs).
    // NFT mint extracted from SPL preTokenBalances/postTokenBalances (classifyNftType → 'legacy').
    name:          'takeBidLegacy',
    disc:          Buffer.from('bc23746c00e9edc9', 'hex'),
    verified:      true,
    direction:     'takeBid',
    buyerAcctIdx:  null,
    sellerAcctIdx: 1,
    coreAssetIdx:  null,  // legacy SPL — mint from extractNftMint (token balance delta)
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
    // ✅ VERIFIED — confirmed from sig 4 (user buys Core NFT from AMM pool).
    // Discriminator observed: a3 66 3a 6b b8 04 a9 79
    // Buyer = accounts[1], Seller (pool owner) = accounts[7], Core asset = accounts[14]
    name:          'buy',
    disc:          Buffer.from('a3663a6bb804a979', 'hex'),
    verified:      true,
    direction:     'buy',
    buyerAcctIdx:  1,
    sellerAcctIdx: 7,
    coreAssetIdx:  14,
  },
];

// ─── Combined lookup ──────────────────────────────────────────────────────────

/** All Tensor program addresses. Used for fast pre-filter. */
export const TENSOR_PROGRAMS = new Set([TCOMP_PROGRAM, TAMM_PROGRAM]);
