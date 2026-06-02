// VictoryLabs — Mints: "NEW" badge for freshly-created collections.
//
// Pure presentational chip. Shown next to the source/CORE badge on a tracker
// row (and the type pill on a Live Mint Feed card) when `isNewCollection(...)`
// holds — i.e. the collection's on-chain creation is within
// NEW_COLLECTION_WINDOW_MS of its first observed mint. The eligibility check
// (`isNewCollection`) lives in lib/format.ts so it can be reused without
// importing React; this file is the visual only.
//
// Styling: subtle cyan/purple accent — bordered, low-alpha fill, no glow/neon,
// no box-shadow. Inline-flex so it sits in the existing badge flex group
// without changing row height (no layout shift).
import type { CSSProperties } from 'react';

const STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 5px',
  borderRadius: 3,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.4px',
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  color: 'rgba(124,206,232,0.92)',
  border: '1px solid rgba(132,176,236,0.45)',
  background: 'rgba(116,150,228,0.10)',
};

export function NewCollectionBadge() {
  return (
    <span style={STYLE} title="Collection created around the time minting started">
      NEW
    </span>
  );
}
