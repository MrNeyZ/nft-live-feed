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
   *
   * ⚠ This is NOT the raw `sale_events.sale_type` DB column. That column is
   * LEGACY/DEAD: `NOT NULL DEFAULT 'list_buy'` (migration 004) and is never
   * written by inserts, so every persisted row reads `'list_buy'`. No query
   * SELECTs it; do NOT use the raw column for reads/analytics — always derive.
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
  tensor_collection_slug: string | null;
  ingested_at: string;
  /** '_parser' field from raw_data JSON; null means Helius-parsed. */
  parser_source: string | null;
  /** Persisted seller-remaining-count (DB column, migration 015). Written
   *  fire-and-forget by the seller_count resolution path in sse.ts. NULL when
   *  never resolved. Makes the SELL badge consistent across devices/reloads
   *  without depending on per-browser localStorage. */
  seller_remaining_count: number | null;
  /** Persisted floor delta at enrichment time (migration 017). Survives page
   *  reloads; stampFromCache uses this value when present and only falls back
   *  to the live floor cache for rows where it is null. */
  floor_delta?: number | null;
  /** Resize-status stamped at /latest response time from the in-process
   *  resolver cache (NOT a DB column — added in the handler). Survives a
   *  page refresh so the RESIZE badge persists across reloads. */
  resize_status?: string | null;
  /** FRESH MINT fact frozen at enrichment time, stored under raw_data's
   *  '_mintedAtMs' key (no migration — see insert.ts UPDATE_META_SQL).
   *  Present (possibly null) once a row has been through the new
   *  enrichment path; absent for older rows written before this existed,
   *  which fall back to the live fresh-mint-cache check in stampFromCache. */
  minted_at_ms?: number | null;
  /** True when raw_data carries the '_mintedAtMs' key at all — distinguishes
   *  "checked at sale time, confirmed not fresh" (key present, value null)
   *  from "never checked" (key absent, pre-fix row) so stampFromCache knows
   *  whether to trust `minted_at_ms` as-is or still try the live fallback. */
  minted_at_checked?: boolean;
  /** Authoritative, transaction-time AMM-fill signal — derived from
   *  raw_data's '_ammFill' key (set by the parser from the MMM lp_fee log,
   *  see src/ingestion/me-raw/parser.ts). Unlike `poolType` (SSE-only,
   *  never persisted), this survives a REST read / page reload / collection
   *  drill-down because it's stored in raw_data at insert time — see
   *  ammFillFromRawData in sale-event-adapters.ts.
   *
   *  Tri-state: true (confirmed AMM fill) / false (confirmed lp_fee===0
   *  ordinary bid acceptance — must never fall back to poolType) / null
   *  (no evidence — key absent, e.g. non-MMM sale, MMM fulfillSell, an
   *  unverified instruction variant, or a row ingested before this field
   *  existed — poolType fallback is allowed for null only). */
  amm_fill: boolean | null;
}

// Select raw_data extracts (not the full JSONB) so the TS-side `deriveSaleType`
// helper can run without re-parsing the whole blob. These scratch columns are
// stripped before the response reaches callers — only the DERIVED `sale_type`
// (set by applySaleType) survives.
//
// NOTE: the queries deliberately do NOT select the raw `sale_events.sale_type`
// column — it's a dead default ('list_buy', never written). sale_type is always
// computed here from these raw_data extracts via `deriveSaleType`.
const SALE_TYPE_EXTRACTS = `
  raw_data->>'_parser'    AS _parser_extract,
  raw_data->>'_direction' AS _direction_extract,
  raw_data->>'_subtype'   AS _subtype_extract,
  raw_data->'events'->'nft'->>'saleType' AS _helius_sale_type_extract,
  (raw_data->>'_ammFill')::boolean AS _amm_fill_extract
`.trim();

// See UPDATE_META_SQL in insert.ts — frozen FRESH MINT fact, stored in
// raw_data rather than a real column so no migration was needed. The
// `?` (jsonb "has key") check is what lets stampFromCache tell "checked,
// not fresh" (key present, null) apart from "never checked" (key absent).
const MINTED_AT_EXTRACTS = `
  (raw_data ? '_mintedAtMs')             AS _minted_at_checked_extract,
  (raw_data->>'_mintedAtMs')::bigint     AS minted_at_ms
`.trim();

interface SaleEventRowRaw extends SaleEventRow {
  _parser_extract:           string | null;
  _direction_extract:        string | null;
  _subtype_extract:          string | null;
  _helius_sale_type_extract: string | null;
  _minted_at_checked_extract: boolean;
  _amm_fill_extract:         boolean | null;
}

// Canonical read-side classifier: overwrite each row's `sale_type` with the
// value DERIVED from raw_data (deriveSaleType). The raw `sale_events.sale_type`
// column is a legacy/dead default ('list_buy') and is intentionally ignored —
// this is the only thing that makes REST reads match live SSE. Never bypass
// this to read the raw column.
function applySaleType(rows: SaleEventRowRaw[]): SaleEventRow[] {
  return rows.map((r) => {
    r.sale_type = deriveSaleType({
      parser:         r._parser_extract,
      direction:      r._direction_extract,
      heliusSaleType: r._helius_sale_type_extract,
      subtype:        r._subtype_extract,
    });
    r.minted_at_checked = r._minted_at_checked_extract;
    // Tri-state passthrough — see SaleEventRow.amm_fill. Do NOT collapse
    // null to false here; that would erase the "no evidence" state a
    // caller needs to know poolType fallback is still allowed.
    r.amm_fill = r._amm_fill_extract;
    // Scrub scratch columns before returning to callers.
    delete (r as Partial<SaleEventRowRaw>)._parser_extract;
    delete (r as Partial<SaleEventRowRaw>)._direction_extract;
    delete (r as Partial<SaleEventRowRaw>)._subtype_extract;
    delete (r as Partial<SaleEventRowRaw>)._helius_sale_type_extract;
    delete (r as Partial<SaleEventRowRaw>)._minted_at_checked_extract;
    delete (r as Partial<SaleEventRowRaw>)._amm_fill_extract;
    return r;
  });
}

const LATEST_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug,
         tensor_collection_slug, ingested_at,
         seller_remaining_count, floor_delta,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS},
         ${MINTED_AT_EXTRACTS}
  FROM sale_events
  ORDER BY block_time DESC, id DESC
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
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug,
         tensor_collection_slug, ingested_at,
         seller_remaining_count, floor_delta,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS},
         ${MINTED_AT_EXTRACTS}
  FROM sale_events
  WHERE me_collection_slug = $1
    AND block_time >= $2
  ORDER BY block_time DESC, id DESC
  LIMIT $3
`;

// Variant used when the caller does not specify a time window. No silent
// recency filter — the row set is bounded only by `limit`.
const BY_COLLECTION_NO_WINDOW_SQL = `
  SELECT id, signature, block_time, marketplace, nft_type, mint_address,
         collection_address, seller, buyer, price_lamports, price_sol, currency,
         nft_name, image_url, collection_name, magic_eden_url, me_collection_slug,
         tensor_collection_slug, ingested_at,
         seller_remaining_count, floor_delta,
         raw_data->>'_parser' AS parser_source,
         ${SALE_TYPE_EXTRACTS},
         ${MINTED_AT_EXTRACTS}
  FROM sale_events
  WHERE me_collection_slug = $1
  ORDER BY block_time DESC, id DESC
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

// ── Canonical sale meta by signature (overlay source for trade-history) ──────
// Returns the canonical DERIVED sale_type (via deriveSaleType, NOT the dead
// sale_events.sale_type default), plus nft_type + marketplace, for the given
// signatures. Used to overlay the ME-activity-derived rows in
// collection-trade-history so shared txs match the rest of the app.
export interface CanonicalSaleMeta {
  signature:   string;
  sale_type:   string;
  nft_type:    string;
  marketplace: string;
  /** See SaleEventRow.amm_fill (tri-state). Included so collection-trade-
   *  history's ME-activity overlay can carry the authoritative AMM signal
   *  onto shared-signature rows, not just sale_type/nft_type/marketplace. */
  amm_fill:    boolean | null;
}
const SALE_META_BY_SIG_SQL = `
  SELECT signature, nft_type, marketplace, ${SALE_TYPE_EXTRACTS}
    FROM sale_events
   WHERE signature = ANY($1)
`;
export async function getCanonicalSaleMetaBySignatures(
  signatures: string[],
): Promise<Map<string, CanonicalSaleMeta>> {
  const out = new Map<string, CanonicalSaleMeta>();
  if (signatures.length === 0) return out;
  const pool = getPool();
  const { rows } = await pool.query<SaleEventRowRaw>(SALE_META_BY_SIG_SQL, [signatures]);
  for (const r of rows) {
    const sale_type = deriveSaleType({
      parser:         r._parser_extract,
      direction:      r._direction_extract,
      heliusSaleType: r._helius_sale_type_extract,
      subtype:        r._subtype_extract,
    });
    out.set(r.signature, {
      signature:   r.signature,
      sale_type,
      nft_type:    r.nft_type,
      marketplace: r.marketplace,
      amm_fill:    r._amm_fill_extract,
    });
  }
  return out;
}
