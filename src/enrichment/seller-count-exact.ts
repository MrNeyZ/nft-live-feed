/**
 * Exact-count fallback for active dumpers.
 *
 * Triggered from the SSE onSale handler ONLY when the fast
 * searchAssets path returned 0–2 (or null) AND the recent-sell
 * tracker shows the wallet is visibly dumping (≥2 sells for this
 * seller+collection in the last 10 min, or ≥3 sells for this seller
 * across any collection in the last 10 min). Runs the heavy
 * `getAssetsByOwner` paginated walk under strict back-pressure:
 *   - concurrency 1 (one in-flight deep scan at a time)
 *   - queue cap 20 (overflow drops with `[seller-count-exact-skip]
 *     reason=queue`)
 *   - per-attempt timeout 5 s (timeouts logged with reason=timeout)
 *   - 3 min cache by `seller|collection` so a flurry of sales from
 *     the same dumper doesn't fan out into N deep scans.
 *
 * Result fans out to every connected client via the bus event
 * `seller_count_update`, which the SSE layer rebroadcasts as a
 * standard `seller_count` patch — frontend's existing reducer
 * handles it (matches by seller+collection, sticky-merges the
 * higher-confidence count).
 */

import { TtlCache } from './cache';
import { getOwnerCollectionDeepCount } from './helius-das';
import { saleEventBus } from '../events/emitter';

const CACHE_TTL_MS    = 3 * 60_000;   // refetch at most every 3 min per pair
const SWEEP_MS        = 60_000;
const ACTIVE_MAX      = 1;
const QUEUE_MAX       = 20;
const PER_ATTEMPT_TIMEOUT_MS = 5_000;

interface CacheEntry { count: number | null; }
const cache = new TtlCache<string, CacheEntry>(CACHE_TTL_MS, SWEEP_MS);

function key(seller: string, collection: string): string {
  return `${seller}|${collection}`;
}

let active = 0;
const queue: Array<() => void> = [];

function tryRun(task: () => void): void {
  if (active < ACTIVE_MAX) { task(); return; }
  if (queue.length >= QUEUE_MAX) {
    console.log('[seller-count-exact-skip] reason=queue');
    return;
  }
  queue.push(task);
}

function next(): void {
  const t = queue.shift();
  if (t) t();
}

/** Fire-and-forget. Returns immediately. Side effect: may emit a
 *  `seller_count_update` bus event later. Idempotent on cache hit. */
export function scheduleExactSellerCount(
  seller: string,
  collection: string,
  sells10m: number,
): void {
  if (!seller || !collection) return;
  const k = key(seller, collection);
  if (cache.has(k)) {
    console.log(`[seller-count-exact-skip] reason=cache seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}…`);
    return;
  }
  // Pre-write a sentinel so a duplicate trigger arriving before the
  // task runs hits the cache check above. Will be overwritten with
  // the real result (or remain null on failure) below.
  cache.set(k, { count: null });
  tryRun(() => { void run(seller, collection, sells10m, k); });
}

async function run(
  seller: string,
  collection: string,
  sells10m: number,
  k: string,
): Promise<void> {
  active++;
  try {
    const racer = new Promise<{ timedOut: true }>((resolve) => {
      const t = setTimeout(() => resolve({ timedOut: true }), PER_ATTEMPT_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    });
    const work = (async () => {
      const r = await getOwnerCollectionDeepCount(seller, collection);
      return { timedOut: false as const, ...r };
    })();
    const result = await Promise.race([racer, work]);
    if ('timedOut' in result && result.timedOut === true && !('count' in result)) {
      console.log(
        `[seller-count-exact-skip] reason=timeout seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}…`,
      );
      return;
    }
    // Narrowed: the work branch resolved.
    const { count, scanned } = result as { count: number | null; scanned: number; timedOut: false };
    cache.set(k, { count });
    if (count == null) {
      console.log(
        `[seller-count-exact-skip] reason=lookup_null seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}… scanned=${scanned}`,
      );
      return;
    }
    console.log(
      `[seller-count-exact-result] seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}… ` +
      `count=${count} pages=${Math.ceil((scanned || 1) / 1000)} scanned=${scanned}`,
    );
    saleEventBus.emitSellerCountUpdate({ seller, collection, count, sells10m });
  } finally {
    active--;
    next();
  }
}
