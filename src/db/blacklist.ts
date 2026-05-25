/**
 * Permanent collection blacklist.
 *
 * COLLECTION_BLACKLIST — keyed by on-chain collection address.
 * SLUG_BLACKLIST       — keyed by Magic Eden collection slug.
 * NAME_BLACKLIST       — keyed by lowercased collection_name; the third gate
 *                        catches rows where neither collectionAddress nor
 *                        meCollectionSlug came back from enrichment but the
 *                        DAS/ME name lookup did. All comparisons are
 *                        case-insensitive.
 *
 * Matched at two points in insert.ts:
 *   1. Pre-insert (fast-path): when collectionAddress / meCollectionSlug /
 *      collectionName are populated at parse time, the row is dropped before
 *      the INSERT and no SSE is emitted at all.
 *   2. Post-enrichment: covers cNFT and other raw paths where the collection
 *      identity only resolves via DAS/ME lookup. The row is DELETEd and a
 *      `remove` SSE event tells clients to drop the card.
 *
 * Add identifiers to whichever set(s) are known. For cNFT collections only
 * the on-chain collection address is typically known up front — that single
 * entry suffices for the post-enrichment gate. Add slug/name entries too if
 * available, for defense in depth.
 */
export const COLLECTION_BLACKLIST = new Set<string>([
  'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf', // collector_crypt — fake/wash sales
  '12TCHn5MB1TnyWC8dmUThgVHYPSQNVbG7mj6fxV1KhwR', // cNFT collection — Tensor-heavy spam, hide from Live Feed
  // Star Atlas Crew — cNFT collection that leaked through the feed: pre-insert
  // gate misses it because cNFT parsers ship collectionAddress=null at parse
  // time; post-enrichment now matches via the DAS-resolved on-chain collection.
  // Slug + name entries below back this up in case ME's /v2/tokens/:mint
  // times out (we've observed frequent staratlascrew timeouts) and the
  // frontend slug filter would otherwise be bypassed.
  'CREWSAACJTKHKhZi96pLRJXsxiGbdZaQHdFW9r7qGJkB', // staratlascrew — cNFT, Tensor-heavy
  // DRiP collection that surfaces on Tensor only (slug `man__machine_dialogues_drip`).
  // The substring filter misses it because the human collection name carries no
  // "drip" marker and there is no ME slug (ME doesn't list it). Address gate is
  // the only reliable signal we have without a Tensor-API lookup.
  '3reTJCRky6oiRh9FF1rTLd2bYWcpymhj3ANZ1BdqNcMw', // Man & Machine Dialogues (DRiP, Tensor-only)
]);

export const SLUG_BLACKLIST = new Set<string>([
  'collector_crypt', // CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf — fake/wash sales
  'staratlascrew',   // CREWSAACJTKHKhZi96pLRJXsxiGbdZaQHdFW9r7qGJkB
]);

/** Lowercased so caller does `NAME_BLACKLIST.has(name.toLowerCase())`. */
export const NAME_BLACKLIST = new Set<string>([
  'collector crypt', // CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf — fake/wash sales
  'star atlas crew', // CREWSAACJTKHKhZi96pLRJXsxiGbdZaQHdFW9r7qGJkB — DAS provides this name when ME slug API fails
  'man & machine dialogues', // 3reTJCRky6oiRh9FF1rTLd2bYWcpymhj3ANZ1BdqNcMw — DRiP, Tensor-only, name carries no "drip"
]);

/** Lowercased substrings — match anywhere in the name. Use sparingly:
 *  every entry adds a substring scan over every accepted sale's
 *  collection name. "drip" covers DRiP / DRIP / Drip Haus / Drip … */
export const NAME_SUBSTRING_BLACKLIST: readonly string[] = [
  'drip',
];

/** Single entrypoint used by the insert pipeline. Returns true when ANY of the
 *  exact-match keys hit OR a name-substring rule fires. Cheap: three Set
 *  lookups + one toLowerCase + N short substring scans. Optional `signature`
 *  / `mintAddress` only used for the substring-rule diagnostic log so callers
 *  don't have to duplicate the log line at every call site. */
export function isBlacklistedCollection(opts: {
  collectionAddress: string | null;
  meCollectionSlug:  string | null | undefined;
  collectionName:    string | null;
  signature?:        string;
  mintAddress?:      string | null;
}): boolean {
  if (opts.collectionAddress && COLLECTION_BLACKLIST.has(opts.collectionAddress)) return true;
  if (opts.meCollectionSlug  && SLUG_BLACKLIST.has(opts.meCollectionSlug))         return true;
  if (opts.collectionName) {
    const lower = opts.collectionName.toLowerCase();
    if (NAME_BLACKLIST.has(lower)) return true;
  }
  // Substring scan over BOTH the lowercased collection name AND the
  // lowercased ME slug. Collections like `paulcharlesart_drip` carry
  // "drip" only in the slug while the human collection name (e.g. the
  // artist's name) doesn't contain the substring at all — the previous
  // name-only loop missed them. Each haystack is checked independently
  // so a row needs only ONE of name/slug to match. The diagnostic log
  // is preserved verbatim from the prior implementation; it now fires
  // for slug matches too, distinguishable by `collection=null`.
  const haystacks: string[] = [];
  if (opts.collectionName)   haystacks.push(opts.collectionName.toLowerCase());
  if (opts.meCollectionSlug) haystacks.push(opts.meCollectionSlug.toLowerCase());
  for (const needle of NAME_SUBSTRING_BLACKLIST) {
    for (const hay of haystacks) {
      if (hay.includes(needle)) {
        console.log(
          `[feed/blacklist] reason=${needle}_collection ` +
          `collection=${opts.collectionName ?? 'null'} ` +
          `slug=${opts.meCollectionSlug ?? 'null'} ` +
          `mint=${opts.mintAddress ?? '—'} ` +
          `sig=${opts.signature ?? '—'}`,
        );
        return true;
      }
    }
  }
  return false;
}
