/**
 * Per-target accepted-sale counters for the AMM poller's useful-ratio backoff.
 *
 * The ingest path (me-raw) increments these whenever it accepts a sale; the
 * amm-poller reads cumulative deltas per sweep to decide whether a target is
 * producing real sales or just burning getTransaction on parser-dropped noise.
 *
 * Kept in its own module so ingest (writer) and amm-poller (reader) don't form
 * an import cycle. Counters are cumulative since process start; the poller takes
 * snapshots and works on deltas. Zero behavior impact — pure accounting.
 *
 * Scope: only the two backoff targets (poll:me_v2, poll:mmm). The marketplace on
 * an accepted SaleEvent maps 1:1 to the poll target:
 *   magic_eden     → poll:me_v2   (ME v2 fixed-price, legacy/pNFT/core)
 *   magic_eden_amm → poll:mmm     (MMM pool fills)
 * Other marketplaces (tensor / tensor_amm) are ignored here — tcomp/tamm are
 * intentionally NOT backed off in v1.
 */

const accepted: Map<string, number> = new Map([
  ['poll:me_v2', 0],
  ['poll:mmm',   0],
]);

/** Map an accepted SaleEvent's marketplace to its backoff poll target, or null
 *  if the marketplace is out of scope for the backoff. */
function targetForMarketplace(marketplace: string): string | null {
  if (marketplace === 'magic_eden')     return 'poll:me_v2';
  if (marketplace === 'magic_eden_amm') return 'poll:mmm';
  return null;
}

/** Called from the ingest OK branch on every accepted sale. Cheap, sync. */
export function noteAcceptedSale(marketplace: string): void {
  const target = targetForMarketplace(marketplace);
  if (!target) return;
  accepted.set(target, (accepted.get(target) ?? 0) + 1);
}

/** Cumulative accepted-sale count for a backoff target since process start. */
export function getAcceptedCount(target: string): number {
  return accepted.get(target) ?? 0;
}
