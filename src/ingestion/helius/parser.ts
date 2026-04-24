import {
  HeliusEnhancedTransaction,
  HeliusNftEvent,
  HeliusNftItem,
} from './types';
import {
  SaleEvent,
  NftType,
  Marketplace,
  Currency,
  CNFT_MIN_PRICE_LAMPORTS,
} from '../../models/sale-event';

// Solana program IDs relevant to NFT type detection
const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const BUBBLEGUM_PROGRAM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';

export type ParseResult =
  | { ok: true; event: SaleEvent }
  | { ok: false; reason: string };

/**
 * Attempt to parse one Helius enhanced transaction into a SaleEvent.
 * Returns { ok: false, reason } for transactions that should be skipped.
 */
export function parseHeliusTransaction(
  tx: HeliusEnhancedTransaction
): ParseResult {
  const nftEvent = tx.events?.nft;
  if (!nftEvent) {
    return { ok: false, reason: 'no nft event block' };
  }

  const type = tx.type ?? nftEvent.type ?? '';
  if (!isSaleType(type)) {
    return { ok: false, reason: `not a sale type: ${type}` };
  }

  const nft = nftEvent.nfts?.[0];
  // cNFT sales may arrive without a resolvable mint — let them pass through
  // with an empty placeholder (matches the raw tensor/tcomp cNFT path).
  const isCnft = type === 'COMPRESSED_NFT_SALE';
  if (!nft?.mint && !isCnft) {
    return { ok: false, reason: 'no mint in nft event' };
  }

  if (!nftEvent.buyer || !nftEvent.seller) {
    return { ok: false, reason: 'missing buyer or seller' };
  }

  const priceLamports = BigInt(nftEvent.amount ?? 0);
  if (priceLamports <= 0n) {
    return { ok: false, reason: 'zero price' };
  }

  const nftType = detectNftType(type, nft, tx);

  // Hard filter: discard low-value cNFT sales
  if (nftType === 'cnft' && priceLamports <= CNFT_MIN_PRICE_LAMPORTS) {
    return {
      ok: false,
      reason: `cnft below min price: ${priceLamports} lamports`,
    };
  }

  const marketplace = detectMarketplace(nftEvent.source, nftEvent.saleType);
  const currency = detectCurrency(tx);

  const event: SaleEvent = {
    signature: tx.signature,
    blockTime: new Date(nftEvent.timestamp * 1000),
    marketplace,
    nftType,
    mintAddress: nft?.mint ?? '',
    collectionAddress: null, // enriched later if needed
    seller: nftEvent.seller,
    buyer: nftEvent.buyer,
    priceLamports,
    priceSol: Number(priceLamports) / 1e9,
    currency,
    rawData: tx as unknown as Record<string, unknown>,
    // Enrichment fields are null at parse time; populated by enrich() before insert
    nftName: null,
    imageUrl: null,
    collectionName: null,
    magicEdenUrl: null,
  };

  return { ok: true, event };
}

function isSaleType(type: string): boolean {
  return type === 'NFT_SALE' || type === 'COMPRESSED_NFT_SALE';
}

function detectNftType(
  txType: string,
  nft: HeliusNftItem,
  tx: HeliusEnhancedTransaction
): NftType {
  if (txType === 'COMPRESSED_NFT_SALE') return 'cnft';

  const tokenStandard = nft.tokenStandard?.toLowerCase() ?? '';
  if (tokenStandard === 'compressed') return 'cnft';

  // Check if Bubblegum program is involved
  if (involvesProgram(tx, BUBBLEGUM_PROGRAM)) return 'cnft';

  // Check if MPL Core program is involved
  if (involvesProgram(tx, MPL_CORE_PROGRAM)) return 'metaplex_core';

  return 'legacy';
}

function involvesProgram(
  tx: HeliusEnhancedTransaction,
  programId: string
): boolean {
  if (!tx.instructions) return false;
  return tx.instructions.some(
    (ix) =>
      ix.programId === programId ||
      ix.innerInstructions?.some((inner) => inner.programId === programId)
  );
}


function detectMarketplace(source: string, saleType: string): Marketplace {
  const isAmm =
    saleType?.toUpperCase() === 'AMM' ||
    saleType?.toUpperCase() === 'AMM_SELL' ||
    saleType?.toUpperCase() === 'AMM_BUY';

  switch (source?.toUpperCase()) {
    case 'MAGIC_EDEN':
      return isAmm ? 'magic_eden_amm' : 'magic_eden';
    case 'TENSOR':
      return isAmm ? 'tensor_amm' : 'tensor';
    default:
      return 'unknown';
  }
}

function detectCurrency(tx: HeliusEnhancedTransaction): Currency {
  // USDC mint on Solana mainnet
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const transfers = tx.tokenTransfers as Array<{ mint?: string }> | undefined;
  if (transfers?.some((t) => t.mint === USDC_MINT)) return 'USDC';
  return 'SOL';
}
