// VictoryLabs — Feed: small pure formatters.
// Extracted verbatim from page.tsx. No closure access, no React, no
// DOM. Pulled out so the upcoming FeedCard / FeedFiltersPanel splits
// can import what they need.

import { formatSol } from '@/soloist/mock-data';

// Display-only price formatter for the live-feed cards. Diverges from
// the shared `formatSol` only in the 0.001..0.01 SOL band: that range
// used to render as 4 decimals ("0.0060"), which made every low-priced
// row read as dust noise. New rule: max 3 decimals with trailing zeros
// trimmed (0.006, 0.007). Sub-0.001 SOL keeps the shared formatter's
// 5/6-decimal path so a 0.00025 SOL sale still renders meaningfully
// instead of collapsing to "0.000". Larger prices (≥ 0.01) fall
// through to the shared formatter unchanged so dashboard / collection
// / tools displays stay in lockstep. Does NOT touch raw priceSol,
// filters, sorting, or floor%.
export function formatFeedPrice(n: number): string {
  if (n >= 0.001 && n < 0.01) {
    return n.toFixed(3).replace(/\.?0+$/, '');
  }
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
