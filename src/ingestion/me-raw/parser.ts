/**
 * Raw Magic Eden transaction parser.
 *
 * Converts a raw Solana `getTransaction` response into a `SaleEvent`
 * using instruction discriminator matching and balance delta analysis —
 * no dependency on Helius enhanced parsing.
 *
 * Plugs into the same pipeline as the Helius parser:
 *   parseRawMeTransaction(tx) → ParseResult → insertSaleEvent()
 *
 * Coverage (ME family only):
 *   ME AMM: legacy (solFulfillBuy ✅), pNFT (solMip1FulfillSell ✅),
 *           Core (coreFulfillBuy ✅, coreFulfillSell ✅)
 *   ME v2:  pNFT/mip1 (mip1ExecuteSaleV2 ✅)
 *           legacy direct sale — executeSale / executeSaleV2 discriminators UNVERIFIED;
 *           parser attempts extraction via token-flow but events are marked for review.
 *
 * Verification date: 2026-04-14
 * DO NOT wire into live ingestion until replay-tested (see replay-test.ts).
 */

import { RawSolanaTx } from './types';
import { SaleEvent, NftType } from '../../models/sale-event';
import { computeSellerNetLamports } from '../seller-net';
import {
  isMeTransaction,
  findMeV2SaleIx,
  findMmmSaleIx,
  extractCoreAssetFromInnerIx,
} from './decoder';
import {
  extractPaymentInfo,
  extractNftMint,
  extractPartiesFromTokenFlow,
} from './price';

/** Derive NFT type from the matched instruction name — more precise than program-presence heuristic. */
function nftTypeFromInstruction(name: string): NftType {
  if (name === 'coreFulfillBuy' || name === 'coreFulfillSell' ||
      name === 'coreFulfillBuyV2' ||
      name === 'coreExecuteSaleV2') return 'core';
  if (name === 'solMip1FulfillBuy' || name === 'solMip1FulfillSell' || name === 'mip1ExecuteSaleV2') return 'pnft';
  return 'legacy';
}

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseRawMeTransaction(tx: RawSolanaTx): ParseResult {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }
  if (!tx.blockTime) {
    return { ok: false, reason: 'missing blockTime' };
  }
  if (!isMeTransaction(tx)) {
    return { ok: false, reason: 'no ME program involved' };
  }

  // Try ME AMM first — instruction names unambiguous from open-source program.
  const mmmMatch = findMmmSaleIx(tx);
  if (mmmMatch) return parseMmmSale(tx, mmmMatch);

  // Try ME v2 fixed-price.
  const meV2Match = findMeV2SaleIx(tx);
  if (meV2Match) return parseMeV2Sale(tx, meV2Match);

  return { ok: false, reason: 'no recognised ME sale instruction' };
}

// ─── ME v2 fixed-price ────────────────────────────────────────────────────────

function parseMeV2Sale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findMeV2SaleIx>>
): ParseResult {
  // Unverified discriminators (executeSale / executeSaleV2) are kept in the
  // instruction list as candidates, but we still attempt parsing — token-flow
  // extraction is reliable regardless of which discriminator matched.
  // The `verified` flag is surfaced in rawData so callers can filter if needed.

  const nftType = nftTypeFromInstruction(match.instructionName);

  // Mint extraction — three paths depending on instruction type:
  //   1. coreAssetIdx set   → fixed accounts index (buyV2, confirmed layout)
  //   2. Core + null idx    → MPL Core inner CPI accounts[0] (coreExecuteSaleV2,
  //                           coreFulfillSell where outer position varies)
  //   3. Legacy / pNFT      → SPL token-balance delta (no Core accounts involved)
  let mint: string | null;
  if (match.coreAssetIdx !== null) {
    mint = match.accounts[match.coreAssetIdx] ?? null;
  } else if (nftType === 'core') {
    mint = extractCoreAssetFromInnerIx(tx);
  } else {
    mint = extractNftMint(tx);
  }
  if (!mint) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine NFT mint` };
  }

  // Parties for ME v2:
  //   SOL-flow (payment.seller) is the primary seller source — the real seller wallet always
  //   receives the largest net SOL increase in the transaction (buyer pays minus ME fee/royalties).
  //   Token-flow (tkSeller = preTokenBalance.owner) is unreliable here: for pNFT/mip1 listings
  //   ME V2 holds the NFT in a program-controlled escrow whose token-account owner is a fixed
  //   program address (not the seller's wallet), causing consistent misattribution.
  //   Token-flow is kept only as a fallback for Core instructions (no SPL balances → tkSeller=null).
  //
  //   For buyer: token-flow (postHolder.owner = buyer's ATA owner) is reliable and preferred.
  const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
  const payment = extractPaymentInfo(tx);
  if (!payment) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine price` };
  }

  const seller = payment.seller ?? tkSeller;
  const buyer  = tkBuyer  ?? payment.buyer;

  if (!seller || !buyer || seller === buyer) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine seller/buyer` };
  }
  if (payment.priceLamports <= 0n) {
    return { ok: false, reason: `me_v2(${match.instructionName}): zero price` };
  }

  const sellerNet = computeSellerNetLamports(tx, seller);
  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'magic_eden',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports:     payment.priceLamports,
    priceSol:          Number(payment.priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData:           {
      _parser:     'me_v2_raw',
      _instruction: match.instructionName,
      _verified:   match.verified,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}

// ─── ME AMM (mmm) ─────────────────────────────────────────────────────────────

function parseMmmSale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findMmmSaleIx>>
): ParseResult {
  const nftType = nftTypeFromInstruction(match.instructionName);
  const accs    = match.accounts;

  // ── Mint / Core asset ID ──────────────────────────────────────────────────

  let mint: string | null;

  if (match.coreAssetIdx !== null) {
    // Core NFT: asset ID at the verified instruction account index.
    mint = accs[match.coreAssetIdx] ?? null;
  } else if (nftType === 'core') {
    // Core NFT with variable account layout (e.g. coreFulfillSell) — read from
    // MPL Core inner CPI accounts[0], which is the canonical stable position.
    mint = extractCoreAssetFromInnerIx(tx);
  } else {
    // Legacy / pNFT: derive mint from SPL token balance changes (confirmed to work).
    mint = extractNftMint(tx);
  }

  if (!mint) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine NFT mint` };
  }

  // ── Seller ────────────────────────────────────────────────────────────────

  let seller: string | null;

  if (match.sellerAcctIdx !== null) {
    seller = accs[match.sellerAcctIdx] ?? null;
  } else if (match.coreAssetIdx === null) {
    // Unverified SOL/pNFT instruction — fall back to token-flow ownership.
    seller = extractPartiesFromTokenFlow(tx, mint).seller;
  } else {
    seller = null; // Core, no verified position — use SOL-flow below
  }

  // ── Buyer ─────────────────────────────────────────────────────────────────

  let buyer: string | null;

  if (match.buyerAcctIdx !== null) {
    buyer = accs[match.buyerAcctIdx] ?? null;
  } else if (match.coreAssetIdx === null) {
    // Unverified SOL/pNFT instruction — fall back to token-flow ownership.
    buyer = extractPartiesFromTokenFlow(tx, mint).buyer;
  } else {
    buyer = null; // Core, no verified position — use SOL-flow below
  }

  // ── Price + SOL-flow fallback ─────────────────────────────────────────────

  const payment = extractPaymentInfo(tx);
  if (!payment || payment.priceLamports <= 0n) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine price` };
  }

  seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine parties` };
  }

  // ── Individual bid detection (non-Core fulfillBuy only) ───────────────────
  //
  // ME AMM (mmm program) handles two distinct cases under the same fulfillBuy
  // instruction family:
  //   1. True pool sale  — NFT is deposited into pool inventory.
  //                        postTokenBalance[NFT].owner == pool state PDA == accounts[1].
  //   2. Individual bid  — NFT delivered directly to the bidder's wallet.
  //                        postTokenBalance[NFT].owner != pool state PDA.
  //
  // The postTokenBalance owner (tokenFlowBuyer) is the definitive signal.
  // Core NFTs have no SPL token balances, so this check is skipped for them.
  let effectiveDirection: string = match.direction;
  if (match.direction === 'fulfillBuy' && nftType !== 'core') {
    const tokenFlowBuyer = extractPartiesFromTokenFlow(tx, mint).buyer;
    const poolPda        = accs[match.buyerAcctIdx ?? 1] ?? null;
    if (tokenFlowBuyer && poolPda && tokenFlowBuyer !== poolPda) {
      // NFT went to a real wallet, not the pool account → individual bid.
      buyer             = tokenFlowBuyer;
      effectiveDirection = 'takeBid'; // maps to bid_sell in both sse.ts and queries.ts
    }
  }

  // ── Build event ───────────────────────────────────────────────────────────

  const sellerNet = computeSellerNetLamports(tx, seller);
  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'magic_eden_amm',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports:     payment.priceLamports,
    priceSol:          Number(payment.priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData:           {
      _parser:      'mmm_raw',
      _instruction: match.instructionName,
      _direction:   effectiveDirection,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
