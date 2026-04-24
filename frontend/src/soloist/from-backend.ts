// Pure mapper: backend SSE/REST payload → UI FeedEvent.
// No React imports, no side effects — safe to unit-test.

import type { FeedEvent as BackendEvent, LatestApiResponse, RestRow } from '@/types';
import { fromRow } from '@/types';
import { COLLECTIONS_DB, FeedEvent, Marketplace, Side } from './mock-data';

const FALLBACK_COLOR = '#8068d8';
const FALLBACK_ABBR  = '??';
const FALLBACK_PALETTE = [
  '#ff8c42', '#36b868', '#8068d8', '#4e8cd4', '#c9a820',
  '#28a878', '#d47832', '#b01d62', '#2fa8d8', '#c084fc', '#e879f9',
];

function collectionMeta(name: string | null): { abbr: string; color: string } {
  if (!name) return { abbr: FALLBACK_ABBR, color: FALLBACK_COLOR };
  const hit = COLLECTIONS_DB.find(c => c.name === name);
  if (hit) return { abbr: hit.abbr, color: hit.color };
  const words = name.split(/\s+/).filter(Boolean);
  const abbr = (
    words.length >= 2
      ? (words[0][0] ?? '') + (words[1][0] ?? '')
      : name.slice(0, 2)
  ).toUpperCase() || FALLBACK_ABBR;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i)) | 0;
  const color = FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
  return { abbr, color };
}

function mapMarketplace(mp: string): Marketplace {
  return (mp === 'tensor' || mp === 'tensor_amm') ? 'tensor' : 'me';
}

/**
 * Backend saleType → UI `side`:
 *   bid_sell, pool_sale, pool_sell, amm_sell → sell
 *   anything else (normal_sale, pool_buy, list_buy, amm_buy, listing) → buy
 */
function mapSide(saleType: string | null | undefined): Side {
  switch (saleType) {
    case 'bid_sell':
    case 'pool_sale':
    case 'pool_sell':
    case 'amm_sell':
      return 'sell';
    default:
      return 'buy';
  }
}

function numFromName(nftName: string | null): number {
  if (!nftName) return 0;
  const m = nftName.match(/#?(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

export function fromBackend(b: BackendEvent): FeedEvent {
  const meta = collectionMeta(b.collectionName);
  const side = mapSide(b.saleType);
  const nftName = b.nftName ?? `${b.collectionName ?? 'Unknown'} #?`;
  return {
    id: b.signature,
    signature: b.signature,
    mintAddress: b.mintAddress ?? '',
    meCollectionSlug: b.meCollectionSlug ?? null,
    collectionName: b.collectionName ?? 'Unknown',
    abbr: meta.abbr,
    color: meta.color,
    nftName,
    num: numFromName(b.nftName),
    rank: 0,
    price: b.priceSol,
    grossPrice: b.priceSol,
    floorDelta: b.floorDelta ?? 0,
    marketplace: mapMarketplace(b.marketplace),
    ts: Date.parse(b.blockTime),
    side,
    nftType: b.nftType ?? 'legacy',
    saleTypeRaw: b.saleType ?? null,
    buyer: b.buyer,
    seller: b.seller,
    imageUrl: b.imageUrl ?? null,
  };
}

/**
 * Build the marketplace URL for an event's badge — routes by the event's
 * detected marketplace so a Tensor sale links to tensor.trade and a Magic
 * Eden sale links to magiceden.io.
 */
export function marketplaceUrl(event: FeedEvent): string | null {
  if (event.marketplace === 'tensor') {
    // `/trade/` on tensor.trade takes a COLLECTION SLUG, not a mint. We
    // don't carry a dedicated tensor slug on FeedEvent — the ME slug is
    // the same thing in practice for every collection Tensor indexes, so
    // use it here. If we have no slug at all, route to `/item/<mint>`
    // (the NFT page, which does accept a mint) instead of putting the
    // mint into the collection-slug slot. Bare tensor.trade is the last
    // resort so the badge always links somewhere on the same marketplace.
    if (event.meCollectionSlug) return `https://www.tensor.trade/trade/${event.meCollectionSlug}`;
    if (event.mintAddress)      return `https://www.tensor.trade/item/${event.mintAddress}`;
    return 'https://www.tensor.trade';
  }
  // Magic Eden (me / me_amm) — slug → collection page; mint → item page;
  // bare ME homepage as the last resort so the badge always links somewhere
  // on the same marketplace.
  if (event.meCollectionSlug) return `https://magiceden.io/marketplace/${event.meCollectionSlug}`;
  if (event.mintAddress)      return `https://magiceden.io/item-details/${event.mintAddress}`;
  return 'https://magiceden.io';
}

export { fromRow, collectionMeta };
export type { BackendEvent, LatestApiResponse, RestRow };
