/**
 * Seller-collection-count cache for the /feed SELL badge.
 *
 * After an instant sell-type sale (`bid_sell`, `pool_sale`, …) we want
 * to surface "this seller still holds N from the same collection" so
 * the operator can tell whether the seller is dumping a large position
 * or just trimming one of many. Backend computes the count via Helius
 * DAS `searchAssets(ownerAddress, grouping=[collection,<addr>])` and
 * caches the result for a short TTL so a flurry of sales from the same
 * wallet doesn't fan out into one DAS round-trip per event.
 *
 * Single-flight dedup: concurrent requests for the same `owner|coll`
 * key share one in-flight promise; everyone resolves to the same value.
 */

import { TtlCache } from './cache';
import { getOwnerCollectionCount } from './helius-das';

const TTL_MS         = 45_000;
const SWEEP_INTERVAL = 60_000;

const cache    = new TtlCache<string, number | null>(TTL_MS, SWEEP_INTERVAL);
const inflight = new Map<string, Promise<number | null>>();

function key(owner: string, collection: string): string {
  return `${owner}|${collection}`;
}

/**
 * Returns the seller's remaining holdings in `collectionAddress`.
 * Cache hit → instant; miss → triggers one DAS call shared via single-
 * flight dedup. Returns null when the lookup fails or DAS doesn't
 * report a numeric `total`.
 */
export async function getSellerCollectionCount(
  owner: string,
  collectionAddress: string,
): Promise<number | null> {
  const k = key(owner, collectionAddress);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const live = inflight.get(k);
  if (live) return live;
  const p = (async () => {
    try {
      const n = await getOwnerCollectionCount(owner, collectionAddress);
      cache.set(k, n);
      return n;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}
