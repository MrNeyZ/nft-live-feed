// Resize Claim — pure state-machine logic (no React, no network, no wallet).
// Kept separate from page.tsx (which has no test framework available to it)
// so it can be compiled + run with plain tsc+node+assert, same convention as
// ../candy-mint/logic.ts and ../ghostbid/logic.ts.
//
// This file replaces the pre-hardening model of
//   sendTransaction returned a signature -> "Done"
// with an explicit per-transaction outcome state machine (RC-1), safe
// per-item retry narrowing (RC-2), and exact-signature reconciliation.

export type TxKind = 'claim' | 'resize';

/** One built-and-tracked transaction. `mints` are the item(s) this ONE
 *  atomic transaction covers — 1 for a claim, up to RESIZES_PER_TX for a
 *  packed resize batch. `blockhash`/`lastValidBlockHeight` come from the
 *  SAME /build response this tx was compiled in (build.ts uses one
 *  getLatestBlockhash call per request, shared by every tx it returns) —
 *  retained here so freshness/expiry can be judged without re-deriving it
 *  from anything in the UI later. */
export interface TrackedTx {
  index: number;
  kind: TxKind;
  mints: string[];
  txBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Explicit per-transaction outcome. `sendTransaction` returning a signature
 * means SUBMITTED, not SUCCESS — there is deliberately no "done"/"success"
 * value reachable straight from a send call; `unresolved` is the only state
 * a fresh signature can occupy until a `/status` poll proves otherwise.
 */
export type TxOutcome =
  | { kind: 'audit_failed'; reason: string }
  | { kind: 'simulation_failed'; err: unknown }
  | { kind: 'stale_before_broadcast' }
  | { kind: 'send_failed'; reason: string }
  | { kind: 'unresolved'; signature: string }
  | { kind: 'confirmed_success'; signature: string }
  | { kind: 'confirmed_failure'; signature: string; err: unknown }
  | { kind: 'expired_no_signature_seen'; signature: string };

export interface SignatureStatusEntry {
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  err: unknown;
}

// ── confirmation classification ──────────────────────────────────────────

export type ConfirmClass = 'success' | 'failed' | 'pending';

/** `processed` (seen but not yet confirmed) and "RPC has no record at all"
 *  are deliberately the SAME class here (`pending`) — only
 *  `confirmed`/`finalized` are definitive. Distinguishing "seen-but-early"
 *  from "never-seen" is `reconcileUnresolved`'s job (it needs the
 *  blockheight too), not this function's. */
export function classifyStatus(entry: SignatureStatusEntry | null): ConfirmClass {
  if (!entry) return 'pending';
  if (entry.confirmationStatus === 'confirmed' || entry.confirmationStatus === 'finalized') {
    return entry.err == null ? 'success' : 'failed';
  }
  return 'pending';
}

export const CONFIRMATION_BUDGET_MS = 35_000;
export const CONFIRMATION_POLL_INTERVAL_MS = 2_000;

export function shouldKeepPolling(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs < CONFIRMATION_BUDGET_MS;
}

export type ReconcileDisposition = 'still_success' | 'still_failed' | 'still_unresolved' | 'safe_to_rebuild';

/**
 * What an `unresolved` item becomes after one more `/status` check, once
 * the confirmation-budget window has already expired.
 *
 * Required invariant (spec): do NOT infer "never landed" merely because
 * `getSignatureStatuses` returns null while the blockhash is still valid —
 * `safe_to_rebuild` requires BOTH "RPC has no record of this signature"
 * AND "the current blockheight has already passed this tx's own
 * lastValidBlockHeight" (i.e. the exact blockhash this signature was built
 * against is provably dead, so it structurally cannot land later). A
 * `processed`-but-not-yet-finalized entry is never "safe to rebuild" no
 * matter how stale the blockhash looks — it was seen, so it might still land.
 *
 * A failed blockheight lookup (`currentBlockHeight === null`) fails CLOSED
 * — stays `still_unresolved` forever until a real read succeeds, never
 * `safe_to_rebuild`.
 */
export function reconcileUnresolved(
  entry: SignatureStatusEntry | null,
  currentBlockHeight: number | null,
  lastValidBlockHeight: number,
): ReconcileDisposition {
  const cls = classifyStatus(entry);
  if (cls === 'success') return 'still_success';
  if (cls === 'failed') return 'still_failed';
  if (currentBlockHeight == null) return 'still_unresolved';
  if (entry == null && currentBlockHeight > lastValidBlockHeight) return 'safe_to_rebuild';
  return 'still_unresolved';
}

// ── blockhash freshness (pre-broadcast) ──────────────────────────────────

/** Reused from this repo's established Candy Mint safety margin (18
 *  blocks) for consistency — this pass did not derive a resize-claim-
 *  specific value from new measurement, and the spec explicitly allows
 *  reusing the established constant when a different one isn't justified. */
export const BLOCKHASH_SAFETY_MARGIN_BLOCKS = 18;

export function hasBlockhashHeadroom(
  lastValidBlockHeight: number,
  currentBlockHeight: number,
  margin: number = BLOCKHASH_SAFETY_MARGIN_BLOCKS,
): boolean {
  return lastValidBlockHeight - currentBlockHeight >= margin;
}

/**
 * POST-SIGN freshness gate (the fix for the blockhash-lifecycle bug this
 * function exists to close): given the ORIGINAL `lastValidBlockHeight` of
 * each already-signed transaction and the current blockheight re-read right
 * after `signAllTransactions()` returns, decides — independently per item —
 * whether it may still be broadcast.
 *
 * Never fetches or accepts a new blockhash here; a signed transaction's
 * blockhash is baked into what Phantom already signed, and swapping it
 * would invalidate that signature. Only the comparison changes.
 *
 * Fail-CLOSED on a blockheight lookup failure (`currentBlockHeight ===
 * null`): every item in `items` is treated as NOT safe to broadcast. This
 * is the opposite of the pre-sign check's fail-open policy (see page.tsx's
 * comment for why: post-sign, refusing to broadcast only costs one more
 * approval, while broadcasting a signed tx we cannot prove still has
 * headroom risks an unrecoverable ambiguous outcome).
 *
 * Order and length are preserved exactly (`items[k]` <-> `result[k]`) so a
 * caller can zip this straight back against its own parallel `signed`/
 * tracked-index arrays without any renumbering.
 */
export function planPostSignBroadcast(
  items: ReadonlyArray<{ lastValidBlockHeight: number }>,
  currentBlockHeight: number | null,
  margin: number = BLOCKHASH_SAFETY_MARGIN_BLOCKS,
): boolean[] {
  return items.map((it) =>
    currentBlockHeight != null && hasBlockhashHeadroom(it.lastValidBlockHeight, currentBlockHeight, margin));
}

// ── retry narrowing (RC-2) ────────────────────────────────────────────────

export type RetryDecision = 'exclude_confirmed' | 'rebuild_after_revalidate' | 'not_yet_retryable';

/**
 * Per-outcome retry classification (spec §6):
 *   confirmed_success        -> excluded permanently for this run
 *   confirmed_failure        -> may be rebuilt, but only after revalidation
 *   audit/sim/stale/send-fail-> safe to rebuild after revalidation (never sent, or never landed)
 *   expired_no_signature_seen-> safe to rebuild after revalidation (reconcile already proved it dead)
 *   unresolved                -> MUST NOT be rebuilt yet (still might land)
 */
export function retryDecision(outcome: TxOutcome): RetryDecision {
  switch (outcome.kind) {
    case 'confirmed_success':
      return 'exclude_confirmed';
    case 'unresolved':
      return 'not_yet_retryable';
    case 'audit_failed':
    case 'simulation_failed':
    case 'stale_before_broadcast':
    case 'send_failed':
    case 'confirmed_failure':
    case 'expired_no_signature_seen':
      return 'rebuild_after_revalidate';
  }
}

export interface RetryPlan {
  /** landed successfully this run — never touch again. */
  confirmedMints: Set<string>;
  /** safe to revalidate-then-rebuild. */
  retryCandidateMints: Set<string>;
  /** still unresolved — must not be retried yet (offer a re-check instead). */
  blockedMints: Set<string>;
}

/** Folds a batch of {mints, outcome} (one entry per TRACKED TX — a tx's
 *  outcome applies to every mint it covered, since it's one atomic
 *  transaction) into the three retry buckets. This is the ONLY input
 *  `handleClaimAll`'s retry path may use to decide what to rebuild — never
 *  the original, un-narrowed scan. */
export function planRetry(entries: ReadonlyArray<{ mints: readonly string[]; outcome: TxOutcome }>): RetryPlan {
  const confirmedMints = new Set<string>();
  const retryCandidateMints = new Set<string>();
  const blockedMints = new Set<string>();
  for (const { mints, outcome } of entries) {
    const decision = retryDecision(outcome);
    for (const m of mints) {
      if (decision === 'exclude_confirmed') confirmedMints.add(m);
      else if (decision === 'rebuild_after_revalidate') retryCandidateMints.add(m);
      else blockedMints.add(m);
    }
  }
  return { confirmedMints, retryCandidateMints, blockedMints };
}

// ── UI truthfulness (§14) ─────────────────────────────────────────────────

export type UiTxLabel =
  | 'Confirmed' | 'Failed' | 'Pending — confirmation unknown'
  | 'Expired before landing — safe to retry'
  | 'Blocked (failed safety check)' | 'Blocked (would fail on-chain)'
  | 'Not sent (blockhash went stale)' | 'Not sent (network error)';

/** Never "Failed" for an unresolved outcome; never "Confirmed" for a bare
 *  submitted signature — see each branch's comment in TxOutcome above. */
export function uiLabel(outcome: TxOutcome): UiTxLabel {
  switch (outcome.kind) {
    case 'confirmed_success': return 'Confirmed';
    case 'confirmed_failure': return 'Failed';
    case 'unresolved': return 'Pending — confirmation unknown';
    case 'expired_no_signature_seen': return 'Expired before landing — safe to retry';
    case 'audit_failed': return 'Blocked (failed safety check)';
    case 'simulation_failed': return 'Blocked (would fail on-chain)';
    case 'stale_before_broadcast': return 'Not sent (blockhash went stale)';
    case 'send_failed': return 'Not sent (network error)';
  }
}
