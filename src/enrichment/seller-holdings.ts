/**
 * Running-holdings counter for the /feed SELL badge
 * ("seller still holds N from this collection").
 *
 * Replaces two prior mechanisms, both retired:
 *   - The per-sale Helius `searchAssets` fast path (`seller-collection-count.ts`'s
 *     `getSellerCollectionCountVerbose`) — its `total` aggregate was confirmed
 *     live (2026-07-15) to badly undercount MPL Core collections (returned `1`
 *     for a wallet `getAssetsByOwner` verified held 29).
 *   - The active-dumper-triggered exact-scan module (`seller-count-exact.ts`)
 *     — retired to avoid two independent writers racing to persist a count
 *     for the same (seller, collection) pair (see the module-retirement note
 *     at the bottom of this file).
 *
 * ── Count semantics ─────────────────────────────────────────────────────
 * `getAndDecrementSellerHolding(seller, collection)` is called once per
 * sell-side sale and returns "how many of this collection does `seller`
 * hold immediately AFTER this sale" (or null if unresolved this time):
 *
 *   - First sale ever observed for a (seller, collection) pair: the
 *     underlying DAS scan (`getOwnerCollectionDeepCount`, the reliable
 *     paginated `getAssetsByOwner` walk) runs AFTER the sale has already
 *     landed on-chain, so its result already reflects "remaining after
 *     THIS sale" — the scanned value is returned as-is, with NO extra -1.
 *     (Proven in seller-holdings.test.ts: "no off-by-one".)
 *   - Every later sale for the same pair: an atomic SQL
 *     `UPDATE ... SET count = count - 1 ... RETURNING count` (see
 *     `atomicDecrementSellerHolding` in db/insert.ts) — no RPC call.
 *
 * ── Atomicity / concurrency ─────────────────────────────────────────────
 * All persisted-count mutations are single atomic SQL statements — the
 * correctness of concurrent sales does NOT depend on in-process locking,
 * Node's single-threadedness, or call ordering:
 *
 *   - Decrementing an EXISTING row: `UPDATE ... RETURNING count` takes an
 *     implicit Postgres row lock for the statement's duration, so N
 *     concurrent decrements for the same pair are serialized by Postgres
 *     itself and each gets a distinct, correctly-descending count.
 *   - Seeding a NEW row (first sight): `INSERT ... ON CONFLICT DO NOTHING
 *     RETURNING count`. Concurrent first-sight callers share ONE Helius
 *     scan (serialized through a per-key FIFO chain — see `chained`
 *     below), but each independently attempts the INSERT; Postgres's
 *     unique constraint on (seller,
 *     collection_address) guarantees exactly one wins and gets the raw
 *     scanned value back. Every loser is guaranteed the row now exists
 *     (a conflict only fires against an already-committed row) and falls
 *     through to a real atomic decrement, so it gets a distinct, lower
 *     value instead of reusing the winner's number.
 *
 * Known relaxation: during a RECONCILIATION (see below), multiple sales
 * concurrently due for reconciliation share one re-scan and all receive
 * that same freshly-verified absolute count, rather than strictly
 * descending per-sale values. The number itself stays accurate; only
 * per-event distinctness is relaxed for that one batch. This is
 * intentional — see "Reconciliation" below.
 *
 * ── Reconciliation (bounded drift correction) ───────────────────────────
 * "Scan once, decrement forever" is not sufficient — the counter cannot
 * see any wallet activity outside our own sale stream (see "What this
 * counter is NOT" below). A fresh authoritative DAS scan is forced,
 * replacing the stored value outright (can move the count up OR down),
 * whenever any of the following is true for a pair (checked after the
 * cheap atomic decrement, using the row's own returned metadata — no
 * extra DB round trip to decide):
 *
 *   - RECONCILE_TTL_MS elapsed since the row was last touched (covers
 *     staleness from low sale volume, backend downtime/restarts, or any
 *     other observation gap — a restart doesn't need its own special case
 *     because the persisted `updated_at` already captures the gap).
 *   - The just-decremented count is <= RECONCILE_LOW_COUNT_THRESHOLD (3,
 *     matching the frontend's own >=3 render gate exactly) — verify with
 *     a real scan BEFORE potentially hiding the badge, rather than
 *     trusting a count that may have drifted low for reasons other than
 *     genuine sales (see "What this counter is NOT").
 *   - RECONCILE_EVERY_N_DECREMENTS (25) decrements have accumulated since
 *     the last scan — bounds worst-case drift for a wallet that never
 *     dips to the low-count threshold.
 *
 * Reconciliation scans are single-flight per (seller, collection)
 * (`reconcileInflight`) so a burst of sales that all cross a trigger at
 * once still costs exactly one Helius call, preserving "no RPC per sale"
 * on the hot path even around a reconciliation event.
 *
 * Fail-closed: if a triggered reconciliation's scan fails (DAS error/
 * timeout), this call returns null — the badge simply doesn't render for
 * THIS sale — rather than surfacing the pre-reconciliation count as if it
 * had just been verified. The already-decremented DB row is left as-is
 * (durable, from the atomic decrement that ran before the reconciliation
 * check), so the next sale for the pair retries from the same due state.
 *
 * ── What this counter is NOT ────────────────────────────────────────────
 * Between reconciliations, this is a best-effort estimate derived ONLY
 * from sales we ourselves ingested — it is explicitly NOT a live-authoritative
 * read of the wallet's actual holdings. Known ways it can drift:
 *
 *   - Seller buys MORE of the collection: never observed by this counter
 *     (it only decrements on OUR OWN observed sell-side sales) — the
 *     count under-reports (too low) until the next reconciliation scan
 *     picks up the real total.
 *   - Seller receives a transfer/gift/airdrop of the collection: same as
 *     above — under-reports until reconciliation.
 *   - A sale this backend missed (listener downtime, an RPC gap not
 *     healed by the AMM poller in time, a parser that doesn't cover that
 *     instruction): the real holding is LOWER than what we show — the
 *     count over-reports until reconciliation.
 *   - DAS index lag: a reconciliation scan that runs immediately after a
 *     rapid sell burst can itself return a briefly-stale value if
 *     Helius's indexer hasn't caught up yet. Self-corrects on the NEXT
 *     reconciliation; not specially detected or retried here.
 *
 * The counter is a display aid, not a settlement-grade source of truth —
 * callers must not treat it as authoritative outside the badge UI.
 */

import { getOwnerCollectionDeepCount } from './helius-das';
import {
  atomicDecrementSellerHolding,
  seedSellerHolding,
  overwriteSellerHolding,
} from '../db/insert';

const RECONCILE_TTL_MS               = 6 * 60 * 60_000; // 6h
const RECONCILE_LOW_COUNT_THRESHOLD  = 3;                // matches the frontend's >=3 render gate
const RECONCILE_EVERY_N_DECREMENTS   = 25;

function key(seller: string, collection: string): string {
  return `${seller}|${collection}`;
}

// Per-key FIFO chains, keyed by (seller, collection) — NOT a simple
// single-flight cache. A plain "share the in-flight promise, clear on
// resolve" cache only dedupes calls that overlap in time; concurrent
// sales for a brand-new pair can still straggle in (each doing its own
// jittery `atomicDecrementSellerHolding` round trip before ever reaching
// the scan step) widely enough to miss each other's in-flight window,
// which would trigger a second redundant Helius scan. Chaining every
// first-sight/reconcile call for a key through `prior.then(...)` instead
// makes them strictly sequential: the first call in the chain does the
// real scan; every later call in the SAME chain, by the time its turn
// arrives, finds the row the first call already wrote and simply
// decrements it — no additional scan, regardless of how staggered the
// arrivals were. This holds even for callers that show up after the
// chain has fully drained: the row is durably in Postgres by then, so
// their normal `atomicDecrementSellerHolding` at the top of
// `getAndDecrementSellerHolding` finds it directly and never reaches
// these functions at all.
//
const firstSightChains  = new Map<string, Promise<number | null>>();

function chained(
  chains: Map<string, Promise<number | null>>,
  k: string,
  work: () => Promise<number | null>,
): Promise<number | null> {
  const prior = chains.get(k) ?? Promise.resolve(null);
  const mine  = prior.then(work, work); // run `work` regardless of the prior link's outcome
  chains.set(k, mine);
  void mine.finally(() => {
    if (chains.get(k) === mine) chains.delete(k); // only the current tail clears the entry
  });
  return mine;
}

// Reconciliation uses a plain single-flight cache (not the FIFO chain
// above): unlike first-sight seeding, a reconcile scan has no "check if
// someone already did this" primitive cheaper than just re-scanning, so
// chaining it would turn N sales that simultaneously cross a reconcile
// trigger into N sequential redundant scans instead of ~1. A plain
// in-flight cache still collapses genuinely overlapping callers (the
// common case — a burst of sales crossing a trigger together); a caller
// arriving after the in-flight scan already cleared can trigger one more
// scan, which is an acceptable, bounded, self-correcting cost for a path
// that's already rare by construction (TTL / low-count / N-decrements).
const reconcileInflight = new Map<string, Promise<number | null>>();

/** First sale ever observed for (seller, collection) — or a caller that
 *  raced in while an earlier first-sight resolution for the same brand-new
 *  pair was still in flight. Queued per-key (see `chained` above) so
 *  AT MOST ONE Helius scan ever happens for a given pair's first sighting,
 *  no matter how the concurrent sales that triggered it are staggered. */
function firstSightScanAndSeed(seller: string, collection: string): Promise<number | null> {
  return chained(firstSightChains, key(seller, collection), async () => {
    // Re-check first: an earlier link in this same chain may have already
    // seeded the row, in which case this is just a normal decrement.
    const already = await atomicDecrementSellerHolding(seller, collection);
    if (already != null) return already.count;

    const { count: scanned } = await getOwnerCollectionDeepCount(seller, collection);
    if (scanned == null) return null; // fail closed — no row created; next sale retries the scan

    const seeded = await seedSellerHolding(seller, collection, scanned);
    if (seeded != null) return seeded; // we won the seed — this sale's raw scanned value stands

    // Lost the seed race outside this chain (should be rare — the chain
    // itself serializes same-key callers — but a row can also be seeded
    // by a call that already fell out of a prior, since-cleared chain).
    // The row is guaranteed to exist now, so decrement for a distinct value.
    const decremented = await atomicDecrementSellerHolding(seller, collection);
    return decremented?.count ?? null;
  });
}

async function reconcileScan(seller: string, collection: string): Promise<number | null> {
  const k = key(seller, collection);
  const live = reconcileInflight.get(k);
  if (live) return live;
  const p = (async (): Promise<number | null> => {
    const { count } = await getOwnerCollectionDeepCount(seller, collection);
    if (count == null) return null; // fail closed — row left at its pre-reconcile (already-persisted) value
    await overwriteSellerHolding(seller, collection, count);
    return count;
  })();
  reconcileInflight.set(k, p);
  try {
    return await p;
  } finally {
    reconcileInflight.delete(k);
  }
}

function reconciliationDue(row: { count: number; decrementsSinceScan: number; prevUpdatedAtMs: number }): boolean {
  return (
    Date.now() - row.prevUpdatedAtMs > RECONCILE_TTL_MS ||
    row.count <= RECONCILE_LOW_COUNT_THRESHOLD ||
    row.decrementsSinceScan >= RECONCILE_EVERY_N_DECREMENTS
  );
}

export async function getAndDecrementSellerHolding(
  seller: string,
  collection: string,
): Promise<number | null> {
  const decremented = await atomicDecrementSellerHolding(seller, collection);

  if (decremented == null) {
    // No row yet for this pair — first sight.
    return firstSightScanAndSeed(seller, collection);
  }

  if (!reconciliationDue(decremented)) {
    return decremented.count;
  }

  return reconcileScan(seller, collection);
}

// ── Module-retirement note (2026-07-15 audit) ───────────────────────────
// `seller-count-exact.ts` (the active-dumper-triggered deep-scan module)
// and its `saleEventBus.emitSellerCountUpdate` / `onSellerCountUpdate`
// wiring in `sse.ts` have been fully removed. That module wrote
// corrected counts to `sale_events` independently of this one (via
// `updateSellerRemainingCountByCollection`, called directly from its own
// bus event) — running it alongside this counter would have been a
// second, uncoordinated writer racing this module's reconciliation path
// for the same rows, able to silently overwrite a fresher value with a
// stale one depending on network timing. This module's reconciliation
// policy above (TTL / low-count / N-decrements, all fail-closed) fully
// subsumes what the old module was for, using the exact same underlying
// scan primitive (`getOwnerCollectionDeepCount`), so nothing was lost.
