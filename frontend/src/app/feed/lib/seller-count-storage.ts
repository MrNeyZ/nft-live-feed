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

// ── Secondary index: signature → sellerRemainingCount ───────────────────────
// Reload-recovery fallback for the primary (seller+collection) map above.
// A sale can land with collectionAddress=null and only get its count attached
// live via the `seller_count` SIGNATURE match (which also backfills the
// address in memory). After a reload the snapshot row's collectionAddress is
// null again, so `${seller}-${collection}` can't be rebuilt and the primary
// lookup misses — but the originating `seller_count` frame always carries the
// sale signature, so a signature-keyed copy lights the row back up.
//
// Separate localStorage key + its own debounce timer so this never perturbs
// the existing v2 seller+collection store (key/version unchanged). The module
// owns this map (lazy-loaded on first access) since — unlike the primary map —
// it isn't shared with the reducer fan-out; it's read only at snapshot time.
export const SELLER_COUNT_BY_SIG_STORAGE_KEY = 'vl.feed.sellerCountBySig.v1';
export const SELLER_COUNT_BY_SIG_MAX_ENTRIES = 500;

let sigCountMap: Map<string, number> | null = null;

function loadSigCounts(): Map<string, number> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(SELLER_COUNT_BY_SIG_STORAGE_KEY);
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

function ensureSigMap(): Map<string, number> {
  if (sigCountMap == null) sigCountMap = loadSigCounts();
  return sigCountMap;
}

function persistSigCounts(map: Map<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size > SELLER_COUNT_BY_SIG_MAX_ENTRIES) {
      const overflow = map.size - SELLER_COUNT_BY_SIG_MAX_ENTRIES;
      const it = map.keys();
      for (let i = 0; i < overflow; i++) {
        const k = it.next().value;
        if (k != null) map.delete(k);
      }
    }
    window.localStorage.setItem(SELLER_COUNT_BY_SIG_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch { /* quota / serialize error — fail silent */ }
}

let sigCountFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushSigCountsNow(): void {
  if (sigCountFlushTimer != null) {
    clearTimeout(sigCountFlushTimer);
    sigCountFlushTimer = null;
  }
  if (sigCountMap) persistSigCounts(sigCountMap);
}

/** Reload-recovery lookup. Returns the persisted count for a sale signature,
 *  or undefined when none is stored. */
export function getPersistedSellerCountBySignature(signature: string | null | undefined): number | undefined {
  if (!signature) return undefined;
  return ensureSigMap().get(signature);
}

/** Store a sale's resolved remaining-count under its signature. Only finite
 *  counts are kept (mirrors the primary map); debounced like the primary map. */
export function upsertPersistedSellerCountBySignature(signature: string | null | undefined, count: number): void {
  if (typeof window === 'undefined') return;
  if (!signature || typeof count !== 'number' || !Number.isFinite(count)) return;
  const m = ensureSigMap();
  if (m.get(signature) === count) return; // no-op when unchanged
  m.set(signature, count);
  if (sigCountFlushTimer != null) return;
  sigCountFlushTimer = setTimeout(flushSigCountsNow, SELLER_COUNT_DEBOUNCE_MS);
}

/** Flush BOTH persisted seller-count stores (primary seller+collection map and
 *  the signature secondary index). Wired to pagehide/beforeunload by the page
 *  so the latest of either map survives a tab close / reload. */
export function flushPersistedSellerCounts(): void {
  flushSellerCountsNow();
  flushSigCountsNow();
}
