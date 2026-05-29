/**
 * Pure, side-effect-free blacklist matchers shared by the render path AND
 * the ingestion boundaries (SSE handlers, REST hydration, localStorage
 * restore). Applying these BEFORE an event enters visible state is what
 * prevents the flash-before-filter: a blacklisted sale/mint never reaches
 * the ordered list, so it is never painted then removed.
 *
 * The matching logic here is identical to the previous render-time checks —
 * it is only centralised so both the boundary and the render backstop use
 * one source of truth and can never diverge.
 */

// ── /feed permanent (frontend-only) blacklists ──────────────────────────────
// Moved verbatim from app/feed/page.tsx. Mirrors src/db/blacklist.ts; the
// backend defines isBlacklistedCollection but does NOT drop sales on emit
// (it only skips floor/offer API calls), so actual hiding is frontend-side.
/** Lowercased collection-name blacklist; mirrors src/db/blacklist.ts NAME_BLACKLIST. */
export const FEED_NAME_BLACKLIST = new Set<string>([
  'collector crypt',
  // staratlascrew leak guard — backend ships meCollectionSlug=null when ME's
  // /v2/tokens/:mint times out, so the slug gate short-circuits; DAS still
  // surfaces the name ("STAR ATLAS CREW"), so this name-level fallback closes
  // the bypass.
  'star atlas crew',
]);
/** Frontend-only slug blacklist — hide specific collections from the Live
 *  Feed without touching ingestion. Collection page still renders if visited. */
export const FEED_SLUG_BLACKLIST = new Set<string>([
  'staratlascrew',
]);
/** Frontend mirror of src/db/blacklist.ts NAME_SUBSTRING_BLACKLIST. Checked
 *  against BOTH collectionName and meCollectionSlug (lowercased). */
export const FEED_NAME_SUBSTRING_BLACKLIST: readonly string[] = ['drip'];

interface FeedEventLike {
  collectionName?: string | null;
  meCollectionSlug?: string | null;
}

/**
 * True when a sale event must be hidden — either by the permanent frontend
 * blacklist (name/slug exact + substring) or by the user's blacklist set.
 * Field set matches the prior render filter: meCollectionSlug + collectionName.
 */
export function isFeedEventBlacklisted(e: FeedEventLike, userSet: ReadonlySet<string>): boolean {
  const name = e.collectionName?.toLowerCase() ?? '';
  const slug = e.meCollectionSlug?.toLowerCase() ?? '';
  // Permanent name / slug (exact). Slug compared raw to match prior behavior.
  if (name && FEED_NAME_BLACKLIST.has(name)) return true;
  if (e.meCollectionSlug && FEED_SLUG_BLACKLIST.has(e.meCollectionSlug)) return true;
  // User blacklist (exact, lowercased) — never a substring.
  if (userSet.size > 0) {
    if (slug && userSet.has(slug)) return true;
    if (name && userSet.has(name)) return true;
  }
  // Permanent substring fallback (name OR slug).
  for (const needle of FEED_NAME_SUBSTRING_BLACKLIST) {
    if (name.includes(needle) || slug.includes(needle)) return true;
  }
  return false;
}

// ── /mints user blacklist ───────────────────────────────────────────────────
interface MintEventLike {
  groupingKey?: string | null;
  collectionAddress?: string | null;
  mintAddress?: string | null;
}
interface MintStatusLike {
  groupingKey?: string | null;
  collectionAddress?: string | null;
  lastMintAddress?: string | null;
  name?: string | null;
}

/** Per-mint card match — groupingKey / collectionAddress / mintAddress.
 *  Identical to the prior render-time isBlacklistedEvent. */
export function isMintEventBlacklisted(e: MintEventLike, userSet: ReadonlySet<string>): boolean {
  if (userSet.size === 0) return false;
  if (e.groupingKey && userSet.has(e.groupingKey.toLowerCase())) return true;
  if (e.collectionAddress && userSet.has(e.collectionAddress.toLowerCase())) return true;
  if (e.mintAddress && userSet.has(e.mintAddress.toLowerCase())) return true;
  return false;
}

/** Collection-row match — groupingKey / collectionAddress / lastMintAddress /
 *  name. Identical to the prior render-time isBlacklistedRow. */
export function isMintStatusBlacklisted(r: MintStatusLike, userSet: ReadonlySet<string>): boolean {
  if (userSet.size === 0) return false;
  if (r.groupingKey && userSet.has(r.groupingKey.toLowerCase())) return true;
  if (r.collectionAddress && userSet.has(r.collectionAddress.toLowerCase())) return true;
  if (r.lastMintAddress && userSet.has(r.lastMintAddress.toLowerCase())) return true;
  const nm = r.name?.trim().toLowerCase();
  if (nm && userSet.has(nm)) return true;
  return false;
}
