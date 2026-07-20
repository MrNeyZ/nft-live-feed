// VictoryLabs — design palette (single source of truth for hue tokens).
//
// WHY: the site had drifted to 3-4 unnamed shades per colour (e.g. green
// lived as #43B984, rgb(64,212,168), rgb(92,224,160), rgb(67,185,132) +
// dozens of hand-tuned alphas), so every new element risked introducing
// a one-off shade that clashed with the rest. This module names the
// shades by ROLE so JS-side inline styles draw from the same scale the
// CSS `:root` mirror exposes (see globals.css `--vl-*` RGB triplets).
//
// USAGE (inline React styles):
//   color:      rgb(VL.greenStrong)
//   background:  alpha(VL.greenStrong, ALPHA.tint)
//   border:     `1px solid ${alpha(VL.greenStrong, ALPHA.border)}`
//
// CSS side uses the mirrored triplets: rgb(var(--vl-green-strong) / .13)
//
// Each hue family carries a few named roles (base / strong / glow /
// muted) rather than a numeric 100-900 scale — the roles map onto how
// the colours are actually used here (text-accent, direction stripe,
// halo, dim qualifier). Keep this list small; add a ROLE, not a one-off.

export type RGB = readonly [number, number, number];

export const VL = {
  // 🟢 green — green-strong is the BUY/direction hue (card edges, badges)
  green:       [67, 185, 132] as RGB,   // #43B984 brand base / text-accent
  greenStrong: [64, 212, 168] as RGB,   // #40D4A8 direction (BUY)
  greenGlow:   [92, 224, 160] as RGB,   // #5CE0A0 halos / flash / hover
  greenMuted:  [122, 154, 133] as RGB,  // #7A9A85 dim qualifier

  // 🔴 red — red-strong is the SELL/direction hue
  red:         [217, 104, 103] as RGB,  // #D96867 brand base / text-accent
  redStrong:   [245, 88, 102] as RGB,   // #F55866 direction (SELL)
  redGlow:     [239, 120, 120] as RGB,  // #EF7878 halos / bright floor
  redMuted:    [191, 95, 95] as RGB,    // #BF5F5F dim qualifier

  // 🟣 purple — purpleTint is the dominant (previously untokenized) UI lavender
  purple:      [124, 92, 240] as RGB,   // #7C5CF0 saturated accent
  purpleTint:  [168, 144, 232] as RGB,  // #A890E8 main UI lavender tint
  purpleDeep:  [128, 104, 216] as RGB,  // #8068D8 deeper

  // 🟡 gold — LMNFT / rarity / special only
  gold:        [199, 180, 121] as RGB,  // #C7B479 base
  goldBright:  [224, 196, 92] as RGB,   // #E0C45C highlight

  // 🩷 pink — the "candy" family accent (CANDY/CANDY-CORE mint badges, ME
  // brand pink in the feed). Was hand-copied as raw #e58aa3 across 4 files
  // (2 of them literally commented "no VL token yet") before this entry.
  pink:        [229, 138, 163] as RGB,  // #E58AA3 base

  // 🔵 blue — VVV launchpad badge only, previously untokenized
  blue:        [95, 168, 230] as RGB,   // #5FA8E6 base

  // 🟪 violet — the personal /tools pages' shared CTA-button colour. Was a
  // hand-copied `btnStyle` block (background + hover-text companion) across
  // 4 tool pages before this entry.
  violet:      [106, 72, 240] as RGB,   // #6A48F0 CTA button background
  violetLight: [201, 184, 255] as RGB,  // #C9B8FF advisory/notice text

  // ⚪ gray — GRAVE launchpad badge only, previously untokenized. Distinct
  // from VLText.muted below (a text tone, not a hue-family accent) even
  // though the two are visually close.
  gray:        [160, 160, 168] as RGB,  // #A0A0A8 base
} as const;

// Neutral text tones (hex — no alpha composition needed in practice).
export const VLText = {
  primary: '#F0EEF8', // NFT names, primary text
  muted:   '#9A9AB4', // collection names, wallets, timestamps, labels
  faint:   '#63637A', // tertiary labels (seller:/buyer: etc.)
} as const;

// Shared alpha ladder — the recurring opacity steps observed across the
// codebase, named so tints/borders/glows stay consistent.
export const ALPHA = {
  tintWeak:    0.06,
  tint:        0.12,
  border:      0.20,
  borderStrong: 0.32,
  glowSoft:    0.22,
  glow:        0.45,
} as const;

export function rgb(c: RGB): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function alpha(c: RGB, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** `#RRGGBB` form — for the handful of call sites that concatenate an alpha
 *  suffix directly onto the string (`${hex(c)}${aa}`) and can't take the
 *  `rgb(...)` function form `rgb()` produces. */
export function hex(c: RGB): string {
  return `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
