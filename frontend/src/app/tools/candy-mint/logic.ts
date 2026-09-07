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
