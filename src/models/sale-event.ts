export type NftType = 'legacy' | 'pnft' | 'core' | 'metaplex_core' | 'cnft';

export type Marketplace =
  | 'magic_eden'
  | 'magic_eden_amm'
  | 'tensor'
  | 'tensor_amm'
  | 'unknown';

export type Currency = 'SOL' | 'USDC';

/**
 * Canonical normalized representation of a single NFT sale event,
 * regardless of marketplace or NFT type.
 */
export interface SaleEvent {
  signature: string;
  blockTime: Date;
  marketplace: Marketplace;
  nftType: NftType;
  mintAddress: string;
  collectionAddress: string | null;
  seller: string;
  buyer: string;
  /** Price in lamports (canonical). 1 SOL = 1_000_000_000 lamports. */
  priceLamports: bigint;
  /** Derived: priceLamports / 1e9 */
  priceSol: number;
  currency: Currency;
  rawData: Record<string, unknown>;
  // Enrichment fields — populated best-effort via Helius DAS after parsing.
  // null means enrichment was skipped or failed; the event is still valid.
  nftName: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  magicEdenUrl: string | null;
  /** Magic Eden verified collection slug, e.g. "froganas". Used to build /marketplace/{slug} URL. */
  meCollectionSlug?: string | null;
  /**
   * Floor-price delta: (salePrice − floorPrice) / floorPrice.
   * e.g. −0.12 = 12% below floor. Null when floor is unavailable.
   */
  floorDelta?: number | null;
  /**
   * Offer delta: salePrice (SOL) − topOfferPrice (SOL).
   * Positive = sale above best offer. Negative = sale below best offer.
   * Null when no active collection offer is available.
   */
  offerDelta?: number | null;
}

/** cNFT sales below this threshold (in lamports) are discarded. */
export const CNFT_MIN_PRICE_LAMPORTS = 2_000_000n; // 0.002 SOL
