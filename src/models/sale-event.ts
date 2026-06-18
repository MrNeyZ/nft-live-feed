export type NftType = 'legacy' | 'pnft' | 'core' | 'metaplex_core' | 'cnft';

export type Marketplace =
  | 'magic_eden'
  | 'magic_eden_amm'
  | 'tensor'
  | 'tensor_amm'
  | 'orbis'
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
  /** NFT mint address. For legacy/pNFT/Core this is the asset's
   *  on-chain mint pubkey. For compressed NFTs (cNFT) we don't
   *  compute the derived `[merkle_tree, leaf_index]` PDA on the
   *  parser hot path — we use the collection address as a stable
   *  placeholder so type assumptions across the codebase
   *  (`.slice(0, 8)` log truncation, DB inserts, frontend dedup)
   *  hold without per-callsite null checks. Signature uniquely
   *  identifies the sale row downstream regardless. */
  mintAddress: string;
  collectionAddress: string | null;
  seller: string;
  buyer: string;
  /** Price in lamports (canonical, gross). 1 SOL = 1_000_000_000 lamports.
   *  This is the price the parser extracted from the instruction data —
   *  the gross sale figure before marketplace fees / royalties. */
  priceLamports: bigint;
  /** Derived: priceLamports / 1e9 */
  priceSol: number;
  /** Best-effort net amount the seller actually received, computed
   *  directly from the transaction's SOL balance delta on the seller
   *  account (`postBalances[i] - preBalances[i]`). Captures the real
   *  proceeds after marketplace fees + royalties. Falls back to null
   *  when the seller wallet isn't found in the tx's accountKeys or the
   *  delta is non-positive. The frontend prefers this when present and
   *  falls back to `priceLamports` / `priceSol`. */
  sellerNetLamports?: bigint | null;
  sellerNetPriceSol?: number | null;
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
  /** On-chain VERIFIED creator addresses resolved by enrichment (DAS). NOT
   *  persisted to sale_events — it exists only so the post-enrichment
   *  blacklist gate can match issuers (e.g. DRiP) that mint each drop under a
   *  fresh per-drop collection address with no name/slug. Null/absent when
   *  enrichment was skipped or DAS returned no verified creators. */
  verifiedCreators?: string[] | null;
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
  /** Resize-status snapshot at sale-frame time. Resolved out-of-band by
   *  `resize-status-resolver`. Frontend renders the RESIZE badge ONLY
   *  when value is `metaplex_resized_unclaimed`. Undefined = no lookup
   *  has been scheduled (prefilter didn't match) or hasn't returned yet
   *  — a `resize_status` SSE patch event will arrive later if it
   *  resolves to the actionable value. */
  resizeStatus?: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized';
}

/** cNFT sales below this threshold (in lamports) are discarded. */
export const CNFT_MIN_PRICE_LAMPORTS = 2_000_000n; // 0.002 SOL
