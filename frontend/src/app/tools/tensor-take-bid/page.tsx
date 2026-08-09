'use client';

// Tensor Take Bid tool — personal use only. Accepts any live Tensor
// collection bid on any mpl-core asset by reading live on-chain bid state
// and building an unsigned `takeBidCore` transaction, signed and sent
// directly by Phantom in the browser — no backend broadcast step, no
// private key ever touches the server. Every backend route is
// requireAuth-gated (site-wide SIWS + UI_ALLOWED_WALLETS).
//
// Ported from the standalone tensor-takebid-tool/ prototype (server.js +
// phantom.html) — see that repo's HANDOFF.md for the on-chain
// reverse-engineering behind the account resolution this tool relies on.
//
// Same connect -> paste -> build -> sign flow rhythm as the other /tools
// wallet-signing pages (candy-mint, mmm-pool-lookup), using the shared
// PANEL/ToolTextInput/CtaButton utility chrome rather than a launchpad-drop
// hero — this tool's input shape (a specific bidState + asset pair, no
// quantity/collection-browsing concept) doesn't map onto that layout.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, ADDR_RE, MONO, PANEL, ToolButton, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { VL, VLText, alpha, rgb } from '@/lib/palette';
import { LiveDot, CtaButton } from '@/soloist/shared';

interface TakeBidInfo {
  owner: string;
  amountLamports: string;
  amountSOL: number;
  quantity: number;
  filledQuantity: number;
  currency: string;
  expiry: string;
  collection: string | null;
}

type FlowState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | {
      kind: 'ready';
      txBase64: string;
      bidInfo: TakeBidInfo;
      builtAtMs: number;
      solDeltaLamports: number | null;
    }
  | { kind: 'signing' }
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

// Built transaction's blockhash is valid ~60-90s (150 blocks) — see
// HANDOFF.md's "remaining caveats". Past this, warn the user to rebuild
// before signing rather than let `send` fail opaquely in Phantom.
const BLOCKHASH_STALE_MS = 75_000;

function humanizeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('bid_already_fully_filled')) return 'This bid is already fully filled — nothing left to take.';
  if (m.includes('asset_account_not_found')) return 'Asset account not found on-chain — check the mint address.';
  if (m.includes('missing_or_invalid_fields')) return 'Enter a valid Bid State address and Asset (NFT mint) address.';
  if (m.includes('insufficient')) return 'Not enough SOL to cover network fees.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('blockhash not found') || m.includes('block height exceeded')) {
    return 'Blockhash expired — rebuild and try again.';
  }
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

export default function TensorTakeBidPage() {
  useEffect(() => { document.title = 'Tensor Take Bid | VictoryLabs'; }, []);

  const [wallet, setWallet] = useState<string | null>(null);
  const [bidState, setBidState] = useState('');
  const [asset, setAsset] = useState('');
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  // Live blockhash-age ticker — only runs while a built tx is sitting
  // unsigned, so the "rebuild" hint below can count up in real time.
  useEffect(() => {
    if (flow.kind !== 'ready') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [flow.kind]);

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setFlow({ kind: 'idle' });
  }

  async function handleBuild() {
    if (!wallet || !ADDR_RE.test(bidState.trim()) || !ADDR_RE.test(asset.trim())) return;
    setFlow({ kind: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/tensor-take-bid/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ bidState: bidState.trim(), asset: asset.trim(), wallet }),
      });
      const j = await r.json() as { ok: boolean; txBase64?: string; bidInfo?: TakeBidInfo; error?: string };
      if (!j.ok || !j.txBase64 || !j.bidInfo) {
        setFlow({ kind: 'error', message: humanizeError(j.error ?? `build failed (HTTP ${r.status})`) });
        return;
      }
      const { txBase64, bidInfo } = j;

      // Best-effort proceeds preview — a simulate failure doesn't block
      // signing, it just means the "you'll receive" line falls back to
      // the bid's gross amount instead of the true net figure.
      let solDeltaLamports: number | null = null;
      try {
        const simR = await fetch(`${API_BASE}/api/tools/tensor-take-bid/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ transactionBase64: txBase64, wallet }),
        });
        const simJ = await simR.json() as { ok: boolean; solDeltaLamports?: number | null };
        if (simJ.ok) solDeltaLamports = simJ.solDeltaLamports ?? null;
      } catch {
        // leave solDeltaLamports null — bidInfo.amountSOL still shown
      }

      setNow(Date.now());
      setFlow({ kind: 'ready', txBase64, bidInfo, builtAtMs: Date.now(), solDeltaLamports });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  async function handleSign() {
    if (flow.kind !== 'ready') return;
    setFlow({ kind: 'signing' });
    try {
      const result = await signSendAndConfirm(flow.txBase64);
      setFlow({ kind: 'success', sig: result.signature });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  const busy = flow.kind === 'building' || flow.kind === 'signing';
  const inputsValid = ADDR_RE.test(bidState.trim()) && ADDR_RE.test(asset.trim());
  const blockhashAgeMs = flow.kind === 'ready' ? now - flow.builtAtMs : 0;
  const blockhashStale = flow.kind === 'ready' && blockhashAgeMs > BLOCKHASH_STALE_MS;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px 60px', ...MONO }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: VLText.primary, margin: 0, letterSpacing: '-0.3px' }}>
            Tensor Take Bid
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: VLText.muted }}>
            <LiveDot />
            <span>accept any live Tensor collection bid — reads live chain state, no API key needed</span>
          </div>
        </div>
        {wallet ? (
          <WalletChip wallet={wallet} onDisconnect={handleDisconnect} />
        ) : (
          <CtaButton onClick={handleConnect}>Connect Phantom</CtaButton>
        )}
      </div>

      <div style={{ ...PANEL, padding: 16 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: VLText.muted, marginBottom: 6 }}>
          Bid State account
        </label>
        <ToolTextInput
          value={bidState}
          onChange={(e) => setBidState(e.target.value)}
          placeholder="the specific bid you're taking"
          disabled={busy}
          style={{ width: '100%' }}
        />

        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: VLText.muted, marginTop: 14, marginBottom: 6 }}>
          Asset (NFT mint you're selling)
        </label>
        <ToolTextInput
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          placeholder="the mpl-core asset mint address"
          disabled={busy}
          style={{ width: '100%' }}
        />

        <div style={{ marginTop: 16 }}>
          <CtaButton
            onClick={handleBuild}
            disabled={!wallet || busy || !inputsValid}
            big
          >
            {flow.kind === 'building' ? 'reading live bid…' : 'Build'}
          </CtaButton>
          {!wallet && (
            <span style={{ marginLeft: 10, fontSize: 11, color: VLText.faint }}>connect a wallet first</span>
          )}
        </div>
      </div>

      {flow.kind === 'ready' && (
        <div style={{ ...PANEL, padding: 16, marginTop: 16 }}>
          <BidInfoRows bidInfo={flow.bidInfo} solDeltaLamports={flow.solDeltaLamports} />

          {blockhashStale && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, fontWeight: 600,
              color: rgb(VL.gold), lineHeight: 1.5, padding: '9px 11px', borderRadius: 8, marginTop: 12,
              background: alpha(VL.gold, 0.08), border: `1px solid ${alpha(VL.gold, 0.3)}`,
            }}>
              <span>⚠</span>
              <span>This blockhash is over {Math.round(BLOCKHASH_STALE_MS / 1000)}s old and may have expired — rebuild before signing.</span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <CtaButton onClick={handleSign} disabled={busy} variant={blockhashStale ? 'blue' : 'green'} big>
              {busy ? 'signing…' : blockhashStale ? 'Sign anyway' : 'Sign & Send'}
            </CtaButton>
            <ToolButton onClick={handleBuild} disabled={busy}>
              Rebuild (fresh price + blockhash)
            </ToolButton>
          </div>
        </div>
      )}

      {flow.kind === 'success' && (
        <div style={{ ...PANEL, padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: rgb(VL.greenStrong) }}>Sent —{' '}
            <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
              {short(flow.sig)}
            </a>
          </div>
        </div>
      )}

      {flow.kind === 'error' && (
        <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 14 }}>{flow.message}</div>
      )}
    </div>
  );
}

function BidInfoRows({ bidInfo, solDeltaLamports }: { bidInfo: TakeBidInfo; solDeltaLamports: number | null }) {
  const expiryMs = Number(bidInfo.expiry) * 1000;
  const expiryLabel = Number.isFinite(expiryMs) && expiryMs > 0
    ? new Date(expiryMs).toLocaleString('en-US', { hour12: false })
    : 'no expiry';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
      <Row label="You'll receive" value={
        <span style={{ fontSize: 16, fontWeight: 800, color: rgb(VL.greenStrong) }}>
          {solDeltaLamports != null ? (solDeltaLamports / 1e9).toFixed(5) : bidInfo.amountSOL.toFixed(5)} SOL
          {solDeltaLamports == null && <span style={{ fontSize: 10, color: VLText.faint, fontWeight: 500 }}> (gross bid — sim unavailable)</span>}
        </span>
      } />
      <Row label="Bid price" value={`${bidInfo.amountSOL.toFixed(5)} SOL`} />
      <Row label="Bid owner" value={<span title={bidInfo.owner}>{short(bidInfo.owner)}</span>} />
      <Row label="Fill" value={`${bidInfo.filledQuantity} / ${bidInfo.quantity}`} />
      {bidInfo.collection && <Row label="Collection" value={<span title={bidInfo.collection}>{short(bidInfo.collection)}</span>} />}
      <Row label="Expiry" value={expiryLabel} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: VLText.muted, fontSize: 11 }}>{label}</span>
      <span style={{ color: VLText.primary }}>{value}</span>
    </div>
  );
}

// Same shape as candy-mint's local WalletChip — click-to-copy address +
// inline disconnect. Duplicated rather than imported since neither page
// exports it as a shared primitive yet.
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
      background: alpha(VL.greenStrong, 0.1),
      border: `1px solid ${alpha(VL.greenStrong, 0.32)}`,
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
