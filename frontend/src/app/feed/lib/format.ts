// VictoryLabs — Feed: small pure formatters.
// Extracted verbatim from page.tsx. No closure access, no React, no
// DOM. Pulled out so the upcoming FeedCard / FeedFiltersPanel splits
// can import what they need.

import { formatSol } from '@/soloist/mock-data';

// Display-only price formatter for the live-feed cards.
//
// Phase 1 polish: single decimal precision per magnitude bucket. The
// price column is right-aligned with `font-variant-numeric: tabular-
// nums` (see FC_PRICE_TEXT_STYLE in page.tsx), so when every row in
// the common 0.001–10 SOL band renders at exactly 3 decimal places
// the decimal point lands at the same column row-to-row and the eye
// pre-attentively compares magnitudes instead of re-measuring each
// row. The shared `formatSol` produces 2 / 3 / 4 / 5 / 6 dp across
// adjacent magnitudes which is what caused the column-jitter the
// audit flagged (0.080 / 0.79 / 0.036 / 0.014 / 1.09).
//
// Bands:
//   ≥ 100         → 0 dp ("125", "1000") rare; big drops
//   ≥ 10          → 2 dp ("12.50")       rare-ish; preserves cents
//   0.001..10     → 3 dp ("0.080" /
//                          "0.790" /
//                          "1.090") common NFT prices, decimals align
//   < 0.001       → shared formatSol     dust band; 5–6 dp tail
//
// Trailing zeros are intentionally preserved in the 3-dp band so
// "0.790" + "1.090" both occupy the same 5-char footprint and right-
// align on the decimal point. Does NOT touch raw priceSol, filters,
// sorting, or floor%.
export function formatFeedPrice(n: number): string {
  if (!Number.isFinite(n) || n < 0) return formatSol(n);
  if (n >= 100)   return n.toFixed(0);
  if (n >= 10)    return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(3);
  return formatSol(n);
}

/** Composite key for the persisted seller-remaining count map.
 *  Backend emits the count async over SSE (event: seller_count) keyed
 *  by the same `${seller}-${collection}` shape; storing by that
 *  composite (instead of the prior signature key) means one resolved
 *  value lights up every row from the same wallet+collection (mid-dump
 *  or post-reload). Returns null when either side is missing so call
 *  sites can short-circuit without producing a key like 'null-null'. */
export function sellerCountKey(seller: string | null | undefined, collection: string | null | undefined): string | null {
  if (!seller || !collection) return null;
  return `${seller}-${collection}`;
}

/** Display-time guard against NaN / Infinity / non-numeric inputs from
 *  malformed wire frames. Returns the value when it's a usable finite
 *  number, else null so render sites can substitute a placeholder. */
export function safeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
