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
  /** Tensor-native collection slug (slugDisplay from find_collection API). Used to build
   *  /trade/{slug} links. Only set for tensor/tensor_amm sales when TENSOR_API_KEY is set. */
  tensorCollectionSlug?: string | null;
  /** On-chain VERIFIED creator addresses resolved by enrichment (DAS). NOT
   *  persisted to sale_events — it exists only so the post-enrichment
   *  blacklist gate can match issuers (e.g. DRiP) that mint each drop under a
   *  fresh per-drop collection address with no name/slug. Null/absent when
   *  enrichment was skipped or DAS returned no verified creators. */
  verifiedCreators?: string[] | null;
  /** True when DAS metadata carried an "Artist" trait_type/key. Transient
   *  (NOT persisted) — feeds only the narrow DRiP cNFT-null-collection gate. */
  hasArtistAttribute?: boolean;
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
  /**
   * FRESH MINT badge support. Set when this sale's `mintAddress` matches a
   * `mint_events` row observed within the last 4h (NFT-level join only — see
   * `src/mints/fresh-mint-cache.ts`). Null when there's no match: unknown
   * mint, mint older than the window, or (today) a cNFT sale from a
   * marketplace whose parser stores the merkle tree instead of the real
   * per-asset ID in `mintAddress` (ME / MMM `cnftFulfillBuy` — Tensor cNFT
   * sales resolve the real asset ID and DO join correctly).
   */
  mintedAtMs?: number | null;
  /**
   * Circular-ownership-loop signal — backend-only derived value, NOT
   * persisted, NOT comprehensive wash detection. Set when this sale's
   * `seller` matches an earlier `buyer` of the SAME `mintAddress` within a
   * bounded 7-day/5-hop, non-AMM-marketplace-only window (see
   * `src/enrichment/ownership-loop-cache.ts`). Undefined when the check
   * didn't run (empty mint/seller/buyer, AMM marketplace) or found no match.
   * Order-sensitive: only meaningful at live-enrichment time, not re-derived
   * for historical rows.
   */
  ownershipLoop?: OwnershipLoopSignal;
  /**
   * Repeat-near-floor-buyer signal — backend-only derived value, NOT
   * persisted, NOT a claim of whale behavior or intentional floor defense.
   * Purely factual: the same `buyer` has bought near-floor (`floorDelta`
   * within 5% of floor) in the same `collectionAddress` at least 3 times,
   * totaling >= 1 SOL, within a 7-day window, on non-AMM marketplaces only
   * (see `src/enrichment/repeat-floor-buyer-cache.ts`). Undefined when the
   * check didn't run or the ring doesn't yet qualify.
   */
  repeatFloorBuyer?: RepeatFloorBuyerSignal;
  /**
   * MMM pool state PDA (the account ME's own API keys by `poolKey`) —
   * captured directly from the confirmed instruction-accounts index for
   * MMM fulfill variants (see `src/ingestion/me-raw/programs.ts`'s
   * `poolAcctIdx`). NOT persisted — sale_events carries no column for it.
   * Null for non-MMM sales and for any MMM instruction variant whose pool
   * account position hasn't been independently verified against a live
   * transaction (fail closed rather than guess).
   */
  poolAddress?: string | null;
  /**
   * Resolved AMM classification for `poolAddress`, normalized from Magic
   * Eden's raw `poolType` (`buy_sided`/`sell_sided`/`two_sided`/`invalid`).
   * NOT persisted — resolved out-of-band by `mmm-pool-type-resolver` and
   * only ever meaningful for the live SSE frame + its `pool_type` patch.
   * The AMM badge renders ONLY when this is exactly `'two_sided'`; `'buy'`,
   * `'sell'`, and `null` (unresolved/unknown/failed lookup) all render the
   * plain BUY/SELL — see `sale-kind.ts`'s `saleKind()`.
   */
  poolType?: 'buy' | 'sell' | 'two_sided' | null;
  /**
   * Timestamp the me-raw parser (`parseRawMeTransaction`) received the raw
   * transaction to process — captured once, synchronously (`Date.now()`,
   * zero I/O), before dispatching to whichever sale-family sub-parser
   * matches. Measures OUR pipeline's ingestion latency (WS/poll →
   * getTransaction → parse), NOT on-chain time — never use `blockTime` as
   * a substitute for this. Undefined for any sale that didn't go through
   * `me-raw/parser.ts` (tensor-raw, mint-raw, historical/pre-existing
   * rows) — callers must expose null rather than fabricate one.
   */
  parserReceivedAt?: Date;
}

/**
 * See `SaleEvent.ownershipLoop`. `closedAfterMs`/`hopsAgo` are 0 for the
 * same-row buyer===seller self-deal case (the strongest, cheapest signal);
 * otherwise they measure the gap back to the matching prior buy.
 */
export interface OwnershipLoopSignal {
  detected: boolean;
  confidence: 'high' | 'low';
  closedAfterMs: number;
  hopsAgo: number;
}

/** See `SaleEvent.repeatFloorBuyer`. `spanMs` is the gap between the first
 *  and latest qualifying near-floor buy within the current 7-day ring. */
export interface RepeatFloorBuyerSignal {
  detected: boolean;
  confidence: 'high' | 'low';
  buyCount: number;
  totalSpentSol: number;
  spanMs: number;
}

/**
 * cNFT sales below this threshold (in lamports) are discarded.
 * Restored to 2_000_000 (0.002 SOL): sub-0.002 cNFT sales are
 * uniformly junk/spam and unwanted in the feed. MPL Core / legacy
 * NFT sales are unaffected — filter is cnft-only.
 */
export const CNFT_MIN_PRICE_LAMPORTS = 2_000_000n; // 0.002 SOL
