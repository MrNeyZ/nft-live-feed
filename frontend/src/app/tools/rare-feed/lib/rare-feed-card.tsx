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

/** Tier pill colors (Tensor-style, muted): 1/1 gold, MYTHIC pink, LEGENDARY
 *  amber, EPIC purple. Tiers + the 1/1 flag come from the backend reasonTags. */
/** Per-tier solid pill color + a subtle premium glow (visible only when
 *  looked for — no neon/bloom). 1/1 gold is the standout. */
const TIER_STYLE: Record<string, { bg: string; glow: string }> = {
  MYTHIC:     { bg: '#ef5b97', glow: '0 0 10px rgba(239, 91, 151, 0.22)' },
  LEGENDARY:  { bg: '#e1a63a', glow: '0 0 8px rgba(225, 166, 58, 0.20)' },
  EPIC:       { bg: '#7c5cf0', glow: '0 0 6px rgba(124, 92, 240, 0.18)' },
  ONE_OF_ONE: { bg: '#d7a53a', glow: '0 0 10px rgba(215, 165, 58, 0.22)' },
};
/** Near-black icon/text on the filled pill (not pure black). */
const PILL_INK = 'rgba(12, 10, 18, 0.82)';
const BADGE_FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

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

  // Tensor-style filled capsule for 1/1 + tiered sales: solid tier background
  // with a subtle premium glow, near-black gem icon + rank, system font.
  // Rank only (supply → tooltip).
  if (oneOfOne || tier) {
    const { bg, glow } = TIER_STYLE[oneOfOne ? 'ONE_OF_ONE' : (tier as string)];
    const title = oneOfOne ? `True 1/1 — #${e.rarityRank}${supply}` : `${tier} — #${e.rarityRank}${supply}`;
    const pill: CSSProperties = {
      display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
      height: 15, padding: '0 5px', borderRadius: 999,
      fontSize: 10, fontWeight: 800, lineHeight: 1, letterSpacing: 0,
      verticalAlign: 'middle', fontFamily: BADGE_FONT,
      color: PILL_INK, background: bg, border: 'none', boxShadow: glow,
    };
    return (
      <span title={title} style={pill}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, display: 'block' }} aria-hidden>
          <path d="M6 3h12l4 6-10 12L2 9l4-6Z" />
        </svg>
        {oneOfOne ? '1/1' : e.rarityRank}
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
