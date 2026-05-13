// Centralized responsive breakpoints — single source of truth for the
// frontend. JS/React reads from this module; CSS reads matching `@media`
// blocks generated from the same numbers (see globals.css, marked section
// "/* ===== breakpoints ===== */"). Keep the two in sync.
//
// Note: this is the *physical* viewport system. The `data-layout`
// (pc/laptop/phone) override in `@/soloist/layout-mode` is a separate,
// user-toggled manual mode and remains unchanged.

export type BreakpointRange =
  | 'mobile'
  | 'tablet'
  | 'small_laptop'
  | 'laptop'
  | 'desktop_large';

// Inclusive upper bound for each range, in CSS px.
// mobile        : 0     – 480
// tablet        : 481   – 768
// small_laptop  : 769   – 1024
// laptop        : 1025  – 1600
// desktop_large : 1601+
export const BREAKPOINTS = {
  mobileMax:       480,
  tabletMax:       768,
  smallLaptopMax: 1024,
  laptopMax:      1600,
} as const;

export const RANGE_ORDER: readonly BreakpointRange[] = [
  'mobile',
  'tablet',
  'small_laptop',
  'laptop',
  'desktop_large',
] as const;

export function rangeForWidth(width: number): BreakpointRange {
  if (width <= BREAKPOINTS.mobileMax)      return 'mobile';
  if (width <= BREAKPOINTS.tabletMax)      return 'tablet';
  if (width <= BREAKPOINTS.smallLaptopMax) return 'small_laptop';
  if (width <= BREAKPOINTS.laptopMax)      return 'laptop';
  return 'desktop_large';
}

// matchMedia query strings — used by the hook and exported so callers can
// reuse them without restating pixel constants.
export const MEDIA = {
  mobile:        `(max-width: ${BREAKPOINTS.mobileMax}px)`,
  tabletUp:      `(min-width: ${BREAKPOINTS.mobileMax + 1}px)`,
  tabletDown:    `(max-width: ${BREAKPOINTS.tabletMax}px)`,
  smallLaptopUp: `(min-width: ${BREAKPOINTS.tabletMax + 1}px)`,
  smallLaptopDown:`(max-width: ${BREAKPOINTS.smallLaptopMax}px)`,
  laptopUp:      `(min-width: ${BREAKPOINTS.smallLaptopMax + 1}px)`,
  laptopDown:    `(max-width: ${BREAKPOINTS.laptopMax}px)`,
  desktopLargeUp:`(min-width: ${BREAKPOINTS.laptopMax + 1}px)`,
} as const;

export function isRangeAtLeast(range: BreakpointRange, min: BreakpointRange): boolean {
  return RANGE_ORDER.indexOf(range) >= RANGE_ORDER.indexOf(min);
}

export function isRangeAtMost(range: BreakpointRange, max: BreakpointRange): boolean {
  return RANGE_ORDER.indexOf(range) <= RANGE_ORDER.indexOf(max);
}
