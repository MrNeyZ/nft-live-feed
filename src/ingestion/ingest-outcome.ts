/**
 * Terminal-outcome taxonomy shared by every raw sale-ingest function
 * (me-raw, tensor-raw, orbis-raw) and consumed by amm-poller.ts's cursor
 * safety logic. A signature's ingestion is TERMINAL SAFE — eligible to
 * let the persisted `poller_state` cursor advance past it — once one of
 * these has actually been observed for it (never merely because work
 * was dispatched):
 *
 *   inserted            — a new sale_events row was written for this sig.
 *   duplicate           — a row for this sig already exists (ON CONFLICT
 *                          DO NOTHING, or an earlier fast-path insert);
 *                          nothing new to do, safe to consider done.
 *   confirmed_irrelevant — the tx was fetched and structurally parsed:
 *                          it is definitely not a sale (listing/cancel/
 *                          pool-admin/on-chain-failed/etc). Confirmed by
 *                          a real fetch + parse, not a log-name guess.
 *   retryable_error      — RPC failure, timeout, DB error, or any other
 *                          transient condition. NOT terminal — a later
 *                          pass must get another chance at this exact
 *                          signature.
 *
 * `retryable_error` is the ONLY non-terminal member — everything else is
 * safe to fold into a cursor advance. When in doubt (ambiguous internal
 * state, a swallowed exception whose safety can't be proven), prefer
 * `retryable_error` — an extra re-fetch is cheap and idempotent
 * (`ON CONFLICT (signature) DO NOTHING`); a silently-skipped real sale
 * is not recoverable once the cursor has moved past it.
 */
export type IngestOutcome =
  | 'inserted'
  | 'duplicate'
  | 'confirmed_irrelevant'
  | 'retryable_error';

/** True iff `outcome` is safe to fold into a cursor advance. */
export function isTerminalSafe(outcome: IngestOutcome): boolean {
  return outcome !== 'retryable_error';
}
