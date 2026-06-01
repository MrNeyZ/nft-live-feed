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

/** Tier badge metadata. Tiers come from the backend's reasonTags; 1/1 is the
 *  force-include flag and always outranks a tier. Colors: 1/1 gold, MYTHIC
 *  pink, LEGENDARY amber, EPIC purple. */
const TIER_BADGE: Record<string, { label: string; color: string }> = {
  MYTHIC:    { label: 'MYTHIC', color: '#ff6fb5' },
  LEGENDARY: { label: 'LEGEND', color: '#f2a93b' },
  EPIC:      { label: 'EPIC',   color: '#a855f7' },
};

/** Badges to render after the rank chip: 1/1 first (if present), then the
 *  single HIGHEST tier (MYTHIC > LEGENDARY > EPIC). In practice a 1/1 and a
 *  tier never co-occur, so this is normally one badge. */
function rareBadges(reasonTags?: string[]): { label: string; color: string; title: string }[] {
  const tags = reasonTags ?? [];
  const out: { label: string; color: string; title: string }[] = [];
  if (tags.includes('ONE_OF_ONE')) out.push({ label: '1/1', color: '#f5c542', title: 'True 1/1' });
  for (const t of ['MYTHIC', 'LEGENDARY', 'EPIC']) {
    if (tags.includes(t)) { out.push({ ...TIER_BADGE[t], title: `${t} — rare sale above floor` }); break; }
  }
  return out;
}

/** Compact rarity chip rendered inline after the NFT name (Rare Feed only).
 *  Surfaces rank (+ supply, tinted by rareScore) plus a 1/1 / tier badge so an
 *  above-floor sale's rarity tier is obvious. */
export function rarityChip(e: RareEvent) {
  if (e.rarityRank == null) return null;
  const c = scoreColor(e.rareScore);
  const chip: CSSProperties = {
    flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: '0.3px',
    padding: '1px 6px', borderRadius: 3, lineHeight: 1.3, whiteSpace: 'nowrap',
    fontFamily: "'SF Mono','Fira Code',monospace",
  };
  return (
    <>
      <span style={{ ...chip, color: c, background: `${c}1f`, border: `1px solid ${c}55` }}>
        #{e.rarityRank}{e.totalSupply ? `/${e.totalSupply}` : ''}
      </span>
      {rareBadges(e.reasonTags).map((b) => (
        <span key={b.label} title={b.title} style={{
          ...chip, marginLeft: 4, color: b.color,
          background: `${b.color}29`, border: `1px solid ${b.color}8c`,
        }}>
          {b.label}
        </span>
      ))}
    </>
  );
}
