/**
 * Unified frontend event type.
 *
 * REST (/api/events/latest) returns snake_case rows from Postgres.
 * SSE (/api/events/stream) emits camelCase from the SaleEvent model.
 * Both are normalised to FeedEvent before rendering.
 */
export interface FeedEvent {
  signature: string;
  blockTime: string;       // ISO-8601
  marketplace: string;
  nftType: string;
  saleType: string;        // 'list_buy' | 'amm_buy' | 'amm_sell' | 'bid_sell'
  mintAddress: string;
  collectionAddress: string | null;
  seller: string;
  buyer: string;
  priceSol: number;
  /** Best-effort net SOL the seller actually received (after fees +
   *  royalties), computed server-side from the tx's pre/post balance
   *  delta. Null when not extractable. UI prefers this when present
   *  and falls back to `priceSol` (gross). */
  sellerNetPriceSol?: number | null;
  currency: string;
  nftName: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  magicEdenUrl: string | null;
  /** Ingestion path: 'helius' | 'me_raw' */
  source: string;
  /** Floor-price delta as a fraction, e.g. -0.12 = -12%. Absent when unknown. */
  floorDelta?: number | null;
  /** Offer delta in SOL: salePrice − topOffer. Absent when unknown. */
  offerDelta?: number | null;
  /** Best-effort rarity from mint_rarity_cache (no provider call). Absent when
   *  the mint isn't cached — the rarity badge is hidden in that case. */
  rarityRank?: number | null;
  totalSupply?: number | null;
  rarityPercentile?: number | null;
  raritySource?: string | null;
  /** True only when the mint carries a stored "1/1"-style trait (renders 1/1). */
  oneOfOne?: boolean;
  /** Verified ME collection slug, e.g. "froganas". Null until meta patch arrives. */
  meCollectionSlug: string | null;
  /** Tensor-native collection slug (slugDisplay). Null for non-Tensor sales or until meta patch. */
  tensorCollectionSlug?: string | null;
  /** Server-persisted seller-remaining-count (DB column seller_remaining_count,
   *  migration 015). Populated on the REST snapshot path via fromRow; absent on
   *  live SSE sale frames (resolved async, then delivered over `seller_count`).
   *  Makes the SELL badge consistent across devices/reloads. */
  sellerRemainingCount?: number | null;
  /** Resize-status snapshot from the backend resolver. Only
   *  'metaplex_resized_unclaimed' triggers the RESIZE chip; other
   *  values render no chip. Absent / null = no lookup scheduled (sale
   *  didn't pass prefilter) or pending. May arrive later via a
   *  `resize_status` SSE patch. */
  resizeStatus?: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized' | null;
}

/** Shape returned by GET /api/events/latest */
export interface LatestApiResponse {
  events: RestRow[];
  count: number;
}

export interface RestRow {
  id: string;
  signature: string;
  block_time: string;
  marketplace: string;
  nft_type: string;
  sale_type: string | null;
  mint_address: string;
  collection_address: string | null;
  seller: string;
  buyer: string;
  price_sol: string;
  currency: string;
  nft_name: string | null;
  image_url: string | null;
  collection_name: string | null;
  magic_eden_url: string | null;
  me_collection_slug: string | null;
  tensor_collection_slug?: string | null;
  parser_source: string | null;
  /** Best-effort rarity stamped by /latest + /by-collection from
   *  mint_rarity_cache (no provider call). Absent when the mint isn't cached. */
  rarity_rank?: number | null;
  total_supply?: number | null;
  rarity_percentile?: number | null;
  rarity_source?: string | null;
  one_of_one?: boolean;
  /** Optional. Backend's /latest handler retro-attaches this from the
   *  in-process floor cache when the slug has been seen in the last
   *  2 minutes. Absent on stale snapshots — frontend hides the chip. */
  floor_delta?: number | null;
  /** Resize-status stamped on the REST snapshot from the resolver
   *  cache (which is DB-preloaded on boot). Survives a page refresh. */
  resize_status?: string | null;
  /** Server-persisted seller-remaining-count (DB column, migration 015).
   *  Null when never resolved. Makes the SELL badge consistent across
   *  devices/reloads without depending on per-browser localStorage. */
  seller_remaining_count?: number | null;
}

export function fromRow(row: RestRow): FeedEvent {
  return {
    signature: row.signature,
    blockTime: row.block_time,
    marketplace: row.marketplace,
    nftType: row.nft_type,
    saleType: row.sale_type ?? 'normal_sale',
    mintAddress: row.mint_address,
    collectionAddress: row.collection_address,
    seller: row.seller,
    buyer: row.buyer,
    priceSol: parseFloat(row.price_sol),
    currency: row.currency,
    nftName: row.nft_name,
    imageUrl: row.image_url,
    collectionName: row.collection_name,
    magicEdenUrl: row.magic_eden_url,
    source: row.parser_source ? 'me_raw' : 'helius',
    meCollectionSlug:     row.me_collection_slug,
    tensorCollectionSlug: row.tensor_collection_slug ?? null,
    sellerRemainingCount: row.seller_remaining_count ?? null,
    floorDelta: row.floor_delta ?? null,
    rarityRank:       row.rarity_rank ?? null,
    totalSupply:      row.total_supply ?? null,
    rarityPercentile: row.rarity_percentile ?? null,
    raritySource:     row.rarity_source ?? null,
    oneOfOne:         row.one_of_one ?? false,
    resizeStatus: (row.resize_status as FeedEvent['resizeStatus']) ?? null,
  };
}
