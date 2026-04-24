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
  });
}

export function saleTypeFromEvent(event: SaleEvent): SaleType {
  return saleTypeFromRawData(event.rawData as Record<string, unknown>);
}
