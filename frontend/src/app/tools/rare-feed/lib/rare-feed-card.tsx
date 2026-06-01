'use client';

// VictoryLabs — Rare Feed → Live Feed Sales card adapters (Stage 1 prep).
// Pure presentational helpers shared by the standalone page's intent and
// the native <RareFeedPanel>: map a rare event onto the shared FeedEvent
// shape, the neutral SALE pill, and the compact rarity chip. Mirrors the
// logic currently inline in rare-feed/page.tsx (kept identical so behavior
// doesn't drift); the page will be DRY'd onto this in a later step.

import { collectionMeta } from '@/soloist/from-backend';
import type { FeedEvent } from '@/soloist/mock-data';
import { RarityRankBadge, scoreColor } from '@/app/feed/lib/rarity-rank-badge';
import type { RareEvent } from './use-rare-feed';

/** Neutral SALE pill for the shared FeedCard (rare events expose no
 *  buy/sell side). Lilac-grey so it reads as metadata, not direction. */
export const SALE_PILL = { label: 'SALE', fg: '#9aa0c8', bg: 'rgba(154,160,200,0.14)' };

// Re-export so existing importers of scoreColor from this module keep working.
export { scoreColor };

/** Map a rare-feed event onto the shared Live Feed Sales `FeedEvent`
 *  shape so it renders through the exact same card. FloorChip is driven
 *  by `floorDeltaPct` (already a fractional ratio); seller/buyer come
 *  from the endpoint's sale_events join. */
export function rareToFeedEvent(e: RareEvent): FeedEvent {
  const { abbr, color } = collectionMeta(e.collectionName);
  const ts = e.saleTime ? new Date(e.saleTime).getTime()
           : new Date(e.createdAt).getTime();
  return {
    id:               e.saleSignature,
    signature:        e.saleSignature,
    mintAddress:      e.mintAddress,
    meCollectionSlug: e.collectionSlug,
    collectionName:   e.collectionName ?? 'Unknown',
    abbr,
    color,
    nftName:          e.nftName ?? (e.collectionName ?? e.mintAddress.slice(0, 6)),
    num:              0,
    rank:             e.rarityRank ?? 0,
    price:            e.salePriceSol,
    grossPrice:       e.salePriceSol,
    sellerNetPrice:   null,
    floorDelta:       e.floorDeltaPct,
    marketplace:      e.source && e.source.toLowerCase().includes('tensor') ? 'tensor' : 'me',
    ts,
    side:             'buy',
    nftType:          '',
    saleTypeRaw:      null,
    buyer:            e.buyer ?? '',
    seller:           e.seller ?? '',
    imageUrl:         e.imageUrl,
    collectionAddress: null,
    sellerRemainingCount: null,
    sellerSells10m:   0,
    resizeStatus:     null,
  };
}

/** Compact rarity badge rendered inline after the NFT name (Rare Feed). Thin
 *  wrapper over the shared <RarityRankBadge> so Rare Feed and the Live Feed
 *  cards render byte-identical badges from one implementation. */
export function rarityChip(e: RareEvent) {
  return (
    <RarityRankBadge
      rarityRank={e.rarityRank}
      totalSupply={e.totalSupply}
      reasonTags={e.reasonTags}
      rareScore={e.rareScore}
    />
  );
}
