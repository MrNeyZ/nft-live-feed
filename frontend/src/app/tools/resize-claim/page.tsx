'use client';

// Resize / Claim — personal use only. Recovers the Metaplex "TM Resize"
// excess SOL for legacy/pNFT NFTs held by the connecting wallet, without
// depending on resize.metaplex.com's own (slow/unreliable) scanner: we
// enumerate the wallet ourselves via Helius DAS (backend `scan.ts`), then
// only use Metaplex's proof server-action per-mint to fetch the fixed
// payout amount + merkle proof. Backend routes are requireAuth-gated
// (site SIWS + UI_ALLOWED_WALLETS).
//
// 2026-09-12 hardening pass (docs/resize-claim-audit-2026-09-12.md):
// replaces the old "sendTransaction returned a signature -> Done" model
// with an explicit per-transaction pipeline —
//   build -> structural audit -> simulate final bytes -> Phantom sign
//   -> independent per-tx send -> bounded confirmation polling
// — and safe, revalidated retry narrowing. See ./logic.ts and ./audit.ts
// for the pure, independently-tested pieces this page only orchestrates.

import { useCallback, useEffect, useRef, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, assertPhantomWallet } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, short } from '@/app/tools/mmm-shared';
import { VL, rgb } from '@/lib/palette';
import {
  type TxKind, type TxOutcome, type TrackedTx, type SignatureStatusEntry,
  classifyStatus, shouldKeepPolling, reconcileUnresolved, hasBlockhashHeadroom, planPostSignBroadcast,
  planRetry, uiLabel, CONFIRMATION_POLL_INTERVAL_MS,
} from './logic';
import { auditResizeClaimTx, freezeIntent, type FrozenResizeClaimIntent } from './audit';

interface ClaimableItem { mint: string; amountLamports: string; proof: string[]; index: number; }
interface ResizableItem { mint: string; metadataSpace: number; }
interface ScanResult {
  wallet: string;
  scanned: number;
  claimable: ClaimableItem[];
  resizable: ResizableItem[];
  alreadyClaimed: string[];
  proofUnknown: string[];
}

type Phase = 'building' | 'auditing' | 'signing' | 'sending' | 'confirming' | 'done';

/** One entry per window started so far (one Phantom approval = one entry).
 *  `start` is this window's offset into the parallel `tracked`/`outcomes`
 *  arrays; its end is the next entry's `start`, or `tracked.length` for the
 *  last (currently-active-or-just-finished) one. */
interface WindowMeta { index: number; total: number; start: number }

interface RunState {
  scan: ScanResult;
  tracked: TrackedTx[];
  outcomes: Array<TxOutcome | undefined>;
  phase: Phase;
  windows: WindowMeta[];
}

// One claim = one transaction (no packing room — see build.ts's header on
// the 1232-byte wire limit). A single shared blockhash + one /build call
// for hundreds of claims doesn't survive the sequential per-tx /verify
// audit that runs before any signature is requested — by the time Phantom
// is even shown, the blockhash is already dead, so EVERY tx in the batch
// comes back "stale_before_broadcast" together. Confirmed against a
// 795-claim wallet on 2026-09-17: chunking into ~100-item windows (each
// with its OWN fresh /build call, i.e. its own fresh blockhash, right
// before that window's own sign/send/confirm cycle) is within the range
// the user has seen land reliably before (100-200/run); 100 leaves margin.
const CLAIM_WINDOW_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'scanned'; scan: ScanResult }
  | { kind: 'running'; run: RunState }
  | { kind: 'error'; message: string; scan?: ScanResult };

function humanThrow(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

function lamportsToSol(lamports: string | number): string {
  return (Number(lamports) / 1e9).toFixed(5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<T>;
}

/** Resize-claim-scoped send — deliberately NOT the shared
 *  phantom.ts#signAllVersionedAndSend: that function throws on the first
 *  failed send, discarding every later item's outcome (RC-3). This wraps
 *  each item's send independently so one failure never erases another's
 *  result. Touches no shared file. */
async function sendSignedTx(tx: VersionedTransaction): Promise<string> {
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  const j = await postJson<{ ok: boolean; signature?: string; error?: string }>(
    '/api/tools/resize-claim/send-tx', { tx: txBase64 },
  );
  if (!j.ok || !j.signature) throw new Error(j.error ?? 'send failed');
  return j.signature;
}

export default function ResizeClaimPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [ui, setUi] = useState<UiState>({ kind: 'idle' });
  // Guards a background confirmation-poll loop against a NEWER run having
  // started (e.g. the operator hits Retry again) — a stale loop must not
  // paint over a newer run's outcomes.
  const runGenRef = useRef(0);

  useEffect(() => { document.title = 'Resize Claim | VictoryLabs'; }, []);
  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
      void handleScan(pk);
    } catch (e) { setUi({ kind: 'error', message: humanThrow((e as Error).message) }); }
  }
  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setUi({ kind: 'idle' });
  }

  async function handleScan(w: string) {
    setUi({ kind: 'scanning' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/resize-claim/scan?wallet=${w}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; error?: string } & Partial<ScanResult>;
      if (!j.ok) { setUi({ kind: 'error', message: j.error ?? `HTTP ${r.status}` }); return; }
      setUi({ kind: 'scanned', scan: j as ScanResult });
    } catch (e) {
      setUi({ kind: 'error', message: 'Could not reach the backend.' });
    }
  }

  // ── one window's pipeline: build -> audit -> simulate -> sign -> send ->
  //    confirm. `priorTracked`/`priorOutcomes` are the already-finished
  //    windows of this same overall run, kept only so the UI can show one
  //    continuous list — every index/lookup below operates on THIS
  //    window's local `tracked`/`outcomes` alone. Returns the combined
  //    (prior + this window) arrays on success, or `null` if a hard error
  //    aborted the run (already reflected in `ui` as an error state) —
  //    callers must stop looping on `null`.
  const runBatch = useCallback(async (
    scan: ScanResult,
    claims: Array<{ mint: string; amountLamports: string; proof: string[] }>,
    resizes: Array<{ mint: string }>,
    priorTracked: TrackedTx[],
    priorOutcomes: Array<TxOutcome | undefined>,
    priorWindows: WindowMeta[],
    windowInfo: WindowMeta,
  ): Promise<{ tracked: TrackedTx[]; outcomes: Array<TxOutcome | undefined>; windows: WindowMeta[] } | null> => {
    const gen = ++runGenRef.current;
    const isCurrent = () => runGenRef.current === gen;
    const allWindows = [...priorWindows, windowInfo];

    // Prepends the prior windows' already-finished items so the panel
    // reads as one continuous list; every local variable below (`tracked`,
    // `outcomes`, `readyIdx`, `stillFresh`, `sendable`, …) stays indexed to
    // THIS window alone.
    const setRun = (run: { tracked: TrackedTx[]; outcomes: Array<TxOutcome | undefined>; phase: Phase }) => {
      if (isCurrent()) setUi({ kind: 'running', run: {
        scan,
        tracked: [...priorTracked, ...run.tracked],
        outcomes: [...priorOutcomes, ...run.outcomes],
        phase: run.phase,
        windows: allWindows,
      } });
    };
    const combined = (tracked: TrackedTx[], outcomes: Array<TxOutcome | undefined>) =>
      ({ tracked: [...priorTracked, ...tracked], outcomes: [...priorOutcomes, ...outcomes], windows: allWindows });

    try {
      // 1 — build (fresh blockhash every call, never reused across runs)
      setRun({ tracked: [], outcomes: [], phase: 'building' });
      const built = await postJson<{ ok: boolean; error?: string;
        txs?: Array<{ kind: TxKind; txBase64: string; mints: string[] }>;
        blockhash?: string; lastValidBlockHeight?: number }>(
        '/api/tools/resize-claim/build', { wallet, claims, resizes },
      );
      if (!built.ok || !built.txs || built.txs.length === 0) {
        setUi({ kind: 'error', message: built.error ?? 'Nothing to build.', scan });
        return null;
      }
      const tracked: TrackedTx[] = built.txs.map((t, i) => ({
        index: i, kind: t.kind, mints: t.mints, txBase64: t.txBase64,
        blockhash: built.blockhash!, lastValidBlockHeight: built.lastValidBlockHeight!,
      }));
      const outcomes: Array<TxOutcome | undefined> = tracked.map(() => undefined);
      setRun({ tracked, outcomes: [...outcomes], phase: 'auditing' });

      // 2 — structural audit + final-byte simulation, BEFORE any signature
      //     exists. Every reject here means Phantom is never even shown for
      //     that tx.
      const intent: FrozenResizeClaimIntent = freezeIntent(wallet!, claims, resizes);
      const readyIdx: number[] = [];
      for (let i = 0; i < tracked.length; i++) {
        let verify: { ok: boolean; error?: string; alts?: Record<string, string[]>;
          simulation?: { err: unknown; unitsConsumed: number | null; logs: string[] | null } };
        try {
          verify = await postJson('/api/tools/resize-claim/verify', { tx: tracked[i].txBase64 });
          // A 429 from our own rate limiter says nothing about whether this
          // tx would land — it's a client-side throttle, not an audit
          // verdict. Retry with backoff instead of lying to the operator
          // with "Blocked (failed safety check)" for an item that was
          // never actually checked.
          for (let attempt = 0; verify.error === 'rate_limited' && attempt < 5; attempt++) {
            await sleep(500 * 2 ** attempt);
            verify = await postJson('/api/tools/resize-claim/verify', { tx: tracked[i].txBase64 });
          }
        } catch {
          outcomes[i] = { kind: 'send_failed', reason: 'could not reach the backend to verify this transaction' };
          continue;
        }
        if (!verify.ok || !verify.alts || !verify.simulation) {
          outcomes[i] = { kind: 'audit_failed', reason: verify.error ?? 'verification request failed' };
          continue;
        }
        const audited = auditResizeClaimTx(tracked[i].txBase64, { kind: tracked[i].kind, mints: tracked[i].mints }, intent, verify.alts);
        if (!audited.ok) { outcomes[i] = { kind: 'audit_failed', reason: audited.reason }; continue; }
        if (verify.simulation.err != null) { outcomes[i] = { kind: 'simulation_failed', err: verify.simulation.err }; continue; }
        readyIdx.push(i);
      }
      setRun({ tracked, outcomes: [...outcomes], phase: 'auditing' });
      if (readyIdx.length === 0) { setRun({ tracked, outcomes, phase: 'done' }); return combined(tracked, outcomes); }

      // 3 — pre-broadcast blockhash freshness: the operator may have sat in
      //     the Phantom prompt for a while by the time we're about to sign;
      //     check freshness BEFORE requesting the signature too (a second,
      //     tighter check happens again right after signing, below).
      const preSignStatus = await postJson<{ ok: boolean; blockHeight?: number }>(
        '/api/tools/resize-claim/status', { signatures: [] },
      );
      const currentHeightPreSign = preSignStatus.ok ? preSignStatus.blockHeight ?? null : null;
      const stillFresh = readyIdx.filter((i) => currentHeightPreSign == null
        ? true // status lookup failure: fail OPEN here only (pre-broadcast, not reconciliation) — the send/simulate steps already gate correctness; consistent with this repo's established pre-check policy (contrast §12's reconciliation-side fail-closed rule, which is different and stricter)
        : hasBlockhashHeadroom(tracked[i].lastValidBlockHeight, currentHeightPreSign));
      for (const i of readyIdx) {
        if (!stillFresh.includes(i)) outcomes[i] = { kind: 'stale_before_broadcast' };
      }
      if (stillFresh.length === 0) { setRun({ tracked, outcomes, phase: 'done' }); return combined(tracked, outcomes); }

      // 4 — ONE Phantom approval for every audited+simulated+fresh tx.
      //     assertPhantomWallet fails closed if the active account drifted
      //     since the intent was frozen, BEFORE the prompt.
      setRun({ tracked, outcomes: [...outcomes], phase: 'signing' });
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom wallet not connected.');
      assertPhantomWallet(wallet!);
      const unsigned = stillFresh.map((i) => VersionedTransaction.deserialize(Buffer.from(tracked[i].txBase64, 'base64')));
      const signed = await sol.signAllTransactions(unsigned);

      // 4.5 — POST-SIGN freshness re-check. The Phantom approval prompt can
      //     sit open long enough for a transaction that was fresh at step 3
      //     to go stale by the time signAllTransactions() actually returns
      //     — the wallet signature does not extend a blockhash's lifetime.
      //     Re-fetch current blockheight (never a new blockhash — that
      //     would invalidate the signature just obtained) and re-check EACH
      //     signed tx's own ORIGINAL lastValidBlockHeight independently, so
      //     one stale tx in the batch can never hold back the others.
      //
      //     Fail-CLOSED here (unlike step 3's pre-sign check, which fails
      //     open): by this point Phantom has already signed, so the only
      //     cost of refusing to broadcast is asking for one more approval
      //     later — whereas broadcasting a signed tx we cannot PROVE still
      //     has headroom risks sending something that lands ambiguously
      //     (or not at all) with no way to reconcile it, since a tx this
      //     gate blocks is deliberately never given a signature/outcome to
      //     reconcile in the first place (see the `sendable` filter below).
      const postSignStatus = await postJson<{ ok: boolean; blockHeight?: number }>(
        '/api/tools/resize-claim/status', { signatures: [] },
      );
      const currentHeightPostSign = postSignStatus.ok ? postSignStatus.blockHeight ?? null : null;
      const okToBroadcast = planPostSignBroadcast(
        stillFresh.map((i) => ({ lastValidBlockHeight: tracked[i].lastValidBlockHeight })),
        currentHeightPostSign,
      );
      const sendable: number[] = []; // indices into `signed`/`stillFresh` (i.e. "k")
      for (let k = 0; k < stillFresh.length; k++) {
        const i = stillFresh[k];
        if (okToBroadcast[k]) sendable.push(k);
        else outcomes[i] = { kind: 'stale_before_broadcast' }; // NEVER broadcast — no signature/outcome to reconcile, safe to rebuild after revalidation like any other stale_before_broadcast item
      }

      // 5 — independent per-tx send (RC-3): one failure never erases or
      //     blocks any other item's own send attempt or outcome. Only the
      //     post-sign-fresh subset is ever handed to sendSignedTx.
      setRun({ tracked, outcomes: [...outcomes], phase: 'sending' });
      for (let k = 0; k < sendable.length; k++) {
        // Space out sends — back-to-back sendTransaction calls for a
        // 100-tx window trip Helius's own rate limit (the backend's
        // send-tx route retries a 429 too, but pacing here means most
        // sends never need that retry at all).
        if (k > 0) await sleep(150);
        const i = stillFresh[sendable[k]];
        try {
          const signature = await sendSignedTx(signed[sendable[k]]);
          outcomes[i] = { kind: 'unresolved', signature };
        } catch (e) {
          outcomes[i] = { kind: 'send_failed', reason: (e as Error).message };
        }
        setRun({ tracked, outcomes: [...outcomes], phase: 'sending' });
      }

      // 6 — bounded confirmation polling on the EXACT returned signatures.
      //     Never labels "Done" — see ./logic.ts's uiLabel for the exact,
      //     truthful per-outcome copy this renders below.
      setRun({ tracked, outcomes: [...outcomes], phase: 'confirming' });
      const startedAt = Date.now();
      for (;;) {
        const pending = outcomes
          .map((o, i) => ({ o, i }))
          .filter((x): x is { o: Extract<TxOutcome, { kind: 'unresolved' }>; i: number } => x.o?.kind === 'unresolved');
        if (pending.length === 0 || !isCurrent()) break;
        if (!shouldKeepPolling(startedAt, Date.now())) break; // leave remaining as unresolved — never inferred as failed
        await sleep(CONFIRMATION_POLL_INTERVAL_MS);
        if (!isCurrent()) break;
        const statusRes = await postJson<{ ok: boolean; blockHeight?: number; statuses?: Array<SignatureStatusEntry | null> }>(
          '/api/tools/resize-claim/status', { signatures: pending.map((p) => p.o.signature) },
        );
        if (!statusRes.ok || !statusRes.statuses) continue;
        pending.forEach(({ o, i }, k) => {
          const cls = classifyStatus(statusRes.statuses![k]);
          if (cls === 'success') outcomes[i] = { kind: 'confirmed_success', signature: o.signature };
          else if (cls === 'failed') outcomes[i] = { kind: 'confirmed_failure', signature: o.signature, err: statusRes.statuses![k]?.err };
          // pending: leave as unresolved, poll again
        });
        setRun({ tracked, outcomes: [...outcomes], phase: 'confirming' });
      }
      setRun({ tracked, outcomes: [...outcomes], phase: 'done' });
      return combined(tracked, outcomes);
    } catch (e) {
      if (isCurrent()) setUi({ kind: 'error', message: humanThrow((e as Error).message), scan });
      return null;
    }
  }, [wallet]);

  // Splits claims/resizes into CLAIM_WINDOW_SIZE-mint windows and runs them
  // one at a time — each window gets its own runBatch call, hence its own
  // fresh /build call (fresh blockhash) and its own Phantom approval,
  // instead of one shared blockhash across the whole set (see
  // CLAIM_WINDOW_SIZE's comment for why that failed at 795 claims).
  async function runWindowed(
    scan: ScanResult,
    claims: Array<{ mint: string; amountLamports: string; proof: string[] }>,
    resizes: Array<{ mint: string }>,
  ) {
    const claimWindows = chunk(claims, CLAIM_WINDOW_SIZE);
    const resizeWindows = chunk(resizes, CLAIM_WINDOW_SIZE);
    const windowCount = Math.max(claimWindows.length, resizeWindows.length);
    if (windowCount === 0) return;
    let tracked: TrackedTx[] = [];
    let outcomes: Array<TxOutcome | undefined> = [];
    let windows: WindowMeta[] = [];
    for (let w = 0; w < windowCount; w++) {
      const windowClaims = claimWindows[w] ?? [];
      const windowResizes = resizeWindows[w] ?? [];
      const windowInfo: WindowMeta = { index: w + 1, total: windowCount, start: tracked.length };
      const result = await runBatch(scan, windowClaims, windowResizes, tracked, outcomes, windows, windowInfo);
      if (!result) return; // hard error — already surfaced as an error state, stop the remaining windows
      ({ tracked, outcomes, windows } = result);
    }
  }

  async function handleClaimAll() {
    if (!wallet || ui.kind !== 'scanned') return;
    const scan = ui.scan;
    const claims = scan.claimable.map((c) => ({ mint: c.mint, amountLamports: c.amountLamports, proof: c.proof }));
    const resizes = scan.resizable.map((r) => ({ mint: r.mint }));
    await runWindowed(scan, claims, resizes);
  }

  // Re-check a single still-unresolved signature on demand (spec §16) —
  // never blindly retried/rebuilt; only reconciled against its own exact
  // signature + its own original lastValidBlockHeight.
  async function handleRecheck(run: RunState, i: number) {
    const outcome = run.outcomes[i];
    if (!outcome || outcome.kind !== 'unresolved') return;
    const res = await postJson<{ ok: boolean; blockHeight?: number; statuses?: Array<SignatureStatusEntry | null> }>(
      '/api/tools/resize-claim/status', { signatures: [outcome.signature] },
    );
    if (!res.ok || !res.statuses) return;
    const disposition = reconcileUnresolved(res.statuses[0] ?? null, res.blockHeight ?? null, run.tracked[i].lastValidBlockHeight);
    const outcomes = [...run.outcomes];
    if (disposition === 'still_success') outcomes[i] = { kind: 'confirmed_success', signature: outcome.signature };
    else if (disposition === 'still_failed') outcomes[i] = { kind: 'confirmed_failure', signature: outcome.signature, err: res.statuses[0]?.err };
    else if (disposition === 'safe_to_rebuild') outcomes[i] = { kind: 'expired_no_signature_seen', signature: outcome.signature };
    // still_unresolved: leave as-is
    setUi({ kind: 'running', run: { ...run, outcomes } });
  }

  // Retry: narrow to items proven safe (never confirmed_success, never
  // still-unresolved), revalidate each against LIVE chain state, then run
  // a brand-new build/audit/simulate/sign/send/confirm cycle for only
  // what's still actually claimable/resizable.
  async function handleRetry(run: RunState) {
    const plan = planRetry(run.tracked.map((t, i) => ({ mints: t.mints, outcome: run.outcomes[i]! })));
    if (plan.retryCandidateMints.size === 0) return;
    const candidateClaims = run.scan.claimable.filter((c) => plan.retryCandidateMints.has(c.mint));
    const candidateResizes = run.scan.resizable.filter((r) => plan.retryCandidateMints.has(r.mint));
    const revalidated = await postJson<{
      ok: boolean;
      claimable?: Array<{ mint: string; amountLamports: string; proof: string[] }>;
      resizable?: Array<{ mint: string }>;
    }>('/api/tools/resize-claim/revalidate', {
      wallet,
      claims: candidateClaims.map((c) => ({ mint: c.mint, amountLamports: c.amountLamports, proof: c.proof })),
      resizes: candidateResizes.map((r) => ({ mint: r.mint })),
    });
    if (!revalidated.ok) return;
    await runWindowed(run.scan, revalidated.claimable ?? [], revalidated.resizable ?? []);
  }

  const scan = ui.kind === 'scanned' ? ui.scan
    : ui.kind === 'running' ? ui.run.scan
    : ui.kind === 'error' ? ui.scan
    : undefined;

  const totalClaimLamports = scan ? scan.claimable.reduce((s, c) => s + Number(c.amountLamports), 0) : 0;
  const canAct = ui.kind === 'scanned' && (ui.scan.claimable.length > 0 || ui.scan.resizable.length > 0);

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px', paddingBottom: 'var(--bottombar-h, 36px)', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Resize Claim</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 20, lineHeight: 1.5 }}>
        Recovers Metaplex&apos;s &quot;TM Resize&quot; excess rent SOL for your legacy/pNFT holdings —
        the same mechanism as <code style={{ color: '#c2bcd8' }}>resize.metaplex.com</code>, but scanning
        your wallet ourselves instead of relying on their scanner. Connect your wallet to scan.
      </p>

      {!wallet ? (
        <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
          <LinkButton onClick={() => void handleScan(wallet)}>rescan</LinkButton>
          <LinkButton onClick={handleDisconnect}>disconnect</LinkButton>
        </div>
      )}

      {ui.kind === 'scanning' && <div style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 12 }}>scanning wallet…</div>}

      {scan && (
        <div style={{ ...PANEL, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.9 }}>
          <div>scanned: {scan.scanned} legacy/pNFT held</div>
          <div style={{ color: rgb(VL.green) }}>
            claimable: {scan.claimable.length} NFT{scan.claimable.length === 1 ? '' : 's'}
            {scan.claimable.length > 0 && ` → ${lamportsToSol(totalClaimLamports)} SOL`}
          </div>
          <div style={{ color: '#f5c84b' }}>resizable (no reward, frees rent): {scan.resizable.length}</div>
          <div style={{ color: '#8a8498' }}>already claimed / shrunk: {scan.alreadyClaimed.length}</div>
          {scan.proofUnknown.length > 0 && (
            <div style={{ color: '#f66' }}>proof lookup failed (rescan to retry): {scan.proofUnknown.length}</div>
          )}
        </div>
      )}

      {ui.kind === 'error' && (
        <div style={{ fontSize: 12, color: '#f66', marginBottom: 12 }}>Error: {ui.message}</div>
      )}

      {canAct && (
        <PrimaryButton onClick={handleClaimAll}>
          Claim {scan!.claimable.length > 0 ? `${lamportsToSol(totalClaimLamports)} SOL` : ''}
          {scan!.claimable.length > 0 && scan!.resizable.length > 0 ? ' + ' : ''}
          {scan!.resizable.length > 0 ? `resize ${scan!.resizable.length}` : ''}
        </PrimaryButton>
      )}

      {ui.kind === 'running' && (
        <RunPanel run={ui.run} onRecheck={(i) => void handleRecheck(ui.run, i)} onRetry={() => void handleRetry(ui.run)} />
      )}
    </div>
  );
}

const PHASE_LABEL: Record<Phase, string> = {
  building: 'building transactions…',
  auditing: 'auditing + simulating (before any signature is requested)…',
  signing: 'approve in Phantom (one approval covers every checked transaction)…',
  sending: 'sending…',
  confirming: 'confirming…',
  done: 'finished — see the exact outcome of every transaction below',
};

function outcomeColor(outcome: TxOutcome | undefined): string {
  if (!outcome) return '#a8a2c0';
  switch (outcome.kind) {
    case 'confirmed_success': return '#0f0';
    case 'confirmed_failure': return '#f66';
    case 'unresolved': return '#f5c84b';
    case 'expired_no_signature_seen': return '#f5c84b';
    default: return '#8a8498';
  }
}

function RunPanel({ run, onRecheck, onRetry }: {
  run: RunState;
  onRecheck: (index: number) => void;
  onRetry: () => void;
}) {
  // A mid-run window can also sit at phase 'done' for one tick before the
  // next window starts — Retry (and the "landed as wSOL" note below) must
  // wait for the LAST window, not just this one.
  const lastWindow = run.windows[run.windows.length - 1] as WindowMeta | undefined;
  const isFinalWindow = !lastWindow || lastWindow.index === lastWindow.total;
  const hasRetryable = run.phase === 'done' && isFinalWindow && run.tracked.some((_, i) => {
    const o = run.outcomes[i];
    return o && o.kind !== 'confirmed_success' && o.kind !== 'unresolved';
  });

  // One row PER PHANTOM APPROVAL (one window), not one row per tx — a
  // several-hundred-item run is several sequential windows, not several
  // hundred rows. Each window's own detail list (individual failed/pending
  // items) is opt-in via its own expand toggle.
  const ranges = run.windows.map((w, idx) => ({
    meta: w,
    start: w.start,
    end: run.windows[idx + 1]?.start ?? run.tracked.length,
  }));

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 10 }}>{PHASE_LABEL[run.phase]}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ranges.map(({ meta, start, end }) => (
          <WindowRow
            key={meta.index}
            run={run}
            meta={meta}
            start={start}
            end={end}
            live={meta === lastWindow && run.phase !== 'done'}
            onRecheck={onRecheck}
          />
        ))}
      </div>
      {run.phase === 'done' && hasRetryable && (
        <div style={{ marginTop: 12 }}>
          <PrimaryButton onClick={onRetry}>Retry remaining (revalidated, never re-sends anything already confirmed)</PrimaryButton>
        </div>
      )}
      {run.phase === 'done' && isFinalWindow && run.tracked.some((_, i) => run.outcomes[i]?.kind === 'confirmed_success') && (
        <div style={{ color: '#a8a2c0', marginTop: 10, fontSize: 11.5 }}>
          Confirmed claims landed as wSOL in your wallet — unwrap it (close the wSOL account) to get native SOL back.
        </div>
      )}
    </div>
  );
}

function WindowRow({ run, meta, start, end, live, onRecheck }: {
  run: RunState; meta: WindowMeta; start: number; end: number; live: boolean;
  onRecheck: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const idxs: number[] = [];
  for (let i = start; i < end; i++) idxs.push(i);
  const total = idxs.length;
  const confirmed = idxs.filter((i) => run.outcomes[i]?.kind === 'confirmed_success').length;
  const attention = idxs.filter((i) => {
    const o = run.outcomes[i];
    return o && o.kind !== 'confirmed_success' && o.kind !== 'unresolved';
  }).length;
  const pending = total - confirmed - attention; // undefined (in flight) or unresolved

  const summaryColor = attention > 0 ? '#f66' : confirmed === total ? rgb(VL.green) : '#a8a2c0';
  const canExpand = attention > 0 || (pending > 0 && run.phase === 'done');

  return (
    <div style={{ ...PANEL, padding: '8px 10px', fontSize: 11.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#c2bcd8' }}>
          Window {meta.index}/{meta.total}{live ? ` — ${PHASE_LABEL[run.phase]}` : ''}
        </span>
        <span style={{ color: summaryColor, fontWeight: 700 }}>
          {confirmed}/{total} confirmed
          {attention > 0 ? ` · ${attention} need attention` : ''}
          {pending > 0 ? ` · ${pending} pending` : ''}
        </span>
      </div>
      {canExpand && (
        <div style={{ marginTop: 4 }}>
          <LinkButton onClick={() => setExpanded((v) => !v)}>{expanded ? 'hide details' : 'show details'}</LinkButton>
        </div>
      )}
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}>
          {idxs.filter((i) => run.outcomes[i]?.kind !== 'confirmed_success').map((i) => (
            <TxRow
              key={i}
              t={run.tracked[i]}
              outcome={run.outcomes[i]}
              recheckable={run.phase === 'done'}
              onRecheck={() => onRecheck(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TxRow({ t, outcome, recheckable, onRecheck }: {
  t: TrackedTx; outcome: TxOutcome | undefined; recheckable: boolean; onRecheck: () => void;
}) {
  const label = outcome ? uiLabel(outcome) : 'Pending…';
  const signature = outcome && 'signature' in outcome ? outcome.signature : undefined;
  return (
    <div style={{ ...PANEL, padding: '8px 10px', fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: '#c2bcd8' }}>
          {t.kind === 'claim' ? 'Claim' : `Resize ×${t.mints.length}`} — {t.mints.map((m) => short(m)).join(', ')}
        </span>
        <span style={{ color: outcomeColor(outcome), fontWeight: 700 }}>{label}</span>
      </div>
      {signature && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noopener noreferrer" style={{ color: '#6cf' }}>
            {short(signature)}
          </a>
          {outcome?.kind === 'unresolved' && recheckable && (
            <LinkButton onClick={onRecheck}>re-check</LinkButton>
          )}
        </div>
      )}
      {outcome?.kind === 'audit_failed' && (
        <div style={{ color: '#f66', fontSize: 10.5 }}>blocked before signing: {outcome.reason}</div>
      )}
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 16px', fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        background: rgb(VL.violet), color: 'var(--vl-white)', border: 'none', borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
        filter: disabled ? undefined : hover ? 'brightness(1.12)' : undefined,
        transition: 'filter 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 10, color: hover ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)',
        background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0,
      }}
    >
      {children}
    </button>
  );
}
