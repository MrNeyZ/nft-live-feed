// Pure, framework-free logic for the Candy Mint tool — extracted from
// page.tsx so the risky bits (tx-confirmation classification, guard-group
// auto-selection, Inspect eligibility, token-payment formatting) are unit
// testable without React. Same convention as
// frontend/src/app/feed/lib/sale-kind.ts + its .test.ts.
//
// Compile + run the tests:
//   npx tsc src/app/tools/candy-mint/logic.ts src/app/tools/candy-mint/logic.test.ts \
//     --outDir /tmp/cm --module commonjs --target es2020 --esModuleInterop \
//     --strict --skipLibCheck && node /tmp/cm/logic.test.js

// ── transaction confirmation ────────────────────────────────────────────────
// The backend /tools/mmm-pools/tx-status response, exactly as returned by
// getSignatureStatuses(searchTransactionHistory). `err` is Solana's raw
// TransactionError (an object like { InstructionError: [i, { Custom: n }] })
// or null.
export interface TxStatusResponse {
  ok?: boolean;
  found?: boolean;
  confirmationStatus?: string | null;
  err?: unknown;
}

export type ConfirmClass = 'success' | 'failed' | 'pending';

// A single poll's verdict. `confirmed`/`finalized` with err==null is the ONLY
// success. `confirmed`/`finalized` with a non-null err is a landed-but-failed
// transaction (reverted, or a guard hard-error) and must NOT count as a mint.
// Anything else — not found yet, only `processed`, an RPC/network miss — is
// still pending.
export function classifyConfirmation(d: TxStatusResponse | null | undefined): ConfirmClass {
  if (!d || d.ok !== true || d.found !== true) return 'pending';
  if (d.confirmationStatus !== 'confirmed' && d.confirmationStatus !== 'finalized') return 'pending';
  return d.err == null ? 'success' : 'failed';
}

export type ConfirmOutcome = 'success' | 'failed' | 'unknown';

// Fold a sequence of poll verdicts into a terminal outcome: the first
// terminal poll wins; if every poll stayed `pending` (the caller exhausted
// its attempt budget), the outcome is `unknown` — a submitted transaction
// whose fate we could not establish. `unknown` is a failure for UI purposes
// (never shown as "Minted", never bumps a counter) but is reported
// distinctly from a known on-chain failure.
export function outcomeFromPolls(polls: ConfirmClass[]): ConfirmOutcome {
  for (const p of polls) {
    if (p === 'success') return 'success';
    if (p === 'failed') return 'failed';
  }
  return 'unknown';
}

// ── confirmation polling budget (M3) ─────────────────────────────────────────
// The old loop was `15 attempts × 300ms` ≈ 4.2s of wall time — commit
// 7d6f12e cut it from the prior ~12s while its message claimed "same budget".
// On a congested drop (exactly when this tool is used) `confirmed` routinely
// takes longer than 4s, so that ceiling turned real mints into `unknown` far
// too often, and `unknown` feeds the duplicate-retry path.
//
// Now: an ELAPSED-TIME budget. Poll at a brisk interval but keep going until
// ~35s have passed. A timeout is still `unknown` (never `failed`) and enters
// the exact-signature reconciliation flow.
export const CONFIRMATION_BUDGET_MS = 35_000;
export const CONFIRMATION_POLL_INTERVAL_MS = 500;

export function shouldKeepPolling(startedAtMs: number, nowMs: number, budgetMs = CONFIRMATION_BUDGET_MS): boolean {
  return nowMs - startedAtMs < budgetMs;
}

// ── exact-signature reconciliation (H2) ─────────────────────────────────────
// For a submitted transaction whose landing we never observed, "getSignature
// Statuses == null" is NOT on its own proof that a rebuild is safe — the
// original may still be within its blockhash validity window and could land
// after we rebuild, double-minting. Reconciliation combines the exact
// signature's status with a fresh block-height read against the tx's OWN
// retained lastValidBlockHeight. No wallet history, no getSignaturesForAddress.
export type ReconcileDisposition =
  // observed landed, err == null -> verify the asset, never rebuild this item
  | 'landed_ok'
  // observed landed, err != null -> definitive on-chain failure, rebuild is safe
  | 'landed_failed'
  // not landed, but blockHeight <= lastValidBlockHeight -> the original can
  // STILL land. Stay unresolved. DO NOT rebuild / resend.
  | 'still_valid_ambiguous'
  // not landed, blockHeight > lastValidBlockHeight -> the original can never
  // land now. Mark expired; rebuild is safe.
  | 'expired_safe_to_retry'
  // the block-height read itself failed -> we cannot prove the original is
  // dead. Fail CLOSED for duplicate prevention: stay unresolved, DO NOT
  // rebuild. (This is deliberately independent of the pre-broadcast freshness
  // guard's fail-OPEN policy — see page.tsx.)
  | 'unresolved_blockheight_unknown';

export interface ReconcileInput {
  statusClass: ConfirmClass;             // classifyConfirmation() of the exact-signature poll
  currentBlockHeight: number | null;     // fresh getBlockHeight, null on read failure
  lastValidBlockHeight: number;          // retained from the exact build that was signed
}

export function classifyReconcile(input: ReconcileInput): ReconcileDisposition {
  if (input.statusClass === 'success') return 'landed_ok';
  if (input.statusClass === 'failed') return 'landed_failed';
  // statusClass === 'pending' (never observed landed)
  if (input.currentBlockHeight == null) return 'unresolved_blockheight_unknown';
  return input.currentBlockHeight > input.lastValidBlockHeight
    ? 'expired_safe_to_retry'
    : 'still_valid_ambiguous';
}

// Whether a rebuild/retry is permitted for an item after reconciliation.
// The three "still might land / can't tell" dispositions are all NO.
export function reconcileAllowsRebuild(d: ReconcileDisposition): boolean {
  return d === 'landed_failed' || d === 'expired_safe_to_retry';
}

// A retained record of one submitted-but-unresolved transaction. Enough to
// reconcile its EXACT signature later, and to know which asset to verify if
// it turns out to have landed.
export interface UnresolvedTx {
  signature: string;
  lastValidBlockHeight: number;
  asset: string;                 // the FINAL build's asset/nftMint pubkey
  family: 'core' | 'legacy';
}

// Duplicate-prevention gate (H2): while ANY unresolved transaction exists,
// a blind fresh Mint is not allowed (it could duplicate one that still
// lands). The user must run "Re-check unresolved" first — which either
// resolves them or proves they're dead.
export function hasUnresolvedTxns(items: ReadonlyArray<{ unresolved?: UnresolvedTx | null }>): boolean {
  return items.some((it) => it.unresolved != null);
}

// ── Re-check-unresolved fold (H2 + H1) — idempotency-critical ──────────────
// One reconcile pass produces a per-signature verdict. This folds the whole
// set into the next UI state + how many counter bumps to apply.
//
// IDEMPOTENCY: a signature is bump-eligible ONLY on the pass that first sees
// `verdict: 'minted'`, and that pass drops it from `stillUnresolved` — so the
// flow resolves and `collectUnresolved` returns [], and a further Re-check is
// a no-op (the caller returns early on an empty set). A signature can
// therefore bump the counter AT MOST ONCE across any number of Re-checks.
export type ReconcileMintVerdict = 'minted' | 'tax_no_mint' | 'not_observed';

export interface OneReconcileResult {
  u: UnresolvedTx;
  disp: ReconcileDisposition;
  // present only when disp === 'landed_ok' (the asset was checked)
  mintVerdict?: ReconcileMintVerdict | null;
}

export interface ReconcileFold {
  stillUnresolved: UnresolvedTx[];   // gate stays closed while non-empty
  bumps: string[];                   // signatures that just became confirmed mints (bump once each)
  resolvedFailed: string[];          // safe-to-retry now (landed-failed / expired / bot-tax)
  notes: string[];                   // per-signature human summary
}

export function foldReconcileResults(results: readonly OneReconcileResult[]): ReconcileFold {
  const stillUnresolved: UnresolvedTx[] = [];
  const bumps: string[] = [];
  const resolvedFailed: string[] = [];
  const notes: string[] = [];
  const shortSig = (s: string) => (s.length <= 10 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`);

  for (const { u, disp, mintVerdict } of results) {
    const s = shortSig(u.signature);
    if (disp === 'landed_ok' && mintVerdict === 'minted') {
      bumps.push(u.signature); notes.push(`${s}: minted`);
    } else if (disp === 'landed_ok' && mintVerdict === 'tax_no_mint') {
      resolvedFailed.push(u.signature); notes.push(`${s}: landed, bot-tax confirmed in logs — no asset`);
    } else if (disp === 'landed_ok') {
      stillUnresolved.push(u); notes.push(`${s}: landed, mint not confirmed yet — re-check`);
    } else if (disp === 'landed_failed') {
      resolvedFailed.push(u.signature); notes.push(`${s}: reverted on-chain — safe to retry`);
    } else if (disp === 'expired_safe_to_retry') {
      resolvedFailed.push(u.signature); notes.push(`${s}: expired, never landed — safe to retry`);
    } else if (disp === 'still_valid_ambiguous') {
      stillUnresolved.push(u); notes.push(`${s}: still valid — could still land, not retrying`);
    } else {
      stillUnresolved.push(u); notes.push(`${s}: block height unavailable — not retrying`);
    }
  }
  return { stillUnresolved, bumps, resolvedFailed, notes };
}

// Best-effort human string for a landed-but-failed transaction's raw
// TransactionError. Candy Guard surfaces its own AnchorError codes here;
// 6023/6024 are the date-window guards (MintNotLive / AfterEndDate) which is
// the failure this tool races against most often. Everything else falls back
// to a truncated dump rather than pretending to know.
export function normalizeMintErr(err: unknown): string {
  if (err == null) return 'Mint transaction failed on-chain.';
  let s: string;
  try { s = typeof err === 'string' ? err : JSON.stringify(err); } catch { return 'Mint transaction failed on-chain.'; }
  if (/\b6024\b/.test(s)) return 'Mint stage had already ended when the transaction landed.';
  if (/\b6023\b/.test(s)) return 'Mint stage was not live yet when the transaction landed.';
  if (/\b6033\b/.test(s)) return 'This wallet is not on the allowed address list for this mint (address gate).';
  if (/InsufficientFundsForRent|insufficient lamports|InsufficientFunds/i.test(s)) return 'Not enough SOL when the transaction landed.';
  return `Mint transaction failed on-chain (${s.length > 140 ? `${s.slice(0, 140)}…` : s}).`;
}

// ── guard-group auto-selection ─────────────────────────────────────────────
// Returned value is the label to put in `selectedGroup` state:
//   string     — a labelled group
//   null       — the root (groupless) guard set, which is a real selectable value
//   undefined  — nothing to select (no groups at all; only happens on a
//                closed machine, where the mint control isn't rendered anyway)
//
// One-group machines select that group even when unsupported, so the UI can
// render *why* it can't be minted instead of a dead hero. Multi-group
// machines prefer the first supported group, else fall back to the first
// group so its unsupported reason is on screen.
export function pickInitialGroup(
  groups: ReadonlyArray<{ label: string | null; supported: boolean }>,
): string | null | undefined {
  if (groups.length === 0) return undefined;
  if (groups.length === 1) return groups[0].label;
  const firstSupported = groups.find((g) => g.supported);
  return (firstSupported ?? groups[0]).label;
}

// ── Inspect eligibility ───────────────────────────────────────────────────
// One predicate for both the button's `disabled` and the inputs' Enter-key
// handler, so keyboard and click can't drift apart again.
export function inspectDisabled(busy: boolean, sig: string): boolean {
  return busy || sig.trim().length === 0;
}

// ── token payment ─────────────────────────────────────────────────────────
export interface TokenPaymentView {
  mint: string;
  amount: string;            // raw on-chain integer, as a decimal string
  destinationAta: string;
  decimals: number | null;   // resolved server-side; null = unresolved
  kind: 'spl' | 'token2022';
}

export function shortMint(mint: string): string {
  return mint.length <= 9 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

// Raw integer + decimals -> human string, using string math so a large
// u64 can't lose precision through a float. `decimals == null` (unresolved)
// -> show the raw integer, which is still truthful.
export function formatTokenAmount(rawAmount: string, decimals: number | null): string {
  if (decimals == null || !Number.isFinite(decimals) || decimals < 0) return rawAmount;
  const neg = rawAmount.trim().startsWith('-');
  const digits = (neg ? rawAmount.trim().slice(1) : rawAmount.trim()).replace(/\D/g, '') || '0';
  if (decimals === 0) return (neg ? '-' : '') + (digits.replace(/^0+(?=\d)/, ''));
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
}

// Just the token leg, human-formatted (`<amount> <shortMint>`), for the
// pre-signature cost line where the SOL delta is shown separately and does
// NOT include an SPL spend. Null when the group has no token payment.
export function tokenCostLabel(
  tp: Pick<TokenPaymentView, 'mint' | 'amount' | 'decimals'> | null,
): string | null {
  if (!tp) return null;
  return `${formatTokenAmount(tp.amount, tp.decimals)} ${shortMint(tp.mint)}`;
}

// ── batch rebuild (Option B: rebuild-before-sign blockhash freshness) ─────
// Phase 1 (build+simulate) only proves the mint is *satisfiable*; its built
// transaction is discarded. Right before the single signAllTransactions,
// every still-ready item is rebuilt (bounded concurrency) for a fresh
// blockhash. Rebuild is otherwise a no-op on transaction contents — see
// the investigation: two independent builds of the same input differ in
// exactly the recentBlockhash and the fresh asset/nftMint pubkey Umi's
// generateSigner() creates per build. That pubkey is the ACTUAL address
// that will be minted, and it must be threaded through everywhere a mint
// identity is shown or recorded — never the discarded phase-1 one (which
// this module never even receives, so it structurally can't leak back in).
export interface RebuildOutcome {
  itemIndex: number;
  ok: boolean;
  transactionBase64?: string;
  mint?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  error?: string;
}

// Bounded-concurrency worker pool. Used for the rebuild wave (measured:
// full-parallel vs bounded(5) differ by ~89ms at 25 items — bounded
// concurrency costs almost nothing here while keeping RPC load predictable).
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

// Splits a rebuild wave's outcomes into what's safe to hand to
// signAllTransactions (in original submission order, matching
// `readyIndexes`) vs what failed to rebuild. `signableItemIndexes[k]`
// corresponds to `signableTxs[k]` — the exact mapping signAllAndSend's
// onSubmitted(position, signature) callback needs to update the right
// BatchItem, and each entry carries ITS OWN rebuild's `mint`, so the
// actual minted address is always sourced from the outcome that produced
// the transaction actually being signed, not from phase 1.
export function partitionRebuildResults(
  readyIndexes: readonly number[],
  outcomes: readonly RebuildOutcome[],
): { signableItemIndexes: number[]; signableTxs: string[]; failed: RebuildOutcome[] } {
  const byIndex = new Map(outcomes.map((o) => [o.itemIndex, o]));
  const signableItemIndexes: number[] = [];
  const signableTxs: string[] = [];
  const failed: RebuildOutcome[] = [];
  for (const i of readyIndexes) {
    const o = byIndex.get(i);
    if (o?.ok && o.transactionBase64) {
      signableItemIndexes.push(i);
      signableTxs.push(o.transactionBase64);
    } else if (o) {
      failed.push(o);
    }
  }
  return { signableItemIndexes, signableTxs, failed };
}

// ── post-sign block-height guard ──────────────────────────────────────────
// A conservative safety MARGIN (blocks), not a landing guarantee — see the
// investigation: real measured decay was ~317ms/block just now, so ~18
// blocks is ~5.7s of buffer against the sequential send loop and any last
// stretch of user delay between signing and send. Explicit and adjustable
// in one place.
export const BLOCKHASH_SAFETY_MARGIN_BLOCKS = 18;

export function hasBlockhashHeadroom(
  lastValidBlockHeight: number,
  currentBlockHeight: number,
  marginBlocks: number = BLOCKHASH_SAFETY_MARGIN_BLOCKS,
): boolean {
  return lastValidBlockHeight - currentBlockHeight >= marginBlocks;
}

// Generic "try once, wait, try again" retry — the shape `page.tsx`'s
// fetchCurrentBlockHeight uses for the guard's block-height read: a single
// transient RPC blip shouldn't make the guard fail open for the whole rest
// of the batch (see the send-loop investigation — a real retry is cheap
// relative to the send loop's own budget). Returns the first non-null
// result; null only if BOTH attempts return null or throw. `attempt`'s own
// network/parsing details live in the caller — this only owns the "try,
// wait, try again" contract, which is what's actually risky to get right
// (and, unlike the network call itself, is unit-testable without mocking
// fetch).
export async function retryOnce<T>(
  attempt: () => Promise<T | null>,
  delayMs: number,
): Promise<T | null> {
  const first = await attempt().catch(() => null);
  if (first != null) return first;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return attempt().catch(() => null);
}

// The headline price for a guard group. Shows SOL and/or token, joined —
// never silently drops the non-SOL leg. `solLamports === '0'` renders as
// "0 SOL" (a real free-mint signal), any other value to 3dp.
export function buildPriceLabel(
  solLamports: string | null,
  tokenPayment: Pick<TokenPaymentView, 'mint' | 'amount' | 'decimals'> | null,
): string | null {
  const parts: string[] = [];
  if (solLamports != null) {
    const sol = Number(solLamports) / 1e9;
    parts.push(`${sol.toFixed(solLamports === '0' ? 0 : 3)} SOL`);
  }
  if (tokenPayment) {
    parts.push(`${formatTokenAmount(tokenPayment.amount, tokenPayment.decimals)} ${shortMint(tokenPayment.mint)}`);
  }
  return parts.length > 0 ? parts.join(' + ') : null;
}
