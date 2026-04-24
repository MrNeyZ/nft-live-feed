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
 * Matched after enrichment in insert.ts: row is deleted from DB and a
 * `remove` SSE event is emitted.
 *
 * All three lists must agree for every blacklisted collection.
 * To add a collection: append to all three sets with the same comment.
 */
export const COLLECTION_BLACKLIST = new Set<string>([
  'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf', // collector_crypt — fake/wash sales
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
