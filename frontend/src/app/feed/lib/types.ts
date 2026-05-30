// VictoryLabs — Feed: shared type aliases.
// Extracted verbatim from page.tsx so the upcoming component splits
// (FeedCard, FeedFiltersPanel) can import a canonical definition
// instead of relying on a top-level `import type` from the page file.
// No fields added or removed vs. the prior inline declarations.

import type { ReactNode } from 'react';
import type { FeedEvent, Side } from '@/soloist/mock-data';

/** Card density mode for the feed list. Drives the thumb size (TAPE
 *  shrinks to 40 px; others stay at 56 px); other density deltas
 *  (padding, gaps, thumb-wrapper width) are owned by CSS rules scoped
 *  to `.feed-density-{comfy,compact,tape}` on the parent feed-list. */
export type Density = 'comfy' | 'compact' | 'tape';

/** Active filter on the top-of-feed Type-filter row. Strict superset
 *  of the wire `Side` ('buy' | 'sell') so 'all' / AMM-side filters /
 *  the listings synthetic surface can be modelled in the same union. */
export type FilterKey = 'all' | Side | 'buyAmm' | 'sellAmm' | 'listing';

/** Resolved-side display label for a sale event. Distinct from
 *  `Side` (the wire-level buy/sell signal) because pool-routed trades
 *  visually cluster under their own AMM label even when the
 *  underlying side maps to buy/sell. */
export type SaleKind = 'buy' | 'sell' | 'buyAmm' | 'sellAmm' | 'unknown';

/** Style descriptor for the BUY / SELL / AMM badge in a FeedCard.
 *  Pulled out of the card so palette tweaks live in one place. */
export interface KindStyle {
  label: string;
  /** Foreground / accent color for the badge text + border tint. */
  fg: string;
  /** Translucent background tint for the badge. */
  bg: string;
  /** 'buy' tone or 'sell' tone — drives the card's left/right border color. */
  borderTone: 'buy' | 'sell' | 'neutral';
}

/** Props for the per-row FeedCard component. Declared at the lib
 *  level so the upcoming component extraction (PR #2) can import it
 *  without forcing FeedCard to live in the same file as the page. */
export interface FeedCardProps {
  event: FeedEvent;
  /** LMB on avatar → open a small centered image preview. */
  onPreview: (url: string) => void;
  /** Current "Inclusive fees" toggle state from BottomStatusBar. Only
   *  AMM_SELL rows actually branch on this; passed down to every card
   *  so the price re-renders the moment the toggle flips. */
  inclusiveFees: boolean;
  /** Frontend fallback floor (SOL) for this card's slug. Used only
   *  when `event.floorDelta` is missing — backend's value always wins
   *  when present. Sourced from the existing `floorBySlug` cache (the
   *  cNFT-dust resolver), so the fallback fires for slugs that cache
   *  has already populated; no new fetches are added on this path. */
  slugFloor?: number | null;
  /** Number of sell-side rows this seller+collection has in the
   *  currently visible feed. Drives the noise-cut on the
   *  seller-remaining badge: a single sell from a seller with high
   *  inventory is quieter than two-in-a-row, which is when the
   *  "active dumping" signal becomes meaningful. */
  sellerSellCountInFeed: number;
  /** True when this row is the most-recent sell in the feed for its
   *  seller+collection pair. The badge only renders on the newest row
   *  so older sibling rows don't repeat the same number. */
  isNewestSellForSellerColl: boolean;
  /** Card density mode. Drives the thumb size (TAPE shrinks to 40 px,
   *  others stay at 56 px); other density deltas (padding, gaps,
   *  thumb wrapper width) are owned by CSS rules scoped to
   *  `.feed-density-{comfy,compact,tape}` on the parent feed-list. */
  density: Density;
  /** Optional pill override for the BUY/SELL/AMM slot. When provided the
   *  pill renders with this label/colors instead of `KIND_STYLES[kind]`.
   *  Used ONLY by Rare Feed (completed sales with no buy/sell side →
   *  neutral "SALE"); /feed never passes it, so its pill is unchanged. */
  pillOverride?: Pick<KindStyle, 'label' | 'fg' | 'bg'>;
  /** Optional chip rendered inline after the NFT name. Used ONLY by Rare
   *  Feed to surface a compact rarity rank/score chip; /feed never passes
   *  it, so the name row is byte-identical there. */
  nameChip?: ReactNode;
}
