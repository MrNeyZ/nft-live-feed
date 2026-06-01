'use client';

// VictoryLabs — Rare Feed → Live Feed Sales card adapters (Stage 1 prep).
// Pure presentational helpers shared by the standalone page's intent and
// the native <RareFeedPanel>: map a rare event onto the shared FeedEvent
// shape, the neutral SALE pill, and the compact rarity chip. Mirrors the
// logic currently inline in rare-feed/page.tsx (kept identical so behavior
// doesn't drift); the page will be DRY'd onto this in a later step.

import type { CSSProperties } from 'react';
import { collectionMeta } from '@/soloist/from-backend';
import type { FeedEvent } from '@/soloist/mock-data';
import type { RareEvent } from './use-rare-feed';

/** Neutral SALE pill for the shared FeedCard (rare events expose no
 *  buy/sell side). Lilac-grey so it reads as metadata, not direction. */
export const SALE_PILL = { label: 'SALE', fg: '#9aa0c8', bg: 'rgba(154,160,200,0.14)' };

export function scoreColor(score: number): string {
  if (score >= 80) return '#5ce0a0';
  if (score >= 60) return '#a890e8';
  if (score >= 40) return '#e8c14a';
  return '#7a7a94';
}

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

/** Tier pill colors (Tensor-style): 1/1 gold, MYTHIC hot-pink, LEGENDARY
 *  amber, EPIC purple. Tiers + the 1/1 flag come from the backend reasonTags. */
const TIER_COLOR: Record<string, string> = {
  MYTHIC:    '#ff2f7d',
  LEGENDARY: '#f5a623',
  EPIC:      '#8b5cf6',
};

/** Compact rarity badge rendered inline after the NFT name (Rare Feed only).
 *  For a 1/1 or a rarity tier it renders ONE Tensor-style colored pill —
 *  diamond glyph + rank, with supply de-emphasized — instead of a rank chip
 *  plus a separate tier badge. Non-tier rows keep the original score-tinted
 *  rank chip. */
export function rarityChip(e: RareEvent) {
  if (e.rarityRank == null) return null;
  const tags   = e.reasonTags ?? [];
  const supply = e.totalSupply ? `/${e.totalSupply}` : '';

  const oneOfOne = tags.includes('ONE_OF_ONE');
  const tier     = (['MYTHIC', 'LEGENDARY', 'EPIC'] as const).find((t) => tags.includes(t));

  // Tensor-like pill for 1/1 + tiered sales.
  if (oneOfOne || tier) {
    const color = oneOfOne ? '#f5c542' : TIER_COLOR[tier as string];
    const title = oneOfOne ? 'True 1/1' : `${tier} — rank ${e.rarityRank}${supply}`;
    const pill: CSSProperties = {
      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
      fontSize: 10, fontWeight: 800, letterSpacing: '0.2px',
      padding: '1px 7px', borderRadius: 8, lineHeight: 1.4, whiteSpace: 'nowrap',
      fontFamily: "'SF Mono','Fira Code',monospace",
      color, background: `${color}24`, border: `1px solid ${color}66`,
    };
    return (
      <span title={title} style={pill}>
        <span style={{ fontSize: 7, marginRight: 3, lineHeight: 1 }}>◆</span>
        {oneOfOne ? '1/1' : e.rarityRank}
        {!oneOfOne && supply && (
          <span style={{ opacity: 0.5, fontWeight: 600, marginLeft: 1 }}>{supply}</span>
        )}
      </span>
    );
  }

  // Fallback (no tier): original score-tinted rank chip.
  const c = scoreColor(e.rareScore);
  return (
    <span style={{
      flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: '0.3px',
      padding: '1px 6px', borderRadius: 3, lineHeight: 1.3, whiteSpace: 'nowrap',
      color: c, background: `${c}1f`, border: `1px solid ${c}55`,
      fontFamily: "'SF Mono','Fira Code',monospace",
    }}>
      #{e.rarityRank}{supply}
    </span>
  );
}
