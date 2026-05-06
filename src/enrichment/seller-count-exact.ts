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
 *     reason=queue`) — overflow does NOT poison the cache
 *   - per-attempt timeout 5 s (timeouts logged with reason=timeout).
 *     The concurrency slot is held until the underlying DAS work
 *     settles, so a timed-out scan does not let a fresh one launch
 *     while DAS is still serving the prior request.
 *   - 3 min cache by `seller|collection` so a flurry of sales from
 *     the same dumper doesn't fan out into N deep scans. Cache only
 *     gets populated after a scan completes (success or null result),
 *     never as a pre-write sentinel.
 *   - `pendingKeys` Set dedupes duplicate triggers while a key is
 *     running or queued (replacement for the old pre-write sentinel).
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
/** Keys currently running OR queued. Replaces the prior pre-write
 *  cache sentinel so a queue overflow does not poison the cache for
 *  the full 3-min TTL. Cleared in run()'s finally. */
const pendingKeys = new Set<string>();

/** Fire-and-forget. Returns immediately. Side effect: may emit a
 *  `seller_count_update` bus event later. Idempotent on cache hit
 *  AND on already-pending key (running or queued). */
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
  if (pendingKeys.has(k)) {
    // Same pair is already running or queued — silent dedupe.
    return;
  }
  // Capacity check BEFORE marking pending. A queue-full drop must not
  // leave this key pending or cached, so the next trigger can retry.
  if (active >= ACTIVE_MAX && queue.length >= QUEUE_MAX) {
    console.log('[seller-count-exact-skip] reason=queue');
    return;
  }
  pendingKeys.add(k);
  const task = (): void => { void run(seller, collection, sells10m, k); };
  if (active < ACTIVE_MAX) {
    task();
  } else {
    queue.push(task);
  }
}

function next(): void {
  const t = queue.shift();
  if (t) t();
}

async function run(
  seller: string,
  collection: string,
  sells10m: number,
  k: string,
): Promise<void> {
  active++;
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    let workResult: { count: number | null; scanned: number } | null = null;
    let workError: unknown = null;
    // Materialize the work promise once and attach an immediate catch
    // so a late rejection (after the timeout already won the race)
    // cannot become an unhandled rejection.
    const work: Promise<void> = getOwnerCollectionDeepCount(seller, collection)
      .then((r) => { workResult = r; })
      .catch((err) => { workError = err; });

    const TIMEOUT = Symbol('seller-count-exact-timeout');
    const racer = new Promise<typeof TIMEOUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMEOUT), PER_ATTEMPT_TIMEOUT_MS);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    });

    const winner = await Promise.race([work, racer]);

    if (winner === TIMEOUT) {
      console.log(
        `[seller-count-exact-skip] reason=timeout seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}…`,
      );
      // CRITICAL: hold the concurrency slot until DAS actually settles.
      // Releasing now would let the next queued (or freshly triggered)
      // deep scan launch while the prior request is still in flight,
      // doubling RPC load against Helius.
      await work;
    } else if (timeoutHandle) {
      // Work won the race — clear the pending timer so it doesn't
      // sit on the event loop holding the unref'd handle.
      clearTimeout(timeoutHandle);
    }

    if (workError) {
      console.log(
        `[seller-count-exact-skip] reason=error seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}… err=${String((workError as Error)?.message ?? workError)}`,
      );
      return;
    }
    if (workResult == null) {
      // Defensive — neither result nor error landed. Skip without
      // poisoning the cache so the next trigger can retry.
      return;
    }
    const { count, scanned } = workResult;
    // Cache only after a real scan completion (including null-count
    // results — those are honest "DAS gave us nothing" signals worth
    // honoring for the TTL window).
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
    pendingKeys.delete(k);
    active--;
    next();
  }
}
