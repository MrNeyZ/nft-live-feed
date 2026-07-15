/**
 * Adapters that feed a `SaleEvent` (or its raw_data payload) into the canonical
 * `deriveSaleType` helper. Kept beside the helper so every emitter in the code
 * base goes through the same extraction surface — no ad-hoc reads of
 * `raw_data._parser` / `_direction` / `events.nft.saleType` anywhere else.
 */

import { SaleEvent } from '../models/sale-event';
import { deriveSaleType, SaleType } from './sale-type';

export function saleTypeFromRawData(rawData: Record<string, unknown>): SaleType {
  const events = rawData.events as Record<string, unknown> | undefined;
  const nft    = events?.nft    as Record<string, unknown> | undefined;
  return deriveSaleType({
    parser:         rawData._parser    as string | undefined,
    direction:      rawData._direction as string | undefined,
    heliusSaleType: nft?.saleType      as string | undefined,
    subtype:        rawData._subtype   as string | undefined,
  });
}

export function saleTypeFromEvent(event: SaleEvent): SaleType {
  return saleTypeFromRawData(event.rawData as Record<string, unknown>);
}

/**
 * Authoritative, transaction-time AMM-fill signal — see the parser.ts
 * comment ("Synchronous AMM-fill classification") for the on-chain
 * evidence (`lp_fee > 0` on a verified MMM fulfillBuy).
 *
 * Tri-state, NOT a plain boolean:
 *   true      — lp_fee > 0, confirmed AMM/pool-inventory fill.
 *   false     — lp_fee === 0, confirmed ordinary bid acceptance. This is
 *               just as authoritative as `true` and must never be
 *               second-guessed by a later ME `poolType` lookup.
 *   undefined — no evidence either way (non-MMM sale, MMM fulfillSell
 *               direction, an unverified instruction variant, or a row
 *               ingested before this field existed). Only THIS state may
 *               fall back to `poolType === 'two_sided'` — see saleKind().
 */
export function ammFillFromRawData(rawData: Record<string, unknown>): boolean | undefined {
  const v = rawData._ammFill;
  return typeof v === 'boolean' ? v : undefined;
}

export function ammFillFromEvent(event: SaleEvent): boolean | undefined {
  return ammFillFromRawData(event.rawData as Record<string, unknown>);
}
