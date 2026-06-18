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
const SOURCE_SLOT_W_SM = 44; // sm: fontSize 9, padding 1×6 — minWidth (grows for long labels)
// lg (collections table) — HARD fixed width so every source badge is pixel-
// identical (option A). 60px fits all common labels (CORE…LEGACY, GRAVE, cNFT,
// VVV, ME, GAY); a rare UNKNOWN fallback may clip — accepted, not optimized for.
const SOURCE_PILL_W_LG = 60;

/** Per-source accent (`--c`) for the Stripe-Premium `.vl-srcchip`.
 *  CORE / LMNFT / CANDY use the exact reference values from
 *  stripe-premium-final.html (purple / gold / teal). Every other source
 *  reuses its existing badge accent (`sb.fg`) so no new shades are invented;
 *  the premium capsule material is identical across all of them. */
const CHIP_ACCENT: Record<string, string> = {
  CORE:  '#7C5CF0',
  LMNFT: '#C7B479',
  CANDY: '#5BB6A6',
};

export function MintsSourceBadge({ row, size = 'sm' }: { row: MintStatus; size?: 'sm' | 'lg' }) {
  void size; // sizing is fixed by the chip primitive; prop kept for callers
  const sb = sourceBadge(row.sourceLabel, row.coreLaunchpad);
  const href = sourceHref(row);
  const accent = CHIP_ACCENT[sb.label] ?? sb.fg;
  const chipStyle = { '--c': accent } as React.CSSProperties;
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
  const chip = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="vl-srcchip"
      style={chipStyle}
      title={linkTitle}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="vl-srcchip-dot" />
      <span className="vl-srcchip-lbl">{sb.label}</span>
    </a>
  ) : (
    <span className="vl-srcchip" style={chipStyle} title={plainTitle}>
      <span className="vl-srcchip-dot" />
      <span className="vl-srcchip-lbl">{sb.label}</span>
    </span>
  );
  // Placement wrapper — same flex slot/position as before; flexShrink:0 so the
  // chip never squeezes. Width is the chip's intrinsic (reference) width.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {chip}
    </span>
  );
}
