// ME Sell (ME Offer Accept) — pure state-machine logic (no React, no
// network, no wallet). Kept separate from page.tsx (which has no test
// framework available to it) so it can be compiled + run with plain
// tsc+node+assert, same convention as ../resize-claim/logic.ts and
// ../ghostbid/logic.ts.
//
// 2026-09-12 hardening pass (docs/me-sell-audit-2026-09-12.md): this tool
// accepts an EXISTING Magic Eden offer (Sell + ExecuteSaleV2, seller-side)
// — a real sale of a real NFT for real SOL, not a listing. This file
// replaces the pre-hardening model of
//   sendRawTransaction resolving -> "Submitted" treated as terminal
// with an explicit outcome state machine (mirrors resize-claim's RC-1) and
// exact-signature reconciliation. Unlike resize-claim, ME Sell only ever
// has ONE transaction in flight per accept attempt — there is no batching
// or multi-tx retry-narrowing fold to do here.

// ── exact price encoding (MS-2) ────────────────────────────────────────────

/** Byte-for-bit identical to src/server/tools-me-sell.ts's own
 *  `solToExactLamports` — keep both in sync if either changes. The
 *  frontend needs its own copy (no shared module between backend/frontend
 *  builds) to construct the `priceLamports` field the bridge path sends to
 *  `/audit-bridge` and `/submit-bridge`; the backend independently
 *  re-derives and byte-checks this value against the tx's own encoded
 *  price regardless (fail-closed), so a client-side mismatch here can only
 *  ever cause a false rejection, never a false acceptance. */
export function solToExactLamports(priceSol: number): string {
  const fixed = priceSol.toFixed(9);
  const [whole, frac] = fixed.split('.');
  return BigInt(whole + frac).toString();
}

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
 * What an `unresolved` accept becomes after one more `/status` check.
 *
 * Required invariant (mirrors resize-claim's logic.ts): do NOT infer "never
 * landed" merely because `getSignatureStatuses` returns null while the
 * blockhash is still valid — `safe_to_rebuild` requires BOTH "RPC has no
 * record of this signature" AND "the current blockheight has already
 * passed this tx's own lastValidBlockHeight" (the exact blockhash this
 * signature was built against is provably dead). A `processed`-but-not-
 * yet-finalized entry is never "safe to rebuild" no matter how stale the
 * blockhash looks — it was seen, so it might still land.
 *
 * A failed blockheight lookup (`currentBlockHeight === null`) fails CLOSED
 * — stays `still_unresolved` forever until a real read succeeds.
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

// ── blockhash freshness ───────────────────────────────────────────────────

/** Reused from this repo's established Candy Mint / Resize Claim safety
 *  margin (18 blocks) for consistency — no ME-Sell-specific value was
 *  derived from new measurement. */
export const BLOCKHASH_SAFETY_MARGIN_BLOCKS = 18;

export function hasBlockhashHeadroom(
  lastValidBlockHeight: number,
  currentBlockHeight: number,
  margin: number = BLOCKHASH_SAFETY_MARGIN_BLOCKS,
): boolean {
  return lastValidBlockHeight - currentBlockHeight >= margin;
}

/**
 * POST-SIGN freshness gate: given the ORIGINAL `lastValidBlockHeight` this
 * accept transaction was built against and the current blockheight re-read
 * right after `signTransaction()` returns, decides whether it may still be
 * broadcast. A Phantom approval prompt can stay open long enough for a
 * transaction that was fresh before signing to go stale by the time
 * signing actually returns — the signature does not extend the baked-in
 * blockhash's lifetime.
 *
 * Never fetches or accepts a new blockhash here — swapping it would
 * invalidate the signature already obtained. Only the comparison changes.
 *
 * Fail-CLOSED on a blockheight lookup failure (`currentBlockHeight ===
 * null`): treated as NOT safe to broadcast. This is the opposite of the
 * pre-sign check's fail-open policy — post-sign, refusing to broadcast
 * only costs one more approval later, whereas broadcasting a signed tx we
 * cannot prove still has headroom risks an unrecoverable ambiguous outcome
 * (a real sale of a real NFT either did or didn't happen, with no
 * signature to reconcile against if we never sent it).
 */
export function planPostSignBroadcast(
  items: ReadonlyArray<{ lastValidBlockHeight: number }>,
  currentBlockHeight: number | null,
  margin: number = BLOCKHASH_SAFETY_MARGIN_BLOCKS,
): boolean[] {
  return items.map((it) =>
    currentBlockHeight != null && hasBlockhashHeadroom(it.lastValidBlockHeight, currentBlockHeight, margin));
}

// ── retry classification ──────────────────────────────────────────────────

export type RetryDecision = 'exclude_confirmed' | 'rebuild_after_revalidate' | 'not_yet_retryable';

/**
 *   confirmed_success        -> excluded permanently for this attempt
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

/** Whether a fresh Build Accept attempt may be started, given the previous
 *  attempt's outcome (if any). Mirrors resize-claim's RC-2 per-item retry
 *  narrowing, collapsed to the single-item case: an `unresolved` prior
 *  attempt must block a rebuild (it might still land — rebuilding now could
 *  produce two competing sells of the same NFT with only one able to
 *  land), everything else may be revalidated and rebuilt. */
export function canRebuild(previous: TxOutcome | null): boolean {
  if (previous == null) return true;
  return retryDecision(previous) !== 'not_yet_retryable';
}

// ── UI truthfulness ────────────────────────────────────────────────────────

export type UiTxLabel =
  | 'Confirmed' | 'Failed' | 'Pending — confirmation unknown'
  | 'Expired before landing — safe to retry'
  | 'Blocked (failed safety check)' | 'Blocked (would fail on-chain)'
  | 'Not sent (blockhash went stale)' | 'Not sent (network error)';

/** Never "Failed" for an unresolved outcome; never "Confirmed" for a bare
 *  submitted signature — a real sale must not be reported done until
 *  independently confirmed. */
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

// ── frozen intent / stale-request race guard (MS-3) ────────────────────────

/** The offer facts this page must treat as fixed from the moment `Load
 *  Offer` resolves until an explicit reload — build/sign/submit must never
 *  silently re-derive these from newer component state, which is exactly
 *  the TOCTOU the audit flagged (MS-3: a price/standard could otherwise
 *  drift between what the operator reviewed and what gets signed). */
export interface FrozenOfferIntent {
  mint: string;
  buyer: string;
  auctionHouse: string;
  priceLamports: string;
  standard: 'pnft' | 'mplCore' | null;
  standardSupported: boolean;
}

/** A monotonically increasing request generation guards against a stale
 *  `loadInfo()`/`doBuild()` call (e.g. the operator changed the mint field
 *  and re-submitted before the first call returned) from painting over a
 *  newer call's result. Call `bump()` at the start of every such call, and
 *  compare the token you captured right after against `isCurrent()` before
 *  committing that call's result to state. */
export function makeGenerationGuard() {
  let current = 0;
  return {
    bump(): number { return (current += 1); },
    isCurrent(token: number): boolean { return token === current; },
  };
}
