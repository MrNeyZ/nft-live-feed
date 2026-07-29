'use client';

// Magic Eden MMM collection-bid tool — personal use only. Builds COLLECTION
// offers (buy-side MMM pools) — see /tools/me-bids for the separate,
// unrelated single-mint item-level offer tool.
//
// Every instruction (create/deposit/update/withdraw/close) is built RAW
// on-chain server-side (src/server/mmm-raw-instructions.ts) — Magic Eden's
// own `/instructions/mmm/create-pool` is Cloudflare-blocked. Two signers
// are required on every lifecycle transaction: a dedicated, narrowly-scoped
// server-held cosigner (partial-signed at build time, never able to move
// funds or act alone) and the pool owner (signed here via Phantom). The
// backend independently re-verifies both signatures before ever
// broadcasting — see src/server/tools-mmm-collection-bids.ts header.
//
// Safety model mirrors /tools/me-bids:
//   - DRY RUN is the default (build + simulate, no signature ever requested).
//   - LIVE mode is gated FIRST by the server (GET /status -> liveEnabled,
//     driven by MMM_COLLECTION_BIDS_ENABLE_LIVE) — this page only reflects
//     what the server reports; the localStorage toggle is UX-only.
//   - Every build/* response is bound to a single-use, server-issued digest
//     of the exact unsigned message bytes; submit rejects any mismatch,
//     expiry, or replay.
//
// Quantity model: MMM has no native "quantity" field — a buy-side pool's
// capacity is purely deposited-SOL-liquidity-vs-price. The server computes
// requiredLiquidityLamports = pricePerNftLamports * maxQuantity; this page
// never sends a liquidity amount independent of quantity for create/deposit.

import { useEffect, useState } from 'react';
import { Transaction } from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ADDR_RE, short } from '@/app/tools/mmm-shared';
import { VL, VLText, alpha, rgb } from '@/lib/palette';

const LIVE_MODE_KEY = 'vl.mmmCollectionBids.liveMode';
const LAST_POOL_KEY = 'vl.mmmCollectionBids.lastPool';
const FIELDS_KEY = 'vl.mmmCollectionBids.fields';

interface PersistedFields {
  tab?: Tab; collectionSymbol?: string; pricePerNftSol?: string; maxQuantity?: string; expiry?: string;
  additionalQuantity?: string; newPriceSol?: string; newExpiry?: string; withdrawAmountSol?: string;
}
function loadPersistedFields(): PersistedFields {
  try {
    const raw = localStorage.getItem(FIELDS_KEY);
    return raw ? JSON.parse(raw) as PersistedFields : {};
  } catch { return {}; }
}

type Tab = 'create' | 'deposit' | 'update' | 'withdraw-sol' | 'close';

interface PoolInfo {
  poolKey: string; owner: string; cosigner: string; spotPriceSol: number;
  curveType: string; curveDelta: string; expiry: string; lpFeeBp: number;
  buysideCreatorRoyaltyBp: number; sellsideAssetAmount: string;
  escrowPda: string; escrowBalanceSol: number; estimatedRemainingQuantity: number;
  allowlists: Array<{ kind: number; value: string }>;
}

interface BuildSummaryCreate {
  action: 'create'; owner: string; collectionSymbol: string; poolKey: string; escrowPda: string;
  pricePerNftSol: number; maxQuantity: number; requiredLiquiditySol: number;
  poolRentSol: number; escrowRentSol: number; totalRequiredWalletSol: number;
  curveType: string; curveDelta: string; lpFeeBp: number; buysideCreatorRoyaltyBp: number;
  expiry: number; allowlistKind: number; allowlistValue: string;
}
interface BuildSummaryDeposit {
  action: 'deposit'; poolKey: string; additionalQuantity: number;
  additionalLiquiditySol: number; escrowBalanceBeforeSol: number;
}
interface BuildSummaryUpdate {
  action: 'update'; poolKey: string; oldPriceSol: number; newPriceSol: number;
  oldExpiry: string; newExpiry: string;
}
interface BuildSummaryWithdraw {
  action: 'withdraw-sol'; poolKey: string; amountSol: number;
  escrowBalanceBeforeSol: number; escrowBalanceAfterSimSol: number | null;
}
interface BuildSummaryClose {
  action: 'close'; poolKey: string; reclaimedRentSol: number;
}
type BuildSummary = BuildSummaryCreate | BuildSummaryDeposit | BuildSummaryUpdate | BuildSummaryWithdraw | BuildSummaryClose;

interface Built {
  tx: string; digest: string; expiresAt: number; summary: BuildSummary; preflightLogs: string[];
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

function humanizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  if (m.includes('owner_equals_cosigner')) return 'Owner wallet cannot be the same as the server cosigner.';
  if (m.includes('collection_allowlist_unresolved')) return 'Could not resolve an on-chain collection value for this collection symbol — check the slug and that it has active listings.';
  if (m.includes('pool_not_found')) return 'Pool not found on-chain.';
  if (m.includes('pool_not_managed_by_this_tool')) return "This pool's cosigner does not match this tool's — it wasn't created here and can't be managed here.";
  if (m.includes('escrow_not_empty_withdraw_first')) return 'Escrow still has SOL in it — withdraw it first.';
  if (m.includes('sellside_inventory_not_empty')) return 'Pool still holds NFT inventory — this tool does not withdraw NFTs.';
  if (m.includes('withdrawal_leaves_non_rent_exempt_residual')) return 'That withdrawal would leave a tiny, non-rent-exempt residual — withdraw the full balance instead.';
  if (m.includes('withdrawal_exceeds_known_escrow_balance') || m.includes('withdrawal_amount_exceeds_expected')) return 'Requested withdrawal exceeds the known escrow balance.';
  if (m.includes('live_mode_disabled_server_side')) return 'LIVE mode is disabled on the server (MMM_COLLECTION_BIDS_ENABLE_LIVE is not set to true).';
  if (m.includes('digest_not_found_expired_or_already_used')) return 'This build expired or was already used — build again.';
  if (m.includes('digest_expired')) return 'This build expired — build again.';
  if (m.includes('signed_tx_message_does_not_match_digest')) return 'Signed transaction did not match what was built — build again.';
  if (m.includes('preflight_simulation_failed')) return 'Server-side preflight simulation failed — this would not succeed on-chain right now.';
  if (m.includes('blockhash_expired') || m.includes('blockhash_near_expiry')) return "This build's blockhash has expired or is about to — build again and sign promptly.";
  if (m.includes('blockhash_mismatch')) return 'Transaction blockhash changed unexpectedly — build again.';
  if (m.includes('invalid_signature')) return 'Signature verification failed.';
  if (m.includes('owner_signature_missing') || m.includes('revalidation_failed')) return 'Owner signature missing or invalid — build again and sign with the connected wallet.';
  return message;
}

export default function MmmCollectionBidsPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [serverLiveEnabled, setServerLiveEnabled] = useState<boolean | null>(null);
  const [cosignerPubkey, setCosignerPubkey] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [tab, setTab] = useState<Tab>('create');

  const [collectionSymbol, setCollectionSymbol] = useState('');
  const [pricePerNftSol, setPricePerNftSol] = useState('');
  const [maxQuantity, setMaxQuantity] = useState('1');
  const [expiry, setExpiry] = useState('');

  const [poolKey, setPoolKey] = useState('');
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  const [poolLookupError, setPoolLookupError] = useState<string | null>(null);

  const [additionalQuantity, setAdditionalQuantity] = useState('1');
  const [newPriceSol, setNewPriceSol] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [withdrawAmountSol, setWithdrawAmountSol] = useState('');

  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });
  const [confirmChecked, setConfirmChecked] = useState(false);

  useEffect(() => {
    setLiveMode(localStorage.getItem(LIVE_MODE_KEY) === '1');
    const savedPool = localStorage.getItem(LAST_POOL_KEY);
    if (savedPool) setPoolKey(savedPool);
    const f = loadPersistedFields();
    if (f.tab) setTab(f.tab);
    if (f.collectionSymbol != null) setCollectionSymbol(f.collectionSymbol);
    if (f.pricePerNftSol != null) setPricePerNftSol(f.pricePerNftSol);
    if (f.maxQuantity != null) setMaxQuantity(f.maxQuantity);
    if (f.expiry != null) setExpiry(f.expiry);
    if (f.additionalQuantity != null) setAdditionalQuantity(f.additionalQuantity);
    if (f.newPriceSol != null) setNewPriceSol(f.newPriceSol);
    if (f.newExpiry != null) setNewExpiry(f.newExpiry);
    if (f.withdrawAmountSol != null) setWithdrawAmountSol(f.withdrawAmountSol);
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
    void fetch(`${API_BASE}/api/tools/mmm-collection-bids/status`, { headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j: { ok: boolean; liveEnabled?: boolean; cosignerPubkey?: string }) => {
        setServerLiveEnabled(j.ok ? !!j.liveEnabled : false);
        setCosignerPubkey(j.ok ? j.cosignerPubkey ?? null : null);
      })
      .catch(() => setServerLiveEnabled(false));
  }, []);

  // Persist form field text across refreshes — pure UX convenience, no
  // effect on transaction building/security.
  useEffect(() => {
    const fields: PersistedFields = {
      tab, collectionSymbol, pricePerNftSol, maxQuantity, expiry,
      additionalQuantity, newPriceSol, newExpiry, withdrawAmountSol,
    };
    localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
  }, [tab, collectionSymbol, pricePerNftSol, maxQuantity, expiry, additionalQuantity, newPriceSol, newExpiry, withdrawAmountSol]);

  const liveAvailable = serverLiveEnabled === true && liveMode;

  function handleToggleLiveMode() {
    if (!serverLiveEnabled) return;
    if (!liveMode) {
      const ok = window.confirm(
        'LIVE mode lets this tool ask your wallet to sign and submit REAL, irreversible Solana ' +
        'transactions that move real SOL into/out of an MMM pool escrow — one explicit confirmation ' +
        'per transaction, never automatic.\n\nDRY RUN (build + simulate, no signature requested) ' +
        'stays available either way.\n\nEnable LIVE mode?'
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
    try { setWallet(await connectPhantom()); }
    catch (err) { setUiState({ kind: 'error', message: humanizeError((err as Error).message) }); }
  }
  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setUiState({ kind: 'idle' });
  }

  async function lookupPool(key: string) {
    setPoolLookupError(null);
    if (!ADDR_RE.test(key)) { setPoolInfo(null); return; }
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-collection-bids/pool?poolKey=${key}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; pool?: PoolInfo; error?: string };
      if (j.ok && j.pool) setPoolInfo(j.pool);
      else { setPoolInfo(null); setPoolLookupError(humanizeError(j.error ?? `HTTP ${r.status}`)); }
    } catch (err) {
      setPoolInfo(null);
      setPoolLookupError(humanizeError((err as Error).message));
    }
  }

  useEffect(() => {
    if (tab === 'create') return;
    const t = setTimeout(() => { void lookupPool(poolKey); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, tab]);

  function switchTab(t: Tab) {
    setTab(t);
    setUiState({ kind: 'idle' });
    setConfirmChecked(false);
  }

  function rememberPool(key: string) {
    setPoolKey(key);
    localStorage.setItem(LAST_POOL_KEY, key);
  }

  async function handleBuild() {
    if (!wallet) return;
    setConfirmChecked(false);
    setUiState({ kind: 'building' });
    try {
      let path = '';
      let body: Record<string, unknown> = {};
      if (tab === 'create') {
        const price = Number(pricePerNftSol);
        const qty = Number(maxQuantity);
        if (!collectionSymbol.trim()) { setUiState({ kind: 'error', message: 'Enter a collection symbol.' }); return; }
        if (!(price > 0)) { setUiState({ kind: 'error', message: 'Enter a price per NFT greater than 0.' }); return; }
        if (!(qty > 0 && Number.isInteger(qty))) { setUiState({ kind: 'error', message: 'Enter a whole-number max quantity greater than 0.' }); return; }
        path = '/api/tools/mmm-collection-bids/build/create';
        // Field is "days from now", not a raw unix timestamp — much less
        // error-prone to type. Blank defaults to 30 days; a non-numeric or
        // non-positive value is rejected explicitly instead of silently
        // becoming "no expiry".
        let expiryDays = 30;
        if (expiry.trim()) {
          const parsed = Number(expiry.trim());
          if (!Number.isFinite(parsed) || parsed <= 0) {
            setUiState({ kind: 'error', message: 'Expiry must be a positive number of days from now (e.g. 30), or leave it blank for the 30-day default.' });
            return;
          }
          expiryDays = parsed;
        }
        const expiryUnix = Math.floor(Date.now() / 1000) + Math.round(expiryDays * 24 * 60 * 60);
        body = {
          owner: wallet, collectionSymbol: collectionSymbol.trim(),
          pricePerNftLamports: Math.round(price * 1e9), maxQuantity: qty,
          expiry: expiryUnix,
        };
      } else {
        if (!ADDR_RE.test(poolKey)) { setUiState({ kind: 'error', message: 'Enter a valid pool address.' }); return; }
        if (tab === 'deposit') {
          const qty = Number(additionalQuantity);
          if (!(qty > 0 && Number.isInteger(qty))) { setUiState({ kind: 'error', message: 'Enter a whole-number additional quantity greater than 0.' }); return; }
          path = '/api/tools/mmm-collection-bids/build/deposit';
          body = { poolKey, additionalQuantity: qty };
        } else if (tab === 'update') {
          const price = newPriceSol.trim() ? Number(newPriceSol) : undefined;
          const exp = newExpiry.trim() ? Number(newExpiry) : undefined;
          if (price == null && exp == null) { setUiState({ kind: 'error', message: 'Enter a new price and/or expiry to change.' }); return; }
          path = '/api/tools/mmm-collection-bids/build/update';
          body = { poolKey, spotPriceLamports: price != null ? Math.round(price * 1e9) : undefined, expiry: exp };
        } else if (tab === 'withdraw-sol') {
          const amt = Number(withdrawAmountSol);
          if (!(amt > 0)) { setUiState({ kind: 'error', message: 'Enter a withdrawal amount greater than 0.' }); return; }
          path = '/api/tools/mmm-collection-bids/build/withdraw-sol';
          body = { poolKey, amountLamports: Math.round(amt * 1e9) };
        } else if (tab === 'close') {
          path = '/api/tools/mmm-collection-bids/build/close';
          body = { poolKey };
        }
      }
      const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
      });
      const j = await r.json() as {
        ok: boolean; tx?: string; digest?: string; expiresAt?: number; summary?: BuildSummary;
        preflight?: { logs?: string[] }; error?: string;
      };
      if (!j.ok || !j.tx || !j.digest || !j.expiresAt || !j.summary) {
        setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      setUiState({ kind: 'built', tx: j.tx, digest: j.digest, expiresAt: j.expiresAt, summary: j.summary, preflightLogs: j.preflight?.logs ?? [] });
      if (j.summary.action === 'create') rememberPool(j.summary.poolKey);
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSimulate() {
    // eslint-disable-next-line no-console
    console.log('[mmm-collection-bids] handleSimulate invoked, uiState.kind=', uiState.kind);
    if (uiState.kind !== 'built' && uiState.kind !== 'simulated') {
      // eslint-disable-next-line no-console
      console.log('[mmm-collection-bids] handleSimulate: guard returned early, unexpected kind=', uiState.kind);
      return;
    }
    const built: Built = uiState;
    setUiState({ kind: 'simulating', ...built });
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-collection-bids/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ tx: built.tx }),
      });
      const j = await r.json() as { ok: boolean; err?: unknown; logs?: string[]; unitsConsumed?: number | null; error?: string };
      if (!j.ok) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'simulated', ...built, simErr: j.err ?? null, simLogs: j.logs ?? [], unitsConsumed: j.unitsConsumed ?? null });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSignSubmit() {
    // Allowed from 'built' directly (server already preflight-simulated
    // at build time) or from 'simulated' (an optional extra client-side
    // re-check) — never from a transient/busy state.
    if ((uiState.kind !== 'built' && uiState.kind !== 'simulated') || !confirmChecked) return;
    const built: Built = uiState;
    if (Date.now() > built.expiresAt) { setUiState({ kind: 'error', message: 'This build expired — build again.' }); return; }
    setUiState({ kind: 'signing', ...built });
    try {
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom wallet not found. Install the Phantom extension.');
      // The server has ALREADY partial-signed the cosigner slot — Phantom
      // signs only the owner slot without altering the message.
      const tx = Transaction.from(Buffer.from(built.tx, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedTx = signed.serialize({ requireAllSignatures: true }).toString('base64');

      const r = await fetch(`${API_BASE}/api/tools/mmm-collection-bids/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ signedTx, digest: built.digest }),
      });
      const j = await r.json() as { ok: boolean; signature?: string; error?: string };
      if (!j.ok || !j.signature) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'success', sig: j.signature, action: built.summary.action });
      setConfirmChecked(false);
      void lookupPool(poolKey || (built.summary.action === 'create' ? (built.summary as BuildSummaryCreate).poolKey : ''));
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  const busy = uiState.kind === 'building' || uiState.kind === 'simulating' || uiState.kind === 'signing';
  const built = uiState.kind === 'built' || uiState.kind === 'simulating' || uiState.kind === 'simulated' || uiState.kind === 'signing';
  const summary = built ? (uiState as Built).summary : null;
  const preflightLogs = built ? (uiState as Built).preflightLogs : [];
  const simulated = uiState.kind === 'simulated';
  const simFailed = simulated && uiState.simErr != null;

  return (
    <div className="feed-root page-transition" data-page="mmm-collection-bids">
    <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px 60px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>MMM Collection Bids</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 8 }}>
        Collection-level offers (MMM buy-side pools) — not item-level. Fixed for now: linear curve,
        delta 0 (constant price per fill), 0% LP fee, 0% royalty. Every lifecycle transaction is built
        raw on-chain and requires two signatures: this tool&apos;s dedicated server cosigner (never able
        to move funds alone) and your wallet as pool owner.
      </p>
      {cosignerPubkey && (
        <div style={{ fontSize: 10, color: '#6e6688', marginBottom: 16 }}>
          server cosigner: <span style={{ color: '#8a84a4' }}>{short(cosignerPubkey)}</span> (public, cannot act without your signature)
        </div>
      )}

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
          LIVE mode is disabled on the server (MMM_COLLECTION_BIDS_ENABLE_LIVE is not set) — build &amp; simulate only.
        </div>
      )}
      {serverLiveEnabled !== false && <div style={{ marginBottom: 16 }} />}

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabButton active={tab === 'create'} onClick={() => switchTab('create')}>Create pool</TabButton>
        <TabButton active={tab === 'deposit'} onClick={() => switchTab('deposit')}>Deposit</TabButton>
        <TabButton active={tab === 'update'} onClick={() => switchTab('update')}>Update</TabButton>
        <TabButton active={tab === 'withdraw-sol'} onClick={() => switchTab('withdraw-sol')}>Withdraw SOL</TabButton>
        <TabButton active={tab === 'close'} onClick={() => switchTab('close')}>Close</TabButton>
      </div>

      {tab !== 'create' && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>
            pool address
            <input style={inputStyle} value={poolKey} onChange={(e) => setPoolKey(e.target.value)} placeholder="pool address" disabled={busy} />
          </label>
          {poolLookupError && <div style={{ fontSize: 10.5, color: '#f66', marginTop: 4 }}>{poolLookupError}</div>}
          {poolInfo && <PoolInfoPanel info={poolInfo} />}
        </div>
      )}

      {tab === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <label style={labelStyle}>
            collection symbol
            <input style={inputStyle} value={collectionSymbol} onChange={(e) => setCollectionSymbol(e.target.value)} placeholder="e.g. open_solmap" disabled={busy} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={labelStyle}>
              price per NFT (SOL)
              <input style={inputStyle} type="number" min={0} step="0.0001" value={pricePerNftSol} onChange={(e) => setPricePerNftSol(e.target.value)} disabled={busy} />
            </label>
            <label style={labelStyle}>
              max quantity
              <input style={inputStyle} type="number" min={1} step="1" value={maxQuantity} onChange={(e) => setMaxQuantity(e.target.value)} disabled={busy} />
            </label>
          </div>
          <label style={labelStyle}>
            expiry (days from now, optional — defaults to 30)
            <input style={inputStyle} type="number" min={0} step="1" value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="30" disabled={busy} />
          </label>
          {Number(pricePerNftSol) > 0 && Number(maxQuantity) > 0 && (
            <div style={{ fontSize: 10.5, color: '#a8a2c0' }}>
              required liquidity: <b style={{ color: '#e8e4f8' }}>{(Number(pricePerNftSol) * Number(maxQuantity)).toFixed(6)} SOL</b>
              {' '}(price × quantity — plus pool + escrow rent, shown after Build)
            </div>
          )}
          <div style={{ ...PANEL, padding: 10, fontSize: 10.5, color: '#8a84a4', marginBottom: 0 }}>
            fixed: linear curve · delta 0 (constant price) · 0% LP fee · 0% royalty
          </div>
        </div>
      )}

      {tab === 'deposit' && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>
            additional quantity
            <input style={inputStyle} type="number" min={1} step="1" value={additionalQuantity} onChange={(e) => setAdditionalQuantity(e.target.value)} disabled={busy} />
          </label>
          {poolInfo && Number(additionalQuantity) > 0 && (
            <div style={{ fontSize: 10.5, color: '#a8a2c0', marginTop: 6 }}>
              additional liquidity: <b style={{ color: '#e8e4f8' }}>{(poolInfo.spotPriceSol * Number(additionalQuantity)).toFixed(6)} SOL</b>
            </div>
          )}
        </div>
      )}

      {tab === 'update' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <label style={labelStyle}>
            new price per NFT (SOL, optional)
            <input style={inputStyle} type="number" min={0} step="0.0001" value={newPriceSol} onChange={(e) => setNewPriceSol(e.target.value)} placeholder={poolInfo ? String(poolInfo.spotPriceSol) : ''} disabled={busy} />
          </label>
          <label style={labelStyle}>
            new expiry (unix s, optional)
            <input style={inputStyle} value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} placeholder={poolInfo ? poolInfo.expiry : ''} disabled={busy} />
          </label>
        </div>
      )}

      {tab === 'withdraw-sol' && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>
            amount to withdraw (SOL)
            <input style={inputStyle} type="number" min={0} step="0.0001" value={withdrawAmountSol} onChange={(e) => setWithdrawAmountSol(e.target.value)} disabled={busy} />
          </label>
          {poolInfo && (
            <div style={{ fontSize: 10.5, color: '#a8a2c0', marginTop: 6 }}>
              current escrow balance: <b style={{ color: '#e8e4f8' }}>{poolInfo.escrowBalanceSol.toFixed(6)} SOL</b> —
              withdraw the full balance, or leave enough to stay above the escrow rent-exempt minimum.
            </div>
          )}
        </div>
      )}

      {tab === 'close' && (
        <div style={{ ...PANEL, padding: 10, fontSize: 10.5, color: rgb(VL.violetLight), marginBottom: 12 }}>
          Closing requires the escrow to be empty (withdraw first) and no NFT inventory in the pool.
          Reclaims the pool account&apos;s rent to the owner.
        </div>
      )}

      <PrimaryButton onClick={handleBuild} disabled={!wallet || busy || (tab !== 'create' && !ADDR_RE.test(poolKey))}>
        {uiState.kind === 'building' ? 'building…' : 'Build (dry-run)'}
      </PrimaryButton>

      {/* position:relative + a z-index above BottomStatusBar's fixed
          wrapper (zIndex: 90 in Gate.tsx) — that wrapper's inner
          pointer-events:auto layer is a full-width <div> that can swallow
          clicks landing in its screen strip even where nothing is visibly
          rendered there. Wrapping every post-Build control here guarantees
          it wins pointer-event priority regardless of scroll padding. */}
      <div style={{ position: 'relative', zIndex: 1000 }}>
      {summary && <SummaryPanel summary={summary} />}
      {built && preflightLogs.length > 0 && (
        <div style={{ fontSize: 10.5, color: '#43b984', marginTop: -8, marginBottom: 12 }}>
          ✓ server-side preflight simulation passed at build time
        </div>
      )}

      {built && (
        <PrimaryButton
          onClick={() => {
            // eslint-disable-next-line no-console
            console.log('[mmm-collection-bids] Simulate button onClick fired');
            handleSimulate();
          }}
          disabled={busy}
        >
          {uiState.kind === 'simulating' ? 'simulating…' : 'Simulate again'}
        </PrimaryButton>
      )}

      {simulated && uiState.kind === 'simulated' && (
        <SimResultPanel err={uiState.simErr} logs={uiState.simLogs} unitsConsumed={uiState.unitsConsumed} />
      )}

      {/* Gated on `built`, not `simulated` — the server already ran a
          preflight simulation during Build (see the green checkmark
          above), so an explicit client-triggered re-simulate is optional
          extra verification, not a hard prerequisite to sign. */}
      {built && !liveAvailable && (
        <div style={{ ...PANEL, padding: 12, fontSize: 11.5, color: rgb(VL.violetLight) }}>
          DRY RUN mode — no signature has been requested.
          {serverLiveEnabled ? ' Switch to LIVE mode above to sign & submit.' : ' LIVE mode is disabled on the server.'}
        </div>
      )}

      {built && liveAvailable && (
        <div style={{ ...PANEL, padding: 12 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: '#e8e4f8', cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              I understand this will submit a <b>real, irreversible</b> on-chain transaction that moves
              real SOL{simFailed ? ' — and the simulation above FAILED, so this will very likely fail too.' : '.'}
            </span>
          </label>
          <div style={{ marginTop: 10 }}>
            <PrimaryButton onClick={handleSignSubmit} disabled={!confirmChecked || busy} danger={!!simFailed}>
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
        </div>
      )}
      {uiState.kind === 'error' && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#f66' }}>Error: {uiState.message}</div>
      )}
      </div>
    </div>
    </div>
    </div>
  );
}

function PoolInfoPanel({ info }: { info: PoolInfo }) {
  const rows: Array<[string, string]> = [
    ['pool', short(info.poolKey)],
    ['owner', short(info.owner)],
    ['cosigner', short(info.cosigner)],
    ['spot price', `${info.spotPriceSol} SOL`],
    ['curve', `${info.curveType} / delta ${info.curveDelta}`],
    ['expiry', info.expiry === '0' ? 'none' : info.expiry],
    ['escrow balance', `${info.escrowBalanceSol.toFixed(6)} SOL`],
    ['est. remaining quantity', String(info.estimatedRemainingQuantity)],
    ['sellside inventory', info.sellsideAssetAmount],
  ];
  return (
    <div style={{ ...PANEL, padding: 10, fontSize: 11, marginTop: 8, marginBottom: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
          <span style={{ color: '#8a84a4' }}>{k}</span>
          <span style={{ color: '#e8e4f8', wordBreak: 'break-all', textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryPanel({ summary }: { summary: BuildSummary }) {
  const rows: Array<[string, string]> = [['action', summary.action]];
  if (summary.action === 'create') {
    rows.push(
      ['owner', short(summary.owner)], ['collection', summary.collectionSymbol], ['pool', short(summary.poolKey)],
      ['escrow', short(summary.escrowPda)], ['price / NFT', `${summary.pricePerNftSol} SOL`], ['max quantity', String(summary.maxQuantity)],
      ['required liquidity', `${summary.requiredLiquiditySol.toFixed(6)} SOL`], ['pool rent', `${summary.poolRentSol.toFixed(6)} SOL`],
      ['escrow rent', `${summary.escrowRentSol.toFixed(6)} SOL`], ['total wallet needed', `${summary.totalRequiredWalletSol.toFixed(6)} SOL`],
      ['curve', `${summary.curveType} / delta ${summary.curveDelta}`], ['lp fee', `${summary.lpFeeBp} bp`], ['royalty', `${summary.buysideCreatorRoyaltyBp} bp`],
      ['expiry', summary.expiry === 0 ? 'none' : String(summary.expiry)],
    );
  } else if (summary.action === 'deposit') {
    rows.push(['pool', short(summary.poolKey)], ['additional quantity', String(summary.additionalQuantity)],
      ['additional liquidity', `${summary.additionalLiquiditySol.toFixed(6)} SOL`], ['escrow before', `${summary.escrowBalanceBeforeSol.toFixed(6)} SOL`]);
  } else if (summary.action === 'update') {
    rows.push(['pool', short(summary.poolKey)], ['old price', `${summary.oldPriceSol} SOL`], ['new price', `${summary.newPriceSol} SOL`],
      ['old expiry', summary.oldExpiry], ['new expiry', summary.newExpiry]);
  } else if (summary.action === 'withdraw-sol') {
    rows.push(['pool', short(summary.poolKey)], ['amount', `${summary.amountSol} SOL`], ['escrow before', `${summary.escrowBalanceBeforeSol.toFixed(6)} SOL`],
      ['escrow after (sim)', summary.escrowBalanceAfterSimSol != null ? `${summary.escrowBalanceAfterSimSol.toFixed(6)} SOL` : 'unknown']);
  } else {
    rows.push(['pool', short(summary.poolKey)], ['reclaimed rent', `${summary.reclaimedRentSol.toFixed(6)} SOL`]);
  }
  return (
    <div style={{ ...PANEL, padding: 12, fontSize: 11.5 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderBottom: '1px solid rgba(168,144,232,0.10)' }}>
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
        Simulated without a real signature (sigVerify off) — checks the transaction would succeed
        against current chain state, not that your wallet is the one signing. That part is separate:
        only your connected wallet and this tool&apos;s cosigner can jointly produce signatures the
        submit endpoint will accept.
      </div>
      {logs.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', color: '#a890e8' }}>program logs ({logs.length})</summary>
          <pre style={{ fontSize: 10, color: '#8a84a4', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
            {logs.join('\n')}
          </pre>
        </details>
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
      type="button"
      onClick={onToggle}
      disabled={disabled}
      style={{
        padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
        cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 6,
        border: `1px solid ${active ? '#f66' : 'rgba(168,144,232,0.4)'}`,
        background: active ? 'rgba(255,102,102,0.12)' : 'rgba(168,144,232,0.08)',
        color: active ? '#f66' : '#a890e8',
        opacity: disabled ? 0.5 : 1,
      }}
      title={disabled ? 'LIVE mode is disabled on the server (MMM_COLLECTION_BIDS_ENABLE_LIVE)' : active ? 'Click to switch back to DRY RUN' : 'Click to enable LIVE signing & submission'}
    >
      {active ? '● LIVE' : '○ DRY RUN'}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
        border: `1px solid ${active ? 'rgba(168,144,232,0.6)' : 'rgba(168,144,232,0.2)'}`,
        background: active ? 'rgba(168,144,232,0.16)' : 'transparent',
        color: active ? '#e8e4f8' : '#9a9ab4',
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
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{ ...btnStyle, background: danger ? '#c0392b' : btnStyle.background, opacity: disabled ? 0.5 : 1, filter, outline: 'none', transition: 'filter 0.1s', marginBottom: 12 }}
    >
      {children}
    </button>
  );
}

function DisconnectLink({ onClick, children }: { onClick: () => void; children?: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ fontSize: 10, color: hover ? '#f0eef8' : '#9a9ab4', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, transition: 'color 0.12s' }}
    >
      {children ?? 'disconnect'}
    </button>
  );
}

const btnStyle: React.CSSProperties = { padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', background: rgb(VL.purpleTint), color: '#000', border: 'none', borderRadius: 8 };
const labelStyle: React.CSSProperties = { fontSize: 11, color: VLText.muted, display: 'flex', flexDirection: 'column', gap: 4 };
const inputStyle: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, background: 'rgba(255,255,255,0.03)', color: VLText.primary, outline: 'none',
  border: `1px solid ${alpha(VL.purpleTint, 0.28)}`, borderRadius: 5,
};
