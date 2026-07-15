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

/**
 * True when this event's `collectionAddress` is actually a Bubblegum merkle
 * tree, not a genuine on-chain collection-group address. The `me_cnft_raw`
 * parser (parseMeCnftSale in src/ingestion/me-raw/parser.ts) stores the
 * merkle tree in BOTH `mintAddress` and `collectionAddress` as a stable
 * per-sale placeholder — correct for dedup/display/Solscan-link purposes,
 * but never a valid collection identity. Bot API v1's stable collection
 * fields (see docs/internal-bot-api-v1.md) must never surface it as
 * `collectionId`/`collectionAddress` — that would misattribute every cNFT
 * sale on this marketplace to a single "collection" (the tree itself).
 */
export function isMerkleTreeCollectionAddress(event: SaleEvent): boolean {
  return (event.rawData as Record<string, unknown> | undefined)?._parser === 'me_cnft_raw';
}

export type CollectionIdentitySource = 'onchain_collection_address' | 'me_slug' | 'tensor_slug';

export interface CollectionIdentity {
  collectionId:             string | null;
  collectionSlug:           string | null;
  collectionAddress:        string | null;
  collectionIdentitySource: CollectionIdentitySource | null;
}

/**
 * Stable collection-identity precedence for Bot API v1 (whale-liquidation
 * bot support — see docs/internal-bot-api-v1.md's "Stable collection
 * identity" section).
 *
 * Precedence: verified on-chain collection address (Helius DAS grouping,
 * resolved only by async enrichment — never available on the parser's
 * synchronous event) > Magic Eden collection slug (existing stable internal
 * identifier — an ME slug never changes for a given collection once
 * assigned, often known synchronously via the mint→slug cache) > Tensor
 * collection slug (async-only, requires TENSOR_API_KEY).
 *
 * Callers MUST already have excluded the merkle-tree placeholder from
 * `collectionAddress` (see `isMerkleTreeCollectionAddress`) — this function
 * does no marketplace-specific filtering itself, it only ranks whatever the
 * caller already trusts.
 */
export function resolveCollectionIdentity(
  collectionAddress:     string | null | undefined,
  meCollectionSlug:      string | null | undefined,
  tensorCollectionSlug:  string | null | undefined,
): CollectionIdentity {
  const addr  = collectionAddress    || null;
  const slug  = meCollectionSlug     || null;
  const tSlug = tensorCollectionSlug || null;
  const collectionIdentitySource: CollectionIdentitySource | null =
    addr ? 'onchain_collection_address' : slug ? 'me_slug' : tSlug ? 'tensor_slug' : null;
  return {
    collectionId:  addr ?? slug ?? tSlug ?? null,
    collectionSlug: slug,
    collectionAddress: addr,
    collectionIdentitySource,
  };
}
