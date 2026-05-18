// VictoryLabs — Feed: persisted seller-remaining counts.
// Extracted verbatim from page.tsx so the upcoming component splits
// (which read seller-count via the same map) don't have to reach back
// into the page file. Module-private debounce state (timer + pending
// map) moves with the helpers — it was already a self-contained
// singleton at module scope; moving it keeps the singleton intact.
//
// The pagehide/beforeunload window listeners that call
// `flushSellerCountsNow` deliberately stay registered in page.tsx —
// they belong to the page's lifecycle, not to the storage helpers.

// Map of `${seller}-${collection}` → count, JSON-encoded into
// localStorage. Backend emits the count asynchronously over SSE
// (event: seller_count) keyed by the same composite. Storing by
// seller+collection — instead of the prior signature key — means one
// resolved value lights up every row from the same wallet+collection
// (mid-dump or post-reload), and old signature-keyed entries from
// prior versions are simply ignored on hydration since they don't
// match the new key shape.
export const SELLER_COUNT_STORAGE_KEY = 'vl.feed.sellerCount.v2';
export const SELLER_COUNT_MAX_ENTRIES = 500;

export function loadSellerCounts(): Map<string, number> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(SELLER_COUNT_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return new Map();
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) m.set(k, v);
    }
    return m;
  } catch { return new Map(); }
}

export function persistSellerCounts(map: Map<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size > SELLER_COUNT_MAX_ENTRIES) {
      const overflow = map.size - SELLER_COUNT_MAX_ENTRIES;
      const it = map.keys();
      for (let i = 0; i < overflow; i++) {
        const k = it.next().value;
        if (k != null) map.delete(k);
      }
    }
    window.localStorage.setItem(SELLER_COUNT_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch { /* quota / serialize error — fail silent */ }
}

/** Debounced wrapper around `persistSellerCounts`. The previous behavior
 *  ran a full Object.fromEntries + JSON.stringify of a ~500-entry Map on
 *  every `seller_count` SSE frame; under a multi-collection dump that
 *  fires many times per second, blocking the main thread. Coalescing on
 *  a 1.5 s timer keeps the persisted store eventually-consistent without
 *  the per-frame serialize cost. A `beforeunload` flush (registered at
 *  the page level) guarantees the latest map survives a tab close. */
const SELLER_COUNT_DEBOUNCE_MS = 1500;
let sellerCountFlushTimer: ReturnType<typeof setTimeout> | null = null;
let sellerCountPendingMap:  Map<string, number> | null = null;

export function flushSellerCountsNow(): void {
  if (sellerCountFlushTimer != null) {
    clearTimeout(sellerCountFlushTimer);
    sellerCountFlushTimer = null;
  }
  if (sellerCountPendingMap) {
    persistSellerCounts(sellerCountPendingMap);
    sellerCountPendingMap = null;
  }
}

export function schedulePersistSellerCounts(map: Map<string, number>): void {
  if (typeof window === 'undefined') return;
  // Capture the live ref — caller mutates the same Map between flushes,
  // so we always serialize the latest state at flush time, not a stale
  // snapshot.
  sellerCountPendingMap = map;
  if (sellerCountFlushTimer != null) return;
  sellerCountFlushTimer = setTimeout(flushSellerCountsNow, SELLER_COUNT_DEBOUNCE_MS);
}
