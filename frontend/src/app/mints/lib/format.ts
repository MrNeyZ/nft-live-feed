// VictoryLabs — Mints: small pure formatters.
// Extracted verbatim from page.tsx. These are display-only helpers
// (no closure access, no React, no DOM). Pulled out so the table-row
// JSX can be split later without forcing each split file to re-import
// or re-declare them. Behaviour byte-identical to the inline versions.

import { formatSol } from '@/soloist/mock-data';

/** Proxy size for inline thumbnails — 64×64 source via the local
 *  `/thumb` proxy. Pass-through for `data:` URIs and for URLs that
 *  already point at the proxy (idempotent). */
export function thumb64(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=64&h=64&fit=cover&output=png`;
}
/** Proxy size for the live-mint card thumbnails — 200×200 source. The
 *  card display size stays around the existing 56–64 px footprint, so
 *  the larger source is purely for crisp rendering on hi-DPI displays
 *  (and matches the spec's "200×200 source if available"). */
export function thumb200(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=200&h=200&fit=cover&output=png`;
}
export function shortMint(addr: string | null): string {
  if (!addr) return '—';
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/** Slug rule used to deep-link a VVV mint into vvv.so. Lowercase,
 *  unicode-folded, non-alphanumerics collapsed to a single hyphen.
 *  Returns '' when the input has no usable characters (caller treats
 *  that as "no link, plain pill"). Examples:
 *    "CSTRIKE v2"        → "cstrike-v2"
 *    "Neo Keith : Angel" → "neo-keith-angel"
 *    "Pepok Collection"  → "pepok-collection"
 *    "Café Latte"        → "cafe-latte"
 *    "###"               → "" (no link) */
export function vvvSlugify(input: string): string {
  let s = input.trim().toLowerCase();
  // NFKD splits accented chars (é → e + combining acute), then we drop
  // the combining marks. Wrapped in try/catch because some legacy
  // browsers don't ship `normalize` for every form.
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { /* noop */ }
  s = s.replace(/[^a-z0-9]+/g, '-');  // anything not [a-z0-9] → '-'
  s = s.replace(/-+/g, '-');          // collapse runs
  s = s.replace(/^-+|-+$/g, '');      // trim edges
  return s;
}

// Mints SOL formatter. Phase 1 polish: single decimal precision per
// magnitude bucket, mirroring `formatFeedPrice` so any future surface
// that places a mints price next to a feed price in the same column
// stays decimal-aligned. The numeric columns on /mints use
// `font-variant-numeric: tabular-nums` already, so 3-dp uniformity in
// the 0.001..10 SOL band lets the decimal point land at the same
// column row-to-row.
//
// Bands:
//   ≥ 100         → 0 dp
//   ≥ 10          → 2 dp
//   0.001..10     → 3 dp (decimals align row-to-row in common case)
//   < 0.001       → shared formatSol (5–6 dp dust tail)
//
// Sentinel values:
//   null lamports → "—"
//   0    lamports → "FREE"
export function fmtSol(lamports: number | null): string {
  if (lamports == null) return '—';
  if (lamports === 0)   return 'FREE';
  const sol = lamports / 1e9;
  if (!Number.isFinite(sol) || sol < 0) return formatSol(sol);
  if (sol >= 100)   return sol.toFixed(0);
  if (sol >= 10)    return sol.toFixed(2);
  if (sol >= 0.001) return sol.toFixed(3);
  return formatSol(sol);
}

export function fmtAge(ts: number): string {
  // Defensive: invalid timestamp → em-dash; future / negative ages
  // collapse into the "just now" branch via the `< 5_000` check
  // below so a clock skew between client and server can't render
  // absurd labels like "-3s ago".
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function shortKey(k: string): string {
  // Display-friendly truncation when no name is available.
  const clean = k.replace(/^[a-z]+:/, '');
  return clean.length > 14 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean;
}
