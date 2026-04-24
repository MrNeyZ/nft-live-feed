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
  /** Verified ME collection slug, e.g. "froganas". Null until meta patch arrives. */
  meCollectionSlug: string | null;
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
  parser_source: string | null;
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
    meCollectionSlug: row.me_collection_slug,
  };
}
