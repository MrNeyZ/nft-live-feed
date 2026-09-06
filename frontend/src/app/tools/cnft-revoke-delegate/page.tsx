'use client';

// cNFT delegate-revoke — throwaway, personal use. An airdropped compressed
// NFT often arrives with a project delegate set on the leaf
// (`ownership.delegated: true`), which stops Magic Eden / Tensor from
// listing it. It is NOT frozen and NOT custodial — the leaf owner is still
// the holder — so the owner can clear it with one Bubblegum `delegate`
// instruction (newLeafDelegate = owner). Connect the owning wallet, paste
// the mint, sign once. Backend route is requireAuth-gated (site SIWS +
// UI_ALLOWED_WALLETS).

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, short } from '@/app/tools/mmm-shared';
import { VL, rgb } from '@/lib/palette';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface AssetView {
  mint: string;
  name: string | null;
  image: string | null;
  collection: string | null;
  compressed: boolean;
  owner: string | null;
  delegated: boolean;
  delegate: string | null;
  tree: string | null;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'loaded'; asset: AssetView }
  | { kind: 'working'; step: 'building' | 'signing'; asset: AssetView }
  | { kind: 'success'; sig: string; asset: AssetView }
  | { kind: 'error'; message: string; asset?: AssetView };

function humanErr(code: string): string {
  switch (code) {
    case 'not_compressed': return 'Not a compressed NFT — no delegate to revoke. List it directly.';
    case 'not_owner':      return 'The connected wallet does not own this NFT.';
    case 'not_delegated':  return 'This NFT has no delegate set — already listable.';
    case 'bad_mint':
    case 'bad_input':      return 'That is not a valid mint address.';
    default:               return code;
  }
}
function humanThrow(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

export default function CnftRevokeDelegatePage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [mint, setMint] = useState('');
  const [ui, setUi] = useState<UiState>({ kind: 'idle' });

  useEffect(() => { document.title = 'cNFT Unlock | VictoryLabs'; }, []);
  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  async function handleConnect() {
    try { setWallet(await connectPhantom()); }
    catch (e) { setUi({ kind: 'error', message: humanThrow((e as Error).message) }); }
  }
  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setUi({ kind: 'idle' });
  }

  // Debounced lookup whenever a valid-looking mint is entered.
  useEffect(() => {
    const m = mint.trim();
    if (!ADDR_RE.test(m)) { setUi({ kind: 'idle' }); return; }
    setUi({ kind: 'checking' });
    const t = setTimeout(() => {
      void fetch(`${API_BASE}/api/tools/cnft-revoke-delegate/asset?mint=${m}`, { headers: { ...authHeaders() } })
        .then((r) => r.json())
        .then((j: { ok: boolean; asset?: AssetView; error?: string }) => {
          if (!j.ok || !j.asset) { setUi({ kind: 'error', message: humanErr(j.error ?? 'lookup failed') }); return; }
          setUi({ kind: 'loaded', asset: j.asset });
        })
        .catch(() => setUi({ kind: 'error', message: 'Could not reach the backend.' }));
    }, 400);
    return () => clearTimeout(t);
  }, [mint]);

  const asset = ui.kind === 'loaded' || ui.kind === 'working' || ui.kind === 'success'
    ? ui.asset
    : ui.kind === 'error' ? ui.asset : undefined;

  const ownedByWallet = !!asset && !!wallet && asset.owner === wallet;
  const canRevoke = !!asset && asset.compressed && asset.delegated && ownedByWallet
    && (ui.kind === 'loaded' || ui.kind === 'error');

  async function handleRevoke() {
    if (!wallet || !asset) return;
    setUi({ kind: 'working', step: 'building', asset });
    try {
      const r = await fetch(`${API_BASE}/api/tools/cnft-revoke-delegate/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ owner: wallet, mint: asset.mint }),
      });
      const j = await r.json() as { ok: boolean; tx?: string; error?: string };
      if (!j.ok || !j.tx) { setUi({ kind: 'error', message: humanErr(j.error ?? `HTTP ${r.status}`), asset }); return; }
      setUi({ kind: 'working', step: 'signing', asset });
      const { signature } = await signSendAndConfirm(j.tx);
      setUi({ kind: 'success', sig: signature, asset });
    } catch (e) {
      setUi({ kind: 'error', message: humanThrow((e as Error).message), asset });
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>cNFT Unlock — revoke leaf delegate</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 20, lineHeight: 1.5 }}>
        Airdropped compressed NFTs often carry a project delegate that stops Magic Eden / Tensor from
        listing them. Not frozen, not custodial — the owner can clear it with one Bubblegum
        <code style={{ color: '#c2bcd8' }}> delegate</code> instruction. Connect the owning wallet, paste the mint, sign once.
      </p>

      {!wallet ? (
        <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
          <LinkButton onClick={handleDisconnect}>disconnect</LinkButton>
        </div>
      )}

      <label style={{ fontSize: 11, color: '#b0aac8', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
        cNFT mint address
        <input
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          placeholder="2vzPcwiQ…"
          spellCheck={false}
          style={{
            padding: '7px 9px', fontSize: 13, background: '#111', color: 'var(--vl-white)',
            border: '1px solid #333', borderRadius: 4, ...MONO,
          }}
        />
      </label>

      {ui.kind === 'checking' && <div style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 12 }}>reading leaf…</div>}

      {asset && (
        <div style={{ ...PANEL, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, color: 'var(--vl-text-primary)' }}>{asset.name ?? short(asset.mint)}</div>
          <div>compressed: {asset.compressed ? 'yes' : <span style={{ color: '#f66' }}>no</span>}</div>
          <div>owner: {asset.owner ? short(asset.owner) : '—'}{asset.owner && !ownedByWallet && <span style={{ color: '#f66' }}> (not this wallet)</span>}</div>
          <div>
            delegated:{' '}
            {asset.delegated
              ? <span style={{ color: '#f5c84b' }}>yes → {short(asset.delegate ?? '')}</span>
              : <span style={{ color: '#0f0' }}>no — already listable</span>}
          </div>
          {asset.collection && <div>collection: {short(asset.collection)}</div>}
        </div>
      )}

      {ui.kind === 'error' && (
        <div style={{ fontSize: 12, color: '#f66', marginBottom: 12 }}>Error: {ui.message}</div>
      )}

      {asset && asset.compressed && asset.delegated && ownedByWallet && (
        <PrimaryButton onClick={handleRevoke} disabled={!canRevoke}>
          {ui.kind === 'working' ? ui.step : 'Revoke delegate'}
        </PrimaryButton>
      )}

      {ui.kind === 'success' && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#0f0' }}>
          Done — delegate revoked.{' '}
          <a href={`https://solscan.io/tx/${ui.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: '#6cf' }}>
            {short(ui.sig)}
          </a>
          <div style={{ color: '#a8a2c0', marginTop: 6 }}>List it on Tensor / Magic Eden now (indexer may lag ~30s).</div>
        </div>
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
