import { getPool } from './client';

export interface SaleEventRow {
  id: string;
  signature: string;
  block_time: string;
  marketplace: string;
  nft_type: string;
  /**
   * Derived from raw_data at query time — mirrors the deriveTradeLabel() logic
   * in sse.ts so REST-loaded events match what SSE emitted live.
   * Values: 'normal_sale' | 'pool_sale' | 'bid_sell' | 'pool_sell' | 'pool_buy'
   */
  sale_type: string;
  mint_address: string;
  collection_address: string | null;
  seller: string;
  buyer: string;
  price_lamports: string;
  price_sol: string;
  currency: string;
  nft_name: string | null;
  image_url: string | null;
  collection_name: string | null;
  magic_eden_url: string | null;
  ingested_at: string;
  /** '_parser' field from raw_data JSON; null means Helius-parsed. */
  parser_source: string | null;
}

/**
 * Derives the display-only sale type from raw_data JSONB.
 * Must stay in sync with _tradeLabel() in src/server/sse.ts.
 *
 *  me_v2_raw   → normal_sale
 *  mmm_raw     → pool_sale
 *  tamm_raw    → bid_sell (takeBid) | pool_sale (pool fill)
 *  tensor_raw  → bid_sell (takeBid) | normal_sale (listing)
 *  Helius path → inspect events.nft.saleType hint from Helius
 */
const SALE_TYPE_EXPR = `
  CASE
    WHEN raw_data->>'_parser' = 'me_v2_raw'  THEN 'normal_sale'
    WHEN raw_data->>'_parser' = 'mmm_raw'    THEN
      CASE
        WHEN raw_data->>'_direction' = 'fulfillSell' THEN 'pool_buy'
        WHEN raw_data->>'_direction' = 'takeBid'     THEN 'bid_sell'
        ELSE 'pool_sale'
      END
    WHEN raw_data->>'_parser' = 'tamm_raw'   THEN
      CASE WHEN raw_data->>'_direction' = 'takeBid' THEN 'bid_sell' ELSE 'pool_sale' END
    WHEN raw_data->>'_parser' = 'tensor_raw' THEN
      CASE WHEN raw_data->>'_direction' = 'takeBid' THEN 'bid_sell' ELSE 'normal_sale' END
    -- Bid-specific patterns checked before generic AMM: ME's AMM bid fills
    -- can produce saleTypes containing both "AMM" and "BID"; those are bid_sell.
    WHEN upper(raw_data->'events'->'nft'->>'saleType') LIKE '%BID%'    THEN 'bid_sell'
    WHEN upper(raw_data->'events'->'nft'->>'saleType') LIKE '%ACCEPT%' THEN 'bid_sell'
    WHEN raw_data->'events'->'nft'->>'saleType' = 'GLOBAL_SELL'        THEN 'bid_sell'
    WHEN upper(raw_data->'events'->'nft'->>'saleType') LIKE '%AMM%'    THEN 'pool_sale'
    ELSE 'normal_sale'
  END
`.trim();

const LATEST_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, ingested_at,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXPR} AS sale_type
  FROM sale_events
  ORDER BY block_time DESC
  LIMIT $1
`;

export async function getLatestEvents(limit: number): Promise<SaleEventRow[]> {
  const pool = getPool();
  const result = await pool.query<SaleEventRow>(LATEST_SQL, [limit]);
  return result.rows;
}
