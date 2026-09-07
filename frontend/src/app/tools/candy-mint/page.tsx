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

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signAllAndSend, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, ToolButton, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { VL, VLText, ALPHA, alpha, rgb, hex } from '@/lib/palette';
import { ItemThumb, LiveDot, Pill, CtaButton } from '@/soloist/shared';
import {
  classifyConfirmation, normalizeMintErr, pickInitialGroup, inspectDisabled,
  buildPriceLabel, tokenCostLabel as tokenCostLabelFor,
  runBounded, partitionRebuildResults, hasBlockhashHeadroom, BLOCKHASH_SAFETY_MARGIN_BLOCKS, retryOnce,
  type ConfirmClass, type TokenPaymentView, type RebuildOutcome,
} from './logic';

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
  mintLimit: MintLimitStatus | null;
  startDateUnix: string | null;
  endDateUnix:   string | null;
  // Present for token-priced groups (tokenPayment / token2022Payment guard).
  // `decimals` is resolved server-side; null when that lookup missed.
  tokenPayment: TokenPaymentView | null;
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

interface LoadedMachine {
  family: CandyMintFamily;
  inspection: Inspection;
  collectionMeta: CollectionMeta | null;
  referenceCollection: string | null;
  referenceCollectionUpdateAuthority: string | null;
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
//   unconfirmed      — submitted, landed status never observed in budget
//   confirmed_failed — submitted, landed with err != null (reverted / guard)
//   success          — submitted, landed with err == null — the only mint
type BatchItemStatus =
  | 'pending' | 'building' | 'simulating' | 'ready'
  | 'rebuilding' | 'signing' | 'expired' | 'confirming'
  | 'success' | 'blocked'
  | 'precheck_failed' | 'rebuild_failed' | 'sign_rejected' | 'confirmed_failed' | 'unconfirmed';

interface BatchItem {
  status: BatchItemStatus;
  sig?: string;
  /** The ACTUAL asset/nftMint address this item will mint into — always
   *  from the rebuild that produced the signed transaction, never phase 1's
   *  (discarded) build. Set once rebuild succeeds; the definitive identity
   *  for this item from that point on. */
  mint?: string;
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
  | { kind: 'minting'; step: 'building' | 'simulating' | 'signing' | 'confirming' }
  | {
      kind: 'ready_to_sign';
      transactionBase64: string;
      solDeltaLamports: number | null;
      botTaxDetected: boolean;
      /** Fixed token price of the selected group (tokenPayment guard), already
       *  human-formatted — the SOL delta above never reflects an SPL spend. */
      tokenCostLabel: string | null;
    }
  | { kind: 'batch'; total: number; items: BatchItem[]; done?: boolean }
  | { kind: 'success'; sig: string }
  // `sig` present when the failure happened after broadcast (landed-but-failed,
  // or unconfirmed) so the user can still inspect the transaction. `unknown`
  // marks the "never observed landing" case — NOT a known on-chain failure —
  // so the renderer can avoid presenting it as a definite failure.
  | { kind: 'error'; message: string; sig?: string; unknown?: boolean };

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

async function waitForConfirmation(signature: string): Promise<ConfirmResult> {
  // 'confirmed' typically lands within ~1 slot (~400-800ms). 15x300ms keeps a
  // ~4.5s worst-case budget while resolving the common case in 1-2 polls.
  for (let attempt = 0; attempt < 15; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
    let cls: ConfirmClass = 'pending';
    let err: unknown = null;
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`, {
        headers: { ...authHeaders() },
      });
      if (r.ok) {
        const d = await r.json() as {
          ok: boolean; found: boolean; confirmationStatus: string | null; err: unknown;
        };
        cls = classifyConfirmation(d);
        err = d.err;
      }
    } catch {
      // transient — treated as pending, retry
    }
    if (cls === 'success') return { status: 'success' };
    if (cls === 'failed') return { status: 'failed', err };
  }
  // Every poll stayed 'pending' (the loop returns early on any terminal) —
  // the tx was submitted but we never observed it land. See
  // outcomeFromPolls / its tests for the timeout contract.
  return { status: 'unknown' };
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

export default function CandyMintPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [sig, setSig] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null | undefined>(undefined);
  const [quantity, setQuantity] = useState(1);
  const [loaded, setLoaded] = useState<LoadedMachine | null>(null);
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
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

  async function handleInspect() {
    if (!sig.trim()) return;
    setFlow({ kind: 'inspecting' });
    setSelectedGroup(undefined);
    setQuantity(1);
    try {
      const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/inspect?sig=${encodeURIComponent(sig.trim())}${walletParam}`, {
        headers: { ...authHeaders() },
      });
      const j = await r.json() as {
        ok: boolean; family?: CandyMintFamily; inspection?: Inspection; collectionMeta?: CollectionMeta | null;
        referenceCollection?: string | null; referenceCollectionUpdateAuthority?: string | null; error?: string;
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

  async function handleMint() {
    if (!wallet || !loaded || selectedGroup === undefined) return;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = loaded;
    const collection = inspection.collection ?? referenceCollection;
    if (!collection) { setFlow({ kind: 'error', message: 'No collection address resolved.' }); return; }
    setFlow({ kind: 'minting', step: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          family,
          candyMachine: inspection.candyMachine,
          candyGuard: inspection.candyGuard,
          collection,
          collectionUpdateAuthority: referenceCollectionUpdateAuthority,
          group: selectedGroup,
          wallet,
        }),
      });
      const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
      if (!j.ok || !j.transactionBase64) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      const transactionBase64 = j.transactionBase64;

      // Phantom won't preview balance changes for an unverified dApp — simulate
      // server-side instead and show the real cost before asking for a signature.
      setFlow({ kind: 'minting', step: 'simulating' });
      const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ transactionBase64, wallet }),
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
        transactionBase64,
        solDeltaLamports: simJ.solDeltaLamports ?? null,
        botTaxDetected: simJ.botTaxDetected ?? false,
        tokenCostLabel: tokenCostLabelFor(selected?.tokenPayment ?? null),
      });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // The mintLimit `used`/`remaining` numbers are a snapshot taken at
  // Inspect time — nothing re-fetches them after a mint lands, so without
  // this the panel keeps showing the pre-mint count forever (looked like a
  // stuck/buggy counter, but it was just never being updated at all).
  // Bumped optimistically per confirmed signature: we know for certain our
  // own mint landed, so there's nothing to wait on a re-fetch for.
  function bumpMintedCount() {
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
            if (g.label !== selectedGroup || !g.mintLimit) return g;
            const used = (g.mintLimit.used ?? 0) + 1;
            return { ...g, mintLimit: { ...g.mintLimit, used, remaining: Math.max(0, g.mintLimit.limit - used) } };
          }),
        },
      };
    });
  }

  async function handleConfirmSign() {
    if (flow.kind !== 'ready_to_sign') return;
    setFlow({ kind: 'minting', step: 'signing' });
    let signature: string;
    try {
      const result = await signSendAndConfirm(flow.transactionBase64);
      signature = result.signature;
    } catch (err) {
      // Rejected / failed before broadcast — no signature to inspect.
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
      return;
    }
    // Broadcast != minted. Only a landed transaction with no on-chain error is
    // a success; a landed-but-failed or never-observed tx is an error that
    // still surfaces the signature, and never bumps the minted counter.
    setFlow({ kind: 'minting', step: 'confirming' });
    const res = await waitForConfirmation(signature);
    if (res.status === 'success') {
      setFlow({ kind: 'success', sig: signature });
      bumpMintedCount();
    } else if (res.status === 'failed') {
      setFlow({ kind: 'error', message: normalizeMintErr(res.err), sig: signature });
    } else {
      setFlow({
        kind: 'error',
        message: 'Confirmation not observed — status unknown. It may still land; check the signature before retrying.',
        sig: signature,
        unknown: true,
      });
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
    if (!wallet || !loaded || selectedGroup === undefined) return;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = loaded;
    const collection = inspection.collection ?? referenceCollection;
    if (!collection) { setFlow({ kind: 'error', message: 'No collection address resolved.' }); return; }

    const total = Math.max(1, Math.floor(quantity));
    const batchTokenCost = tokenCostLabelFor(selected?.tokenPayment ?? null);
    const items: BatchItem[] = Array.from({ length: total }, () => ({ status: 'pending' }));
    setFlow({ kind: 'batch', total, items: [...items] });

    const buildPayload = () => ({
      family,
      candyMachine: inspection.candyMachine,
      candyGuard: inspection.candyGuard,
      collection,
      collectionUpdateAuthority: referenceCollectionUpdateAuthority,
      group: selectedGroup,
      wallet,
    });

    // ── phase 1 (pre-check): build + simulate, stop at the first bad one ──
    for (let i = 0; i < total; i++) {
      items[i] = { status: 'building' };
      setFlow({ kind: 'batch', total, items: [...items] });
      try {
        const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(buildPayload()),
        });
        const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
        if (!j.ok || !j.transactionBase64) {
          items[i] = { status: 'precheck_failed', message: humanizeBackendError(j.error, r.status) };
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }

        items[i] = { status: 'simulating' };
        setFlow({ kind: 'batch', total, items: [...items] });
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
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }
        if (simJ.botTaxDetected) {
          items[i] = { status: 'blocked', message: 'bot-tax path detected — stopped, not signing' };
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }

        // Phase 1's transactionBase64 is intentionally NOT retained —
        // rebuild replaces it below.
        items[i] = { status: 'ready', solDeltaLamports: simJ.solDeltaLamports ?? null, tokenCostLabel: batchTokenCost };
        setFlow({ kind: 'batch', total, items: [...items] });
      } catch (err) {
        items[i] = { status: 'precheck_failed', message: humanizeThrownError((err as Error).message) };
        setFlow({ kind: 'batch', total, items: [...items] });
        break;
      }
    }

    const readyIndexes = items.map((it, i) => (it.status === 'ready' ? i : -1)).filter((i) => i >= 0);
    if (readyIndexes.length === 0) {
      setFlow({ kind: 'batch', total, items: [...items], done: true });
      return;
    }

    // ── phase 1.5 (rebuild): fresh blockhash + fresh asset per item, ──────
    // bounded concurrency (measured: full-parallel vs bounded(5) differed
    // by only ~89ms at 25 items — bounded keeps RPC load predictable for
    // effectively free).
    const REBUILD_CONCURRENCY = 6;
    for (const i of readyIndexes) items[i] = { ...items[i], status: 'rebuilding' };
    setFlow({ kind: 'batch', total, items: [...items] });

    const outcomes = await runBounded(readyIndexes, REBUILD_CONCURRENCY, async (i): Promise<RebuildOutcome> => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(buildPayload()),
        });
        const j = await r.json() as {
          ok: boolean; transactionBase64?: string; blockhash?: string;
          lastValidBlockHeight?: number; asset?: string; error?: string;
        };
        if (!j.ok || !j.transactionBase64 || j.lastValidBlockHeight == null) {
          return { itemIndex: i, ok: false, error: humanizeBackendError(j.error, r.status) };
        }
        return {
          itemIndex: i, ok: true, transactionBase64: j.transactionBase64,
          mint: j.asset, blockhash: j.blockhash, lastValidBlockHeight: j.lastValidBlockHeight,
        };
      } catch (err) {
        return { itemIndex: i, ok: false, error: humanizeThrownError((err as Error).message) };
      }
    });

    // Attach each item's ACTUAL rebuilt mint address now — this is the only
    // place `mint` is ever set, always from that item's own rebuild.
    for (const o of outcomes) {
      items[o.itemIndex] = o.ok
        ? { ...items[o.itemIndex], mint: o.mint }
        : { ...items[o.itemIndex], status: 'rebuild_failed', message: `rebuild failed: ${o.error}` };
    }
    setFlow({ kind: 'batch', total, items: [...items] });

    const { signableItemIndexes, signableTxs } = partitionRebuildResults(readyIndexes, outcomes);
    const lastValidByItem = new Map(
      outcomes.filter((o): o is RebuildOutcome & { lastValidBlockHeight: number } => o.ok && o.lastValidBlockHeight != null)
        .map((o) => [o.itemIndex, o.lastValidBlockHeight]),
    );

    if (signableItemIndexes.length === 0) {
      setFlow({ kind: 'batch', total, items: [...items], done: true });
      return;
    }

    // ── phase 2: one Phantom approval for every rebuilt item ────────────
    try {
      for (const i of signableItemIndexes) items[i] = { ...items[i], status: 'signing' };
      setFlow({ kind: 'batch', total, items: [...items] });

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
        setFlow({ kind: 'batch', total, items: [...items] });
        return false;
      };

      await signAllAndSend(
        signableTxs,
        (pos, signature) => {
          const i = signableItemIndexes[pos];
          items[i] = { ...items[i], status: 'confirming', sig: signature };
          setFlow({ kind: 'batch', total, items: [...items] });
        },
        shouldSend,
      );

      // ── phase 3: wait for each SENT item to land, in submission order ──
      // Items the headroom guard skipped never got a signature (`sig`
      // stays unset) and are correctly excluded here — they were never
      // broadcast, so there's nothing to confirm. A confirmed tx with
      // err != null (reverted / guard hard-error) or one that never lands
      // within the budget is NOT a mint — mark it accordingly, keep its
      // signature, never bump the counter.
      for (const i of signableItemIndexes) {
        const sig = items[i].sig;
        if (!sig) continue;
        const res = await waitForConfirmation(sig);
        if (res.status === 'success') {
          items[i] = { ...items[i], status: 'success' };
          bumpMintedCount();
        } else if (res.status === 'failed') {
          items[i] = { ...items[i], status: 'confirmed_failed', message: normalizeMintErr(res.err) };
        } else {
          items[i] = { ...items[i], status: 'unconfirmed', message: 'confirmation not observed — status unknown, check signature' };
        }
        setFlow({ kind: 'batch', total, items: [...items] });
      }
    } catch (err) {
      // signAllTransactions rejected (e.g. user cancelled the approval), or
      // a send call threw mid-loop — anything not already terminal never
      // got sent. Never auto-retried; re-running Mint builds fresh items.
      const message = humanizeThrownError((err as Error).message);
      const terminal: BatchItemStatus[] = ['success', 'expired', 'confirmed_failed', 'unconfirmed'];
      for (const i of signableItemIndexes) {
        if (!terminal.includes(items[i].status)) items[i] = { ...items[i], status: 'sign_rejected', message };
      }
      setFlow({ kind: 'batch', total, items: [...items] });
    }

    // Release the busy lock whether the batch ran to completion or stopped
    // early on an error/blocked item — otherwise `busy` (tied to
    // flow.kind === 'batch') never clears and the Mint control can't come
    // back to start a new batch.
    setFlow({ kind: 'batch', total, items: [...items], done: true });
  }

  function handleMintClick() {
    if (quantity > 1) void handleMintBatch();
    else void handleMint();
  }

  const busy = flow.kind === 'inspecting' || flow.kind === 'minting' || (flow.kind === 'batch' && !flow.done);
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
              placeholder="load a different drop by reference tx signature"
              style={{ width: 340, maxWidth: '100%' }}
            />
            <CtaButton onClick={handleInspect} disabled={inspectBlocked}>
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
            Direct on-chain minting, no frontend needed. Paste a recent mint tx to load the drop.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !inspectBlocked) void handleInspect(); }}
              placeholder="mint transaction signature"
              big
              style={{ flex: 1 }}
            />
            <CtaButton onClick={handleInspect} disabled={inspectBlocked} big>
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

              {/* ── mint control — the ONE spot that morphs through the flow ── */}
              {loaded.inspection.alive && !soldOut && selected?.supported && (
                <div style={{ marginTop: 8 }}>
                  {flow.kind === 'ready_to_sign' ? (
                    <ReadyToSignControl
                      flow={flow}
                      busy={busy}
                      onConfirm={handleConfirmSign}
                      onCancel={() => setFlow({ kind: 'idle' })}
                    />
                  ) : flow.kind === 'batch' && !flow.done ? (
                    <BatchControl flow={flow} />
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
  signing: rgb(VL.purpleTint),
  confirming: rgb(VL.purpleTint),
  success: rgb(VL.greenStrong),
  blocked: rgb(VL.redStrong),
  precheck_failed: rgb(VL.redStrong),
  rebuild_failed: rgb(VL.redStrong),
  sign_rejected: rgb(VL.redStrong),
  confirmed_failed: rgb(VL.redStrong),
  // Neutral lavender, not red — status genuinely unknown / deliberately not
  // sent, not a known failure.
  expired: rgb(VL.purpleTint),
  unconfirmed: rgb(VL.purpleTint),
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
  signing: 'signing',
  confirming: 'confirming',
  success: 'success',
  blocked: 'blocked',
  precheck_failed: 'pre-check failed',
  rebuild_failed: 'rebuild failed',
  sign_rejected: 'rejected',
  expired: 'not sent',
  confirmed_failed: 'failed',
  unconfirmed: 'unconfirmed',
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

function BatchControl({ flow }: { flow: { kind: 'batch'; total: number; items: BatchItem[] } }) {
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
            && (['ready', 'rebuilding', 'signing', 'confirming', 'success'] as BatchItemStatus[]).includes(it.status) && (
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

