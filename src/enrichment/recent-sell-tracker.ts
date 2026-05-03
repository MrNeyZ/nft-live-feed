/**
 * Per-(seller, collection) sell-event ring buffer for the /feed
 * "seller-is-dumping" signal.
 *
 * Background: the Helius DAS `searchAssets(owner, collection)` count
 * is the authoritative number for the seller-remaining badge, but it
 * frequently underreports (DAS index lag, asset already transferred
 * out by the time we query, NFT moved to a wallet alias, etc.). When
 * the lookup returns 0–2 we still want to flag a wallet that's
 * visibly dumping in real time — i.e. has fired multiple sell-side
 * sales in the last 10 minutes for the same collection.
 *
 * This module is a tiny in-memory tracker:
 *   - `noteRecentSell(seller, collection, ts)` — call from the SSE
 *     onSale handler when the saleType matches the badge's sell-set.
 *   - `getRecentSellCount(seller, collection)` — returns the count
 *     of sell-side sales seen for that pair in the last 10 min.
 *
 * Bounded both ways:
 *   - Per-key entries are lazily trimmed against `WINDOW_MS` on every
 *     read or write — so an idle key never stays large.
 *   - Total keys cap (`MAX_KEYS`) drops oldest insertion-order entry
 *     when the map would grow past the cap. Insertion order is
 *     preserved by Map's spec, so iterating `.keys()` yields oldest
 *     first.
 */

const WINDOW_MS = 10 * 60_000;
const MAX_KEYS  = 50_000;

// `${seller}|${collection}` → list of timestamps (ms since epoch).
const log = new Map<string, number[]>();
// `${seller}` → list of timestamps for ANY collection (cross-collection
// dumping signal — "this wallet has been dumping a lot lately").
const sellerLog = new Map<string, number[]>();

function key(seller: string, collection: string): string {
  return `${seller}|${collection}`;
}

function trim(arr: number[], cutoff: number): void {
  // Linear shift from the front while entries are older than cutoff.
  // Shift is O(n) but bounded by `n = sells in 10 min for one pair`,
  // typically 1–5. No need for a deque.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

export function noteRecentSell(seller: string, collection: string, ts: number = Date.now()): void {
  if (!seller || !collection) return;
  const k = key(seller, collection);
  let arr = log.get(k);
  if (!arr) {
    if (log.size >= MAX_KEYS) {
      const it = log.keys();
      const r  = it.next();
      if (!r.done) log.delete(r.value);
    }
    arr = [];
    log.set(k, arr);
  }
  arr.push(ts);
  trim(arr, ts - WINDOW_MS);
  // Mirror into the per-seller log (any collection) for the
  // cross-collection dumping signal.
  let sArr = sellerLog.get(seller);
  if (!sArr) {
    if (sellerLog.size >= MAX_KEYS) {
      const it = sellerLog.keys();
      const r  = it.next();
      if (!r.done) sellerLog.delete(r.value);
    }
    sArr = [];
    sellerLog.set(seller, sArr);
  }
  sArr.push(ts);
  trim(sArr, ts - WINDOW_MS);
}

export function getRecentSellCount(seller: string, collection: string, now: number = Date.now()): number {
  if (!seller || !collection) return 0;
  const arr = log.get(key(seller, collection));
  if (!arr) return 0;
  trim(arr, now - WINDOW_MS);
  if (arr.length === 0) {
    log.delete(key(seller, collection));
    return 0;
  }
  return arr.length;
}

/** Count of sell-side sales by `seller` ACROSS any collection in the
 *  10-min window. Pairs with `getRecentSellCount` to drive the active-
 *  dumper trigger that authorises an exact deep-count fetch. */
export function getRecentSellerCountAny(seller: string, now: number = Date.now()): number {
  if (!seller) return 0;
  const arr = sellerLog.get(seller);
  if (!arr) return 0;
  trim(arr, now - WINDOW_MS);
  if (arr.length === 0) {
    sellerLog.delete(seller);
    return 0;
  }
  return arr.length;
}
