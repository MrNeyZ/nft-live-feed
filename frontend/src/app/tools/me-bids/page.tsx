'use client';

// Magic Eden item-level bid tool — personal use only. ME's own web UI has
// disabled placing NEW offers on Solana; this page calls ME's public
// Instruction API directly (GET /instructions/buy, /buy_change_price,
// /buy_cancel) to build the same transactions, then signs via the existing
// Phantom flow and submits through the existing generic broadcast proxy.
// Every backend route is requireAuth-gated (site-wide SIWS + UI_ALLOWED_WALLETS),
// same convention as /tools/dotland — see src/server/tools-me-bids.ts header.
//
// Safety model: DRY RUN is the default and always available (build +
// simulate, no wallet signature ever requested). LIVE mode is an explicit,
// persisted, confirmed opt-in that unlocks the Sign & Submit button — and
// every individual submission still requires a fresh checkbox confirmation
// showing the exact parsed summary. This process never touches a private
// key; Phantom signs, our backend only ever proxies the already-signed
// bytes to RPC.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ADDR_RE, short } from '@/app/tools/mmm-shared';
import { VL, rgb } from '@/lib/palette';

const LIVE_MODE_KEY = 'vl.meBids.liveMode';

type Tab = 'create' | 'change-price' | 'cancel' | 'my-offers';

interface BuildSummaryCreate {
  action: 'create'; buyer: string; tokenMint: string; priceSol: number; expiry: number | null;
  auctionHouseAddress: string; auctionHouseSource: string; feePayer: string | null;
  buyerLamportsOut: number; currentEscrowSol: number | null;
}
interface BuildSummaryChangePrice {
  action: 'change-price'; buyer: string; tokenMint: string; oldPriceSol: number; newPriceSol: number;
  auctionHouseAddress: string; pdaAddress: string | null; feePayer: string | null; buyerLamportsOut: number;
}
interface BuildSummaryCancel {
  action: 'cancel'; buyer: string; tokenMint: string; priceSol: number;
  auctionHouseAddress: string; pdaAddress: string | null; feePayer: string | null;
}
type BuildSummary = BuildSummaryCreate | BuildSummaryChangePrice | BuildSummaryCancel;

type UiState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'built'; tx: string; summary: BuildSummary }
  | { kind: 'simulating'; tx: string; summary: BuildSummary }
  | { kind: 'simulated'; tx: string; summary: BuildSummary; simErr: unknown; simLogs: string[]; unitsConsumed: number | null }
  | { kind: 'signing'; tx: string; summary: BuildSummary }
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

interface MeOffer {
  pdaAddress?: string; tokenMint?: string; auctionHouse?: string; buyer?: string; price?: number; expiry?: number;
}

function humanizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  if (m.includes('offer_not_found')) return 'No active offer found for this wallet on this mint.';
  if (m.includes('me_api_key_not_configured')) return 'ME API key not configured on the server.';
  if (m.includes('me_api_cooldown_active') || m.includes('me_api_rate_limited')) return 'Magic Eden API is rate-limited right now — try again shortly.';
  return message;
}

export default function MeBidsPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [tab, setTab] = useState<Tab>('create');
  const [mint, setMint] = useState('');
  const [priceSol, setPriceSol] = useState('');
  const [newPriceSol, setNewPriceSol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [myOffers, setMyOffers] = useState<MeOffer[] | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);
  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });
  const [confirmChecked, setConfirmChecked] = useState(false);

  useEffect(() => {
    setLiveMode(localStorage.getItem(LIVE_MODE_KEY) === '1');
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  function handleToggleLiveMode() {
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
    if (!ADDR_RE.test(mint)) { setUiState({ kind: 'error', message: 'Enter a valid mint address.' }); return; }
    setConfirmChecked(false);
    setUiState({ kind: 'building' });
    try {
      let path = '';
      let body: Record<string, unknown> = {};
      if (tab === 'create') {
        const p = Number(priceSol);
        if (!(p > 0)) { setUiState({ kind: 'error', message: 'Enter a price greater than 0.' }); return; }
        path = '/api/tools/me-bids/build/create';
        body = { buyer: wallet, tokenMint: mint, priceSol: p, expiry: expiry.trim() ? Number(expiry) : undefined };
      } else if (tab === 'change-price') {
        const p = Number(newPriceSol);
        if (!(p > 0)) { setUiState({ kind: 'error', message: 'Enter a new price greater than 0.' }); return; }
        path = '/api/tools/me-bids/build/change-price';
        body = { buyer: wallet, tokenMint: mint, newPriceSol: p };
      } else if (tab === 'cancel') {
        path = '/api/tools/me-bids/build/cancel';
        body = { buyer: wallet, tokenMint: mint };
      } else {
        return;
      }
      const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      const j = await r.json() as { ok: boolean; tx?: string; summary?: BuildSummary; error?: string };
      if (!j.ok || !j.tx || !j.summary) {
        setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      setUiState({ kind: 'built', tx: j.tx, summary: j.summary });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSimulate() {
    if (uiState.kind !== 'built' && uiState.kind !== 'simulated') return;
    const { tx, summary } = uiState;
    setUiState({ kind: 'simulating', tx, summary });
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-bids/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tx }),
      });
      const j = await r.json() as { ok: boolean; err?: unknown; logs?: string[]; unitsConsumed?: number | null; error?: string };
      if (!j.ok) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'simulated', tx, summary, simErr: j.err ?? null, simLogs: j.logs ?? [], unitsConsumed: j.unitsConsumed ?? null });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSignSubmit() {
    if (uiState.kind !== 'simulated' || !confirmChecked) return;
    const { tx, summary } = uiState;
    setUiState({ kind: 'signing', tx, summary });
    try {
      const result = await signSendAndConfirm(tx);
      setUiState({ kind: 'success', sig: result.signature });
      setConfirmChecked(false);
      if (wallet) void loadMyOffers();
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  const busy = uiState.kind === 'building' || uiState.kind === 'simulating' || uiState.kind === 'signing';
  const built = uiState.kind === 'built' || uiState.kind === 'simulating' || uiState.kind === 'simulated' || uiState.kind === 'signing';
  const summary = built ? (uiState as { summary: BuildSummary }).summary : null;
  const simulated = uiState.kind === 'simulated';
  const simFailed = simulated && uiState.simErr != null;

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px 60px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>ME Bids — item-level offers</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 16 }}>
        Direct Instruction-API bid tool — bypasses ME&apos;s disabled web UI. Item-level bids only
        (create / change price / cancel). No MMM pool or collection-bid creation here.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {!wallet ? (
          <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
            <DisconnectLink onClick={handleDisconnect} />
          </div>
        )}
        <ModeToggle liveMode={liveMode} onToggle={handleToggleLiveMode} />
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabButton active={tab === 'create'} onClick={() => switchTab('create')}>Create bid</TabButton>
        <TabButton active={tab === 'change-price'} onClick={() => switchTab('change-price')}>Change price</TabButton>
        <TabButton active={tab === 'cancel'} onClick={() => switchTab('cancel')}>Cancel</TabButton>
        <TabButton active={tab === 'my-offers'} onClick={() => switchTab('my-offers')}>My offers</TabButton>
      </div>

      {tab !== 'my-offers' && (
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
                  <input style={inputStyle} value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="-1 = no expiry" disabled={busy} />
                </label>
              </div>
            )}
            {tab === 'change-price' && (
              <label style={labelStyle}>
                new price (SOL)
                <input style={inputStyle} type="number" min={0} step="0.0001" value={newPriceSol} onChange={(e) => setNewPriceSol(e.target.value)} disabled={busy} />
              </label>
            )}
          </div>

          <PrimaryButton onClick={handleBuild} disabled={!wallet || busy || !mint}>
            {uiState.kind === 'building' ? 'building…' : 'Build (dry-run)'}
          </PrimaryButton>

          {summary && <SummaryPanel summary={summary} />}

          {built && (
            <PrimaryButton onClick={handleSimulate} disabled={busy}>
              {uiState.kind === 'simulating' ? 'simulating…' : 'Simulate'}
            </PrimaryButton>
          )}

          {simulated && (
            <SimResultPanel err={uiState.simErr} logs={uiState.simLogs} unitsConsumed={uiState.unitsConsumed} />
          )}

          {simulated && !liveMode && (
            <div style={{ ...PANEL, padding: 12, fontSize: 11.5, color: rgb(VL.violetLight) }}>
              DRY RUN mode — no signature has been requested. Switch to LIVE mode above to sign &amp; submit.
            </div>
          )}

          {simulated && liveMode && (
            <div style={{ ...PANEL, padding: 12 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: '#e8e4f8', cursor: 'pointer' }}>
                <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} style={{ marginTop: 2 }} />
                <span>
                  I understand this will submit a <b>real, irreversible</b> on-chain transaction
                  {simFailed ? ' — and the simulation above FAILED, so this will very likely fail too.' : '.'}
                </span>
              </label>
              <div style={{ marginTop: 10 }}>
                <PrimaryButton onClick={handleSignSubmit} disabled={!confirmChecked || busy} danger={simFailed}>
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

function SummaryPanel({ summary }: { summary: BuildSummary }) {
  const rows: Array<[string, string]> = [];
  rows.push(['action', summary.action]);
  rows.push(['mint', summary.tokenMint]);
  rows.push(['buyer', summary.buyer]);
  rows.push(['fee payer', summary.feePayer ?? '(unknown)']);
  rows.push(['auction house', summary.auctionHouseAddress]);
  if (summary.action === 'create') {
    rows.push(['price', `${summary.priceSol} SOL`]);
    rows.push(['expiry', summary.expiry == null ? 'none' : String(summary.expiry)]);
    rows.push(['auction house source', summary.auctionHouseSource]);
    rows.push(['buyer SOL out (max)', `${(summary.buyerLamportsOut / 1e9).toFixed(6)} SOL`]);
    if (summary.currentEscrowSol != null) rows.push(['current escrow balance', `${summary.currentEscrowSol.toFixed(6)} SOL`]);
  } else if (summary.action === 'change-price') {
    rows.push(['old price', `${summary.oldPriceSol} SOL`]);
    rows.push(['new price', `${summary.newPriceSol} SOL`]);
    rows.push(['buyer SOL out (max)', `${(summary.buyerLamportsOut / 1e9).toFixed(6)} SOL`]);
    if (summary.pdaAddress) rows.push(['offer pda', summary.pdaAddress]);
  } else {
    rows.push(['price (refunded)', `${summary.priceSol} SOL`]);
    if (summary.pdaAddress) rows.push(['offer pda', summary.pdaAddress]);
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

function ModeToggle({ liveMode, onToggle }: { liveMode: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
        cursor: 'pointer', borderRadius: 6, border: `1px solid ${liveMode ? '#f66' : 'rgba(168,144,232,0.4)'}`,
        background: liveMode ? 'rgba(255,102,102,0.12)' : 'rgba(168,144,232,0.08)',
        color: liveMode ? '#f66' : '#a890e8',
      }}
      title={liveMode ? 'Click to switch back to DRY RUN' : 'Click to enable LIVE signing & submission'}
    >
      {liveMode ? '● LIVE' : '○ DRY RUN'}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
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
        fontSize: 10, color: hover ? '#f0eef8' : '#9a9ab4',
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
  background: rgb(VL.violet), color: '#fff', border: 'none', borderRadius: 6,
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#b0aac8', display: 'flex', flexDirection: 'column', gap: 4 };
const inputStyle: React.CSSProperties = {
  padding: '6px 8px', fontSize: 13, background: '#111', color: '#fff',
  border: '1px solid #333', borderRadius: 4,
};
