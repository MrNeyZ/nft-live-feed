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
]);

export const SLUG_BLACKLIST = new Set<string>([
  'collector_crypt', // CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf — fake/wash sales
]);

/** Lowercased so caller does `NAME_BLACKLIST.has(name.toLowerCase())`. */
export const NAME_BLACKLIST = new Set<string>([
  'collector crypt', // CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf — fake/wash sales
]);

/** Single entrypoint used by the insert pipeline. Returns true when ANY of the
 *  three keys match. Cheap: three Set lookups + one toLowerCase. */
export function isBlacklistedCollection(opts: {
  collectionAddress: string | null;
  meCollectionSlug:  string | null | undefined;
  collectionName:    string | null;
}): boolean {
  if (opts.collectionAddress && COLLECTION_BLACKLIST.has(opts.collectionAddress)) return true;
  if (opts.meCollectionSlug  && SLUG_BLACKLIST.has(opts.meCollectionSlug))         return true;
  if (opts.collectionName    && NAME_BLACKLIST.has(opts.collectionName.toLowerCase())) return true;
  return false;
}
