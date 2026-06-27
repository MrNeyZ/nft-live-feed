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

// Cache lifetimes — bumped from the original short windows to keep
// the seller-count badge a best-effort signal that doesn't pummel
// Helius. A wallet's holdings change slowly relative to a /feed tick,
// so a few minutes of staleness is fine.
const TTL_MS         = 4 * 60_000;        // owner+collection count: 4 min
const SWEEP_INTERVAL = 60_000;

// Strict back-pressure on outbound DAS calls. The badge is purely
// decorative — under load (a hot collection dump or a flurry of MMM
// trait-bid acceptances) we'd rather drop late lookups than block the
// rest of the pipeline waiting for them.
const MAX_ACTIVE = 2;     // concurrent in-flight DAS calls allowed
const MAX_QUEUED = 20;    // pending lookups beyond this are dropped
let activeCount  = 0;
let queuedCount  = 0;
let droppedCount = 0;
const waitQueue: Array<() => void> = [];
function acquireSlot(): Promise<boolean> {
  if (activeCount < MAX_ACTIVE) { activeCount++; return Promise.resolve(true); }
  if (queuedCount >= MAX_QUEUED) { droppedCount++; return Promise.resolve(false); }
  queuedCount++;
  return new Promise<boolean>(resolve => {
    waitQueue.push(() => { queuedCount--; activeCount++; resolve(true); });
  });
}
function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

interface CachedCount { count: number | null; method: OwnerCollectionCountMethod | 'cached'; scanned?: number; }
const cache    = new TtlCache<string, CachedCount>(TTL_MS, SWEEP_INTERVAL);
const inflight = new Map<string, Promise<CachedCount>>();

function key(owner: string, collection: string): string {
  return `${owner}|${collection}`;
}

/** Resolve `mintAddress` → on-chain collection group address via DAS.
 *  Caching and inflight dedup are handled by the shared fetchAsset layer
 *  (4h hit cache, 60s miss cache). Returns null when DAS doesn't carry a
 *  collection grouping (cNFT without verified collection, partial index,
 *  or any RPC failure). Never throws. */
export async function resolveCollectionForMint(mintAddress: string): Promise<string | null> {
  try {
    const meta = await getAsset(mintAddress, 'seller_collection_count');
    return meta.collectionAddress ?? null;
  } catch {
    return null;
  }
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
    // Acquire a slot before any RPC work. If the queue is full the
    // lookup is dropped — the badge is decorative and we'd rather
    // skip it than wedge the pipeline behind a backlog.
    const granted = await acquireSlot();
    if (!granted) {
      const entry: CachedCount = { count: null, method: 'failed' };
      // Negative-cache the drop briefly so a flood of identical
      // lookups doesn't spin the queue. The full TTL applies — a
      // dropped lookup is treated like a failed one.
      cache.set(k, entry);
      inflight.delete(k);
      return entry;
    }
    try {
      const r = await getOwnerCollectionCountVerbose(owner, collectionAddress);
      const entry: CachedCount = { count: r.count, method: r.method, scanned: r.scanned };
      cache.set(k, entry);
      return entry;
    } finally {
      releaseSlot();
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Counters for the periodic health log. Read-only accessor for any
 *  diagnostic surface that wants to surface back-pressure without
 *  importing the internals. */
export function sellerCountSlotStats(): { active: number; queued: number; dropped: number } {
  return { active: activeCount, queued: queuedCount, dropped: droppedCount };
}

/** Backward-compatible wrapper — returns just the count. */
export async function getSellerCollectionCount(
  owner: string,
  collectionAddress: string,
): Promise<number | null> {
  const r = await getSellerCollectionCountVerbose(owner, collectionAddress);
  return r.count;
}
