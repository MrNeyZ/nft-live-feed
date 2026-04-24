import { getPool } from './client';
import { deriveSaleType } from '../domain/sale-type';

export interface SaleEventRow {
  id: string;
  signature: string;
  block_time: string;
  marketplace: string;
  nft_type: string;
  /**
   * Derived from raw_data via the canonical `deriveSaleType` helper in
   * `src/domain/sale-type.ts`. The SAME helper is used by the SSE emitter, so
   * REST-loaded events always match what SSE emitted live.
   * Values: 'normal_sale' | 'pool_sale' | 'bid_sell' | 'pool_buy'
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
  me_collection_slug: string | null;
  ingested_at: string;
  /** '_parser' field from raw_data JSON; null means Helius-parsed. */
  parser_source: string | null;
}

// Select raw_data extracts (not the full JSONB) so the TS-side `deriveSaleType`
// helper can run without re-parsing the whole blob. These columns are stripped
// from the response before it reaches callers — only `sale_type` survives.
const SALE_TYPE_EXTRACTS = `
  raw_data->>'_parser'    AS _parser_extract,
  raw_data->>'_direction' AS _direction_extract,
  raw_data->'events'->'nft'->>'saleType' AS _helius_sale_type_extract
`.trim();

interface SaleEventRowRaw extends SaleEventRow {
  _parser_extract:           string | null;
  _direction_extract:        string | null;
  _helius_sale_type_extract: string | null;
}

function applySaleType(rows: SaleEventRowRaw[]): SaleEventRow[] {
  return rows.map((r) => {
    r.sale_type = deriveSaleType({
      parser:         r._parser_extract,
      direction:      r._direction_extract,
      heliusSaleType: r._helius_sale_type_extract,
    });
    // Scrub scratch columns before returning to callers.
    delete (r as Partial<SaleEventRowRaw>)._parser_extract;
    delete (r as Partial<SaleEventRowRaw>)._direction_extract;
    delete (r as Partial<SaleEventRowRaw>)._helius_sale_type_extract;
    return r;
  });
}

const LATEST_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug, ingested_at,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS}
  FROM sale_events
  ORDER BY block_time DESC
  LIMIT $1
`;

export async function getLatestEvents(limit: number): Promise<SaleEventRow[]> {
  const pool = getPool();
  const result = await pool.query<SaleEventRowRaw>(LATEST_SQL, [limit]);
  return applySaleType(result.rows);
}

const BY_COLLECTION_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug, ingested_at,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS}
  FROM sale_events
  WHERE me_collection_slug = $1
    AND block_time >= $2
  ORDER BY block_time DESC
  LIMIT $3
`;

// Variant used when the caller does not specify a time window. No silent
// recency filter — the row set is bounded only by `limit`.
const BY_COLLECTION_NO_WINDOW_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug, ingested_at,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS}
  FROM sale_events
  WHERE me_collection_slug = $1
  ORDER BY block_time DESC
  LIMIT $2
`;

/**
 * History for one collection slug.
 *   `since`  cutoff (inclusive) when non-null; rows with block_time < since
 *            are excluded. Pass null for a time-unbounded query (bounded only
 *            by `limit`) — callers must opt in to a time window explicitly.
 *   `limit`  hard safety cap regardless of window size.
 * Newest first; backfilled rows participate the same way live rows do.
 */
export async function getEventsByCollection(
  slug: string, since: Date | null, limit: number,
): Promise<SaleEventRow[]> {
  const pool = getPool();
  if (since === null) {
    const result = await pool.query<SaleEventRowRaw>(BY_COLLECTION_NO_WINDOW_SQL, [slug, limit]);
    return applySaleType(result.rows);
  }
  const result = await pool.query<SaleEventRowRaw>(BY_COLLECTION_SQL, [slug, since, limit]);
  return applySaleType(result.rows);
}
