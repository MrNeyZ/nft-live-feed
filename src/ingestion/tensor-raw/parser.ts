/**
 * Raw Tensor transaction parser.
 *
 * Converts a raw Solana `getTransaction` response into a `SaleEvent`
 * using instruction discriminator matching and balance delta analysis —
 * no dependency on Helius enhanced parsing.
 *
 * Coverage (2026-04-14, all verified against ground-truth txs):
 *   TComp: buy (Core NFT) ✅
 *          takeBid (Core NFT) ✅
 *          cNFT buy / takeBid ⚠️ (asset ID extraction not yet implemented)
 *   TAMM:  sell into pool (Core NFT) ✅
 *          buy from pool (Core NFT) ✅
 */

import { RawSolanaTx } from './types';
import { SaleEvent, NftType, CNFT_MIN_PRICE_LAMPORTS } from '../../models/sale-event';
import { computeSellerNetLamports } from '../seller-net';
import { TAMM_PROGRAM } from './programs';
import {
  isTensorTransaction,
  findTcompSaleIx,
  findTammSaleIx,
  classifyNftType,
  extractCoreAssetFromInnerIx,
} from './decoder';
import {
  extractPaymentInfo,
  extractCnftPaymentInfo,
  extractNftMint,
  extractPartiesFromTokenFlow,
  extractCnftAssetId,
} from './price';

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseRawTensorTransaction(tx: RawSolanaTx): ParseResult {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }
  if (!tx.blockTime) {
    return { ok: false, reason: 'missing blockTime' };
  }
  if (!isTensorTransaction(tx)) {
    return { ok: false, reason: 'no Tensor program involved' };
  }

  // Try TComp first (fixed-price: listings + bids).
  const tcompMatch = findTcompSaleIx(tx);
  if (tcompMatch) return parseTcompSale(tx, tcompMatch);

  // Try TAMM (AMM pool trades).
  const tammMatch = findTammSaleIx(tx);
  if (tammMatch) return parseTammSale(tx, tammMatch);

  return { ok: false, reason: 'no recognised Tensor sale instruction' };
}

// ─── TComp fixed-price ────────────────────────────────────────────────────────

function parseTcompSale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findTcompSaleIx>>
): ParseResult {
  const nftType = classifyNftType(tx, match.instructionName);
  const accs    = match.accounts;

  // ── Mint / asset ID ────────────────────────────────────────────────────────

  let mint: string | null;

  if (nftType === 'core') {
    // Core NFT: prefer the verified account index; fall back to the MPL Core
    // inner CPI (accounts[0] of the first MPL Core instruction) when the
    // indexed lookup is absent OR yields an empty string (e.g. ALT-loaded
    // asset, variant layout, or unverified instruction).
    mint = match.coreAssetIdx !== null ? (accs[match.coreAssetIdx] || null) : null;
    if (!mint) mint = extractCoreAssetFromInnerIx(tx);
    if (!mint) {
      return {
        ok: false,
        reason: `tcomp(${match.instructionName}): could not determine Core asset ID`,
      };
    }
  } else if (nftType === 'cnft') {
    // cNFT: no SPL token balance — derive the asset ID from the Bubblegum
    // `transfer` inner CPI inside the tx we already fetched. If the local
    // derivation fails, emit with an empty mint placeholder so the sale still
    // surfaces in the feed (downstream enrich skips empty mints cleanly).
    mint = extractCnftAssetId(tx) ?? '';
  } else {
    // Standard SPL NFT (legacy / pNFT).
    mint = extractNftMint(tx);
    if (!mint) {
      return {
        ok: false,
        reason: `tcomp(${match.instructionName}): could not determine NFT mint`,
      };
    }
  }

  // ── Seller / buyer ─────────────────────────────────────────────────────────

  let seller: string | null = null;
  let buyer:  string | null = null;

  if (match.buyerAcctIdx  !== null) buyer  = accs[match.buyerAcctIdx]  ?? null;
  if (match.sellerAcctIdx !== null) seller = accs[match.sellerAcctIdx] ?? null;

  // SPL token flow fallback for non-Core/non-cNFT when indices are absent.
  if ((!buyer || !seller) && nftType !== 'cnft' && nftType !== 'core') {
    const flow = extractPartiesFromTokenFlow(tx, mint);
    buyer  = buyer  ?? flow.buyer;
    seller = seller ?? flow.seller;
  }

  // ── Price ──────────────────────────────────────────────────────────────────

  // For cNFT listing purchases, unrelated SOL transfers (escrow closures, rent)
  // inflate the SOL-delta heuristic. Use the maxAmount-bounded inner-transfer
  // scan instead. For bid acceptances (takeBid*), TComp settles the payment via
  // direct lamport manipulation (no inner System Transfer CPIs), so the cNFT
  // inner-transfer scan finds nothing and returns null. Use SOL-delta for those:
  // the bidder's wallet carries the largest decrease and gives the correct price.
  const isBidAcceptance = match.instructionName.startsWith('takeBid');
  const payment = (nftType === 'cnft' && !isBidAcceptance)
    ? extractCnftPaymentInfo(tx, match.ix)
    : extractPaymentInfo(tx);
  if (!payment || payment.priceLamports <= 0n) {
    return { ok: false, reason: `tcomp(${match.instructionName}): could not determine price` };
  }

  // SOL-delta fallback for buyer/seller (e.g. takeBid has no buyerAcctIdx).
  seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `tcomp(${match.instructionName}): could not determine seller/buyer` };
  }

  // ── cNFT minimum price filter ──────────────────────────────────────────────

  if (nftType === 'cnft' && payment.priceLamports <= CNFT_MIN_PRICE_LAMPORTS) {
    return {
      ok: false,
      reason: `tcomp(${match.instructionName}): cnft below min price: ${payment.priceLamports}`,
    };
  }

  // ── Build event ────────────────────────────────────────────────────────────

  const sellerNet = computeSellerNetLamports(tx, seller);
  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'tensor',
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
    rawData: {
      _parser:      'tensor_raw',
      _instruction: match.instructionName,
      _verified:    match.verified,
      _direction:   match.direction,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}

// ─── TAMM AMM ─────────────────────────────────────────────────────────────────

function parseTammSale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findTammSaleIx>>
): ParseResult {
  const nftType = classifyNftType(tx, match.instructionName);
  const accs    = match.accounts;

  // ── Mint / asset ID ────────────────────────────────────────────────────────

  let mint: string | null;

  if (nftType === 'core') {
    // Core NFT: same fallback chain as TComp — indexed first, then MPL Core
    // inner CPI. Covers variants where the asset position is ALT-loaded or the
    // instruction has no verified index.
    mint = match.coreAssetIdx !== null ? (accs[match.coreAssetIdx] || null) : null;
    if (!mint) mint = extractCoreAssetFromInnerIx(tx);
    if (!mint) {
      return {
        ok: false,
        reason: `tamm(${match.instructionName}): could not determine Core asset ID`,
      };
    }
  } else {
    // Standard SPL NFT.
    mint = extractNftMint(tx);
    if (!mint) {
      return { ok: false, reason: `tamm(${match.instructionName}): could not determine NFT mint` };
    }
  }

  // ── Seller / buyer ─────────────────────────────────────────────────────────

  let seller: string | null = null;
  let buyer:  string | null = null;

  if (match.buyerAcctIdx  !== null) buyer  = accs[match.buyerAcctIdx]  ?? null;
  if (match.sellerAcctIdx !== null) seller = accs[match.sellerAcctIdx] ?? null;

  // TAMM sell: pool owner (buyer) was historically at instruction slot 7.
  // Newer pool layouts dropped the TSwap singleton from the front of the
  // account list, shifting the pool owner to slot 0 and leaving slot 7
  // occupied by the TAMM program itself. Detect that degenerate case and
  // use slot 0 instead.
  if (match.direction === 'sell' && buyer === TAMM_PROGRAM) {
    buyer = accs[0] ?? null;
  }

  // For user-buys-from-pool with NO verified seller index, token-flow
  // and payment-flow both resolve to the POOL VAULT PDA — not the human
  // pool owner. Refuse those fallbacks for the SELLER slot specifically;
  // the event is dropped rather than surfaced with a wrong wallet. Buyer
  // (= user) is still resolved normally from flow because it's correct.
  const poolBuyAmbiguous = match.direction === 'buy' && match.sellerAcctIdx === null;

  if ((!buyer || !seller) && nftType !== 'core') {
    const flow = extractPartiesFromTokenFlow(tx, mint);
    buyer  = buyer  ?? flow.buyer;
    if (!poolBuyAmbiguous) seller = seller ?? flow.seller;
  }

  // ── Price ──────────────────────────────────────────────────────────────────

  const payment = extractPaymentInfo(tx);
  if (!payment || payment.priceLamports <= 0n) {
    return { ok: false, reason: `tamm(${match.instructionName}): could not determine price` };
  }

  if (!poolBuyAmbiguous) seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `tamm(${match.instructionName}): could not determine seller/buyer` };
  }

  // ── Build event ────────────────────────────────────────────────────────────

  // For TAMM pool_buy (direction='buy'), `seller` resolves via the
  // static `sellerAcctIdx=0` slot which for shared-escrow TAMM pool
  // shapes is a protocol fee wallet (e.g. A5sAP5KhTQ7KG…) whose
  // positive lamport delta is dust (~0.001 SOL), not the pool owner's
  // proceeds. Computing sellerNetLamports here produces a
  // conceptually-meaningless number that ends up rendered by the
  // frontend's `event.price = sellerNetPriceSol ?? priceSol` fallback,
  // displaying ~0.001 SOL live for sales that are actually ~0.06.
  // Buyer paid the gross — there is no meaningful "seller net" for
  // pool_buy — so we leave the field null and let priceSol win.
  // bid_sell (takeBid*) and pool_sale (sell direction) paths still
  // compute sellerNet as before.
  const sellerNet = match.direction === 'buy'
    ? null
    : computeSellerNetLamports(tx, seller);
  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'tensor_amm',
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
    rawData: {
      _parser:      'tamm_raw',
      _instruction: match.instructionName,
      _verified:    match.verified,
      _direction:   match.direction,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
