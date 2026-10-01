'use client';

// Shared Tensor-style rarity rank badge — single source of truth for the
// compact filled pill (gem icon + rank, tier color, subtle glow) used by Rare
// Feed and (once the Live Feed API carries rarity) the Live Feed sale cards.
//
// Tiering:
//   • If `reasonTags` are present (Rare Feed API), the tier is taken from them
//     (ONE_OF_ONE / MYTHIC / LEGENDARY / EPIC) — exact previous behavior.
//   • If `reasonTags` is absent/empty (e.g. a Live Feed event with raw
//     rank+supply), the tier is computed from percentile: ≤1% MYTHIC, ≤5%
//     LEGENDARY, ≤15% EPIC, else no badge (RARE/UNCOMMON/COMMON hidden).
// The score-tinted fallback rank chip renders only when `rareScore` is given
// (Rare Feed); a Live Feed event below EPIC simply renders nothing.

import type { CSSProperties } from 'react';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

/** Per-tier solid pill color + a subtle premium glow (no neon/bloom). */
export const TIER_STYLE: Record<string, { bg: string; glow: string }> = {
  MYTHIC:     { bg: rgb(VL.rarityMythic),    glow: `0 0 10px ${alpha(VL.rarityMythic, 0.22)}` },
  LEGENDARY:  { bg: rgb(VL.rarityLegendary), glow: `0 0 8px ${alpha(VL.rarityLegendary, 0.20)}` },
  EPIC:       { bg: rgb(VL.purple), glow: '0 0 6px rgb(var(--vl-purple) / 0.18)' },
  ONE_OF_ONE: { bg: rgb(VL.rarityOneOfOne),  glow: `0 0 10px ${alpha(VL.rarityOneOfOne, 0.22)}` },
};
/** Near-black icon/text on the filled pill (not pure black). */
const PILL_INK = alpha(VL.ink, 0.82);
const BADGE_FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** Score → fallback rank-chip tint (Rare Feed non-tier rows only). */
export function scoreColor(score: number): string {
  if (score >= 80) return rgb(VL.green);
  if (score >= 60) return rgb(VL.purpleTint);
  if (score >= 40) return rgb(VL.gold);
  return VLText.muted;
}

const TIERS = ['MYTHIC', 'LEGENDARY', 'EPIC'] as const;
export type RarityTier = typeof TIERS[number];

/** Percentile tier from raw rank+supply (same cutoffs as the badge). */
export function rarityTier(rank: number | null | undefined, supply: number | null | undefined): RarityTier | null {
  if (rank == null || !supply || supply <= 0) return null;
  const pct = rank / supply;
  return pct <= 0.01 ? 'MYTHIC' : pct <= 0.05 ? 'LEGENDARY' : pct <= 0.15 ? 'EPIC' : null;
}

export interface RarityRankBadgeProps {
  rarityRank:  number | null | undefined;
  totalSupply: number | null | undefined;
  /** Rare Feed reasonTags (drives tier when present). Omit for raw rank+supply. */
  reasonTags?: string[];
  /** Rare Feed rare score — enables the non-tier fallback chip. Omit on Live
   *  Feed so below-EPIC rows render no badge. */
  rareScore?:  number | null;
}

/** Compact rarity badge. Returns null when there's no rank, or (without a
 *  rareScore) when the item isn't EPIC+. */
export function RarityRankBadge({ rarityRank, totalSupply, reasonTags, rareScore }: RarityRankBadgeProps) {
  if (rarityRank == null) return null;
  const supply   = totalSupply ? `/${totalSupply}` : '';
  const tags     = reasonTags ?? [];
  const oneOfOne = tags.includes('ONE_OF_ONE');

  // Tier: from tags when present (Rare Feed) — else from percentile (raw data).
  let tier: string | null = tags.length ? (TIERS.find((t) => tags.includes(t)) ?? null) : null;
  if (!oneOfOne && !tier && tags.length === 0) tier = rarityTier(rarityRank, totalSupply);

  // Filled Tensor-style capsule for 1/1 + tiered sales.
  if (oneOfOne || tier) {
    const { bg, glow } = TIER_STYLE[oneOfOne ? 'ONE_OF_ONE' : (tier as string)];
    const title = oneOfOne ? `True 1/1 — #${rarityRank}${supply}` : `${tier} — #${rarityRank}${supply}`;
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
        {oneOfOne ? '1/1' : rarityRank}
      </span>
    );
  }

  // Fallback (no tier): original score-tinted rank chip — Rare Feed only.
  if (rareScore == null) return null;
  const c = scoreColor(rareScore);
  return (
    <span style={{
      flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: '0.3px',
      padding: '1px 6px', borderRadius: 3, lineHeight: 1.3, whiteSpace: 'nowrap',
      color: c, background: `${c}1f`, border: `1px solid ${c}55`,
      fontFamily: "'SF Mono','Fira Code',monospace",
    }}>
      #{rarityRank}{supply}
    </span>
  );
}
