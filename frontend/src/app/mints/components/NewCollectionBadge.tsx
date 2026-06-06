// VictoryLabs — Mints: "NEW" indicator for freshly-created collections.
//
// Pure presentational indicator. Shown overlaid on the collection / NFT
// thumbnail (top-right corner) on a tracker row AND a Live Mint Feed card
// when `isNewCollection(...)` holds — i.e. the collection's on-chain
// creation is within NEW_COLLECTION_WINDOW_MS of its first observed mint.
// The eligibility check (`isNewCollection`) lives in lib/format.ts; this
// file is the visual only.
//
// Styling: small circular "verification" indicator — premium blue/purple
// gradient disc with a check glyph and a page-coloured ring (cut-out look),
// mirroring a verified-account badge. Absolutely positioned so it overlays
// the image corner without consuming layout (no row/card height change).
// The host element must be `position: relative`.
import type { CSSProperties } from 'react';

// Size variants. `tracker` is the original compact disc with a subtle bump;
// `feed` is a noticeably larger, attention-grabbing disc for the Live Mint
// Feed cards. Only geometry/glyph scale change — colour, shape, icon and the
// corner-overlay behaviour are identical across variants.
type BadgeSize = 'tracker' | 'feed';

const DIMS: Record<BadgeSize, { disc: number; font: number; glyph: number; border: number }> = {
  // Slightly larger than the original 13 px — subtle, won't disturb row layout.
  tracker: { disc: 15, font: 9, glyph: 8, border: 1.5 },
  // Larger than tracker (15 px) but dialled back from the earlier 23 px.
  feed: { disc: 18, font: 10, glyph: 9, border: 2 },
};

const baseDot: CSSProperties = {
  position: 'absolute',
  top: -2,
  right: -2,
  borderRadius: '50%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, #5b8def 0%, #7c6ff0 100%)',
  boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
  color: '#fff',
  fontWeight: 800,
  lineHeight: 1,
  pointerEvents: 'none',
  zIndex: 2,
};

export function NewCollectionBadge({ size = 'tracker' }: { size?: BadgeSize } = {}) {
  const d = DIMS[size];
  const style: CSSProperties = {
    ...baseDot,
    width: d.disc,
    height: d.disc,
    fontSize: d.font,
    border: `${d.border}px solid rgba(12,14,24,0.95)`,
  };
  return (
    <span style={style} aria-label="New collection" title="Collection created around the time minting started">
      <svg width={d.glyph} height={d.glyph} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
