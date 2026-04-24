/**
 * Canonical derivation of the display-only `sale_type` label.
 *
 * This is the ONLY place `sale_type` may be computed. All readers/emitters
 * (SSE `sale` / `rawpatch`, REST `/latest`, REST `/by-collection`) must route
 * through this helper so the same underlying row always produces the same
 * label everywhere. Previously the logic lived in three places — a SQL CASE
 * expression in `queries.ts`, a TS function in `sse.ts`, and a second TS
 * function in `insert.ts` — which drifted whenever the schema changed.
 *
 * Inputs are the minimal subset needed from a sale row:
 *   - parser          = raw_data._parser
 *   - direction       = raw_data._direction
 *   - heliusSaleType  = raw_data.events.nft.saleType (Helius fast-path only)
 *
 * Precedence: raw-parser branches take priority over the Helius hint. Any row
 * with a known `_parser` ignores `heliusSaleType` even if present.
 */

export type SaleType = 'normal_sale' | 'pool_sale' | 'bid_sell' | 'pool_buy';

export interface SaleTypeInput {
  parser?:         string | null;
  direction?:      string | null;
  heliusSaleType?: string | null;
}

export function deriveSaleType(input: SaleTypeInput): SaleType {
  const parser = input.parser ?? undefined;
  const dir    = input.direction ?? undefined;

  // ── Raw-parser branches (program address is authoritative) ──────────────
  if (parser === 'me_v2_raw') return 'normal_sale';
  if (parser === 'mmm_raw') {
    if (dir === 'fulfillSell') return 'pool_buy';
    if (dir === 'takeBid')     return 'bid_sell';
    return 'pool_sale';
  }
  if (parser === 'tamm_raw') {
    return dir === 'takeBid' ? 'bid_sell' : 'pool_sale';
  }
  if (parser === 'tensor_raw') {
    return dir === 'takeBid' ? 'bid_sell' : 'normal_sale';
  }

  // ── Helius fast-path hint ───────────────────────────────────────────────
  // ME's AMM bid system can emit saleType strings containing both "AMM" and
  // "BID" (e.g. "AMM_BID_FILL") — bid patterns must be checked first so those
  // resolve to bid_sell rather than pool_sale.
  const st = (input.heliusSaleType ?? '').toUpperCase();
  if (st.includes('BID') || st.includes('ACCEPT') || st === 'GLOBAL_SELL') return 'bid_sell';
  if (st.includes('AMM'))                                                  return 'pool_sale';

  return 'normal_sale';
}
