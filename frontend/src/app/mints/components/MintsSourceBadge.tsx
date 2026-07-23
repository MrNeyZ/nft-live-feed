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
import { VLText } from '@/lib/palette';

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

/** Display-only label normalization for the fixed-width table chip. CANDY
 *  and GRAVE render full-length now (paired with the `vl-srcchip--long`
 *  smaller font-size below, same treatment LMNFT already got) — only
 *  UNKNOWN (rare fallback) still abbreviates to fit the slot. Source logic
 *  and `sourceBadge()` labels are unchanged — this affects the rendered
 *  text only; tooltips still use the full source name. */
const CHIP_LABEL: Record<string, string> = {
  UNKNOWN: 'UNK',
};
/** Labels long enough (5+ chars) to read cramped at the base chip font-size
 *  — see `.vl-srcchip--long` in globals.css. */
const LONG_LABELS = new Set(['LMNFT', 'CANDY', 'GRAVE']);
/** 3-char labels — widened letter-spacing instead of a bigger font-size
 *  (see `.vl-srcchip--short` in globals.css). */
const SHORT_LABELS = new Set(['NFT', 'VVV']);
function srcChipClassName(label: string): string {
  if (LONG_LABELS.has(label)) return 'vl-srcchip vl-srcchip--long';
  if (SHORT_LABELS.has(label)) return 'vl-srcchip vl-srcchip--short';
  return 'vl-srcchip';
}

/** Fixed chip width — sized to fit the widest kept label (LMNFT) with the dot
 *  + reference padding, so every source chip is the same width and the
 *  dot+label group centers identically row to row. 66px ≈ dot (6.6) + gap (6) +
 *  LMNFT glyphs + the 10px side padding, so the centered group fills the slot
 *  instead of floating in dead space (shorter labels CORE/VVV/ME center in the
 *  same physical width). */
const SRCCHIP_W = 66;

export function MintsSourceBadge({ row, size = 'sm' }: { row: MintStatus; size?: 'sm' | 'lg' }) {
  void size; // sizing is fixed by the chip primitive; prop kept for callers
  const sb = sourceBadge(row.sourceLabel, row.coreLaunchpad);
  const href = sourceHref(row);
  // Deploy-only collection — the accumulator returns early on a
  // collection-CREATE event and never increments `observedMints`
  // (see accumulator.ts), so `observedMints === 0` is an exact signal
  // for "collection created, no mints observed yet" — not a heuristic.
  // The moment the first real mint lands, `observedMints` becomes ≥1 and
  // this row falls through to the normal per-source accent below on its
  // own — no extra state.
  //
  // Still shows the real launchpad label (LMNFT/CORE/VVV/…) rather than a
  // generic "DPLY" — the PRICE cell already carries the "this is a
  // deploy, not a mint" signal (renders "deploy" — see MintsTableRow.tsx),
  // so a separate generic badge text here was a redundant second way of
  // saying the same thing. Forcing the accent to muted gray instead of the
  // source's normal color is what actually distinguishes a deploy row from
  // a real mint at a glance, while still answering "which launchpad".
  const isDeployOnly = row.observedMints === 0;
  // Restore the original per-source VictoryLabs accent (sb.fg): CORE purple
  // (#a890e8), LMNFT gold (#c7b479), CANDY pink (#e58aa3), and GRAVE / VVV /
  // LEGACY / cNFT / PRNT / GAY / ME unchanged. No invented shades.
  const accent = isDeployOnly ? VLText.muted : sb.fg;
  const label  = CHIP_LABEL[sb.label] ?? sb.label;
  const chipClassName = srcChipClassName(label);
  // flexShrink:0 so the anchor keeps its full SRCCHIP_W box as a flex child of
  // the wrapper / icon group — without it the default flex-shrink:1 lets row
  // pressure collapse the <a> toward its content width, so only the dot/label
  // area stayed clickable. boxSizing is border-box via `.vl-srcchip`; the inline
  // width is the full capsule, so the anchor itself owns the entire 66px hitbox.
  const chipStyle = { '--c': accent, width: SRCCHIP_W, flexShrink: 0 } as React.CSSProperties;
  const plainTitle = isDeployOnly
    ? `Collection deployed via ${row.sourceLabel} — no mints yet`
    : row.sourceLabel === 'LaunchMyNFT'
      ? 'LaunchMyNFT mint page unavailable'
      : row.sourceLabel;
  // Linked-pill tooltip: VVV / GRAVE get an explicit "Open on …" hint
  // per the per-collection deep-link UX so users know clicking opens
  // the launchpad's page. Other sources keep the raw label as the
  // hover hint. Deploy rows get the same deploy-specific hint as the
  // plain (unlinked) pill above.
  const linkTitle = isDeployOnly
    ? `Collection deployed via ${row.sourceLabel} — no mints yet`
    : row.sourceLabel === 'VVV'
      ? 'Open on VVV'
      : row.sourceLabel === 'GRAVE'
        ? 'Open on gravemint.io'
        : row.sourceLabel;
  const chip = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={chipClassName}
      style={chipStyle}
      title={linkTitle}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="vl-srcchip-dot" />
      <span className="vl-srcchip-lbl">{label}</span>
    </a>
  ) : (
    <span className={chipClassName} style={chipStyle} title={plainTitle}>
      <span className="vl-srcchip-dot" />
      <span className="vl-srcchip-lbl">{label}</span>
    </span>
  );
  // Placement wrapper — same flex slot/position as before; flexShrink:0 so the
  // chip never squeezes; width pinned to the full SRCCHIP_W (== the anchor).
  //
  // position:relative + z-index lift the chip ABOVE the SHOW action zone. That
  // zone (MintsTableRow.tsx — the `<td>` SHOW cell) is `position:absolute;
  // right:-16; width:min(calc(100% - 16px),180px)`, anchored to the SHOW cell's
  // right and grown LEFTWARD, intentionally overlapping into the COLLECTION
  // column. As a later DOM sibling with z-index:auto it painted on top of this
  // chip, so on laptop (narrow table → chip near the COLLECTION/SHOW boundary)
  // the SHOW band covered the chip's right portion and swallowed its clicks —
  // only the chip's left edge (dot/first glyph) stayed hittable. A positive
  // z-index moves the chip's stacking context above the SHOW band's auto level
  // (both resolve in the same row stacking context — neither <td> sets z-index),
  // so the <a> is the topmost element across its full visible capsule. The SHOW
  // band's idle fill is ~0.05 alpha over only the small overlap, so lifting the
  // chip is visually imperceptible — no width/height/colour/layout change.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: SRCCHIP_W, position: 'relative', zIndex: 3 }}>
      {chip}
    </span>
  );
}
