// VictoryLabs — Feed: small pure formatters.
// Extracted verbatim from page.tsx. No closure access, no React, no
// DOM. Pulled out so the upcoming FeedCard / FeedFiltersPanel splits
// can import what they need.

import { formatSol } from '@/soloist/mock-data';

// Trim trailing zeros (and any dangling dot) from a DECIMAL string only —
// never from integer / "K"-suffixed outputs like "120" or "2.0K", where a
// blind /0+$/ would corrupt the value ("120" → "12").
function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

// Display-only price formatter for the live-feed cards. Two rules on top of
// the shared `formatSol`:
//   1. Sub-cent prices (0.0005 .. 0.01 SOL) render as max 3 decimals with
//      trailing zeros trimmed — so 0.0008 → "0.001" and 0.006 → "0.006"
//      instead of padded forms ("0.00080") that expand the column and read
//      as dust noise. Values below 0.0005 would round to "0.000" (reads as
//      free), so they keep the shared formatter's fine-grained 5/6-decimal
//      path and still render meaningfully (e.g. 0.00025).
//   2. All other prices pass through `formatSol` but with trailing zeros
//      trimmed, so 0.080 → "0.08" and 1.20 → "1.2". Integer / K outputs are
//      left intact.
// `formatSol` itself is untouched, so dashboard / collection / tools stay in
// lockstep. Does NOT touch raw priceSol, filters, sorting, or floor%.
export function formatFeedPrice(n: number): string {
  if (!Number.isFinite(n)) return formatSol(n);
  if (n >= 0.0005 && n < 0.01) {
    return trimTrailingZeros(n.toFixed(3));
  }
  return trimTrailingZeros(formatSol(n));
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
