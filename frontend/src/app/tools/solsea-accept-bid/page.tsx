'use client';

// SolSea forgotten-bid Accept Bid tool — personal use only. SolSea's own
// frontend (api.all.art) has been effectively dead since ~2022 (expired
// TLS cert, no working accept-bid UI), but its on-chain bid program still
// holds thousands of funded, never-cancelled bids from 2022. If you own
// the exact NFT one of those bids targets, this tool builds the raw
// on-chain Accept Bid instruction directly — bypassing the dead
// marketplace entirely.
//
// Native SOL bids only for now — a bid denominated in an SPL token
// (SolSea's own currency, BONK, etc) is refused with a clear error rather
// than silently mis-built.
//
// Single signer: only your connected wallet needs to sign. If the buyer's
// NFT-receiving token account doesn't exist yet, this transaction also
// creates it (you pay its ~0.002 SOL rent as part of accepting).
// DRY RUN (build + simulate, no signature ever requested) is the default;
// LIVE mode is gated first by the server.

import { useEffect, useState } from 'react';
import { Transaction } from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ADDR_RE, short } from '@/app/tools/mmm-shared';
import { CtaButton } from '@/soloist/shared';
import { VLText, alpha, VL } from '@/lib/palette';

const LIVE_MODE_KEY = 'vl.solseaAcceptBid.liveMode';
const FIELDS_KEY = 'vl.solseaAcceptBid.fields';

interface BidInfo {
  bidKey: string; bidder: string; mint: string; priceSol: number | null;
  currency: string; isNativeSol: boolean;
}
interface BuildSummary {
  seller: string; bidKey: string; bidder: string; mint: string; priceSol: number; createsBuyerAta: boolean;
}
interface Built { tx: string; digest: string; expiresAt: number; summary: BuildSummary; preflightLogs: string[] }

type UiState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | ({ kind: 'built' } & Built)
  | ({ kind: 'simulating' } & Built)
  | ({ kind: 'simulated' } & Built & { simErr: unknown; simLogs: string[]; unitsConsumed: number | null })
  | ({ kind: 'signing' } & Built)
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

function humanizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('bid_not_found_or_already_closed')) return 'This bid no longer exists — it was already accepted or cancelled.';
  if (m.includes('bid_not_active')) return 'This bid is not currently active.';
  if (m.includes('non_native_currency_not_supported_yet')) return 'This bid is denominated in an SPL token (not native SOL) — this tool only supports native-SOL bids right now.';
  if (m.includes('bid_escrow_underfunded')) return "This bid's escrow account exists but doesn't hold the full funded amount — likely already drained.";
  if (m.includes('seller_does_not_hold_this_nft')) return "The connected wallet doesn't hold this exact NFT right now.";
  if (m.includes('invalid_bid_key')) return 'Enter a valid bid account address.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  if (m.includes('live_mode_disabled_server_side')) return 'LIVE mode is disabled on the server (SOLSEA_ACCEPT_BID_ENABLE_LIVE is not set to true).';
  if (m.includes('digest_not_found_expired_or_already_used') || m.includes('digest_expired')) return 'This build expired or was already used — build again.';
  if (m.includes('signed_tx_message_does_not_match_digest')) return 'Signed transaction did not match what was built — build again.';
  if (m.includes('preflight_simulation_failed')) return 'Server-side preflight simulation failed — this would not succeed on-chain right now.';
  if (m.includes('blockhash_expired') || m.includes('blockhash_near_expiry')) return "This build's blockhash has expired or is about to — build again and sign promptly.";
  if (m.includes('invalid_signature')) return 'Signature verification failed.';
  return message;
}

export default function SolseaAcceptBidPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [serverLiveEnabled, setServerLiveEnabled] = useState<boolean | null>(null);
  const [liveMode, setLiveMode] = useState(false);

  const [bidKey, setBidKey] = useState('');
  const [bidInfo, setBidInfo] = useState<BidInfo | null>(null);
  const [bidLookupError, setBidLookupError] = useState<string | null>(null);
  const [bidLoading, setBidLoading] = useState(false);

  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });
  const [confirmChecked, setConfirmChecked] = useState(false);

  useEffect(() => {
    setLiveMode(localStorage.getItem(LIVE_MODE_KEY) === '1');
    try {
      const raw = localStorage.getItem(FIELDS_KEY);
      if (raw) { const f = JSON.parse(raw) as { bidKey?: string }; if (f.bidKey) setBidKey(f.bidKey); }
    } catch { /* ignore */ }
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
    void fetch(`${API_BASE}/api/tools/solsea-accept-bid/status`, { headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j: { ok: boolean; liveEnabled?: boolean }) => setServerLiveEnabled(j.ok ? !!j.liveEnabled : false))
      .catch(() => setServerLiveEnabled(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(FIELDS_KEY, JSON.stringify({ bidKey }));
  }, [bidKey]);

  const liveAvailable = serverLiveEnabled === true && liveMode;

  function handleToggleLiveMode() {
    if (!serverLiveEnabled) return;
    if (!liveMode) {
      const ok = window.confirm(
        'LIVE mode lets this tool ask your wallet to sign and submit a REAL, irreversible Solana ' +
        'transaction that transfers your NFT and receives real SOL from a SolSea bid escrow — one ' +
        'explicit confirmation, never automatic.\n\nDRY RUN (build + simulate, no signature requested) ' +
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

  async function lookupBid(key: string) {
    setBidLookupError(null);
    setBidInfo(null);
    if (!ADDR_RE.test(key)) return;
    setBidLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/tools/solsea-accept-bid/bid?bidKey=${key}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; bid?: BidInfo; error?: string };
      if (j.ok && j.bid) setBidInfo(j.bid);
      else setBidLookupError(humanizeError(j.error ?? `HTTP ${r.status}`));
    } catch (err) {
      setBidLookupError(humanizeError((err as Error).message));
    } finally {
      setBidLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => { void lookupBid(bidKey); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidKey]);

  async function handleBuild() {
    if (!wallet || !ADDR_RE.test(bidKey)) return;
    setConfirmChecked(false);
    setUiState({ kind: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/solsea-accept-bid/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ seller: wallet, bidKey }),
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
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSimulate() {
    if (uiState.kind !== 'built' && uiState.kind !== 'simulated') return;
    const built: Built = uiState;
    setUiState({ kind: 'simulating', ...built });
    try {
      const r = await fetch(`${API_BASE}/api/tools/solsea-accept-bid/simulate`, {
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
    if ((uiState.kind !== 'built' && uiState.kind !== 'simulated') || !confirmChecked) return;
    const built: Built = uiState;
    if (Date.now() > built.expiresAt) { setUiState({ kind: 'error', message: 'This build expired — build again.' }); return; }
    setUiState({ kind: 'signing', ...built });
    try {
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom wallet not found. Install the Phantom extension.');
      const tx = Transaction.from(Buffer.from(built.tx, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedTx = signed.serialize({ requireAllSignatures: true }).toString('base64');

      const r = await fetch(`${API_BASE}/api/tools/solsea-accept-bid/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ signedTx, digest: built.digest }),
      });
      const j = await r.json() as { ok: boolean; signature?: string; error?: string };
      if (!j.ok || !j.signature) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'success', sig: j.signature });
      setConfirmChecked(false);
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

  const canBuild = !!wallet && !busy && ADDR_RE.test(bidKey) && !!bidInfo && bidInfo.isNativeSol;

  return (
    <div className="feed-root page-transition" data-page="solsea-accept-bid">
    <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px 60px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>SolSea Accept Bid</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 16 }}>
        SolSea&apos;s marketplace frontend has been effectively dead since ~2022, but its on-chain bid
        program still holds thousands of funded, never-cancelled bids. If you hold the exact NFT one
        of those bids targets, this builds the accept-bid transaction directly on-chain — single
        signature, just your wallet. <b>Native SOL bids only</b> for now.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {!wallet ? (
          <CtaButton onClick={handleConnect} style={{ marginBottom: 12 }}>Connect Phantom</CtaButton>
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
          LIVE mode is disabled on the server (SOLSEA_ACCEPT_BID_ENABLE_LIVE is not set) — build &amp; simulate only.
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>
          bid account address
          <input style={inputStyle} value={bidKey} onChange={(e) => setBidKey(e.target.value)} placeholder="bid escrow address" disabled={busy} />
        </label>
        {bidLoading && <div style={{ fontSize: 10.5, color: '#8a84a4', marginTop: 4 }}>looking up…</div>}
        {bidLookupError && <div style={{ fontSize: 10.5, color: '#f66', marginTop: 4 }}>{bidLookupError}</div>}
        {bidInfo && <BidInfoPanel info={bidInfo} />}
      </div>

      <CtaButton onClick={handleBuild} disabled={!canBuild} style={{ marginBottom: 12 }}>
        {uiState.kind === 'building' ? 'building…' : 'Build (dry-run)'}
      </CtaButton>

      <div style={{ position: 'relative', zIndex: 1000 }}>
      {summary && <SummaryPanel summary={summary} />}
      {built && preflightLogs.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--vl-green-primary)', marginTop: -8, marginBottom: 12 }}>
          ✓ server-side preflight simulation passed at build time
        </div>
      )}

      {built && (
        <CtaButton onClick={handleSimulate} disabled={busy} style={{ marginBottom: 12 }}>
          {uiState.kind === 'simulating' ? 'simulating…' : 'Simulate again'}
        </CtaButton>
      )}

      {simulated && uiState.kind === 'simulated' && (
        <SimResultPanel err={uiState.simErr} logs={uiState.simLogs} unitsConsumed={uiState.unitsConsumed} />
      )}

      {built && !liveAvailable && (
        <div style={{ ...PANEL, padding: 12, fontSize: 11.5, color: VL_TEXT_MUTED }}>
          DRY RUN mode — no signature has been requested.
          {serverLiveEnabled ? ' Switch to LIVE mode above to sign & submit.' : ' LIVE mode is disabled on the server.'}
        </div>
      )}

      {built && liveAvailable && (
        <div style={{ ...PANEL, padding: 12 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: '#e8e4f8', cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              I understand this will submit a <b>real, irreversible</b> on-chain transaction that
              transfers my NFT to the bidder and pays the bid amount to me{simFailed ? ' — and the simulation above FAILED, so this will very likely fail too.' : '.'}
            </span>
          </label>
          <div style={{ marginTop: 10 }}>
            <CtaButton onClick={handleSignSubmit} disabled={!confirmChecked || busy} variant={simFailed ? 'danger' : 'purple'} style={{ marginBottom: 12 }}>
              {busy ? 'signing…' : 'Sign & Submit'}
            </CtaButton>
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

const VL_TEXT_MUTED = 'var(--vl-purple-tint)';

function BidInfoPanel({ info }: { info: BidInfo }) {
  const rows: Array<[string, string]> = [
    ['bidder', short(info.bidder)],
    ['target mint', short(info.mint)],
    ['price', info.isNativeSol ? `${info.priceSol} SOL` : `non-SOL currency (${short(info.currency)}) — not supported`],
  ];
  return (
    <div style={{ ...PANEL, padding: 10, fontSize: 11, marginTop: 8, marginBottom: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
          <span style={{ color: '#8a84a4' }}>{k}</span>
          <span style={{ color: info.isNativeSol ? '#e8e4f8' : '#f66', wordBreak: 'break-all', textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryPanel({ summary }: { summary: BuildSummary }) {
  const rows: Array<[string, string]> = [
    ['seller (you)', short(summary.seller)], ['bid', short(summary.bidKey)], ['bidder', short(summary.bidder)],
    ['mint', short(summary.mint)], ['price', `${summary.priceSol} SOL`],
    ['buyer ATA', summary.createsBuyerAta ? 'will be created (you pay ~0.002 SOL rent)' : 'already exists'],
  ];
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
        border: `1px solid ${active ? '#f66' : 'rgb(var(--vl-purple-tint) / 0.4)'}`,
        background: active ? 'rgba(255,102,102,0.12)' : 'rgb(var(--vl-purple-tint) / 0.08)',
        color: active ? '#f66' : 'var(--vl-purple-tint)',
        opacity: disabled ? 0.5 : 1,
      }}
      title={disabled ? 'LIVE mode is disabled on the server (SOLSEA_ACCEPT_BID_ENABLE_LIVE)' : active ? 'Click to switch back to DRY RUN' : 'Click to enable LIVE signing & submission'}
    >
      {active ? '● LIVE' : '○ DRY RUN'}
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
      style={{ fontSize: 10, color: hover ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, transition: 'color 0.12s' }}
    >
      {children ?? 'disconnect'}
    </button>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: VLText.muted, display: 'flex', flexDirection: 'column', gap: 4 };
const inputStyle: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, background: 'rgba(255,255,255,0.03)', color: VLText.primary, outline: 'none',
  border: `1px solid ${alpha(VL.purpleTint, 0.28)}`, borderRadius: 5,
};
