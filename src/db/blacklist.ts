/**
 * Permanent collection blacklist.
 *
 * COLLECTION_BLACKLIST — keyed by on-chain collection address.
 * Matched after enrichment in insert.ts: row is deleted from DB.
 *
 * SLUG_BLACKLIST — keyed by Magic Eden collection slug.
 * Matched in enrich.ts to skip floor/offer API calls, and in insert.ts
 * as a second gate when collectionAddress is null but slug is known.
 *
 * Both lists must agree for every blacklisted collection.
 * To add a collection: append to both sets with the same comment.
 */
export const COLLECTION_BLACKLIST = new Set<string>([
  'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf', // collector_crypt — fake/wash sales
]);

export const SLUG_BLACKLIST = new Set<string>([
  'collector_crypt', // CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf — fake/wash sales
]);
