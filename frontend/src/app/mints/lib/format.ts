// VictoryLabs — Mints: small pure formatters.
// Extracted verbatim from page.tsx. These are display-only helpers
// (no closure access, no React, no DOM). Pulled out so the table-row
// JSX can be split later without forcing each split file to re-import
// or re-declare them. Behaviour byte-identical to the inline versions.

import { formatSol } from '@/soloist/mock-data';

/** "Newly created collection" heuristic (UI-only). Flagged NEW when the
 *  on-chain creation time (`collectionCreatedAt`, from the collection-created
 *  resolver) is within NEW_COLLECTION_WINDOW_MS of the first observed mint
 *  (`firstSeenAt`). Pure: both args must be present positive numbers,
 *  otherwise false (never invent freshness). */
export const NEW_COLLECTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
export function isNewCollection(createdAt?: number, firstSeenAt?: number): boolean {
  return typeof createdAt === 'number' && createdAt > 0
    && typeof firstSeenAt === 'number' && firstSeenAt > 0
    && Math.abs(firstSeenAt - createdAt) <= NEW_COLLECTION_WINDOW_MS;
}

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

/** Truncate (floor) `lamports` to `dp` SOL decimals, then trim trailing zeros.
 *  Works from integer lamports (not `sol * 10**dp`) to avoid float-edge
 *  truncation bugs like 0.012 → 0.011. Mint-tracker only — TRUNCATION, not
 *  rounding. */
function truncSol(lamports: number, dp: number): string {
  const lamportsPerUnit = 1e9 / 10 ** dp;             // lamports per smallest shown digit
  const units           = Math.floor(lamports / lamportsPerUnit);
  return trimTrailingZeros((units / 10 ** dp).toFixed(dp));
}

export function fmtSol(lamports: number | null): string {
  if (lamports == null) return '—';
  // `<= 0` (not `=== 0`): legacy rows can carry a negative priceLamports
  // (signer net-received lamports) — render FREE, never negative SOL.
  if (lamports <= 0)    return 'FREE';
  // Mint Tracker uses TRUNCATION, not rounding — so 0.0065 reads 0.006, never
  // 0.007. (The shared soloist `formatSol` rounds via toFixed and must stay
  // unchanged for the sale/listing feeds, so we do NOT call it here.)
  //   ≥ 0.001 SOL → 3 dp truncated  (0.0065 → 0.006, 0.0125 → 0.012)
  //   smaller     → keep more significant digits (0.00017 stays 0.00017)
  if (lamports >= 1_000_000) return truncSol(lamports, 3);   // ≥ 0.001 SOL
  if (lamports >= 100_000)   return truncSol(lamports, 5);   // ≥ 0.0001 SOL
  return truncSol(lamports, 6);
}

/** Mint-price display rule shared by the Live Mint Feed card AND the Mint
 *  Tracker table price column (single source of truth — do not duplicate).
 *  Lamports in; null → '—', ≤0 → 'FREE' (same contract as `fmtSol`).
 *    • < 0.1 SOL → TRUNCATE (floor) to ≤3 decimals, never round
 *        0.00411 → 0.004 · 0.0036 → 0.003 · 0.059 → 0.059 · 0.0999 → 0.099
 *    • ≥ 0.1 SOL → shared `formatSol` (rounded), trailing zeros trimmed
 *        0.2 → 0.2 · 0.55 → 0.55 · 0.553 → 0.55 · 0.6 → 0.6 · 1.822 → 1.82
 *  A sub-0.001 SOL paid mint can't be shown in 3 dp, so it falls back to the
 *  rounded `formatSol` rather than reading as a bare 0. DB/raw value unchanged. */
export function fmtMintPrice(lamports: number | null): string {
  if (lamports == null) return '—';
  if (lamports <= 0)    return 'FREE';
  // < 0.1 SOL, ≥ 0.001 SOL → floor to 3 dp (truncSol already trims zeros).
  if (lamports < 100_000_000 && lamports >= 1_000_000) return truncSol(lamports, 3);
  // ≥ 0.1 SOL (or sub-0.001 fallback) → rounded formatSol, trailing zeros off.
  return trimTrailingZeros(formatSol(lamports / 1e9));
}

/** Strip trailing zeros (and a now-bare decimal point) from a formatted
 *  number string, preserving any non-digit suffix (e.g. the 'K' formatSol
 *  appends for ≥1000). No decimal point → returned unchanged. */
function trimTrailingZeros(s: string): string {
  const m = s.match(/^(\d+)\.(\d+)(\D*)$/);
  if (!m) return s;
  const [, intPart, frac, suffix] = m;
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${intPart}.${trimmed}${suffix}` : `${intPart}${suffix}`;
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

/** Compact age formatter shared by the LAST and CREATED columns of the
 *  Mint Tracker table. Drops the "ago" suffix to keep the columns
 *  narrow; switches to weeks at 14 d, months at 30 d, years at 365 d
 *  so even old collections stay readable as a single small token
 *  (e.g. "3mo", "2y"). NEVER renders absolute dates.
 *  Bucket boundaries:
 *    <5s    → "now"
 *    <60s   → "Ns"
 *    <60m   → "Nm"
 *    <24h   → "Nh"
 *    <14d   → "Nd"        (1-13 days stay as days)
 *    <30d   → "Nw"        (14-29 days → weeks; 18d → 2w)
 *    <365d  → "Nmo"       (30-364 days → months; 45d → 1mo, 90d → 3mo)
 *    else   → "Ny"        (year buckets) */
export function fmtAgeShort(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 5_000)         return 'now';
  if (diff < 60_000)        return `${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 14)            return `${days}d`;
  if (days < 30)            return `${Math.floor(days / 7)}w`;
  if (days < 365)           return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function shortKey(k: string): string {
  // Display-friendly truncation when no name is available.
  const clean = k.replace(/^[a-z]+:/, '');
  return clean.length > 14 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean;
}
