'use client';

// Candy Mint tool — personal use only. Reconstructs a Candy Guard mint
// transaction from a real, already-landed mint signature (or raw
// candyMachine/candyGuard addresses) and mints directly on-chain — no
// off-chain gate beyond whatever the guard itself enforces. Supports both
// Candy Guard families — 'core' (MPL Core assets) and 'legacy' (Token
// Metadata NFTs) — auto-detected from the reference signature. Every
// backend route is requireAuth-gated (site-wide SIWS + UI_ALLOWED_WALLETS).
//
// Exists because candy machines get closed (rent reclaimed) the instant
// they sell out — a frontend can look "closed" while still minting, or
// look "live" while the machine is actually already gone. Paste a recent
// mint signature to find out which, on-chain, right now.
//
// Layout below is a VictoryLabs read of a launchpad drop page (Rarible-style
// hero: big image + MINTING NOW + title + creator + quantity stepper + mint
// button + stats line) — reusing existing shared primitives (Pill, LiveDot,
// ItemThumb, VL palette) rather than inventing a parallel visual language.
//
// `loaded` (the inspected machine) and `flow` (the in-progress mint attempt)
// are deliberately separate pieces of state — the hero renders off `loaded`
// alone, so it stays on screen through the whole build → simulate → sign
// sequence instead of disappearing the moment a mint attempt starts. The
// simulated-cost / Sign & Send control renders inline in the exact spot the
// quantity+Mint row occupied, not as a separate panel further down the page.

import { useEffect, useRef, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import {
  connectPhantom, eagerConnectPhantom, getPhantom, currentPhantomPublicKey,
  signAllAndSend, signSendAndConfirm,
} from '@/wallet/phantom';
import { API_BASE, MONO, ToolButton, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { VL, VLText, ALPHA, alpha, rgb, hex } from '@/lib/palette';
import { ItemThumb, LiveDot, Pill, CtaButton } from '@/soloist/shared';
import {
  classifyConfirmation, normalizeMintErr, describeCandyGuardCustomError, pickInitialGroup, inspectDisabled,
  buildPriceLabel, tokenCostLabel as tokenCostLabelFor,
  runBounded, hasBlockhashHeadroom, BLOCKHASH_SAFETY_MARGIN_BLOCKS, retryOnce,
  CONFIRMATION_BUDGET_MS, CONFIRMATION_POLL_INTERVAL_MS, shouldKeepPolling,
  classifyReconcile, reconcileAllowsRebuild, hasUnresolvedTxns, foldReconcileResults,
  type ConfirmClass, type TokenPaymentView, type UnresolvedTx, type OneReconcileResult,
} from './logic';
import {
  freezeMintIntent, buildTxBody, paymentAuthorizationMatches, guardSetMatches, emptyPayment,
  type FrozenMintIntent, type ResolvedGuardPayment, type PaymentAuthorization,
} from './intent';
import { auditCandyMintTx } from './audit';

interface MintLimitStatus {
  id: number;
  limit: number;
  used: number | null;
  remaining: number | null;
}

interface GuardGroupSummary {
  label: string | null;
  enabledGuards: string[];
  unsupportedGuards: string[];
  supported: boolean;
  solPaymentLamports: string | null;
  solPaymentDestination: string | null;
  solFixedFeeLamports: string | null;
  solFixedFeeDestination: string | null;
  addressGateAddress: string | null;
  mintLimit: MintLimitStatus | null;
  startDateUnix: string | null;
  endDateUnix:   string | null;
  // Present for token-priced groups (tokenPayment / token2022Payment guard).
  // `decimals` is resolved server-side; null when that lookup missed.
  tokenPayment: TokenPaymentView | null;
  // The COMPLETE payment authorization for this group (all payment-affecting
  // guards' amounts + destinations, incl. freeze*). Frozen into the mint
  // intent and re-checked EXACTLY against the FINAL build.
  payment: PaymentAuthorization;
}

type CandyMintFamily = 'core' | 'legacy';

interface Inspection {
  alive: boolean;
  candyMachine: string;
  candyGuard: string;
  collection: string | null;
  itemsRedeemed: string | null;
  itemsAvailable: string | null;
  groups: GuardGroupSummary[];
}

interface CollectionMeta {
  name: string | null;
  image: string | null;
  description: string | null;
  creator: string | null;
}

/** Another candy machine (either program family) pointing at the SAME
 *  collection as the one being inspected — see siblings.ts. Surfaces
 *  "phase 2" drops nothing else links to. */
interface SiblingCandyMachine {
  candyMachine:   string;
  candyGuard:     string;
  family:         CandyMintFamily;
  itemsRedeemed:  number;
  itemsAvailable: number;
}

interface LoadedMachine {
  family: CandyMintFamily;
  inspection: Inspection;
  collectionMeta: CollectionMeta | null;
  referenceCollection: string | null;
  referenceCollectionUpdateAuthority: string | null;
  siblings: SiblingCandyMachine[];
}

// Each cause of "this item did not become a mint" gets its own status
// rather than one shared 'error' bucket — pre-check, rebuild, an expiring
// blockhash, a rejected approval, and a confirmed on-chain failure are all
// different facts and shouldn't read as interchangeable:
//   precheck_failed  — phase 1 build/simulate failed (never had a real tx)
//   blocked          — phase 1 bot-tax detected (never built for real)
//   rebuild_failed   — phase 1.5 rebuild (fresh blockhash + asset) failed
//   sign_rejected    — signAllTransactions itself was rejected/threw
//   expired          — signed, but skipped at send time: insufficient
//                       blockhash headroom (see BLOCKHASH_SAFETY_MARGIN_BLOCKS)
//                       — NOT submitted, never got a signature
//   audit_failed     — phase 1.75 structural audit of the FINAL bytes failed
//                       — never signed
//   unconfirmed      — submitted, landed status never observed in budget —
//                       retains its exact signature + lastValidBlockHeight for
//                       reconciliation (H2); a blind re-Mint is blocked while
//                       this exists
//   confirmed_failed — submitted, landed with err != null (reverted / guard)
//   confirmed_no_asset — landed err==null but the asset provably never got
//                       created (bot-tax / no mint) — NOT a success, no bump
//   asset_unverified — landed err==null but the asset read is temporarily
//                       unavailable — NOT claimed minted, re-checkable
//   success          — landed, err == null, AND the asset exists — the only mint
type BatchItemStatus =
  | 'pending' | 'building' | 'simulating' | 'ready'
  | 'rebuilding' | 'auditing' | 'signing' | 'expired' | 'confirming' | 'verifying'
  | 'success' | 'blocked'
  | 'precheck_failed' | 'rebuild_failed' | 'audit_failed' | 'sign_rejected'
  | 'confirmed_failed' | 'tax_no_mint' | 'not_observed' | 'unconfirmed';

interface BatchItem {
  status: BatchItemStatus;
  sig?: string;
  /** The ACTUAL asset/nftMint address this item will mint into — always
   *  from the FINAL rebuild that produced the signed transaction, never
   *  phase 1's (discarded) build. */
  mint?: string;
  /** From the FINAL rebuild — retained so the post-sign headroom guard and
   *  (if it goes unconfirmed) reconciliation can check this exact tx. */
  lastValidBlockHeight?: number;
  /** Set when this item is submitted but its landing was never observed.
   *  While any item has this, a blind fresh Mint is blocked (H2). */
  unresolved?: UnresolvedTx | null;
  solDeltaLamports?: number | null;
  tokenCostLabel?: string | null;
  message?: string;
}

// The mint-attempt state machine — independent of `loaded`/hero data. Only
// 'ready_to_sign' and 'batch' replace the quantity+Mint control; every other
// state renders alongside it.
type FlowState =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  | { kind: 'minting'; step: 'building' | 'simulating' | 'finalizing' | 'auditing' | 'signing' | 'confirming' | 'verifying' }
  | { kind: 'reconciling' }
  | {
      kind: 'ready_to_sign';
      // The PRE-CHECK build's cost — its bytes are discarded; handleConfirmSign
      // does a FINAL fresh rebuild + audit from `intent` before signing.
      solDeltaLamports: number | null;
      botTaxDetected: boolean;
      tokenCostLabel: string | null;
      /** The single frozen mint intent for this attempt. Everything from here
       *  on (final rebuild, audit, wallet check) reads from this, not live
       *  React state (M1-freeze). */
      intent: FrozenMintIntent;
    }
  | { kind: 'batch'; total: number; items: BatchItem[]; intent: FrozenMintIntent; done?: boolean }
  | { kind: 'success'; sig: string }
  // `sig` present when the failure happened after broadcast. `unknown` marks
  // "never observed landing" — NOT a known failure. `unresolved` (+ `intent`)
  // is retained for exact-signature reconciliation and blocks a blind re-Mint.
  | {
      kind: 'error'; message: string; sig?: string; unknown?: boolean;
      unresolved?: UnresolvedTx | null; intent?: FrozenMintIntent;
    };

const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  invalid_signature: 'Not a valid transaction signature.',
  signature_not_found: 'No transaction found for that signature.',
  reference_tx_failed_onchain: 'That reference transaction failed on-chain — try a different one.',
  no_candy_guard_instruction_found: 'No Candy Guard mint instruction (core or legacy) in that transaction.',
  unexpected_account_count: 'Unrecognized instruction shape — not a plain mint call.',
  account_resolution_failed: 'Could not resolve accounts from that transaction.',
  unrecognized_candy_guard_program: 'That candyGuard address is not owned by either known Candy Guard program.',
  provide_sig_or_candyMachine_and_candyGuard: 'Enter a signature, or both candyMachine and candyGuard addresses.',
  candy_machine_closed: 'Candy machine is closed — the account no longer exists on-chain.',
  group_not_found: 'Selected guard group not found.',
  missing_or_invalid_fields: 'Missing or invalid fields.',
  collection_update_authority_unresolved: 'Could not resolve the collection\'s update authority (legacy mint).',
  candy_guard_not_found: 'Candy Guard account not found on-chain — the drop may have been closed.',
  rate_limited: 'Rate limited — wait a few seconds and try again (or resume with a smaller quantity).',
};

function humanizeBackendError(code: string | undefined, httpStatus?: number): string {
  if (code) {
    // simulate-tx forwards a raw `{"InstructionError":[i,{"Custom":n}]}`
    // dump as `error` on sim failure — decode it before falling through to
    // the plain-code lookup below, which would otherwise split on the JSON's
    // own colons and return it verbatim.
    const guardMsg = describeCandyGuardCustomError(code);
    if (guardMsg) return guardMsg;
    const base = code.split(':')[0].trim();
    // `unsupported_guards: gatekeeper, allowList` — keep the guard names
    // (they explain *why* this drop can't be minted here) but wrap them in
    // a sentence instead of surfacing the raw code.
    if (base === 'unsupported_guards') {
      const guards = code.slice(code.indexOf(':') + 1).trim();
      return guards
        ? `This drop needs more than a wallet signature (${guards}) — it can't be minted from this tool.`
        : 'This drop needs more than a wallet signature — it can\'t be minted from this tool.';
    }
    return BACKEND_ERROR_MESSAGES[base] ?? code;
  }
  return httpStatus ? `Request failed (HTTP ${httpStatus}).` : 'Request failed. Please try again.';
}

// Two-unit countdown (d/h -> h/m -> m/s) — granularity shrinks as the
// target gets closer, standard countdown-UX convention. `msRemaining` is
// clamped to 0 by the caller checking `notYetLive` before rendering this.
function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function humanizeThrownError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this mint.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

// Both `signSendAndConfirm` and `signAllAndSend` return as soon as Phantom /
// the RPC accept the transaction — they do NOT wait for it to land (public
// RPC WSS confirm is unreliable, see phantom.ts). This is the ONE shared
// confirmation primitive for both the single and batch flows: it polls the
// same tx-status endpoint the MMM pool buy flow uses, and classifies each
// poll via `classifyConfirmation` (landed + err == null is the only
// success; landed + err != null is a real on-chain failure).
//
// Outcome:
//   { status: 'success' }            landed, no error
//   { status: 'failed', err }        landed, on-chain error (reverted / guard hard-error)
//   { status: 'unknown' }            never observed landed within the budget
// 'unknown' is treated as a non-success by every caller (never "Minted",
// never bumps a counter) but reported distinctly from a known failure.
type ConfirmResult =
  | { status: 'success' }
  | { status: 'failed'; err: unknown }
  | { status: 'unknown' };

// One tx-status poll for `signature`. The backend's /tx-status already uses
// getSignatureStatuses(searchTransactionHistory:true), so this is a valid
// exact-signature check for reconciliation of an older submission too.
async function pollTxStatus(signature: string): Promise<{ cls: ConfirmClass; err: unknown }> {
  try {
    const url = `${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`;
    const r = await fetch(url, { headers: { ...authHeaders() } });
    if (r.ok) {
      const d = await r.json() as { ok: boolean; found: boolean; confirmationStatus: string | null; err: unknown };
      return { cls: classifyConfirmation(d), err: d.err };
    }
  } catch {
    // transient — treated as pending
  }
  return { cls: 'pending', err: null };
}

async function waitForConfirmation(signature: string): Promise<ConfirmResult> {
  // ELAPSED-TIME budget (M3), not a fixed attempt count. 'confirmed' usually
  // lands in ~1 slot, but a congested drop — the exact scenario this tool
  // exists for — can take much longer; a premature timeout turns a real mint
  // into `unknown`, which then gates the Mint button behind reconciliation.
  const startedAt = Date.now();
  let firstPoll = true;
  while (firstPoll || shouldKeepPolling(startedAt, Date.now())) {
    if (!firstPoll) await new Promise((r) => setTimeout(r, CONFIRMATION_POLL_INTERVAL_MS));
    firstPoll = false;
    const { cls, err } = await pollTxStatus(signature);
    if (cls === 'success') return { status: 'success' };
    if (cls === 'failed') return { status: 'failed', err };
  }
  // Submitted but never observed to land. Reconciliation (exact signature +
  // block height) is the only safe way forward — never a blind rebuild.
  return { status: 'unknown' };
}

// ── post-confirmation mint verification (H1) ─────────────────────────────────
// A landed Candy Guard bot-tax transaction has err==null but mints nothing —
// and a clean account-null is NOT proof of "no mint" (RPC lag / load-balanced
// nodes, see verify-asset.ts). So:
//   'minted'       — asset account exists, right owner
//   'tax_no_mint'  — asset absent AND the confirmed tx's OWN logs carry the
//                    bot-tax marker (strong evidence from the transaction)
//   'not_observed' — asset absent, logs clean / not fetchable / RPC error —
//                    NEITHER minted NOR bot-tax; caller keeps the signature,
//                    allows an exact re-check, never bumps the counter
type MintVerdict = 'minted' | 'tax_no_mint' | 'not_observed';
async function verifyMint(asset: string, family: 'core' | 'legacy', signature: string): Promise<MintVerdict> {
  try {
    const r = await fetch(
      `${API_BASE}/api/tools/candy-mint/verify-asset?asset=${encodeURIComponent(asset)}&family=${family}&sig=${encodeURIComponent(signature)}`,
      { headers: { ...authHeaders() } },
    );
    const d = await r.json() as { ok: boolean; verdict?: MintVerdict };
    if (!d.ok || !d.verdict) return 'not_observed';
    return d.verdict;
  } catch {
    return 'not_observed';
  }
}

// Resolve a submitted signature to a terminal disposition — including the
// H1 mint check when it lands cleanly. Shared by single + batch + reconcile.
type SubmittedDisposition =
  | { kind: 'minted' }
  | { kind: 'tax_no_mint' }
  | { kind: 'not_observed' }
  | { kind: 'confirmed_failed'; err: unknown }
  | { kind: 'unresolved'; unresolved: UnresolvedTx };

async function resolveSubmitted(
  signature: string,
  final: { asset: string; lastValidBlockHeight: number; family: 'core' | 'legacy' },
): Promise<SubmittedDisposition> {
  const res = await waitForConfirmation(signature);
  if (res.status === 'failed') return { kind: 'confirmed_failed', err: res.err };
  if (res.status === 'unknown') {
    return {
      kind: 'unresolved',
      unresolved: { signature, lastValidBlockHeight: final.lastValidBlockHeight, asset: final.asset, family: final.family },
    };
  }
  const verdict = await verifyMint(final.asset, final.family, signature);
  if (verdict === 'minted') return { kind: 'minted' };
  if (verdict === 'tax_no_mint') return { kind: 'tax_no_mint' };
  return { kind: 'not_observed' };
}

// Is a blind fresh Mint currently blocked because an earlier submission's
// fate is unknown (H2)? True while any retained unresolved signature exists.
function hasUnresolvedInFlow(flow: FlowState): boolean {
  if (flow.kind === 'error') return !!flow.unresolved;
  if (flow.kind === 'batch') return hasUnresolvedTxns(flow.items);
  return false;
}
function collectUnresolved(flow: FlowState): UnresolvedTx[] {
  if (flow.kind === 'error' && flow.unresolved) return [flow.unresolved];
  if (flow.kind === 'batch') {
    return flow.items.map((it) => it.unresolved).filter((u): u is UnresolvedTx => u != null);
  }
  return [];
}

// ── FINAL fresh build + audit (M2, M4, M5) ──────────────────────────────────
// Rebuild the transaction from the FROZEN intent right before signing (fresh
// blockhash + fresh ephemeral asset), simulate the FINAL bytes, then
// structurally audit the FINAL bytes. Only the ephemeral identity may change
// between the pre-check build and this one — target/payment intent is frozen.
interface FinalBuild {
  transactionBase64: string;
  asset: string;
  lastValidBlockHeight: number;
  solDeltaLamports: number | null;
  botTaxDetected: boolean;
}
async function buildAndAuditFinal(
  intent: FrozenMintIntent,
): Promise<{ ok: true; build: FinalBuild } | { ok: false; error: string }> {
  // wallet-switch guard: the tx will be built for intent.wallet; if Phantom's
  // active account has drifted, stop now (before any RPC spend).
  const active = currentPhantomPublicKey();
  if (active && active !== intent.wallet) {
    return { ok: false, error: 'Connected wallet changed since this mint was reviewed — reconnect and start over.' };
  }
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(buildTxBody(intent, intent.wallet)),
    });
  } catch (err) {
    return { ok: false, error: humanizeThrownError((err as Error).message) };
  }
  const j = await r.json() as {
    ok: boolean; transactionBase64?: string; asset?: string; lastValidBlockHeight?: number;
    resolvedGuardPayment?: ResolvedGuardPayment; resolvedEnabledGuards?: string[]; error?: string;
  };
  if (!j.ok || !j.transactionBase64 || !j.asset || j.lastValidBlockHeight == null
      || !j.resolvedGuardPayment || !Array.isArray(j.resolvedEnabledGuards)) {
    return { ok: false, error: humanizeBackendError(j.error, r.status) };
  }
  const finalTx = j.transactionBase64;
  const finalAsset = j.asset;

  // EXACT enabled-guard-SET equality — the FINAL build re-read the live
  // base∪group merged guard set; if a guard was added, removed, or
  // substituted since review (even a 0-remaining-account one, or a same-
  // count swap the auditor's account count can't see), fail closed.
  const guardMatch = guardSetMatches(intent.enabledGuards, j.resolvedEnabledGuards);
  if (!guardMatch.ok) {
    return { ok: false, error: `Candy Guard configuration changed since review (${guardMatch.reason}). Re-inspect and review the mint again.` };
  }

  // EXACT payment-authorization check — the FINAL build re-read live guard
  // state; if the mint PRICE (amount or destination, SOL or token) or the
  // address gate differs from what the user reviewed, fail closed. No
  // tolerance — a changed price means a fresh review, not a silent sign.
  const payMatch = paymentAuthorizationMatches(intent.payment, j.resolvedGuardPayment);
  if (!payMatch.ok) {
    return { ok: false, error: `Mint payment ${payMatch.reason}. Not signing — re-inspect the drop and review again.` };
  }

  // simulate the FINAL bytes (never reuse the pre-check simulation)
  let simJ: { ok: boolean; solDeltaLamports?: number | null; botTaxDetected?: boolean; error?: string };
  try {
    const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ transactionBase64: finalTx, wallet: intent.wallet }),
    });
    simJ = await simR.json();
  } catch (err) {
    return { ok: false, error: humanizeThrownError((err as Error).message) };
  }
  if (!simJ.ok) return { ok: false, error: humanizeBackendError(simJ.error) };

  // structural audit of the FINAL bytes against the FROZEN intent
  const audit = auditCandyMintTx(finalTx, intent, {
    expectedAsset: finalAsset,
    connectedWallet: currentPhantomPublicKey() ?? undefined,
  });
  if (!audit.ok) {
    return { ok: false, error: `Transaction failed a safety check and was not signed: ${audit.reason}` };
  }

  return {
    ok: true,
    build: {
      transactionBase64: finalTx,
      asset: finalAsset,
      lastValidBlockHeight: j.lastValidBlockHeight,
      solDeltaLamports: simJ.solDeltaLamports ?? null,
      botTaxDetected: simJ.botTaxDetected ?? false,
    },
  };
}

// NOTE: the pre-vs-final SOL-DELTA is deliberately NOT gated by a tolerance.
// Mint-price authorization is enforced EXACTLY via paymentAuthorizationMatches
// (amounts + destinations from the backend's fresh guard read vs the frozen
// intent). The simulated SOL delta only reports protocol overhead (base fee +
// priority + asset-account rent), which legitimately varies slot to slot and
// is shown to the user, not gated.

// Post-sign, pre-broadcast blockhash-headroom check for the SINGLE flow (M2 /
// §12) — mirrors the batch guard. Fail-OPEN on a height-read outage (a
// genuinely stale tx is still caught by confirmation and never counted as a
// mint; this policy is deliberately separate from reconciliation's fail-CLOSED
// block-height policy). Reuses the same `fetchCurrentBlockHeight` (retryOnce)
// the batch flow uses.
async function singleFlowHeadroomOk(lastValidBlockHeight: number): Promise<{ ok: boolean; blocksLeft?: number }> {
  const height = await fetchCurrentBlockHeight();
  if (height == null) return { ok: true }; // fail open
  if (hasBlockhashHeadroom(lastValidBlockHeight, height, BLOCKHASH_SAFETY_MARGIN_BLOCKS)) return { ok: true };
  return { ok: false, blocksLeft: lastValidBlockHeight - height };
}

// One cheap read for the batch-mint post-sign blockhash-headroom guard (see
// handleMintBatch's `shouldSend`). One retry after a short delay (via
// logic.ts's retryOnce — cheap insurance against a single transient blip,
// measured to be well within the send loop's own budget: send-loop
// investigation found the max-batch send loop is ~190ms/1 block against an
// 18-block margin). Null after both attempts -> the guard fails OPEN
// (still sends) rather than blocking a batch on an auxiliary read outage
// unrelated to whether that batch is actually stale; see shouldSend's own
// comment for the full reasoning. The caller (not this function) is
// responsible for surfacing that bypass — it knows the batch size, this
// doesn't.
async function fetchCurrentBlockHeight(): Promise<number | null> {
  return retryOnce(async () => {
    const r = await fetch(`${API_BASE}/api/tools/candy-mint/block-height`, { headers: { ...authHeaders() } });
    if (!r.ok) return null;
    const d = await r.json() as { ok: boolean; blockHeight?: number };
    return d.ok && typeof d.blockHeight === 'number' ? d.blockHeight : null;
  }, 300);
}

/** Disambiguates a pasted base58 string as a tx signature (64 bytes, ~87-88
 *  chars) vs an NFT/asset address (32 bytes, ~32-44 chars) purely by
 *  length — same 64-char boundary the backend's own `isValidSignature`
 *  (fetch-tx.ts) uses, so the two ranges never overlap. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function classifyPastedRef(v: string): 'signature' | 'asset' | 'invalid' {
  const t = v.trim();
  if (!BASE58_RE.test(t)) return 'invalid';
  if (t.length >= 64) return 'signature';
  if (t.length >= 32) return 'asset';
  return 'invalid';
}

export default function CandyMintPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [sig, setSig] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null | undefined>(undefined);
  const [quantity, setQuantity] = useState(1);
  const [loaded, setLoaded] = useState<LoadedMachine | null>(null);
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });
  // Collapsed by default — this is a secondary/bonus panel (see siblings.ts),
  // not core to the mint flow, and was crowding the hero when always open.
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  // Re-entrancy guard for the mint handlers — `disabled` derived from async
  // state has a render-timing race; this ref closes it deterministically.
  const mintRunningRef = useRef(false);

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  // Deep-link from the /mints feed's Candy Machine badge: `?asset=` (an NFT
  // mint address — the backend resolves its earliest signature itself, see
  // resolve-asset-signature.ts) or `?sig=` (a raw tx signature). Either way
  // this auto-fires Inspect once on mount so the badge click lands straight
  // on a loaded drop instead of an empty box.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const assetParam = params.get('asset');
    const sigParam = params.get('sig');
    if (assetParam) {
      setSig(assetParam);
      void handleInspect({ asset: assetParam });
    } else if (sigParam) {
      setSig(sigParam);
      void handleInspect({ sig: sigParam });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // mintLimit's used/remaining is per-wallet — it was only ever fetched at
  // Inspect time for whatever wallet happened to be connected then. Switch
  // wallets afterwards without re-inspecting and the panel kept showing the
  // PREVIOUS wallet's count (looked like "the site thinks it's the same
  // wallet" — it wasn't checking the new one at all, just never refreshed).
  // Re-fetch the wallet-scoped numbers whenever the connected wallet changes
  // while a machine is already loaded; everything else (family, collection
  // meta, addresses) is wallet-independent and stays put.
  useEffect(() => {
    if (!loaded) return;
    const candyMachine = loaded.inspection.candyMachine;
    const candyGuard = loaded.inspection.candyGuard;
    let cancelled = false;
    (async () => {
      try {
        const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
        const r = await fetch(
          `${API_BASE}/api/tools/candy-mint/inspect?candyMachine=${encodeURIComponent(candyMachine)}&candyGuard=${encodeURIComponent(candyGuard)}${walletParam}`,
          { headers: { ...authHeaders() } },
        );
        const j = await r.json() as { ok: boolean; inspection?: Inspection };
        if (!cancelled && j.ok && j.inspection) {
          setLoaded((prev) => (prev ? { ...prev, inspection: j.inspection as Inspection } : prev));
        }
      } catch {
        // best-effort refresh — keep showing whatever we already have
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-runs on wallet change
  }, [wallet]);

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    // Reset the in-progress mint attempt (ready_to_sign, batch, success,
    // error) — none of it belongs to whichever wallet connects next. The
    // drop itself (`loaded`) and the pasted signature stay put; the
    // wallet-switch effect re-fetches per-wallet numbers (mintLimit
    // used/remaining) once a new wallet connects.
    setFlow({ kind: 'idle' });
    setQuantity(1);
  }

  async function handleInspect(override?: {
    asset?: string; sig?: string; candyMachine?: string; candyGuard?: string;
  }) {
    let asset = override?.asset;
    let sigValue = override?.sig;
    const { candyMachine: cmOverride, candyGuard: cgOverride } = override ?? {};
    if (!override) {
      const kind = classifyPastedRef(sig);
      if (kind === 'signature') sigValue = sig.trim();
      else if (kind === 'asset') asset = sig.trim();
      else return;
    }
    if (!asset && !sigValue && !(cmOverride && cgOverride)) return;
    setFlow({ kind: 'inspecting' });
    setSelectedGroup(undefined);
    setQuantity(1);
    setSiblingsOpen(false);
    try {
      const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
      // Sibling candy machines (see SiblingCandyMachine) are loaded directly
      // by address — a phase-2 CM may have zero mints yet, so there's no
      // signature to resolve at all.
      const refParam = (cmOverride && cgOverride)
        ? `candyMachine=${encodeURIComponent(cmOverride)}&candyGuard=${encodeURIComponent(cgOverride)}`
        : asset
          ? `asset=${encodeURIComponent(asset)}`
          : `sig=${encodeURIComponent(sigValue!)}`;
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/inspect?${refParam}${walletParam}`, {
        headers: { ...authHeaders() },
      });
      const j = await r.json() as {
        ok: boolean; family?: CandyMintFamily; inspection?: Inspection; collectionMeta?: CollectionMeta | null;
        referenceCollection?: string | null; referenceCollectionUpdateAuthority?: string | null; error?: string;
        siblings?: SiblingCandyMachine[];
      };
      if (!j.ok || !j.inspection || !j.family) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setLoaded({
        family: j.family,
        inspection: j.inspection,
        collectionMeta: j.collectionMeta ?? null,
        referenceCollection: j.referenceCollection ?? null,
        referenceCollectionUpdateAuthority: j.referenceCollectionUpdateAuthority ?? null,
        siblings: j.siblings ?? [],
      });
      setFlow({ kind: 'idle' });
      // Always land on a concrete group (see pickInitialGroup): a lone
      // unsupported group is still selected so its "needs more than a wallet
      // signature" reason renders instead of a dead hero.
      setSelectedGroup(pickInitialGroup(j.inspection.groups));
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // Freeze the one mint intent for this attempt from the currently-inspected
  // machine + selected group. Null when a required field is missing.
  function freezeCurrentIntent(quantity: number): FrozenMintIntent | null {
    if (!wallet || !loaded || selectedGroup === undefined || !selected) return null;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = loaded;
    return freezeMintIntent({
      wallet, family,
      candyMachine: inspection.candyMachine,
      candyGuard: inspection.candyGuard,
      collection: inspection.collection ?? referenceCollection,
      collectionUpdateAuthority: referenceCollectionUpdateAuthority,
      group: selectedGroup,
      quantity,
      selectedGroup: {
        label: selected.label,
        // The backend's complete extracted payment authorization for this
        // group — frozen verbatim, re-checked EXACTLY at final build.
        payment: selected.payment ?? emptyPayment(),
        enabledGuards: selected.enabledGuards ?? [],
      },
    });
  }

  async function handleMint() {
    if (mintRunningRef.current) return;
    if (hasUnresolvedInFlow(flow)) { return; } // blocked — reconcile first (H2)
    const intent = freezeCurrentIntent(1);
    if (!intent) { setFlow({ kind: 'error', message: 'Could not read the mint parameters — re-inspect the drop.' }); return; }
    mintRunningRef.current = true;
    setFlow({ kind: 'minting', step: 'building' });
    try {
      // PRE-CHECK: build + simulate to prove the mint is satisfiable and
      // price it. These bytes are DISCARDED — handleConfirmSign does a FINAL
      // fresh build + structural audit from `intent` right before signing.
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildTxBody(intent, intent.wallet)),
      });
      const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
      if (!j.ok || !j.transactionBase64) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setFlow({ kind: 'minting', step: 'simulating' });
      const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ transactionBase64: j.transactionBase64, wallet: intent.wallet }),
      });
      const simJ = await simR.json() as {
        ok: boolean; solDeltaLamports?: number | null; botTaxDetected?: boolean; error?: string;
      };
      if (!simJ.ok) {
        setFlow({ kind: 'error', message: humanizeBackendError(simJ.error, simR.status) });
        return;
      }
      setFlow({
        kind: 'ready_to_sign',
        solDeltaLamports: simJ.solDeltaLamports ?? null,
        botTaxDetected: simJ.botTaxDetected ?? false,
        tokenCostLabel: tokenCostLabelFor(selected?.tokenPayment ?? null),
        intent,
      });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    } finally {
      mintRunningRef.current = false;
    }
  }

  // The mintLimit `used`/`remaining` numbers are a snapshot taken at
  // Inspect time — nothing re-fetches them after a mint lands, so without
  // this the panel keeps showing the pre-mint count forever (looked like a
  // stuck/buggy counter, but it was just never being updated at all).
  // Bumped optimistically per confirmed signature: we know for certain our
  // own mint landed, so there's nothing to wait on a re-fetch for.
  // Bumped ONLY after a mint is verified (landed + asset exists) — a landed
  // bot-tax tx must not move this. `groupLabel` comes from the frozen intent.
  function bumpMintedCount(groupLabel: string | null) {
    setLoaded((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        inspection: {
          ...prev.inspection,
          itemsRedeemed: prev.inspection.itemsRedeemed != null
            ? String(Number(prev.inspection.itemsRedeemed) + 1)
            : prev.inspection.itemsRedeemed,
          groups: prev.inspection.groups.map((g) => {
            if (g.label !== groupLabel || !g.mintLimit) return g;
            const used = (g.mintLimit.used ?? 0) + 1;
            return { ...g, mintLimit: { ...g.mintLimit, used, remaining: Math.max(0, g.mintLimit.limit - used) } };
          }),
        },
      };
    });
  }

  async function handleConfirmSign() {
    if (mintRunningRef.current || flow.kind !== 'ready_to_sign') return;
    const intent = flow.intent;
    mintRunningRef.current = true;
    try {
      // ── FINAL fresh build + simulate + structural audit (M2/M4/M5) ──────
      setFlow({ kind: 'minting', step: 'finalizing' });
      const fb = await buildAndAuditFinal(intent);
      if (!fb.ok) { setFlow({ kind: 'error', message: fb.error, intent }); return; }
      const final = fb.build;

      // A landed bot-tax on the FINAL sim -> never sign (do not fall back to
      // the pre-check result). (Exact mint-price authorization is already
      // enforced inside buildAndAuditFinal via paymentAuthorizationMatches.)
      if (final.botTaxDetected) {
        setFlow({ kind: 'error', message: 'Bot-tax path detected on the final transaction — not signing.', intent });
        return;
      }

      // ── sign, THEN a real pre-broadcast headroom gate, THEN send ────────
      // Reuse the batch primitive with a one-element list: one Phantom
      // approval, `shouldSend` consulted BEFORE the broadcast, `expectWallet`
      // re-checks Phantom's active account inside phantom.ts.
      setFlow({ kind: 'minting', step: 'signing' });
      let signature: string | undefined;
      let staleBlocksLeft: number | null = null;
      try {
        const sigs = await signAllAndSend(
          [final.transactionBase64],
          (_pos, sig) => { signature = sig; },
          async () => {
            const fresh = await singleFlowHeadroomOk(final.lastValidBlockHeight);
            if (!fresh.ok) staleBlocksLeft = fresh.blocksLeft ?? 0;
            return fresh.ok;
          },
          { sendPath: `${API_BASE}/api/tools/candy-mint/send-tx`, expectWallet: intent.wallet },
        );
        signature = sigs[0] ?? signature;
      } catch (err) {
        setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message), intent });
        return;
      }
      if (!signature) {
        // shouldSend declined — signed but never broadcast, never resigned (M2/§12).
        setFlow({
          kind: 'error', intent,
          message: `Not sent — blockhash headroom too low (${staleBlocksLeft} blocks left, need ${BLOCKHASH_SAFETY_MARGIN_BLOCKS}+). Nothing was broadcast. Try Mint again to rebuild.`,
        });
        return;
      }

      setFlow({ kind: 'minting', step: 'confirming' });
      const disp = await resolveSubmitted(signature, {
        asset: final.asset, lastValidBlockHeight: final.lastValidBlockHeight, family: intent.family,
      });
      const retained: UnresolvedTx = {
        signature, lastValidBlockHeight: final.lastValidBlockHeight, asset: final.asset, family: intent.family,
      };
      if (disp.kind === 'minted') {
        setFlow({ kind: 'success', sig: signature });
        bumpMintedCount(intent.group);
      } else if (disp.kind === 'not_observed') {
        // Landed clean, but the mint could NOT be confirmed (asset not visible,
        // no bot-tax evidence). NOT a success — keep the signature, gate a
        // blind re-Mint, allow an exact Re-check.
        setFlow({
          kind: 'error', unknown: true, sig: signature, intent, unresolved: retained,
          message: 'Transaction landed, but the mint could not be confirmed yet (the new asset is not visible on-chain). Use "Re-check unresolved" — do not Mint again until it resolves.',
        });
      } else if (disp.kind === 'tax_no_mint') {
        setFlow({
          kind: 'error', sig: signature, intent,
          message: 'Transaction landed but no asset was minted — the Candy Guard bot-tax path fired (its logs confirm it). Nothing was created; you were not charged the mint price.',
        });
      } else if (disp.kind === 'confirmed_failed') {
        setFlow({ kind: 'error', message: normalizeMintErr(disp.err), sig: signature, intent });
      } else {
        // unresolved — never observed landing. Keep the exact signature +
        // lastValidBlockHeight for reconciliation; a blind re-Mint is blocked.
        setFlow({
          kind: 'error',
          message: 'Confirmation not observed — status unknown. It may still land. Use "Re-check unresolved" before trying again.',
          sig: signature,
          unknown: true,
          unresolved: disp.unresolved,
          intent,
        });
      }
    } finally {
      mintRunningRef.current = false;
    }
  }

  // Batch mint — three phases, ONE Phantom approval, per the Option B
  // blockhash-freshness investigation (session doc):
  //
  //   1. pre-check: build + simulate every item, stop at the first bad one
  //      (unchanged from before). Proves the mint is satisfiable and prices
  //      it; its built transaction is discarded — never signed, never sent.
  //   1.5 rebuild: every still-ready item is rebuilt (bounded concurrency)
  //      immediately before signing, for a fresh blockhash. Measured: two
  //      independent builds of the same input differ ONLY in recentBlockhash
  //      and the fresh asset/nftMint pubkey Umi generates per build — so
  //      phase 1's cost figures stay valid and don't need re-simulating,
  //      only the transaction bytes need replacing. That fresh asset pubkey
  //      is the ACTUAL mint address and is threaded onto the item from here
  //      on — phase 1's is discarded and never stored anywhere.
  //   2. one Phantom approval (signAllAndSend) for every rebuilt item, with
  //      a post-sign blockhash-headroom guard (see `shouldSend` below)
  //      gating the broadcast step per item — never a second approval.
  //
  // Packing all N mints into a single on-chain transaction doesn't fit
  // (measured: 10 MintV1 instructions serialize to ~1830 bytes, over the
  // 1232-byte legacy wire limit) — this is what "one click mints 10"
  // actually is on real candy-machine sites: N separate transactions,
  // signed together.
  async function handleMintBatch() {
    if (mintRunningRef.current) return;
    if (hasUnresolvedInFlow(flow)) return; // blocked — reconcile first (H2)
    const total = Math.max(1, Math.floor(quantity));
    const intent = freezeCurrentIntent(total);
    if (!intent) { setFlow({ kind: 'error', message: 'Could not read the mint parameters — re-inspect the drop.' }); return; }
    mintRunningRef.current = true;
    try {
      await runMintBatch(intent, total);
    } finally {
      mintRunningRef.current = false;
    }
  }

  async function runMintBatch(intent: FrozenMintIntent, total: number) {
    const batchTokenCost = tokenCostLabelFor(selected?.tokenPayment ?? null);
    const items: BatchItem[] = Array.from({ length: total }, () => ({ status: 'pending' }));
    const setItems = () => setFlow({ kind: 'batch', total, items: [...items], intent });
    setItems();

    const buildPayload = () => buildTxBody(intent, intent.wallet);
    const wallet = intent.wallet;
    const family = intent.family;

    // ── phase 1 (pre-check): build + simulate, stop at the first bad one ──
    for (let i = 0; i < total; i++) {
      items[i] = { status: 'building' };
      setItems();
      try {
        const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(buildPayload()),
        });
        const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
        if (!j.ok || !j.transactionBase64) {
          items[i] = { status: 'precheck_failed', message: humanizeBackendError(j.error, r.status) };
          setItems();
          break;
        }

        items[i] = { status: 'simulating' };
        setItems();
        const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ transactionBase64: j.transactionBase64, wallet }),
        });
        const simJ = await simR.json() as {
          ok: boolean; solDeltaLamports?: number | null; botTaxDetected?: boolean; error?: string;
        };
        if (!simJ.ok) {
          items[i] = { status: 'precheck_failed', message: humanizeBackendError(simJ.error, simR.status) };
          setItems();
          break;
        }
        if (simJ.botTaxDetected) {
          items[i] = { status: 'blocked', message: 'bot-tax path detected — stopped, not signing' };
          setItems();
          break;
        }

        // Phase 1's transactionBase64 is intentionally NOT retained —
        // rebuild replaces it below.
        items[i] = { status: 'ready', solDeltaLamports: simJ.solDeltaLamports ?? null, tokenCostLabel: batchTokenCost };
        setItems();
      } catch (err) {
        items[i] = { status: 'precheck_failed', message: humanizeThrownError((err as Error).message) };
        setItems();
        break;
      }
    }

    const readyIndexes = items.map((it, i) => (it.status === 'ready' ? i : -1)).filter((i) => i >= 0);
    if (readyIndexes.length === 0) {
      setFlow({ kind: 'batch', total, items: [...items], intent, done: true });
      return;
    }

    // ── phase 1.5 + 1.75 (final build + validate, M4): one bounded wave per
    //     item — FINAL fresh build (blockhash + asset), EXACT payment-
    //     authorization check vs the frozen intent, FINAL-byte simulation,
    //     FINAL-byte structural audit. Identical validation to the single
    //     flow (buildAndAuditFinal). Only items that pass ALL of it — and are
    //     not bot-taxed on the FINAL sim — become signable. No silent
    //     fallback to a phase-1 result. Bounded concurrency preserved
    //     (measured: full-parallel vs bounded(6) is ~free at 25 items).
    const REBUILD_CONCURRENCY = 6;
    for (const i of readyIndexes) items[i] = { ...items[i], status: 'rebuilding' };
    setItems();

    const lastValidByItem = new Map<number, number>();
    const finalTxByItem = new Map<number, string>();

    await runBounded(readyIndexes, REBUILD_CONCURRENCY, async (i) => {
      items[i] = { ...items[i], status: 'auditing' };
      setItems();
      const fb = await buildAndAuditFinal(intent);
      if (!fb.ok) {
        items[i] = { ...items[i], status: 'audit_failed', message: `final check failed: ${fb.error}` };
        setItems();
        return;
      }
      if (fb.build.botTaxDetected) {
        items[i] = { ...items[i], status: 'blocked', message: 'bot-tax path on the final transaction — not signing' };
        setItems();
        return;
      }
      lastValidByItem.set(i, fb.build.lastValidBlockHeight);
      finalTxByItem.set(i, fb.build.transactionBase64);
      items[i] = {
        ...items[i], status: 'ready', mint: fb.build.asset,
        lastValidBlockHeight: fb.build.lastValidBlockHeight,
        solDeltaLamports: fb.build.solDeltaLamports ?? items[i].solDeltaLamports,
      };
      setItems();
    });

    const signableItemIndexes = readyIndexes.filter((i) => finalTxByItem.has(i));
    const signableTxs = signableItemIndexes.map((i) => finalTxByItem.get(i)!);

    if (signableItemIndexes.length === 0) {
      setFlow({ kind: 'batch', total, items: [...items], intent, done: true });
      return;
    }

    // ── phase 2: one Phantom approval for every rebuilt+audited item ────
    try {
      for (const i of signableItemIndexes) items[i] = { ...items[i], status: 'signing' };
      setItems();

      // Post-sign blockhash-headroom guard: everything below is ALREADY
      // signed by the time this runs (one approval covers the whole list
      // unconditionally) — this only gates the broadcast step. One
      // current-block-height read for the whole batch (memoized on first
      // call; signAllAndSend invokes shouldSend in submission order, so
      // this fires exactly once), then each item's OWN lastValidBlockHeight
      // from ITS OWN rebuild is checked against it with a conservative,
      // explicit margin. A safety heuristic, not a landing guarantee — see
      // BLOCKHASH_SAFETY_MARGIN_BLOCKS. A skipped item never gets a
      // signature, is never marked minted, and is never auto-retried.
      let cachedHeight: number | null | undefined;
      const shouldSend = async (pos: number): Promise<boolean> => {
        const i = signableItemIndexes[pos];
        if (cachedHeight === undefined) {
          cachedHeight = await fetchCurrentBlockHeight();
          if (cachedHeight == null) {
            // Both attempts (fetchCurrentBlockHeight's own retry) failed —
            // fail open rather than block a promptly-signed batch over an
            // unrelated auxiliary-endpoint outage (see the send-loop
            // investigation: a genuinely stale tx sent anyway is caught
            // cleanly by phase 3's confirmation handling either way, never
            // counted as a mint). Not silent, though — this is the one
            // case the guard provides zero protection, worth being able to
            // find in the logs.
            console.warn(
              '[candy-mint] batch blockhash guard unavailable after retry — '
              + `block-height read failed twice (batch size=${signableItemIndexes.length}); `
              + 'guard bypassed, continuing without headroom validation',
            );
          }
        }
        const lastValid = lastValidByItem.get(i);
        if (cachedHeight == null || lastValid == null) return true; // can't evaluate -> fail open, see fetchCurrentBlockHeight's comment
        if (hasBlockhashHeadroom(lastValid, cachedHeight, BLOCKHASH_SAFETY_MARGIN_BLOCKS)) return true;
        items[i] = {
          ...items[i], status: 'expired',
          message: `not sent — blockhash headroom too low (${lastValid - cachedHeight} blocks, need ${BLOCKHASH_SAFETY_MARGIN_BLOCKS}+)`,
        };
        setItems();
        return false;
      };

      await signAllAndSend(
        signableTxs,
        (pos, signature) => {
          const i = signableItemIndexes[pos];
          items[i] = { ...items[i], status: 'confirming', sig: signature };
          setItems();
        },
        shouldSend,
        { sendPath: `${API_BASE}/api/tools/candy-mint/send-tx`, expectWallet: intent.wallet },
      );

      // ── phase 3: confirm each SENT item, then verify its asset (H1) ────
      // Bounded concurrency (each confirm is now an elapsed-time budget of up
      // to ~35s — sequential over 25 items would be pathological). Items the
      // headroom guard skipped never got a signature and are excluded. A
      // landed tx with err != null, one whose asset provably wasn't created
      // (bot-tax), or one that never lands in budget is NOT a mint — its
      // signature + lastValidBlockHeight are retained for reconciliation, the
      // counter is never bumped.
      const toConfirm = signableItemIndexes.filter((i) => {
        const it = items[i];
        return it.sig && it.mint && it.lastValidBlockHeight != null;
      });
      for (const i of toConfirm) items[i] = { ...items[i], status: 'verifying' };
      setItems();
      await runBounded(toConfirm, 5, async (i) => {
        const it = items[i];
        const disp = await resolveSubmitted(it.sig!, {
          asset: it.mint!, lastValidBlockHeight: it.lastValidBlockHeight!, family: intent.family,
        });
        if (disp.kind === 'minted') {
          items[i] = { ...items[i], status: 'success' };
          bumpMintedCount(intent.group);
        } else if (disp.kind === 'not_observed') {
          // landed clean, mint unconfirmed — retain for exact Re-check, gate a re-Mint
          items[i] = {
            ...items[i], status: 'not_observed',
            message: 'landed, mint not confirmed yet — Re-check unresolved',
            unresolved: { signature: it.sig!, lastValidBlockHeight: it.lastValidBlockHeight!, asset: it.mint!, family: intent.family },
          };
        } else if (disp.kind === 'tax_no_mint') {
          items[i] = { ...items[i], status: 'tax_no_mint', message: 'landed but no asset minted — bot-tax confirmed in logs' };
        } else if (disp.kind === 'confirmed_failed') {
          items[i] = { ...items[i], status: 'confirmed_failed', message: normalizeMintErr(disp.err) };
        } else {
          items[i] = { ...items[i], status: 'unconfirmed', message: 'confirmation not observed — Re-check unresolved', unresolved: disp.unresolved };
        }
        setItems();
      });
    } catch (err) {
      // signAllTransactions rejected (e.g. user cancelled the approval), or
      // a send call threw mid-loop — anything not already terminal never
      // got sent. Never auto-retried; re-running Mint builds fresh items.
      const message = humanizeThrownError((err as Error).message);
      const terminal: BatchItemStatus[] = [
        'success', 'expired', 'confirmed_failed', 'tax_no_mint', 'not_observed', 'unconfirmed',
      ];
      for (const i of signableItemIndexes) {
        if (!terminal.includes(items[i].status)) items[i] = { ...items[i], status: 'sign_rejected', message };
      }
      setItems();
    }

    // Release the busy lock whether the batch ran to completion or stopped
    // early on an error/blocked item — otherwise `busy` (tied to
    // flow.kind === 'batch') never clears and the Mint control can't come
    // back to start a new batch.
    setFlow({ kind: 'batch', total, items: [...items], intent, done: true });
  }

  // ── Re-check unresolved (H2) ────────────────────────────────────────────
  // Reconcile every retained unresolved signature by its EXACT signature
  // (searchTransactionHistory) + a fresh block-height read against that tx's
  // own lastValidBlockHeight. No wallet history, no auto-resend. While ANY
  // signature stays ambiguous / can-still-land, the Mint button stays blocked.
  async function handleRecheckUnresolved() {
    if (mintRunningRef.current) return;
    const unresolved = collectUnresolved(flow);
    if (unresolved.length === 0) return;
    const priorFlow = flow;
    const priorIntent: FrozenMintIntent | undefined =
      priorFlow.kind === 'batch' ? priorFlow.intent
        : priorFlow.kind === 'error' ? priorFlow.intent
          : undefined;
    mintRunningRef.current = true;
    setFlow({ kind: 'reconciling' });
    try {
      const height = await fetchCurrentBlockHeight(); // retryOnce; null on outage
      // Each exact signature reconciled INDEPENDENTLY (bounded concurrency).
      const results = await runBounded(unresolved, 4, async (u): Promise<OneReconcileResult> => {
        const { cls } = await pollTxStatus(u.signature); // exact sig; backend uses searchTransactionHistory
        const disp = classifyReconcile({ statusClass: cls, currentBlockHeight: height, lastValidBlockHeight: u.lastValidBlockHeight });
        const mintVerdict = disp === 'landed_ok' ? await verifyMint(u.asset, u.family, u.signature) : null;
        return { u, disp, mintVerdict };
      });

      // Pure fold (tested for idempotency in logic.test.ts): a signature can
      // bump the counter at most once, and only on the pass that first sees
      // 'minted' — which also drops it from stillUnresolved so the gate
      // opens and a further Re-check is a no-op.
      const fold = foldReconcileResults(results);
      for (const _sig of fold.bumps) bumpMintedCount(priorIntent?.group ?? null);

      if (fold.stillUnresolved.length > 0) {
        setFlow({
          kind: 'error', unknown: true, intent: priorIntent,
          unresolved: fold.stillUnresolved[0], sig: fold.stillUnresolved[0].signature,
          message: `${fold.stillUnresolved.length} transaction(s) still unresolved — Mint stays locked. ${fold.notes.join(' · ')}`,
        });
      } else if (fold.bumps.length > 0 && fold.resolvedFailed.length === 0) {
        setFlow({ kind: 'success', sig: fold.bumps[0] });
      } else {
        setFlow({
          kind: 'error', sig: results[0]?.u.signature,
          message: `${fold.notes.join(' · ')} — you can Mint again now.`,
        });
      }
    } catch (err) {
      // Reconcile itself failed — restore the prior unresolved gate.
      if (priorFlow.kind === 'error') {
        setFlow({ ...priorFlow, message: `Re-check failed: ${humanizeThrownError((err as Error).message)}. ${priorFlow.message}` });
      } else {
        setFlow(priorFlow);
      }
    } finally {
      mintRunningRef.current = false;
    }
  }

  function handleMintClick() {
    if (hasUnresolvedInFlow(flow)) { void handleRecheckUnresolved(); return; }
    if (quantity > 1) void handleMintBatch();
    else void handleMint();
  }

  const busy = flow.kind === 'inspecting' || flow.kind === 'minting' || flow.kind === 'reconciling' || (flow.kind === 'batch' && !flow.done);
  // A blind fresh Mint is blocked while any submitted transaction's fate is
  // unknown (H2). The Mint button becomes a "Re-check unresolved" action.
  const mintLockedByUnresolved = hasUnresolvedInFlow(flow);
  // One predicate for the Inspect button's `disabled` AND the inputs'
  // Enter-key handler, so keyboard and click can't drift apart (they did:
  // onKeyDown called handleInspect unconditionally, re-firing while busy).
  const inspectBlocked = inspectDisabled(busy, sig);
  const selected = loaded?.inspection.groups.find((g) => g.label === selectedGroup) ?? null;
  const mintExhausted = selected?.mintLimit != null && selected.mintLimit.remaining === 0;
  const soldOut = loaded != null
    && loaded.inspection.itemsRedeemed != null && loaded.inspection.itemsAvailable != null
    && loaded.inspection.itemsRedeemed === loaded.inspection.itemsAvailable;

  // Live countdown for a group whose `startDate` guard hasn't hit yet, and
  // the symmetric case — a group whose `endDate` has already passed. Both
  // are guaranteed on-chain failures if attempted, not a maybe: a not-yet-
  // live group bot-taxes (MintNotLive), and — confirmed live against a real
  // candy machine (FNYji1B78vKk7QrzCoEAKkS6NkDGsKUGdCV9feM4xmr1, group
  // "public") — an already-ended group hard-reverts with AnchorError
  // AfterEndDate (code 6024), no tax, just a dead simulate. `supported`
  // only tells you the guard *type* is satisfiable from a wallet signature;
  // it says nothing about whether the date window is open right now, so
  // this needs its own gate. Neither state is "closed" (the group still
  // exists and is otherwise mintable), so it must not read identically to
  // the sold-out/closed StatusNotices. Ticks once a second; the guard's own
  // on-chain date is the only source of truth, this just formats/gates
  // against it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const startsAtMs = selected?.startDateUnix != null ? Number(selected.startDateUnix) * 1000 : null;
  const endsAtMs   = selected?.endDateUnix   != null ? Number(selected.endDateUnix)   * 1000 : null;
  const notYetLive = startsAtMs != null && nowMs < startsAtMs;
  const stageEnded = endsAtMs   != null && nowMs >= endsAtMs;

  const mintDisabled = !wallet || busy || !loaded || !loaded.inspection.alive || soldOut || !selected?.supported || mintExhausted || notYetLive || stageEnded;
  // The Mint control's click target: when unresolved txns exist it re-checks
  // them instead (and is NOT disabled by the mint-eligibility gates, only by
  // `busy`).
  const mintCtaDisabled = mintLockedByUnresolved ? busy : mintDisabled;
  const quantityCap = Math.max(1, selected?.mintLimit?.remaining ?? 25);

  // Keeps the selected quantity in bounds as `remaining` shrinks (each
  // confirmed mint, or a wallet switch) — without this, picking e.g. 9 then
  // minting them all left `quantity` stuck at 9 with nothing to clamp it,
  // so the next attempt (now capped at 1 remaining) silently tried to batch
  // 9 anyway. The stepper's own +/- already respect `max`, but that doesn't
  // retroactively fix a value set before the cap dropped.
  useEffect(() => {
    setQuantity((q) => Math.min(Math.max(1, q), quantityCap));
  }, [quantityCap]);

  const heroTitle = loaded?.collectionMeta?.name ?? (loaded ? short(loaded.inspection.candyMachine) : null);
  // SOL and/or token — buildPriceLabel never silently drops a non-SOL leg.
  const priceLabel = buildPriceLabel(
    selected?.solPaymentLamports ?? null,
    selected?.tokenPayment ?? null,
  );

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 20px 60px', ...MONO }}>
      {/* ── utility strip: wallet + (once a drop is loaded) a compact re-loader ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: loaded ? 28 : 16 }}>
        {wallet ? (
          <WalletChip wallet={wallet} onDisconnect={handleDisconnect} />
        ) : (
          <CtaButton onClick={handleConnect}>Connect Phantom</CtaButton>
        )}
        <div style={{ flex: 1 }} />
        {loaded && (
          <>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !inspectBlocked) void handleInspect(); }}
              placeholder="load a different drop by tx signature or NFT address"
              style={{ width: 340, maxWidth: '100%' }}
            />
            <CtaButton onClick={() => void handleInspect()} disabled={inspectBlocked}>
              {flow.kind === 'inspecting' ? 'checking…' : 'Inspect'}
            </CtaButton>
          </>
        )}
      </div>

      {/* ── start screen — centered loader, shown until a drop is loaded ─── */}
      {!loaded && (
        <div
          style={{
            maxWidth: 520, margin: '40px auto 0', padding: '40px 36px', borderRadius: 20, textAlign: 'center',
            background: `radial-gradient(140% 160% at 50% 0%, ${alpha(VL.purpleDeep, 0.16)} 0%, transparent 60%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.08)} 0%, rgba(0,0,0,0.5) 100%)`,
            border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.1)}`,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: rgb(VL.purpleTint), marginBottom: 10 }}>
            VictoryLabs · Candy Mint
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: VLText.primary, margin: '0 0 10px' }}>Candy Machine Direct Mint</h1>
          <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: '0 0 22px' }}>
            Direct on-chain minting, no frontend needed. Paste a recent mint tx signature — or any NFT address from the drop — to load it.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !inspectBlocked) void handleInspect(); }}
              placeholder="mint transaction signature or NFT address"
              big
              style={{ flex: 1 }}
            />
            <CtaButton onClick={() => void handleInspect()} disabled={inspectBlocked} big>
              {flow.kind === 'inspecting' ? 'checking…' : 'Inspect'}
            </CtaButton>
          </div>
          {flow.kind === 'error' && (
            <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 16 }}>{flow.message}</div>
          )}
        </div>
      )}

      {/* ── launchpad hero — stays mounted through the whole mint flow ──── */}
      {loaded && (
        <div
          style={{
            position: 'relative', borderRadius: 20, overflow: 'hidden', marginBottom: 20,
            background: `radial-gradient(120% 140% at 15% 10%, ${alpha(VL.purpleDeep, 0.18)} 0%, transparent 55%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.09)} 0%, rgba(0,0,0,0.55) 100%)`,
            border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.12)}`,
          }}
        >
          {/* padding/gap clamp + min(340px,100%) square thumb so the hero
              never forces horizontal page scroll below ~400px; desktop
              (>=~800px inner width) still gets the full 32px / 340px. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'clamp(16px, 4vw, 32px)', padding: 'clamp(16px, 4vw, 32px)' }}>
            <div style={{
              width: 'min(340px, 100%)', aspectRatio: '1 / 1', flexShrink: 0,
              borderRadius: 16, overflow: 'hidden', margin: '0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ItemThumb
                imageUrl={loaded.collectionMeta?.image ?? null}
                color={rgb(VL.purpleTint)}
                abbr={(heroTitle ?? '??').slice(0, 2).toUpperCase()}
                size={340}
              />
            </div>

            <div style={{ flex: '1 1 340px', minWidth: 'min(280px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LiveDot color={loaded.inspection.alive ? rgb(VL.greenStrong) : rgb(VL.gray)} />
                <span style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase',
                  color: loaded.inspection.alive ? rgb(VL.greenStrong) : VLText.muted,
                }}>
                  {loaded.inspection.alive ? 'Minting now' : 'Closed — no longer mintable'}
                </span>
                <span style={{ fontSize: 10, color: VLText.muted, border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`, borderRadius: 4, padding: '1px 6px' }}>
                  {loaded.family === 'core' ? 'MPL CORE' : 'TOKEN METADATA'}
                </span>
              </div>

              <h1 style={{ fontSize: 30, fontWeight: 800, color: VLText.primary, margin: 0, lineHeight: 1.15 }}>
                {heroTitle}
              </h1>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {loaded.collectionMeta?.creator && (
                  <Pill label={`by ${short(loaded.collectionMeta.creator)}`} color={rgb(VL.purpleTint)} />
                )}
                <Pill label="on Solana" color={rgb(VL.purpleTint)} />
                <Pill label={short(loaded.inspection.candyMachine)} title="candy machine" color={rgb(VL.gray)} />
                {loaded.siblings.length > 0 && (
                  <Pill
                    label={`${siblingsOpen ? '▾' : '▸'} siblings (${loaded.siblings.length})`}
                    active={siblingsOpen}
                    color={rgb(VL.purpleTint)}
                    onClick={() => setSiblingsOpen((o) => !o)}
                    title="Other candy machines pointed at this same collection"
                  />
                )}
              </div>

              {loaded.collectionMeta?.description && (
                <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: 0, maxWidth: 480 }}>
                  {loaded.collectionMeta.description}
                </p>
              )}

              {loaded.inspection.alive && loaded.inspection.groups.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {loaded.inspection.groups.map((g) => (
                    <Pill
                      key={g.label ?? '__root__'}
                      label={g.label ?? '(root)'}
                      active={selectedGroup === g.label}
                      color={g.supported ? hex(VL.greenStrong) : hex(VL.redStrong)}
                      onClick={() => setSelectedGroup(g.label)}
                      title={g.supported ? g.enabledGuards.join(', ') : `unsupported: ${g.unsupportedGuards.join(', ')}`}
                    />
                  ))}
                </div>
              )}

              {selected && !selected.supported && (
                <StatusNotice tone="warning">
                  This group needs more than a wallet signature (unsupported: {selected.unsupportedGuards.join(', ')}) — can't mint it from here.
                </StatusNotice>
              )}

              {/* Explicit reasons the mint control is missing — a blank gap
                  where the button used to be reads as "is the page broken?"
                  to anyone who doesn't already know this tool's premise
                  (machines close/sell out). Say so plainly instead. Boxed
                  as a distinct notice, not plain prose — at the same
                  font-size/color as the collection description this read
                  as the same kind of element, when it's a status, not copy. */}
              {!loaded.inspection.alive && (
                <StatusNotice>
                  This candy machine is closed — it no longer exists on-chain (fully minted, or the drop ended).
                </StatusNotice>
              )}
              {loaded.inspection.alive && soldOut && (
                <StatusNotice>
                  Fully minted ({loaded.inspection.itemsRedeemed}/{loaded.inspection.itemsAvailable}) — nothing left to mint.
                </StatusNotice>
              )}

              {/* Other candy machines on the SAME collection — catches
                  "phase 2" drops nothing else links to (see CLOIDS,
                  2026-09-16: a second CM sat fully unminted for 18 days).
                  Secondary/bonus info, not core to the mint flow — collapsed
                  behind the "siblings (N)" pill above by default so it
                  doesn't crowd the hero; expand state is per-Inspect only. */}
              {siblingsOpen && loaded.siblings.length > 0 && (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
                  padding: '9px 11px', borderRadius: 8,
                  background: alpha(VL.purpleTint, 0.06), border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
                }}>
                  {loaded.siblings.map((s) => {
                    const open = s.itemsRedeemed < s.itemsAvailable;
                    return (
                      <div key={s.candyMachine} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                        <span style={{ color: open ? rgb(VL.greenStrong) : VLText.muted }}>{open ? '●' : '○'}</span>
                        <span style={{ color: VLText.primary, fontWeight: 600 }}>{short(s.candyMachine)}</span>
                        <span style={{ color: VLText.muted }}>
                          {s.itemsRedeemed}/{s.itemsAvailable} · {s.family === 'core' ? 'MPL CORE' : 'TOKEN METADATA'}
                        </span>
                        <div style={{ flex: 1 }} />
                        <CtaButton
                          onClick={() => void handleInspect({ candyMachine: s.candyMachine, candyGuard: s.candyGuard })}
                          disabled={busy}
                        >
                          Load
                        </CtaButton>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── mint control — the ONE spot that morphs through the flow ── */}
              {loaded.inspection.alive && !soldOut && selected?.supported && (
                <div style={{ marginTop: 8 }}>
                  {mintLockedByUnresolved ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <CtaButton onClick={() => void handleRecheckUnresolved()} disabled={busy} big>
                        {flow.kind === 'reconciling' ? 're-checking…' : 'Re-check unresolved'}
                      </CtaButton>
                      <span style={{ fontSize: 11, color: rgb(VL.purpleTint) }}>
                        Mint is locked — an earlier transaction hasn&apos;t been confirmed and could still land.
                      </span>
                    </div>
                  ) : flow.kind === 'ready_to_sign' ? (
                    <ReadyToSignControl
                      flow={flow}
                      busy={busy}
                      onConfirm={handleConfirmSign}
                      onCancel={() => setFlow({ kind: 'idle' })}
                    />
                  ) : flow.kind === 'batch' && !flow.done ? (
                    <BatchControl flow={flow} />
                  ) : flow.kind === 'reconciling' ? (
                    <StatusNotice>Re-checking unresolved transactions…</StatusNotice>
                  ) : mintExhausted ? (
                    <StatusNotice>
                      You've hit your mint limit on this wallet ({selected?.mintLimit?.limit}/{selected?.mintLimit?.limit}) — switch wallets to mint more.
                    </StatusNotice>
                  ) : notYetLive ? (
                    <StatusNotice>
                      {selected?.label ? `"${selected.label}"` : 'This stage'} opens in{' '}
                      <span style={{ ...MONO, fontWeight: 700, color: rgb(VL.purpleTint) }}>
                        {formatCountdown(startsAtMs! - nowMs)}
                      </span>
                      {priceLabel ? ` — ${priceLabel}` : ''}
                    </StatusNotice>
                  ) : stageEnded ? (
                    <StatusNotice>
                      {selected?.label ? `"${selected.label}"` : 'This stage'} has ended — pick another group above, if one's still open.
                    </StatusNotice>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <QuantityStepper value={quantity} max={quantityCap} onChange={setQuantity} disabled={busy} />
                      <CtaButton onClick={handleMintClick} disabled={mintDisabled} big>
                        {flow.kind === 'minting'
                          ? flow.step
                          : quantity > 1
                            ? `Mint ×${quantity}`
                            : priceLabel
                              ? `Mint for ${priceLabel}`
                              : 'Mint'}
                      </CtaButton>
                    </div>
                  )}

                  {flow.kind === 'success' && (
                    <div style={{ fontSize: 12, color: rgb(VL.greenStrong), marginTop: 10 }}>
                      Minted —{' '}
                      <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
                        {short(flow.sig)}
                      </a>
                    </div>
                  )}
                  {flow.kind === 'error' && (
                    // 'unknown' (never observed landing) renders neutral, not
                    // red — it must not read as a definite on-chain failure.
                    <div style={{ fontSize: 12, color: flow.unknown ? rgb(VL.purpleTint) : rgb(VL.redStrong), marginTop: 10 }}>
                      {flow.message}
                      {flow.sig && (
                        <>
                          {' — '}
                          <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
                            {short(flow.sig)}
                          </a>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: VLText.faint, marginTop: 10 }}>
                {loaded.inspection.itemsRedeemed != null && (
                  <>{loaded.inspection.itemsRedeemed} minted{loaded.inspection.itemsAvailable ? ` / ${loaded.inspection.itemsAvailable}` : ''}</>
                )}
                {selected?.mintLimit && (
                  <> · {selected.mintLimit.limit} per wallet{selected.mintLimit.remaining != null ? ` (${selected.mintLimit.remaining} left for you)` : ''}</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── on-chain detail (address-level, collapsed under the hero) ──── */}
      {loaded && (
        <div style={{ fontSize: 11, color: VLText.faint, marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <span>candyMachine: {short(loaded.inspection.candyMachine)}</span>
          <span>candyGuard: {short(loaded.inspection.candyGuard)}</span>
          {loaded.inspection.collection && <span>collection: {short(loaded.inspection.collection)}</span>}
        </div>
      )}
    </div>
  );
}

const ALPHA_BORDER = 0.28;

const BATCH_STATUS_COLOR: Record<BatchItemStatus, string> = {
  pending: VLText.faint,
  building: VLText.muted,
  simulating: VLText.muted,
  ready: VLText.muted,
  rebuilding: VLText.muted,
  auditing: VLText.muted,
  signing: rgb(VL.purpleTint),
  confirming: rgb(VL.purpleTint),
  verifying: rgb(VL.purpleTint),
  success: rgb(VL.greenStrong),
  blocked: rgb(VL.redStrong),
  precheck_failed: rgb(VL.redStrong),
  rebuild_failed: rgb(VL.redStrong),
  audit_failed: rgb(VL.redStrong),
  sign_rejected: rgb(VL.redStrong),
  confirmed_failed: rgb(VL.redStrong),
  tax_no_mint: rgb(VL.redStrong),
  // Neutral lavender, not red — status genuinely unknown / deliberately not
  // sent, not a known failure.
  expired: rgb(VL.purpleTint),
  unconfirmed: rgb(VL.purpleTint),
  not_observed: rgb(VL.purpleTint),
};

// Compact display text — several statuses are named for precision
// (precheck_failed vs rebuild_failed vs confirmed_failed) but don't need
// that much width in a dense per-item row.
const BATCH_STATUS_LABEL: Record<BatchItemStatus, string> = {
  pending: 'pending',
  building: 'building',
  simulating: 'simulating',
  ready: 'ready',
  rebuilding: 'rebuilding',
  auditing: 'auditing',
  signing: 'signing',
  confirming: 'confirming',
  verifying: 'verifying',
  success: 'success',
  blocked: 'blocked',
  precheck_failed: 'pre-check failed',
  rebuild_failed: 'rebuild failed',
  audit_failed: 'audit failed',
  sign_rejected: 'rejected',
  expired: 'not sent',
  confirmed_failed: 'failed',
  tax_no_mint: 'no asset minted',
  unconfirmed: 'unconfirmed',
  not_observed: 'asset unverified',
};

function BatchStatusBadge({ status }: { status: BatchItemStatus }) {
  return <span style={{ color: BATCH_STATUS_COLOR[status], minWidth: 92, display: 'inline-block' }}>{BATCH_STATUS_LABEL[status]}</span>;
}

// A boxed, bordered notice — distinct from the collection's own description
// paragraph, which is plain flowing prose at the same neutral tone. Without
// this the two read as the same kind of element (same size/color), even
// though one is body copy and the other is a status about why there's no
// Mint button right now.
function StatusNotice({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning'; children: React.ReactNode }) {
  const accent = tone === 'warning' ? VL.redStrong : VL.purpleTint;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 7,
      fontSize: 11.5, fontWeight: 600, color: tone === 'warning' ? rgb(VL.redStrong) : VLText.primary,
      lineHeight: 1.5, padding: '9px 11px', borderRadius: 8, marginTop: 8,
      background: alpha(accent, 0.08), border: `1px solid ${alpha(accent, ALPHA_BORDER)}`,
    }}>
      <span style={{ color: rgb(accent), flexShrink: 0, marginTop: 1 }}>{tone === 'warning' ? '⚠' : '●'}</span>
      <span>{children}</span>
    </div>
  );
}

// Replaces the quantity+Mint row in place — cost line + Sign & Send button,
// exactly where the Mint button was, per how a real launchpad's own button
// morphs into a confirm state rather than opening a separate view.
function ReadyToSignControl({ flow, busy, onConfirm, onCancel }: {
  flow: { kind: 'ready_to_sign'; solDeltaLamports: number | null; botTaxDetected: boolean; tokenCostLabel: string | null };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 10.5, color: VLText.muted }}>
          {flow.botTaxDetected
            ? '⚠ bot-tax path — do not sign'
            : flow.tokenCostLabel
              ? 'Simulated SOL change + fixed token price'
              : 'Simulated cost (pre-signature)'}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: flow.botTaxDetected ? rgb(VL.redStrong) : rgb(VL.greenStrong) }}>
          {flow.solDeltaLamports != null ? `${(flow.solDeltaLamports / 1e9).toFixed(5)} SOL` : 'unknown'}
          {flow.tokenCostLabel ? ` + ${flow.tokenCostLabel}` : ''}
        </span>
      </div>
      <CtaButton onClick={onConfirm} disabled={busy || flow.botTaxDetected} big>
        {busy ? 'signing' : 'Sign & Send'}
      </CtaButton>
      <ToolButton onClick={onCancel} disabled={busy}>
        Cancel
      </ToolButton>
    </div>
  );
}

function BatchControl({ flow }: { flow: { kind: 'batch'; total: number; items: BatchItem[]; intent: FrozenMintIntent } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: VLText.muted }}>
        Minting {flow.items.filter((it) => it.status === 'success').length}/{flow.total}
        {' '}(one Phantom approval for all of them):
      </div>
      {flow.items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: VLText.faint, width: 22 }}>#{i + 1}</span>
          <BatchStatusBadge status={it.status} />
          {it.solDeltaLamports != null
            && (['ready', 'rebuilding', 'auditing', 'signing', 'confirming', 'verifying', 'success'] as BatchItemStatus[]).includes(it.status) && (
            <span style={{ color: rgb(VL.greenStrong), fontWeight: 600 }}>
              {(it.solDeltaLamports / 1e9).toFixed(5)} SOL{it.tokenCostLabel ? ` + ${it.tokenCostLabel}` : ''}
            </span>
          )}
          {/* The ACTUAL rebuilt asset address — set once rebuild succeeds,
              never the discarded phase-1 build's. */}
          {it.mint && (
            <span style={{ color: VLText.faint }} title={it.mint}>
              → {short(it.mint)}
            </span>
          )}
          {it.sig && (
            <a href={`https://solscan.io/tx/${it.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
              {short(it.sig)}
            </a>
          )}
          {/* Message color follows the row's own status color — an
              'unconfirmed' message must not read as red/definite-failure. */}
          {it.message && <span style={{ color: BATCH_STATUS_COLOR[it.status] }}>{it.message}</span>}
        </div>
      ))}
    </div>
  );
}

function QuantityStepper({ value, max, onChange, disabled }: {
  value: number; max: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const clamp = (v: number) => Math.max(1, Math.min(max, v));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
      borderRadius: 8, overflow: 'hidden', height: 40,
    }}>
      <StepperButton onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= 1}>−</StepperButton>
      <div style={{ width: 40, textAlign: 'center', fontSize: 15, fontWeight: 700, color: VLText.primary }}>{value}</div>
      <StepperButton onClick={() => onChange(clamp(value + 1))} disabled={disabled || value >= max}>+</StepperButton>
    </div>
  );
}

function StepperButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 36, height: 40, border: 'none', background: 'transparent',
        color: disabled ? VLText.faint : VLText.primary, fontSize: 16, cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

// Reusable-by-design (not wired into other /tools pages yet): a green-dot
// pill with click-to-copy address + inline disconnect, replacing the plain
// "Connected: 71pWA…vFTPs" + underlined-text-link pattern this page (and
// every other /tools page) previously copied.
function WalletChip({ wallet, onDisconnect }: { wallet: string; onDisconnect: () => void }) {
  const [copied, setCopied] = useState(false);
  const [hoverX, setHoverX] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(wallet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '5px 6px 5px 10px', borderRadius: 20,
      background: alpha(VL.greenStrong, ALPHA.tintWeak),
      border: `1px solid ${alpha(VL.greenStrong, ALPHA.border)}`,
    }}>
      <LiveDot color={rgb(VL.greenStrong)} />
      <button
        onClick={copy}
        title={wallet}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 12, fontWeight: 600, color: copied ? rgb(VL.greenStrong) : VLText.primary,
        }}
      >
        {copied ? 'copied!' : short(wallet)}
      </button>
      <button
        onClick={onDisconnect}
        onMouseEnter={() => setHoverX(true)}
        onMouseLeave={() => setHoverX(false)}
        title="Disconnect"
        style={{
          background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', lineHeight: 1,
          fontSize: 14, color: hoverX ? VLText.primary : VLText.faint, transition: 'color 0.12s',
        }}
      >
        ×
      </button>
    </div>
  );
}

