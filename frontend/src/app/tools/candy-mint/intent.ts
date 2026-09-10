// Candy Mint — the single frozen mint intent for one attempt.
//
// Captured once, at the moment the user commits to a mint (clicks Mint /
// confirms the review), from the currently-inspected machine + selected
// group. EVERYTHING downstream — the final fresh rebuild, the final
// simulation, the structural audit, the post-sign wallet check — reads from
// this object, never from live React state. A later inspect refresh, group
// re-pick, wallet reconnect, or quantity change cannot silently widen or
// substitute what gets built and signed: it can only be applied by starting
// a new attempt (which freezes a new intent).
//
// This is not a new architecture — it is a plain value object threaded
// through the existing single/batch handlers.

export interface TokenPay {
  mint: string;
  amount: string;         // raw on-chain integer, decimal string
  destinationAta: string;
  kind: 'spl' | 'token2022';
}

// The COMPLETE user-authorized MINT PAYMENT for a guard group — every
// payment-affecting guard's amounts + destinations. Mirrors the backend's
// `PaymentGuardConfig` (guard-config.ts). This is a mint-PRICE authorization:
// it does NOT include transaction fee / priority / account rent (protocol
// overhead the user does not individually authorize).
export interface PaymentAuthorization {
  solPaymentLamports: string | null;
  solPaymentDestination: string | null;
  solFixedFeeLamports: string | null;
  solFixedFeeDestination: string | null;
  freezeSolPaymentLamports: string | null;
  freezeSolPaymentDestination: string | null;
  tokenPayment: TokenPay | null;
  freezeTokenPayment: TokenPay | null;
  addressGateAddress: string | null;
}

// The backend echoes this back from its FRESH read of live guard state on the
// FINAL build (build.ts `resolvedGuardPayment`). Identical shape.
export type ResolvedGuardPayment = PaymentAuthorization;

export interface FrozenMintIntent {
  // ── identity / target ──────────────────────────────────────────────────
  wallet: string;                        // connected wallet at freeze time = fee payer = minter = recipient
  family: 'core' | 'legacy';
  candyMachine: string;
  candyGuard: string;
  collection: string;
  collectionUpdateAuthority: string | null; // legacy only; null => backend resolves live
  group: string | null;                  // selected guard group label (null = root)
  quantity: number;                      // how many the user authorized this attempt

  // ── payment authorization (from the reviewed guard config) ─────────────
  // Re-checked EXACTLY against the FINAL build's fresh guard read before
  // signing (paymentAuthorizationMatches). The structural auditor also pins
  // every destination here as an account of the built guard instruction.
  payment: PaymentAuthorization;

  enabledGuards: string[];               // reviewed guard names (informational + audit sanity)
}

export function emptyPayment(): PaymentAuthorization {
  return {
    solPaymentLamports: null, solPaymentDestination: null,
    solFixedFeeLamports: null, solFixedFeeDestination: null,
    freezeSolPaymentLamports: null, freezeSolPaymentDestination: null,
    tokenPayment: null, freezeTokenPayment: null, addressGateAddress: null,
  };
}

// Everything the auditor / final-build path needs to authorize a mint,
// pulled from the inspected machine + selected group. `quantity` is what the
// user set on the stepper. Returns null when a required field is missing
// (no wallet, no collection, no group) — the caller must not proceed.
export function freezeMintIntent(input: {
  wallet: string | null;
  family: 'core' | 'legacy';
  candyMachine: string;
  candyGuard: string;
  collection: string | null;
  collectionUpdateAuthority: string | null;
  group: string | null | undefined;
  quantity: number;
  selectedGroup: {
    label: string | null;
    payment: PaymentAuthorization;
    enabledGuards: string[];
  } | null;
}): FrozenMintIntent | null {
  if (!input.wallet || !input.collection || input.group === undefined || !input.selectedGroup) return null;
  const g = input.selectedGroup;
  return {
    wallet: input.wallet,
    family: input.family,
    candyMachine: input.candyMachine,
    candyGuard: input.candyGuard,
    collection: input.collection,
    collectionUpdateAuthority: input.collectionUpdateAuthority,
    group: g.label,
    quantity: Math.max(1, Math.floor(input.quantity)),
    payment: g.payment ?? emptyPayment(),
    enabledGuards: g.enabledGuards ?? [],
  };
}

// The /build-tx request body derived from a frozen intent. The SAME body is
// used for the initial (pre-check) build and the FINAL fresh rebuild — the
// only thing that changes between them is server-side ephemeral identity
// (blockhash + generated asset keypair).
export function buildTxBody(intent: FrozenMintIntent, wallet: string): {
  family: string; candyMachine: string; candyGuard: string; collection: string;
  collectionUpdateAuthority: string | null; group: string | null; wallet: string;
} {
  return {
    family: intent.family,
    candyMachine: intent.candyMachine,
    candyGuard: intent.candyGuard,
    collection: intent.collection,
    collectionUpdateAuthority: intent.collectionUpdateAuthority,
    group: intent.group,
    wallet,
  };
}

// Every SOL/token destination the reviewed config authorizes the mint to
// pay. Used by the auditor for positive containment (each MUST appear as an
// account of the built guard instruction).
export function paymentDestinations(pay: PaymentAuthorization): string[] {
  const out: string[] = [];
  for (const d of [pay.solPaymentDestination, pay.solFixedFeeDestination, pay.freezeSolPaymentDestination]) {
    if (d) out.push(d);
  }
  if (pay.tokenPayment?.destinationAta) out.push(pay.tokenPayment.destinationAta);
  if (pay.freezeTokenPayment?.destinationAta) out.push(pay.freezeTokenPayment.destinationAta);
  return out;
}

export function intentPaymentDestinations(intent: FrozenMintIntent): string[] {
  return paymentDestinations(intent.payment);
}

// Canonical (sorted, unique) guard-name set — so two views of the same
// on-chain guard config compare equal regardless of order. Mirrors the
// backend's `canonicalGuardNames`.
export function canonicalGuards(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

// EXACT set equality between the FROZEN reviewed enabled-guard set and the
// set the FINAL build actually resolved from live guard state
// (`resolvedEnabledGuards`). This is the guard-set counterpart to
// paymentAuthorizationMatches, and is required IN ADDITION to the auditor's
// remaining-account-count check — the count cannot distinguish a same-count
// swap (mintLimit↔allocation) or a 0-remaining-account guard being added or
// removed (botTax / startDate / endDate / redeemedAmount / addressGate).
//   added guard      -> reject
//   removed guard    -> reject
//   substituted guard-> reject
//   same set, different order -> accept (after canonicalization)
export function guardSetMatches(
  reviewed: readonly string[],
  resolved: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const a = canonicalGuards(reviewed);
  const b = canonicalGuards(resolved);
  if (a.length === b.length && a.every((g, i) => g === b[i])) return { ok: true };
  const added = b.filter((g) => !a.includes(g));
  const removed = a.filter((g) => !b.includes(g));
  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  return { ok: false, reason: parts.join('; ') || 'guard set differs' };
}

// EXACT equality between the FROZEN reviewed mint-payment authorization and
// what the FINAL build actually resolved from live guard state. This is a
// mint-PRICE check — every amount + destination (SOL, fixed fee, freeze SOL,
// token, freeze token) and the address gate must match to the lamport / the
// exact pubkey. Deliberately NOT a tolerance: if the drop operator changed
// the price (or a group's guards) between review and the final build, the
// user must return to review, not sign under a fuzzy band. (Transaction fee
// / rent / priority are protocol overhead — not checked here; simulation
// reports those dynamically.)
export function paymentAuthorizationMatches(
  reviewed: PaymentAuthorization,
  resolved: PaymentAuthorization,
): { ok: true } | { ok: false; reason: string } {
  const eq = (a: string | null, b: string | null, label: string): string | null =>
    a === b ? null : `${label} changed since review (reviewed ${a ?? 'none'}, now ${b ?? 'none'})`;
  const eqTok = (a: TokenPay | null, b: TokenPay | null, label: string): string | null => {
    if ((a == null) !== (b == null)) return `${label} changed since review (one side has no token payment)`;
    if (a == null || b == null) return null;
    if (a.mint !== b.mint) return `${label} mint changed since review`;
    if (a.amount !== b.amount) return `${label} amount changed since review (reviewed ${a.amount}, now ${b.amount})`;
    if (a.destinationAta !== b.destinationAta) return `${label} destination changed since review`;
    return null;
  };

  const checks = [
    eq(reviewed.solPaymentLamports, resolved.solPaymentLamports, 'SOL mint price'),
    eq(reviewed.solPaymentDestination, resolved.solPaymentDestination, 'SOL payment destination'),
    eq(reviewed.solFixedFeeLamports, resolved.solFixedFeeLamports, 'fixed fee amount'),
    eq(reviewed.solFixedFeeDestination, resolved.solFixedFeeDestination, 'fixed fee destination'),
    eq(reviewed.freezeSolPaymentLamports, resolved.freezeSolPaymentLamports, 'freeze SOL price'),
    eq(reviewed.freezeSolPaymentDestination, resolved.freezeSolPaymentDestination, 'freeze SOL destination'),
    eq(reviewed.addressGateAddress, resolved.addressGateAddress, 'address gate'),
    eqTok(reviewed.tokenPayment, resolved.tokenPayment, 'token payment'),
    eqTok(reviewed.freezeTokenPayment, resolved.freezeTokenPayment, 'freeze token payment'),
  ].filter((x): x is string => x != null);

  return checks.length === 0 ? { ok: true } : { ok: false, reason: checks[0] };
}
