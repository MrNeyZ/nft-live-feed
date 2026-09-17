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
/** Proxy size for the live-mint card thumbnails — 128×128 source, 1:1
 *  with /feed's default `compressImage()`. The card display size is 56 px,
 *  so 128 covers 2× DPI without over-fetching. The click-to-open preview
 *  uses `thumb256` instead. */
export function thumb128(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=128&h=128&fit=cover&output=png`;
}
/** Proxy size for the click-to-open image preview overlay — 256×256
 *  source, matching /feed's `compressImage(url, 256)`. The overlay renders
 *  at 200 px; the card thumbnail stays on `thumb128` and is untouched. */
export function thumb256(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=256&h=256&fit=cover&output=png`;
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

/** Round `lamports` to `dp` SOL decimals, then trim trailing zeros. Works
 *  from integer lamports (not `sol * 10**dp`) to avoid float-edge rounding
 *  bugs like 0.0125 → 0.0124999999.
 *
 *  Was TRUNCATION (floor) until 2026-09-16 — deliberately, per the old
 *  comment here, so the tracker "never overstates" a mint's price. In
 *  practice that read as a bug: a real CLOIDS mint costing 0.00298844 SOL
 *  displayed as "0.002" (floor of 2.98844 is 2), which is further from the
 *  true value than "0.003" (round of 2.98844 is 3) — the truncation didn't
 *  just avoid overstating, it systematically understated by up to a whole
 *  display unit. Ordinary rounding now, matching the shared soloist
 *  `formatSol` used by every other feed. */
function roundSol(lamports: number, dp: number): string {
  const lamportsPerUnit = 1e9 / 10 ** dp;             // lamports per smallest shown digit
  const units           = Math.round(lamports / lamportsPerUnit);
  return trimTrailingZeros((units / 10 ** dp).toFixed(dp));
}

export function fmtSol(lamports: number | null): string {
  if (lamports == null) return '—';
  // No "free" price bucket — a real mint always costs at least network fee
  // + rent, so we always show the raw resolved number, however small.
  // Floor legacy negative rows (signer net-received lamports) to 0 rather
  // than showing a negative SOL amount.
  const clamped = lamports < 0 ? 0 : lamports;
  //   ≥ 0.001 SOL → 3 dp, rounded  (0.0065 → 0.007, 0.0125 → 0.013, 0.00298844 → 0.003)
  //   smaller     → keep more significant digits (0.00017 stays 0.00017)
  if (clamped >= 1_000_000) return roundSol(clamped, 3);   // ≥ 0.001 SOL
  if (clamped >= 100_000)   return roundSol(clamped, 5);   // ≥ 0.0001 SOL
  return roundSol(clamped, 6);
}

/** Mint-price display rule shared by the Live Mint Feed card AND the Mint
 *  Tracker table price column (single source of truth — do not duplicate).
 *  Lamports in; null → '—'. Genuinely free (0 lamports) still shows `0`
 *  (colored green elsewhere as "free") — this is not a free bucket, it's the
 *  real resolved value.
 *    • 0 SOL              → `0`
 *    • (0, 0.001) SOL     → floored to the display minimum `0.001` — never
 *      show more than 3 decimals just because the real value is tiny; a
 *      real-but-tiny paid mint reads as "0.001", not "0.00079"/"0.0000004".
 *    • [0.001, 0.1) SOL   → rounded to 3 decimals
 *        0.00411 → 0.004 · 0.0036 → 0.004 · 0.059 → 0.059 · 0.0999 → 0.1
 *    • ≥ 0.1 SOL          → shared `formatSol` (rounded), trailing zeros trimmed
 *        0.2 → 0.2 · 0.55 → 0.55 · 0.553 → 0.55 · 0.6 → 0.6 · 1.822 → 1.82 */
/** Format a raw u64 token amount (as a decimal string) into a human amount
 *  using the token's decimals. Trims to 4 fractional digits, then drops
 *  trailing zeros. Returns null for a non-numeric input. Mirrors the
 *  Mint Tracker table's own formatter so the Live Mint Feed reads the same. */
export function formatTokenAmount(raw: string, decimals: number): string | null {
  if (!/^\d+$/.test(raw)) return null;
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart  = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  const fracTrunc = fracPart.slice(0, 4).replace(/0+$/, '');
  return fracTrunc.length > 0 ? `${intPart}.${fracTrunc}` : intPart;
}

export function fmtMintPrice(lamports: number | null): string {
  if (lamports == null) return '—';
  // Floor legacy negative rows (signer net-received lamports) to 0.
  const clamped = lamports < 0 ? 0 : lamports;
  if (clamped === 0) return '0';
  // (0, 0.001) SOL → display floor. A real paid mint this tiny still reads
  // as "0.001", not padded out to 5-6 decimals just to show its true size —
  // that extra precision reads as noise/inflated digits, not information.
  if (clamped < 1_000_000) return '0.001';
  // [0.001, 0.1) SOL → round to 3 dp (roundSol already trims zeros).
  if (clamped < 100_000_000) return roundSol(clamped, 3);
  // ≥ 0.1 SOL → rounded formatSol, trailing zeros off.
  return trimTrailingZeros(formatSol(clamped / 1e9));
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

/** Wire `blockTime` (ISO 8601 string) → ms anchor used for feed ordering
 *  and age display. Falls back to wall-clock `Date.now()` when the value
 *  is missing, unparseable, OR implausibly far in the future.
 *
 *  The future guard matters: a single bad RPC frame (block time handed
 *  back already in ms, i.e. ~1000x ahead — or plain validator/client
 *  clock skew) would otherwise pin that event to the very top of the
 *  Live Mint Feed reading "just now" for the whole session, and freeze
 *  the collection's LAST-mint age in the tracker table — the left row
 *  does `lastMintAt = Math.max(prev, receivedAt)`, so a future anchor is
 *  never overtaken by real later mints. Past values are left untouched:
 *  an old replayed mint legitimately sorts down and reads "3h ago". */
const RECEIVED_AT_FUTURE_SKEW_MS = 120_000; // 2 min — covers normal clock drift
export function resolveReceivedAt(blockTime: unknown): number {
  const now = Date.now();
  if (typeof blockTime !== 'string' || blockTime.length === 0) return now;
  const ms = Date.parse(blockTime);
  if (!Number.isFinite(ms) || ms > now + RECEIVED_AT_FUTURE_SKEW_MS) return now;
  return ms;
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
