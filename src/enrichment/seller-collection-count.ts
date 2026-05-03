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
import {
  getAsset,
  getOwnerCollectionCountVerbose,
  type OwnerCollectionCountMethod,
} from './helius-das';

const TTL_MS         = 45_000;
const SWEEP_INTERVAL = 60_000;

interface CachedCount { count: number | null; method: OwnerCollectionCountMethod | 'cached'; scanned?: number; }
const cache    = new TtlCache<string, CachedCount>(TTL_MS, SWEEP_INTERVAL);
const inflight = new Map<string, Promise<CachedCount>>();

// Mint → collectionAddress resolver. Live sale events often arrive with
// `collectionAddress = null` (parser couldn't extract a verified group on
// the fly). DAS `getAsset` resolves it; we cache the answer for 15 min
// since a mint's collection grouping never changes after creation. Null
// values cached too — repeated misses (cNFT without grouping, dust mint)
// shouldn't burn DAS calls.
const COLL_TTL_MS         = 15 * 60_000;
const COLL_SWEEP_INTERVAL = 60_000;
const collectionCache    = new TtlCache<string, string | null>(COLL_TTL_MS, COLL_SWEEP_INTERVAL);
const collectionInflight = new Map<string, Promise<string | null>>();

function key(owner: string, collection: string): string {
  return `${owner}|${collection}`;
}

/** Resolve `mintAddress` → on-chain collection group address via DAS.
 *  Cached + single-flight. Returns null when DAS doesn't carry a
 *  collection grouping (cNFT without verified collection, partial
 *  index, or any RPC failure). Never throws. */
export async function resolveCollectionForMint(mintAddress: string): Promise<string | null> {
  const cached = collectionCache.get(mintAddress);
  if (cached !== undefined) return cached;
  const live = collectionInflight.get(mintAddress);
  if (live) return live;
  const p = (async () => {
    try {
      const meta = await getAsset(mintAddress);
      const addr = meta.collectionAddress ?? null;
      collectionCache.set(mintAddress, addr);
      return addr;
    } catch {
      // Transient DAS failure — cache null so the immediate retry
      // doesn't fan out, but the entry will expire on the standard
      // TTL and a future sale for this mint can try again.
      collectionCache.set(mintAddress, null);
      return null;
    } finally {
      collectionInflight.delete(mintAddress);
    }
  })();
  collectionInflight.set(mintAddress, p);
  return p;
}

export interface SellerCountResult {
  count:   number | null;
  method:  OwnerCollectionCountMethod | 'cached';
  /** Total assets walked during the fallback scan, when applicable. */
  scanned?: number;
}

/** Verbose variant — returns count + the path that produced it
 *  ('searchAssets' | 'getAssetsByOwner' | 'failed' | 'cached') so the
 *  SSE log can flag whether the value came from the fast path or the
 *  slower fallback scan. Cache stores the full record. */
export async function getSellerCollectionCountVerbose(
  owner: string,
  collectionAddress: string,
): Promise<SellerCountResult> {
  const k = key(owner, collectionAddress);
  const hit = cache.get(k);
  if (hit !== undefined) return { ...hit, method: 'cached' };
  const live = inflight.get(k);
  if (live) return live;
  const p = (async (): Promise<CachedCount> => {
    try {
      const r = await getOwnerCollectionCountVerbose(owner, collectionAddress);
      const entry: CachedCount = { count: r.count, method: r.method, scanned: r.scanned };
      cache.set(k, entry);
      return entry;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Backward-compatible wrapper — returns just the count. */
export async function getSellerCollectionCount(
  owner: string,
  collectionAddress: string,
): Promise<number | null> {
  const r = await getSellerCollectionCountVerbose(owner, collectionAddress);
  return r.count;
}
