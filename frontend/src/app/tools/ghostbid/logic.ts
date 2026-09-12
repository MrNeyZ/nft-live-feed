// Pure, React-free GhostBid page logic — kept separate from page.tsx (which
// has no test framework available to it) so it can be compiled + run with
// plain `tsc`+`node`+`assert`, same convention as
// src/app/tools/candy-mint/logic.ts.

/**
 * Arbitrates which of several concurrent GhostBid requests (list load or
 * refresh, for any list) is allowed to paint `result`/`error`, and which of
 * several concurrent requests of the SAME type is allowed to clear that
 * type's own loading flag.
 *
 * Two separate concerns, both real races GhostBid hits in practice:
 *
 *  1. `result`/`error` are shared between load() and refresh() — an older
 *     request of EITHER type resolving after a newer request of EITHER type
 *     must not overwrite what the newer one painted (cross-list switch,
 *     same-list double-refresh, load-vs-refresh interleaving). Gated by one
 *     monotonic counter shared across both call sites.
 *
 *  2. `busy` (load's spinner) and `refreshing` (refresh's button label) are
 *     NOT shared with each other — each must only be cleared by the most
 *     recent request of ITS OWN type. A stale load finishing after a newer
 *     load must not clear `busy` (a newer load's own completion will do
 *     that); but a load finishing after a newer, unrelated REFRESH started
 *     must still be allowed to clear `busy` — a refresh starting doesn't
 *     supersede a load in flight. Tracked with two extra "latest gen of
 *     this type" fields, independent of the shared counter's current value.
 */
export class GhostBidRequestArbiter {
  private counter = 0;
  private latestLoad = 0;
  private latestRefresh = 0;

  /** Call at the start of load(). Returns this request's generation. */
  beginLoad(): number {
    const gen = ++this.counter;
    this.latestLoad = gen;
    return gen;
  }

  /** Call at the start of refresh(). Returns this request's generation. */
  beginRefresh(): number {
    const gen = ++this.counter;
    this.latestRefresh = gen;
    return gen;
  }

  /** True if `gen` is still the most recently STARTED request overall
   *  (load or refresh) — gates writes to the shared `result`/`error` state. */
  isLatestOverall(gen: number): boolean {
    return gen === this.counter;
  }

  /** True if `gen` is still the most recently started LOAD — gates
   *  clearing `busy`. */
  isLatestLoad(gen: number): boolean {
    return gen === this.latestLoad;
  }

  /** True if `gen` is still the most recently started REFRESH — gates
   *  clearing `refreshing`. */
  isLatestRefresh(gen: number): boolean {
    return gen === this.latestRefresh;
  }
}

/**
 * PROFIT's floor half (GB-2): the dataset's `floorSol` values are a static
 * offline snapshot and "Refresh" only re-checks escrow/activity, never
 * floor. `snapshotAt` (unix ms mtime of that list's dataset file, from the
 * backend) is the only honest signal of how old that snapshot is — this
 * turns it into the exact caption shown near the PROFIT column/controls.
 * No live floor is ever fetched here; this only describes what's already
 * true of the data GhostBid already has.
 */
export function floorSnapshotCaption(snapshotAt: number | null | undefined): string {
  if (!snapshotAt || !Number.isFinite(snapshotAt)) {
    return 'Profit uses stored floor snapshot. Refresh updates escrow/activity only, not floor.';
  }
  const date = new Date(snapshotAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Profit uses floor snapshot from ${date}. Refresh updates escrow/activity only.`;
}
