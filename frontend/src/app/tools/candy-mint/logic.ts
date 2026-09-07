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
