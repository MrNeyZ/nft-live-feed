// VictoryLabs — Mints: source-badge pill rendered next to each
// collection title in the COLLECTION column. Same palette as the
// prior right-side SOURCE column (uses `sourceBadge`); rendered
// smaller (9 px, tighter padding) so it reads as secondary metadata
// next to the title rather than competing with it. Clickable when
// `sourceHref` resolves a URL (links to the launchpad's mint page);
// plain `<span>` otherwise. flexShrink: 0 so it doesn't squeeze on
// narrow rows.
//
// Behaviour byte-identical to the prior inline IIFE in page.tsx —
// extracted only so the per-row JSX can be split later without
// inlining a small builder into the row's body.

import type { MintStatus } from '../lib/types';
import { sourceBadge, sourceHref } from '../lib/source';

/** `size` is opt-in: 'sm' (default) is the original 9px pill used by the Live
 *  Mint Feed card (left byte-identical). 'lg' is the ~25%-larger table variant
 *  so the source pill matches the enlarged status badge in the collection
 *  table. Only the collection table passes 'lg'. */

/** Fixed slot widths in px, sized to the widest 5-char pill at each size
 *  variant (LMNFT / CANDY / GRAVE — fontWeight 700, letterSpacing 0.4 +
 *  the pill's horizontal padding). Wrapping every badge in a slot of this
 *  width pins the surrounding layout: shorter labels (CORE / VVV) center
 *  inside the same physical slot instead of letting their narrower pill
 *  shrink the cell. Longer labels (METAPLEX / UNKNOWN — rare) still
 *  render full width and grow the slot naturally via `minWidth`. */
const SOURCE_SLOT_W_SM = 44; // sm: fontSize 9,  padding 1×6
const SOURCE_SLOT_W_LG = 56; // lg: fontSize 10, padding 2×8

export function MintsSourceBadge({ row, size = 'sm' }: { row: MintStatus; size?: 'sm' | 'lg' }) {
  const sb = sourceBadge(row.sourceLabel, row.coreLaunchpad);
  const href = sourceHref(row);
  const lg = size === 'lg';
  const pillStyle: React.CSSProperties = {
    display: 'inline-block',
    padding: lg ? '2px 8px' : '1px 6px',
    fontSize: lg ? 10 : 9,
    fontWeight: 700,
    borderRadius: lg ? 4 : 3,
    background: sb.bg, color: sb.fg, letterSpacing: '0.4px',
    textDecoration: 'none', cursor: href ? 'pointer' : 'default',
    flexShrink: 0, lineHeight: lg ? '16px' : '13px', textTransform: 'uppercase',
  };
  const plainTitle = row.sourceLabel === 'LaunchMyNFT'
    ? 'LaunchMyNFT mint page unavailable'
    : row.sourceLabel;
  // Linked-pill tooltip: VVV / GRAVE get an explicit "Open on …" hint
  // per the per-collection deep-link UX so users know clicking opens
  // the launchpad's page. Other sources keep the raw label as the
  // hover hint.
  const linkTitle = row.sourceLabel === 'VVV'
    ? 'Open on VVV'
    : row.sourceLabel === 'GRAVE'
      ? 'Open on gravemint.io'
      : row.sourceLabel;
  const pill = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      
      style={pillStyle}
      onClick={(e) => e.stopPropagation()}
    >{sb.label}</a>
  ) : (
    <span  style={pillStyle}>{sb.label}</span>
  );
  // Fixed-width slot — pins horizontal footprint so CORE / VVV occupy the
  // same physical column as LMNFT / CANDY / GRAVE. minWidth (not width) so
  // an unusually long label (METAPLEX, UNKNOWN) can still grow the slot
  // naturally instead of clipping. Centering the colored pill inside keeps
  // narrow labels visually balanced.
  const slotMinW = lg ? SOURCE_SLOT_W_LG : SOURCE_SLOT_W_SM;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, minWidth: slotMinW,
    }}>
      {pill}
    </span>
  );
}
