'use client';

// Magic Eden item-level bid tool — personal use only. ME's own web UI has
// disabled placing NEW offers on Solana; this page calls ME's public
// Instruction API directly (GET /instructions/buy, /buy_change_price,
// /buy_cancel, /withdraw) to build the same transactions, then signs via
// Phantom and submits through this tool's OWN dedicated, digest-verified
// submit endpoint — never the generic, unauthenticated-content
// `/api/tools/mmm-pools/send-tx` proxy (see src/server/tools-me-bids.ts
// header for why: that proxy accepts arbitrary client base64 with zero
// validation, which is unsafe to reuse for a tool that builds its own
// transactions from a third-party API response). The read-only
// `/api/tools/mmm-pools/tx-status` endpoint IS reused below for
// confirmation polling — it only ever queries a signature's status, it
// never accepts or executes a transaction, so it doesn't carry the same
// risk.
//
// Safety model:
//   - DRY RUN is the default and always available (build + simulate, no
//     wallet signature ever requested).
//   - LIVE mode (Sign & Submit) is gated FIRST by the SERVER
//     (GET /status -> liveEnabled, driven by the ME_BIDS_ENABLE_LIVE env
//     var) — this page never assumes LIVE is available; it reflects
//     whatever the server reports. The localStorage toggle below that is
//     UX-only preference layered on top, not a security boundary.
//   - Every build/* response is bound to a single-use, server-issued
//     SHA-256 "digest" of the exact unsigned message bytes. Signing
//     happens locally against those exact bytes; submit sends the signed
//     bytes back together with the digest, and the server rejects if
//     they don't match, are expired, or were already used.
//   - This process never touches a private key; Phantom signs locally.
//
// Lifecycle: cancelling an offer does NOT return escrow SOL — the bid
// amount stays in the buyer's M2 escrow until a separate withdraw-escrow
// build/submit. This page tracks an explicit per-bid lifecycle state
// (see `LifecycleState`) so a cancelled offer is never presented as
// "funds returned"; the final `reconciled` state is only reached after a
// real escrow withdrawal has been confirmed.

import { useEffect, useState } from 'react';
import { Transaction } from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ADDR_RE, short } from '@/app/tools/mmm-shared';
import { VL, rgb } from '@/lib/palette';

const LIVE_MODE_KEY = 'vl.meBids.liveMode';
const RECORDS_KEY = 'vl.meBids.records';

type Tab = 'create' | 'change-price' | 'cancel' | 'withdraw-escrow' | 'my-offers';

// ── Non-secret cancellation context — exactly what build/create returns.
// Safe to persist: public on-chain addresses/values only. ──────────────────
interface CancellationContext {
  buyer: string;
  tokenMint: string;
  price: number;
  auctionHouseAddress: string;
  tradeStatePda: string;
  escrowPda: string;
}

// ── Explicit lifecycle — cancelling alone NEVER reaches `reconciled`.
// See file header. ──────────────────────────────────────────────────────
type LifecycleState =
  | 'built' | 'simulated' | 'submitted' | 'confirmed' | 'indexed'
  | 'cancelled' | 'cancel_confirmed'
  | 'escrow_withdraw_built' | 'escrow_withdrawn' | 'reconciled';

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  built: 'built',
  simulated: 'simulated',
  submitted: 'create submitted',
  confirmed: 'create confirmed on-chain',
  indexed: "confirmed + visible in ME's index",
  cancelled: 'cancel submitted',
  cancel_confirmed: 'cancel confirmed — escrow SOL NOT yet returned',
  escrow_withdraw_built: 'withdrawal built, not yet signed',
  escrow_withdrawn: 'withdrawal confirmed on-chain',
  reconciled: 'reconciled — escrow SOL returned to wallet',
};

interface BidRecord {
  context: CancellationContext;
  state: LifecycleState;
  createSig?: string;
  cancelSig?: string;
  withdrawSig?: string;
  updatedAt: number;
}

function recordKey(buyer: string, mint: string): string {
  return `${buyer}:${mint}`;
}
function loadRecords(): Record<string, BidRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    return raw ? JSON.parse(raw) as Record<string, BidRecord> : {};
  } catch { return {}; }
}
function saveRecord(rec: BidRecord) {
  const all = loadRecords();
  all[recordKey(rec.context.buyer, rec.context.tokenMint)] = rec;
  localStorage.setItem(RECORDS_KEY, JSON.stringify(all));
}

interface BuildSummaryCreate {
  action: 'create'; buyer: string; tokenMint: string; priceSol: number;
  requestedExpiry: number | null; effectiveExpiry: number | null;
  auctionHouseAddress: string; auctionHouseSource: string; tradeStatePda: string;
  escrowBalanceBeforeSol: number | null; escrowBalanceAfterSimSol: number | null;
}
interface BuildSummaryChangePrice {
  action: 'change-price'; buyer: string; tokenMint: string; oldPriceSol: number; newPriceSol: number;
  auctionHouseAddress: string; pdaAddress: string; resolvedFrom: 'me_index' | 'local_context';
  escrowBalanceAfterSimSol: number | null;
}
interface BuildSummaryCancel {
  action: 'cancel'; buyer: string; tokenMint: string; priceSol: number;
  auctionHouseAddress: string; pdaAddress: string; resolvedFrom: 'me_index' | 'local_context';
  escrowUnaffected: true;
}
interface BuildSummaryWithdraw {
  action: 'withdraw-escrow'; buyer: string; auctionHouseAddress: string; escrowPda: string;
  amountSol: number; escrowBalanceBeforeSol: number | null; escrowBalanceAfterSimSol: number | null;
}
type BuildSummary = BuildSummaryCreate | BuildSummaryChangePrice | BuildSummaryCancel | BuildSummaryWithdraw;

interface Built {
  tx: string; digest: string; expiresAt: number; summary: BuildSummary; preflightLogs: string[];
  cancellationContext?: CancellationContext;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | ({ kind: 'built' } & Built)
  | ({ kind: 'simulating' } & Built)
  | ({ kind: 'simulated' } & Built & { simErr: unknown; simLogs: string[]; unitsConsumed: number | null })
  | ({ kind: 'signing' } & Built)
  | { kind: 'success'; sig: string; action: BuildSummary['action'] }
  | { kind: 'error'; message: string };

interface MeOffer {
  pdaAddress?: string; tokenMint?: string; auctionHouse?: string; buyer?: string; price?: number; expiry?: number;
}

function humanizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  if (m.includes('offer_not_found_and_no_fallback_context')) return 'No active offer found (Magic Eden index) and no local cancellation context available for this mint.';
  if (m.includes('offer_not_found')) return 'No active offer found for this wallet on this mint.';
  if (m.includes('me_api_key_not_configured')) return 'ME API key not configured on the server.';
  if (m.includes('me_api_cooldown_active') || m.includes('me_api_rate_limited')) return 'Magic Eden API is rate-limited right now — try again shortly.';
  if (m.includes('live_mode_disabled_server_side')) return 'LIVE mode is disabled on the server (ME_BIDS_ENABLE_LIVE is not set to true).';
  if (m.includes('digest_not_found_expired_or_already_used')) return 'This build expired or was already used — build again.';
  if (m.includes('digest_expired')) return 'This build expired — build again.';
  if (m.includes('signed_tx_message_does_not_match_digest')) return 'Signed transaction did not match what was built — build again.';
  if (m.includes('auction_house_unresolved')) return 'Could not find an existing offer or listing for this mint to determine the auction house.';
  if (m.includes('preflight_simulation_failed')) return 'Server-side preflight simulation failed — this transaction would not succeed on-chain right now.';
  if (m.includes('blockhash_expired')) return 'This build’s blockhash has expired — build again and sign promptly.';
  if (m.includes('blockhash_near_expiry')) return 'This build’s blockhash is about to expire — build again and sign promptly.';
  if (m.includes('blockhash_mismatch')) return 'Transaction blockhash changed unexpectedly — build again.';
  if (m.includes('invalid_signature')) return 'Signature verification failed — the signed transaction was not valid for this wallet.';
  if (m.includes('withdrawal_exceeds_known_escrow_balance') || m.includes('withdrawal_amount_exceeds_expected')) {
    return 'Requested withdrawal amount exceeds the known escrow balance.';
  }
  if (m.includes('unexpected_signer') || m.includes('missing_buyer_signature') || m.includes('missing_or_wrong_signature')) {
    return 'Unexpected or missing signature — build again and sign with the connected wallet.';
  }
  return message;
}

export default function MeBidsPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [serverLiveEnabled, setServerLiveEnabled] = useState<boolean | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [tab, setTab] = useState<Tab>('create');
  const [mint, setMint] = useState('');
  const [priceSol, setPriceSol] = useState('');
  const [newPriceSol, setNewPriceSol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [withdrawAh, setWithdrawAh] = useState('');
  const [withdrawAmountSol, setWithdrawAmountSol] = useState('');
  const [withdrawBalance, setWithdrawBalance] = useState<number | null>(null);
  const [myOffers, setMyOffers] = useState<MeOffer[] | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);
  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [records, setRecords] = useState<Record<string, BidRecord>>({});

  useEffect(() => {
    setLiveMode(localStorage.getItem(LIVE_MODE_KEY) === '1');
    setRecords(loadRecords());
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
    void fetch(`${API_BASE}/api/tools/me-bids/status`, { headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j: { ok: boolean; liveEnabled?: boolean }) => setServerLiveEnabled(j.ok ? !!j.liveEnabled : false))
      .catch(() => setServerLiveEnabled(false));
  }, []);

  const liveAvailable = serverLiveEnabled === true && liveMode;

  const activeRecord = wallet && mint ? records[recordKey(wallet, mint)] : undefined;

  function persistRecord(rec: BidRecord) {
    saveRecord(rec);
    setRecords(loadRecords());
  }

  function handleToggleLiveMode() {
    if (!serverLiveEnabled) return;
    if (!liveMode) {
      const ok = window.confirm(
        'LIVE mode lets this tool ask your wallet to sign and submit REAL, irreversible Solana ' +
        'transactions that move real SOL — one explicit confirmation per transaction, never automatic.\n\n' +
        'DRY RUN (build + simulate, no signature ever requested) stays available either way.\n\n' +
        'Enable LIVE mode?'
      );
      if (!ok) return;
      localStorage.setItem(LIVE_MODE_KEY, '1');
      setLiveMode(true);
    } else {
      localStorage.setItem(LIVE_MODE_KEY, '0');
      setLiveMode(false);
    }
  }

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }
  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setUiState({ kind: 'idle' });
  }

  async function loadMyOffers() {
    if (!wallet) return;
    setOffersLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-bids/my-offers?wallet=${wallet}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; offers?: MeOffer[]; error?: string };
      if (j.ok) setMyOffers(j.offers ?? []);
      else setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    } finally {
      setOffersLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'my-offers' && wallet) void loadMyOffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, wallet]);

  // Auto-populate + auto-fetch the withdraw tab's auction house / balance
  // from the active record for the current mint, or from whatever the
  // operator already typed.
  useEffect(() => {
    if (tab !== 'withdraw-escrow' || !wallet) return;
    if (activeRecord && !withdrawAh) setWithdrawAh(activeRecord.context.auctionHouseAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, wallet, activeRecord]);

  useEffect(() => {
    if (tab !== 'withdraw-escrow' || !wallet || !ADDR_RE.test(withdrawAh)) { setWithdrawBalance(null); return; }
    const t = setTimeout(() => {
      void fetch(`${API_BASE}/api/tools/me-bids/escrow-balance?wallet=${wallet}&auctionHouseAddress=${withdrawAh}`, { headers: { ...authHeaders() } })
        .then((r) => r.json())
        .then((j: { ok: boolean; balanceSol?: number | null }) => setWithdrawBalance(j.ok ? j.balanceSol ?? null : null))
        .catch(() => setWithdrawBalance(null));
    }, 400);
    return () => clearTimeout(t);
  }, [tab, wallet, withdrawAh]);

  function switchTab(t: Tab) {
    setTab(t);
    setUiState({ kind: 'idle' });
    setConfirmChecked(false);
  }

  function jumpTo(t: Tab, m: string) {
    setMint(m);
    switchTab(t);
  }

  async function handleBuild() {
    if (!wallet) return;
    setConfirmChecked(false);
    setUiState({ kind: 'building' });
    try {
      let path = '';
      let body: Record<string, unknown> = {};
      if (tab === 'withdraw-escrow') {
        if (!ADDR_RE.test(withdrawAh)) { setUiState({ kind: 'error', message: 'Enter a valid auction house address.' }); return; }
        const amt = Number(withdrawAmountSol);
        if (!(amt > 0)) { setUiState({ kind: 'error', message: 'Enter a withdrawal amount greater than 0.' }); return; }
        path = '/api/tools/me-bids/build/withdraw-escrow';
        body = { buyer: wallet, auctionHouseAddress: withdrawAh, amountSol: amt };
      } else {
        if (!ADDR_RE.test(mint)) { setUiState({ kind: 'error', message: 'Enter a valid mint address.' }); return; }
        if (tab === 'create') {
          const p = Number(priceSol);
          if (!(p > 0)) { setUiState({ kind: 'error', message: 'Enter a price greater than 0.' }); return; }
          path = '/api/tools/me-bids/build/create';
          body = { buyer: wallet, tokenMint: mint, priceSol: p, expiry: expiry.trim() ? Number(expiry) : undefined };
        } else if (tab === 'change-price') {
          const p = Number(newPriceSol);
          if (!(p > 0)) { setUiState({ kind: 'error', message: 'Enter a new price greater than 0.' }); return; }
          path = '/api/tools/me-bids/build/change-price';
          body = { buyer: wallet, tokenMint: mint, newPriceSol: p, cancellationContext: activeRecord?.context };
        } else if (tab === 'cancel') {
          path = '/api/tools/me-bids/build/cancel';
          body = { buyer: wallet, tokenMint: mint, cancellationContext: activeRecord?.context };
        } else {
          return;
        }
      }
      const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      const j = await r.json() as {
        ok: boolean; tx?: string; digest?: string; expiresAt?: number; summary?: BuildSummary;
        preflight?: { logs?: string[] }; cancellationContext?: CancellationContext; error?: string;
      };
      if (!j.ok || !j.tx || !j.digest || !j.expiresAt || !j.summary) {
        setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      setUiState({
        kind: 'built', tx: j.tx, digest: j.digest, expiresAt: j.expiresAt, summary: j.summary,
        preflightLogs: j.preflight?.logs ?? [], cancellationContext: j.cancellationContext,
      });
      if (tab === 'withdraw-escrow' && activeRecord) {
        persistRecord({ ...activeRecord, state: 'escrow_withdraw_built', updatedAt: Date.now() });
      }
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSimulate() {
    if (uiState.kind !== 'built' && uiState.kind !== 'simulated') return;
    const built: Built = uiState;
    setUiState({ kind: 'simulating', ...built });
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-bids/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tx: built.tx }),
      });
      const j = await r.json() as { ok: boolean; err?: unknown; logs?: string[]; unitsConsumed?: number | null; error?: string };
      if (!j.ok) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'simulated', ...built, simErr: j.err ?? null, simLogs: j.logs ?? [], unitsConsumed: j.unitsConsumed ?? null });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSignSubmit() {
    if (uiState.kind !== 'simulated' || !confirmChecked) return;
    const built: Built = uiState;
    if (Date.now() > built.expiresAt) {
      setUiState({ kind: 'error', message: 'This build expired — build again.' });
      return;
    }
    setUiState({ kind: 'signing', ...built });
    try {
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom wallet not found. Install the Phantom extension.');
      const tx = Transaction.from(Buffer.from(built.tx, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedTx = signed.serialize({ requireAllSignatures: true }).toString('base64');

      const r = await fetch(`${API_BASE}/api/tools/me-bids/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ signedTx, digest: built.digest }),
      });
      const j = await r.json() as { ok: boolean; signature?: string; error?: string };
      if (!j.ok || !j.signature) {
        setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      const action = built.summary.action;
      setUiState({ kind: 'success', sig: j.signature, action });
      setConfirmChecked(false);

      // Advance the tracked lifecycle for this bid — never mark "reconciled"
      // from a cancel alone.
      if (action === 'create' && built.cancellationContext) {
        persistRecord({ context: built.cancellationContext, state: 'submitted', createSig: j.signature, updatedAt: Date.now() });
      } else if (action === 'cancel' && activeRecord) {
        persistRecord({ ...activeRecord, state: 'cancelled', cancelSig: j.signature, updatedAt: Date.now() });
      } else if (action === 'withdraw-escrow' && activeRecord) {
        persistRecord({ ...activeRecord, withdrawSig: j.signature, updatedAt: Date.now() });
      }
      if (wallet) void loadMyOffers();
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  /** Best-effort, manually-triggered confirmation check — reuses the
   *  existing read-only tx-status endpoint (queries a signature's status
   *  only, never submits anything). Advances the tracked lifecycle state
   *  one step; never skips straight to "reconciled". */
  async function checkConfirmation(rec: BidRecord, which: 'create' | 'cancel' | 'withdraw') {
    const sig = which === 'create' ? rec.createSig : which === 'cancel' ? rec.cancelSig : rec.withdrawSig;
    if (!sig) return;
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/tx-status?sig=${sig}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; found?: boolean; confirmationStatus?: string | null; err?: unknown };
      if (!j.ok || !j.found || j.err != null) return;
      const landed = j.confirmationStatus === 'confirmed' || j.confirmationStatus === 'finalized';
      if (!landed) return;
      if (which === 'create' && rec.state === 'submitted') {
        persistRecord({ ...rec, state: 'confirmed', updatedAt: Date.now() });
      } else if (which === 'cancel' && rec.state === 'cancelled') {
        persistRecord({ ...rec, state: 'cancel_confirmed', updatedAt: Date.now() });
      } else if (which === 'withdraw' && rec.state === 'escrow_withdraw_built') {
        persistRecord({ ...rec, state: 'escrow_withdrawn', updatedAt: Date.now() });
      } else if (which === 'withdraw') {
        // Any confirmed withdraw signature reaches the final state.
        persistRecord({ ...rec, state: 'reconciled', updatedAt: Date.now() });
      }
    } catch { /* best-effort only */ }
  }

  async function checkIndexed(rec: BidRecord) {
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-bids/offers?mint=${rec.context.tokenMint}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; offers?: MeOffer[] };
      if (!j.ok) return;
      const found = (j.offers ?? []).some((o) => o.buyer === rec.context.buyer);
      if (found && rec.state === 'confirmed') persistRecord({ ...rec, state: 'indexed', updatedAt: Date.now() });
    } catch { /* best-effort only */ }
  }

  const busy = uiState.kind === 'building' || uiState.kind === 'simulating' || uiState.kind === 'signing';
  const built = uiState.kind === 'built' || uiState.kind === 'simulating' || uiState.kind === 'simulated' || uiState.kind === 'signing';
  const summary = built ? (uiState as Built).summary : null;
  const preflightLogs = built ? (uiState as Built).preflightLogs : [];
  const simulated = uiState.kind === 'simulated';
  const simFailed = simulated && uiState.simErr != null;

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px 60px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>ME Bids — item-level offers</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 16 }}>
        Direct Instruction-API bid tool — bypasses ME&apos;s disabled web UI. Item-level bids only
        (create / change price / cancel / withdraw escrow). No MMM pool or collection-bid creation here.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        {!wallet ? (
          <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
            <DisconnectLink onClick={handleDisconnect} />
          </div>
        )}
        <ModeToggle liveMode={liveMode} serverLiveEnabled={serverLiveEnabled} onToggle={handleToggleLiveMode} />
      </div>
      {serverLiveEnabled === false && (
        <div style={{ fontSize: 10.5, color: '#6e6688', marginBottom: 16 }}>
          LIVE mode is disabled on the server (ME_BIDS_ENABLE_LIVE is not set) — build &amp; simulate only.
        </div>
      )}
      {serverLiveEnabled !== false && <div style={{ marginBottom: 16 }} />}

      {activeRecord && tab !== 'my-offers' && (
        <LifecycleBanner
          record={activeRecord}
          onCheckConfirm={(which) => void checkConfirmation(activeRecord, which)}
          onCheckIndexed={() => void checkIndexed(activeRecord)}
          onJumpWithdraw={() => switchTab('withdraw-escrow')}
        />
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabButton active={tab === 'create'} onClick={() => switchTab('create')}>Create bid</TabButton>
        <TabButton active={tab === 'change-price'} onClick={() => switchTab('change-price')}>Change price</TabButton>
        <TabButton active={tab === 'cancel'} onClick={() => switchTab('cancel')}>Cancel</TabButton>
        <TabButton active={tab === 'withdraw-escrow'} onClick={() => switchTab('withdraw-escrow')}>Withdraw escrow</TabButton>
        <TabButton active={tab === 'my-offers'} onClick={() => switchTab('my-offers')}>My offers</TabButton>
      </div>

      {tab !== 'my-offers' && tab !== 'withdraw-escrow' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <label style={labelStyle}>
              token mint
              <input style={inputStyle} value={mint} onChange={(e) => setMint(e.target.value)} placeholder="mint address" disabled={busy} />
            </label>
            {tab === 'create' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={labelStyle}>
                  price (SOL)
                  <input style={inputStyle} type="number" min={0} step="0.0001" value={priceSol} onChange={(e) => setPriceSol(e.target.value)} disabled={busy} />
                </label>
                <label style={labelStyle}>
                  expiry (unix s, optional)
                  <input style={inputStyle} value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="leave blank for ME's default" disabled={busy} />
                </label>
              </div>
            )}
            {tab === 'change-price' && (
              <label style={labelStyle}>
                new price (SOL)
                <input style={inputStyle} type="number" min={0} step="0.0001" value={newPriceSol} onChange={(e) => setNewPriceSol(e.target.value)} disabled={busy} />
              </label>
            )}
            {tab === 'cancel' && (
              <div style={{ ...PANEL, padding: 10, fontSize: 10.5, color: rgb(VL.violetLight), marginBottom: 0 }}>
                Cancelling frees this offer but does <b>not</b> return the bid SOL — it stays in your
                M2 escrow. Use the &quot;Withdraw escrow&quot; tab afterward to reclaim it.
              </div>
            )}
            {activeRecord && (tab === 'change-price' || tab === 'cancel') && (
              <div style={{ fontSize: 10, color: '#6e6688' }}>
                Using locally-retained context from this wallet&apos;s own create ({short(activeRecord.context.tradeStatePda)}) —
                works even if Magic Eden&apos;s read index hasn&apos;t caught up yet.
              </div>
            )}
          </div>

          <PrimaryButton onClick={handleBuild} disabled={!wallet || busy || !mint}>
            {uiState.kind === 'building' ? 'building…' : 'Build (dry-run)'}
          </PrimaryButton>

          {summary && <SummaryPanel summary={summary} />}
          {built && preflightLogs.length > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--vl-green-primary)', marginTop: -8, marginBottom: 12 }}>
              ✓ server-side preflight simulation passed at build time
            </div>
          )}

          <BuildSimulateSubmit
            built={built} busy={busy} uiState={uiState} liveAvailable={liveAvailable} serverLiveEnabled={serverLiveEnabled}
            simulated={simulated} simFailed={!!simFailed} confirmChecked={confirmChecked} setConfirmChecked={setConfirmChecked}
            onSimulate={handleSimulate} onSignSubmit={handleSignSubmit}
          />
        </>
      )}

      {tab === 'withdraw-escrow' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <label style={labelStyle}>
              auction house address
              <input style={inputStyle} value={withdrawAh} onChange={(e) => setWithdrawAh(e.target.value)} placeholder="auction house address" disabled={busy} />
            </label>
            {withdrawBalance != null && (
              <div style={{ fontSize: 11, color: '#a8a2c0' }}>
                current escrow balance: <b style={{ color: '#e8e4f8' }}>{withdrawBalance.toFixed(6)} SOL</b>
              </div>
            )}
            <label style={labelStyle}>
              amount to withdraw (SOL)
              <input style={inputStyle} type="number" min={0} step="0.0001" value={withdrawAmountSol} onChange={(e) => setWithdrawAmountSol(e.target.value)} disabled={busy} />
            </label>
            {withdrawBalance != null && Number(withdrawAmountSol) > 0 && (
              <div style={{ fontSize: 11, color: '#8a84a4' }}>
                expected resulting balance: {(withdrawBalance - Number(withdrawAmountSol)).toFixed(6)} SOL
              </div>
            )}
          </div>

          <PrimaryButton onClick={handleBuild} disabled={!wallet || busy || !withdrawAh || !withdrawAmountSol}>
            {uiState.kind === 'building' ? 'building…' : 'Build (dry-run)'}
          </PrimaryButton>

          {summary && <SummaryPanel summary={summary} />}
          {built && preflightLogs.length > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--vl-green-primary)', marginTop: -8, marginBottom: 12 }}>
              ✓ server-side preflight simulation passed at build time
            </div>
          )}

          <BuildSimulateSubmit
            built={built} busy={busy} uiState={uiState} liveAvailable={liveAvailable} serverLiveEnabled={serverLiveEnabled}
            simulated={simulated} simFailed={!!simFailed} confirmChecked={confirmChecked} setConfirmChecked={setConfirmChecked}
            onSimulate={handleSimulate} onSignSubmit={handleSignSubmit}
          />
        </>
      )}

      {tab === 'my-offers' && (
        <MyOffersPanel
          offers={myOffers}
          loading={offersLoading}
          wallet={wallet}
          onRefresh={loadMyOffers}
          onChangePrice={(m) => jumpTo('change-price', m)}
          onCancel={(m) => jumpTo('cancel', m)}
        />
      )}
    </div>
  );
}

function BuildSimulateSubmit({
  built, busy, uiState, liveAvailable, serverLiveEnabled, simulated, simFailed, confirmChecked, setConfirmChecked,
  onSimulate, onSignSubmit,
}: {
  built: boolean; busy: boolean; uiState: UiState; liveAvailable: boolean; serverLiveEnabled: boolean | null;
  simulated: boolean; simFailed: boolean; confirmChecked: boolean; setConfirmChecked: (v: boolean) => void;
  onSimulate: () => void; onSignSubmit: () => void;
}) {
  return (
    <>
      {built && (
        <PrimaryButton onClick={onSimulate} disabled={busy}>
          {uiState.kind === 'simulating' ? 'simulating…' : 'Simulate again'}
        </PrimaryButton>
      )}

      {simulated && uiState.kind === 'simulated' && (
        <SimResultPanel err={uiState.simErr} logs={uiState.simLogs} unitsConsumed={uiState.unitsConsumed} />
      )}

      {simulated && !liveAvailable && (
        <div style={{ ...PANEL, padding: 12, fontSize: 11.5, color: rgb(VL.violetLight) }}>
          DRY RUN mode — no signature has been requested.
          {serverLiveEnabled ? ' Switch to LIVE mode above to sign & submit.' : ' LIVE mode is disabled on the server.'}
        </div>
      )}

      {simulated && liveAvailable && (
        <div style={{ ...PANEL, padding: 12 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: '#e8e4f8', cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              I understand this will submit a <b>real, irreversible</b> on-chain transaction
              {simFailed ? ' — and the simulation above FAILED, so this will very likely fail too.' : '.'}
            </span>
          </label>
          <div style={{ marginTop: 10 }}>
            <PrimaryButton onClick={onSignSubmit} disabled={!confirmChecked || busy} danger={simFailed}>
              {busy ? 'signing…' : 'Sign & Submit'}
            </PrimaryButton>
          </div>
        </div>
      )}

      {uiState.kind === 'success' && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#0f0' }}>
          Confirmed:{' '}
          <a href={`https://solscan.io/tx/${uiState.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: '#6cf' }}>
            {short(uiState.sig)}
          </a>
          {uiState.action === 'cancel' && (
            <div style={{ color: '#f7b955', marginTop: 4 }}>
              Offer cancelled — the bid SOL is still in your M2 escrow. Go to &quot;Withdraw escrow&quot; to reclaim it.
            </div>
          )}
        </div>
      )}
      {uiState.kind === 'error' && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#f66' }}>Error: {uiState.message}</div>
      )}
    </>
  );
}

function LifecycleBanner({ record, onCheckConfirm, onCheckIndexed, onJumpWithdraw }: {
  record: BidRecord;
  onCheckConfirm: (which: 'create' | 'cancel' | 'withdraw') => void;
  onCheckIndexed: () => void;
  onJumpWithdraw: () => void;
}) {
  const escrowReturned = record.state === 'escrow_withdrawn' || record.state === 'reconciled';
  return (
    <div style={{ ...PANEL, padding: 10, fontSize: 11, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--vl-purple-tint)', fontWeight: 700 }}>lifecycle: {LIFECYCLE_LABEL[record.state]}</span>
        <span style={{ color: escrowReturned ? 'var(--vl-green-primary)' : '#f7b955' }}>
          {escrowReturned ? '✓ escrow returned' : '● escrow NOT yet returned'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
        {record.state === 'submitted' && <DisconnectLink onClick={() => onCheckConfirm('create')}>check confirmation</DisconnectLink>}
        {record.state === 'confirmed' && <DisconnectLink onClick={onCheckIndexed}>check ME index</DisconnectLink>}
        {record.state === 'cancelled' && <DisconnectLink onClick={() => onCheckConfirm('cancel')}>check cancel confirmation</DisconnectLink>}
        {record.state === 'escrow_withdraw_built' && <DisconnectLink onClick={() => onCheckConfirm('withdraw')}>check withdrawal confirmation</DisconnectLink>}
        {(record.state === 'cancel_confirmed' || record.state === 'cancelled') && (
          <DisconnectLink onClick={onJumpWithdraw}>withdraw escrow now</DisconnectLink>
        )}
      </div>
    </div>
  );
}

function SummaryPanel({ summary }: { summary: BuildSummary }) {
  const rows: Array<[string, string]> = [];
  rows.push(['action', summary.action]);
  rows.push(['buyer', summary.buyer]);
  rows.push(['auction house', summary.auctionHouseAddress]);
  if (summary.action === 'create') {
    rows.push(['mint', summary.tokenMint]);
    rows.push(['price', `${summary.priceSol} SOL`]);
    rows.push(['requested expiry', summary.requestedExpiry == null ? "(ME's default)" : String(summary.requestedExpiry)]);
    rows.push(['effective expiry (from sim)', summary.effectiveExpiry == null ? 'unknown' : String(summary.effectiveExpiry)]);
    rows.push(['auction house source', summary.auctionHouseSource]);
    rows.push(['trade-state pda', summary.tradeStatePda]);
    if (summary.escrowBalanceBeforeSol != null) rows.push(['escrow balance before', `${summary.escrowBalanceBeforeSol.toFixed(6)} SOL`]);
    if (summary.escrowBalanceAfterSimSol != null) rows.push(['escrow balance after (simulated)', `${summary.escrowBalanceAfterSimSol.toFixed(6)} SOL`]);
  } else if (summary.action === 'change-price') {
    rows.push(['mint', summary.tokenMint]);
    rows.push(['old price', `${summary.oldPriceSol} SOL`]);
    rows.push(['new price', `${summary.newPriceSol} SOL`]);
    rows.push(['offer pda', summary.pdaAddress]);
    rows.push(['resolved from', summary.resolvedFrom === 'me_index' ? "Magic Eden's live index" : 'local saved context']);
    if (summary.escrowBalanceAfterSimSol != null) rows.push(['escrow balance after (simulated)', `${summary.escrowBalanceAfterSimSol.toFixed(6)} SOL`]);
  } else if (summary.action === 'cancel') {
    rows.push(['mint', summary.tokenMint]);
    rows.push(['price (stays in escrow)', `${summary.priceSol} SOL`]);
    rows.push(['offer pda', summary.pdaAddress]);
    rows.push(['resolved from', summary.resolvedFrom === 'me_index' ? "Magic Eden's live index" : 'local saved context']);
  } else {
    rows.push(['escrow pda', summary.escrowPda]);
    rows.push(['amount', `${summary.amountSol} SOL`]);
    if (summary.escrowBalanceBeforeSol != null) rows.push(['escrow balance before', `${summary.escrowBalanceBeforeSol.toFixed(6)} SOL`]);
    if (summary.escrowBalanceAfterSimSol != null) rows.push(['escrow balance after (simulated)', `${summary.escrowBalanceAfterSimSol.toFixed(6)} SOL`]);
  }
  return (
    <div style={{ ...PANEL, padding: 12, fontSize: 11.5 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderBottom: '1px solid rgb(var(--vl-purple-tint) / 0.10)' }}>
          <span style={{ color: '#8a84a4' }}>{k}</span>
          <span style={{ color: '#e8e4f8', wordBreak: 'break-all', textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function SimResultPanel({ err, logs, unitsConsumed }: { err: unknown; logs: string[]; unitsConsumed: number | null }) {
  const ok = err == null;
  return (
    <div style={{ ...PANEL, padding: 12, fontSize: 11.5 }}>
      <div style={{ color: ok ? '#0f0' : '#f66', fontWeight: 700, marginBottom: 6 }}>
        {ok ? '✓ simulation succeeded' : '✗ simulation failed'}
      </div>
      {!ok && <div style={{ color: '#f66', marginBottom: 6, wordBreak: 'break-all' }}>{JSON.stringify(err)}</div>}
      {unitsConsumed != null && <div style={{ color: '#8a84a4', marginBottom: 6 }}>compute units: {unitsConsumed}</div>}
      <div style={{ fontSize: 10, color: '#6e6688', marginBottom: 6 }}>
        Simulated without a real signature (sigVerify off) — this checks that the transaction would
        succeed against current chain state (funds, PDAs, program logic), not that your wallet is the
        one signing. That part is guaranteed separately: only your connected wallet can produce a
        signature Phantom will accept.
      </div>
      {logs.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--vl-purple-tint)' }}>program logs ({logs.length})</summary>
          <pre style={{ fontSize: 10, color: '#8a84a4', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
            {logs.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

function MyOffersPanel({ offers, loading, wallet, onRefresh, onChangePrice, onCancel }: {
  offers: MeOffer[] | null; loading: boolean; wallet: string | null;
  onRefresh: () => void; onChangePrice: (mint: string) => void; onCancel: (mint: string) => void;
}) {
  if (!wallet) return <div style={{ fontSize: 12, color: '#a8a2c0' }}>Connect a wallet to see your active offers.</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 11.5, color: '#a8a2c0' }}>{loading ? 'loading…' : `${offers?.length ?? 0} active offer(s)`}</div>
        <DisconnectLink onClick={onRefresh}>refresh</DisconnectLink>
      </div>
      {(offers ?? []).map((o) => (
        <div key={o.pdaAddress ?? o.tokenMint} style={{ ...PANEL, padding: 10, fontSize: 11.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: '#e8e4f8' }}>{o.tokenMint ? short(o.tokenMint) : '(unknown mint)'}</span>
            <span style={{ color: '#0f0' }}>{o.price != null ? `${o.price} SOL` : '?'}</span>
          </div>
          <div style={{ color: '#6e6688', fontSize: 10, marginTop: 4 }}>
            expiry: {o.expiry == null || o.expiry === -1 ? 'none' : o.expiry} · pda: {o.pdaAddress ? short(o.pdaAddress) : '?'}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <DisconnectLink onClick={() => o.tokenMint && onChangePrice(o.tokenMint)}>change price</DisconnectLink>
            <DisconnectLink onClick={() => o.tokenMint && onCancel(o.tokenMint)}>cancel</DisconnectLink>
          </div>
        </div>
      ))}
      {offers && offers.length === 0 && !loading && (
        <div style={{ fontSize: 12, color: '#6e6688' }}>No active offers found for this wallet.</div>
      )}
    </div>
  );
}

function ModeToggle({ liveMode, serverLiveEnabled, onToggle }: {
  liveMode: boolean; serverLiveEnabled: boolean | null; onToggle: () => void;
}) {
  const disabled = serverLiveEnabled !== true;
  const active = liveMode && serverLiveEnabled === true;
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      style={{
        padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
        cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 6,
        border: `1px solid ${active ? '#f66' : 'rgb(var(--vl-purple-tint) / 0.4)'}`,
        background: active ? 'rgba(255,102,102,0.12)' : 'rgb(var(--vl-purple-tint) / 0.08)',
        color: active ? '#f66' : 'var(--vl-purple-tint)',
        opacity: disabled ? 0.5 : 1,
      }}
      title={
        disabled
          ? 'LIVE mode is disabled on the server (ME_BIDS_ENABLE_LIVE)'
          : active ? 'Click to switch back to DRY RUN' : 'Click to enable LIVE signing & submission'
      }
    >
      {active ? '● LIVE' : '○ DRY RUN'}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
        border: `1px solid ${active ? 'rgb(var(--vl-purple-tint) / 0.6)' : 'rgb(var(--vl-purple-tint) / 0.2)'}`,
        background: active ? 'rgb(var(--vl-purple-tint) / 0.16)' : 'transparent',
        color: active ? '#e8e4f8' : 'var(--vl-text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ onClick, disabled, danger, children }: {
  onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const filter = disabled ? undefined : active ? 'brightness(0.9)' : hover ? 'brightness(1.12)' : undefined;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        ...btnStyle,
        background: danger ? '#c0392b' : btnStyle.background,
        opacity: disabled ? 0.5 : 1,
        filter,
        outline: 'none',
        transition: 'filter 0.1s',
        marginBottom: 12,
      }}
    >
      {children}
    </button>
  );
}

function DisconnectLink({ onClick, children }: { onClick: () => void; children?: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 10, color: hover ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)',
        background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0,
        transition: 'color 0.12s',
      }}
    >
      {children ?? 'disconnect'}
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: rgb(VL.violet), color: 'var(--vl-white)', border: 'none', borderRadius: 6,
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#b0aac8', display: 'flex', flexDirection: 'column', gap: 4 };
const inputStyle: React.CSSProperties = {
  padding: '6px 8px', fontSize: 13, background: '#111', color: 'var(--vl-white)',
  border: '1px solid #333', borderRadius: 4,
};
