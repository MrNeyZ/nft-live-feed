'use client';

// DotLand direct-mint tool — personal use only. Calls DotLand's public
// `buy_plot` instruction directly (no off-chain gate, confirmed against
// their own on-chain-shipped Anchor IDL). Every backend route is
// requireAuth-gated (site-wide SIWS + UI_ALLOWED_WALLETS), so this page
// is only reachable by wallets already allowed to log into this site.
//
// `buy_plot_allowlisted` (the free/holder path, merkle-proof gated) is
// intentionally NOT implemented here.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, fmtSol, short } from '@/app/tools/mmm-shared';

// GridState: "occupancy bitmap for all 10_000 blocks" (program's own IDL
// docstring) — 100x100. Mirrors GRID_SIZE in src/server/tools-dotland.ts.
const GRID_SIZE = 100;

interface DotlandConfig {
  admin: string;
  treasury: string;
  pricePerBlockLamports: string;
  updateFeeLamports: string;
  maxBlocksPerPurchase: number;
  paused: boolean;
  plotsSold: string;
  blocksSold: string;
  collection: string;
  blocksRemaining: string;
}

type FieldName = 'x' | 'y' | 'width' | 'height';

// Single source of truth for what's on screen — exactly one of these is
// ever rendered, so a stale "free" readout can never sit next to a fresh
// error (the two used to be independent state and could contradict).
type UiState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'valid'; totalBlocks: number }
  | { kind: 'invalid'; message: string; fields: FieldName[] }
  | { kind: 'buying'; step: 'building' | 'signing' }
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

function validateInputs(
  x: number, y: number, width: number, height: number, maxBlocks: number | null,
): { message: string; fields: FieldName[] } | null {
  if (!Number.isInteger(x) || x < 0) return { message: 'x must be 0 or greater.', fields: ['x'] };
  if (x > GRID_SIZE - 1) return { message: `x must be ${GRID_SIZE - 1} or less.`, fields: ['x'] };
  if (!Number.isInteger(y) || y < 0) return { message: 'y must be 0 or greater.', fields: ['y'] };
  if (y > GRID_SIZE - 1) return { message: `y must be ${GRID_SIZE - 1} or less.`, fields: ['y'] };
  if (!Number.isInteger(width) || width < 1) return { message: 'width must be at least 1.', fields: ['width'] };
  if (!Number.isInteger(height) || height < 1) return { message: 'height must be at least 1.', fields: ['height'] };
  if (x + width > GRID_SIZE) {
    return { message: `This area extends past the edge of the map (x + width must be ≤ ${GRID_SIZE}).`, fields: ['x', 'width'] };
  }
  if (y + height > GRID_SIZE) {
    return { message: `This area extends past the edge of the map (y + height must be ≤ ${GRID_SIZE}).`, fields: ['y', 'height'] };
  }
  if (maxBlocks != null && width * height > maxBlocks) {
    return { message: `Maximum ${maxBlocks} blocks per purchase (this is ${width * height}).`, fields: ['width', 'height'] };
  }
  return null;
}

const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  plot_already_taken: 'This area has already been claimed.',
  range_overlaps_sold_blocks: 'Part of this area has already been claimed.',
  mint_paused: 'Minting is currently paused.',
  exceeds_max_blocks_per_purchase: 'Too many blocks for a single purchase.',
  invalid_x: 'Selected area is outside the map.',
  invalid_y: 'Selected area is outside the map.',
  invalid_width: 'Selected area is outside the map.',
  invalid_height: 'Selected area is outside the map.',
  missing_buyer: 'Wallet not connected.',
};

function humanizeBackendError(code: string | undefined, httpStatus?: number): string {
  if (code) return BACKEND_ERROR_MESSAGES[code] ?? 'Something went wrong. Please try again.';
  return httpStatus ? `Request failed (HTTP ${httpStatus}).` : 'Request failed. Please try again.';
}

function humanizeThrownError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this purchase.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

export default function DotlandPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [config, setConfig] = useState<DotlandConfig | null>(null);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [width, setWidth] = useState('1');
  const [height, setHeight] = useState('1');
  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });

  async function loadConfig() {
    try {
      const r = await fetch(`${API_BASE}/api/tools/dotland/config`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; config?: DotlandConfig; error?: string };
      if (j.ok && j.config) setConfig(j.config);
      else setUiState({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
      void loadConfig();
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setConfig(null);
    setUiState({ kind: 'idle' });
  }

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => {
      if (pk) { setWallet(pk); void loadConfig(); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced validate-then-check — client-side range/fit checks run first
  // (no network if they fail); only a locally-valid rectangle is checked
  // against the live occupancy bitmap.
  useEffect(() => {
    if (!wallet) { setUiState({ kind: 'idle' }); return; }
    const bx = Number(x), by = Number(y), bw = Number(width), bh = Number(height);
    const invalid = validateInputs(bx, by, bw, bh, config?.maxBlocksPerPurchase ?? null);
    if (invalid) { setUiState({ kind: 'invalid', message: invalid.message, fields: invalid.fields }); return; }

    setUiState({ kind: 'checking' });
    const t = setTimeout(() => {
      void fetch(
        `${API_BASE}/api/tools/dotland/availability?x=${bx}&y=${by}&width=${bw}&height=${bh}`,
        { headers: { ...authHeaders() } },
      )
        .then((r) => r.json())
        .then((j: { ok: boolean; free?: boolean; occupiedBlocks?: number; totalBlocks?: number; error?: string }) => {
          if (!j.ok) { setUiState({ kind: 'error', message: humanizeBackendError(j.error) }); return; }
          const totalBlocks = j.totalBlocks ?? bw * bh;
          if (j.free) setUiState({ kind: 'valid', totalBlocks });
          else setUiState({ kind: 'invalid', message: `${j.occupiedBlocks}/${totalBlocks} block(s) already taken.`, fields: [] });
        })
        .catch(() => setUiState({ kind: 'error', message: 'Could not check availability. Please try again.' }));
    }, 400);
    return () => clearTimeout(t);
  }, [wallet, x, y, width, height, config]);

  async function handleBuy() {
    if (!wallet || uiState.kind !== 'valid') return;
    const bx = Number(x), by = Number(y), bw = Number(width), bh = Number(height);
    setUiState({ kind: 'buying', step: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/dotland/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ buyer: wallet, x: bx, y: by, width: bw, height: bh }),
      });
      const j = await r.json() as { ok: boolean; tx?: string; error?: string };
      if (!j.ok || !j.tx) {
        setUiState({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setUiState({ kind: 'buying', step: 'signing' });
      const result = await signSendAndConfirm(j.tx);
      setUiState({ kind: 'success', sig: result.signature });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  const busy = uiState.kind === 'buying';
  const blocks = (Number(width) || 0) * (Number(height) || 0);
  const totalSol = config ? (BigInt(config.pricePerBlockLamports) * BigInt(blocks || 0)) : null;
  const invalidFields = uiState.kind === 'invalid' ? uiState.fields : [];
  const buyDisabled = !wallet || busy || uiState.kind !== 'valid';

  return (
    <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>DotLand — contract mint</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 20 }}>
        Calls buy_plot directly on-chain. Public path only — no allowlist/merkle claims here.
      </p>

      {!wallet ? (
        <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
          <DisconnectLink onClick={handleDisconnect} />
        </div>
      )}

      {config && (
        <div style={{ ...PANEL, padding: 12, marginBottom: 16, fontSize: 12 }}>
          <div>price/block: {fmtSol(Number(config.pricePerBlockLamports))} SOL</div>
          <div>max blocks/purchase: {config.maxBlocksPerPurchase}</div>
          <div>paused: {config.paused ? 'YES' : 'no'}</div>
          <div>plots sold: {config.plotsSold} · blocks sold: {config.blocksSold} / 10000</div>
          <div>blocks remaining: {config.blocksRemaining}</div>
          <div>collection: {short(config.collection)}</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <NumberField label="x" value={x} onChange={setX} min={0} max={99} hasError={invalidFields.includes('x')} />
        <NumberField label="y" value={y} onChange={setY} min={0} max={99} hasError={invalidFields.includes('y')} />
        <NumberField label="width" value={width} onChange={setWidth} min={1} max={255} hasError={invalidFields.includes('width')} />
        <NumberField label="height" value={height} onChange={setHeight} min={1} max={255} hasError={invalidFields.includes('height')} />
      </div>

      {totalSol !== null && (
        <div style={{ fontSize: 12, color: '#c2bcd8', marginBottom: 4 }}>
          {blocks} block(s) → {fmtSol(Number(totalSol))} SOL + rent + fee
        </div>
      )}

      <StatusLine state={uiState} />

      <PrimaryButton onClick={handleBuy} disabled={buyDisabled}>
        {uiState.kind === 'buying' ? uiState.step : 'Buy plot'}
      </PrimaryButton>

      {uiState.kind === 'success' && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#0f0' }}>
          Confirmed:{' '}
          <a href={`https://solscan.io/tx/${uiState.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: '#6cf' }}>
            {short(uiState.sig)}
          </a>
        </div>
      )}

    </div>
  );
}

function StatusLine({ state }: { state: UiState }) {
  switch (state.kind) {
    case 'checking':
      return <div style={{ fontSize: 12, marginBottom: 12, color: '#a8a2c0' }}>checking availability…</div>;
    case 'valid':
      return <div style={{ fontSize: 12, marginBottom: 12, color: '#0f0' }}>✓ all {state.totalBlocks} block(s) free</div>;
    case 'invalid':
      return <div style={{ fontSize: 12, marginBottom: 12, color: '#f66' }}>✗ {state.message}</div>;
    case 'error':
      return <div style={{ fontSize: 12, marginBottom: 12, color: '#f66' }}>Error: {state.message}</div>;
    default:
      return null;
  }
}

function NumberField({ label, value, onChange, min, max, hasError }: {
  label: string; value: string; onChange: (v: string) => void; min: number; max: number; hasError: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const borderColor = hasError ? '#f66' : focused ? '#7c5cff' : hover ? 'rgba(168,144,232,0.55)' : '#333';
  return (
    <label style={labelStyle}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputStyle,
          borderColor,
          outline: focused ? '2px solid #7c5cff' : 'none',
          outlineOffset: 1,
          transition: 'border-color 0.12s',
        }}
      />
    </label>
  );
}

function PrimaryButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
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
        opacity: disabled ? 0.5 : 1,
        filter,
        outline: 'none',
        transition: 'filter 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function DisconnectLink({ onClick }: { onClick: () => void }) {
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
      disconnect
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: '#6a48f0', color: '#fff', border: 'none', borderRadius: 6,
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#b0aac8', display: 'flex', flexDirection: 'column', gap: 4 };
const inputStyle: React.CSSProperties = {
  padding: '6px 8px', fontSize: 13, background: '#111', color: '#fff',
  border: '1px solid #333', borderRadius: 4,
};
