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
import {
  isTensorTransaction,
  findTcompSaleIx,
  findTammSaleIx,
  classifyNftType,
} from './decoder';
import {
  extractPaymentInfo,
  extractNftMint,
  extractPartiesFromTokenFlow,
  extractCnftAssetId,
} from './price';
import bs58 from 'bs58';

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
    // Core NFT: asset address is at a verified account index — no SPL balance.
    if (match.coreAssetIdx === null) {
      return {
        ok: false,
        reason: `tcomp(${match.instructionName}): coreAssetIdx not set for Core NFT`,
      };
    }
    mint = accs[match.coreAssetIdx] ?? null;
    if (!mint) {
      return {
        ok: false,
        reason: `tcomp(${match.instructionName}): Core asset not found at accounts[${match.coreAssetIdx}]`,
      };
    }
  } else if (nftType === 'cnft') {
    // cNFT: no SPL token balance — asset ID from instruction data (stub).
    const ixData = Buffer.from(bs58.decode(match.ix.data));
    mint = extractCnftAssetId(accs, ixData);
    if (!mint) {
      return {
        ok: false,
        reason: `tcomp(${match.instructionName}): cNFT asset ID extraction not yet implemented`,
      };
    }
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

  const payment = extractPaymentInfo(tx);
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
    // Core NFT: asset address at verified account index.
    if (match.coreAssetIdx === null) {
      return {
        ok: false,
        reason: `tamm(${match.instructionName}): coreAssetIdx not set for Core NFT`,
      };
    }
    mint = accs[match.coreAssetIdx] ?? null;
    if (!mint) {
      return {
        ok: false,
        reason: `tamm(${match.instructionName}): Core asset not found at accounts[${match.coreAssetIdx}]`,
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

  if ((!buyer || !seller) && nftType !== 'core') {
    const flow = extractPartiesFromTokenFlow(tx, mint);
    buyer  = buyer  ?? flow.buyer;
    seller = seller ?? flow.seller;
  }

  // ── Price ──────────────────────────────────────────────────────────────────

  const payment = extractPaymentInfo(tx);
  if (!payment || payment.priceLamports <= 0n) {
    return { ok: false, reason: `tamm(${match.instructionName}): could not determine price` };
  }

  seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `tamm(${match.instructionName}): could not determine seller/buyer` };
  }

  // ── Build event ────────────────────────────────────────────────────────────

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
