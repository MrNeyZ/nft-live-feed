'use client';

// Gate — wraps the entire app in the root layout.
//
// Flow:
//   no auth                    → <Login>
//   authed + mode === 'off'    → <ModeSelect>  (FULL / BUDGET / SALES_ONLY)
//   authed + mode is active    → render children normally (the app)
//
// The OFF button in TopNav posts mode=off, clears auth, and reloads — which
// drops back into <Login> via this same component on the next render.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { isAuthed, login } from './auth';
import { fetchMode, setMode, SELECTABLE_MODES, type RuntimeMode } from './mode';

type GateState =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'mode-select' }
  | { kind: 'active'; mode: Exclude<RuntimeMode, 'off'> };

export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  // Initial resolution: check auth locally, then query backend mode.
  const resolve = useCallback(async () => {
    if (!isAuthed()) { setState({ kind: 'login' }); return; }
    const mode = await fetchMode();
    if (mode == null || mode === 'off') setState({ kind: 'mode-select' });
    else setState({ kind: 'active', mode });
  }, []);

  useEffect(() => { void resolve(); }, [resolve]);

  if (state.kind === 'loading') {
    return <div style={fullscreen}><div style={{ color: '#55556e', fontSize: 12 }}>…</div></div>;
  }
  if (state.kind === 'login') {
    return <LoginScreen onSuccess={() => { void resolve(); }} />;
  }
  if (state.kind === 'mode-select') {
    return <ModeSelectScreen onSelected={() => { window.location.href = '/dashboard'; }} />;
  }
  return <>{children}</>;
}

// ── Screens ─────────────────────────────────────────────────────────────────

// ── Wallet connect helper ──────────────────────────────────────────────────
//
// Phantom (and most Solana wallets) inject `window.solana` / `window.phantom.solana`.
// We don't pull in @solana/wallet-adapter — the gate only needs the current
// pubkey, and the injection API is stable enough for a control panel.

interface InjectedSolana {
  isPhantom?: boolean;
  connect?: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString(): string } }>;
  publicKey?: { toString(): string } | null;
}

function getInjectedSolana(): InjectedSolana | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    phantom?: { solana?: InjectedSolana };
    solana?:  InjectedSolana;
  };
  return w.phantom?.solana ?? w.solana ?? null;
}

/** Display-only: first5…last5 with the Unicode horizontal ellipsis (U+2026).
 *  Full address stays in state for submit. */
function shortenAddress(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 5)}\u2026${addr.slice(-5)}`;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [wallet,  setWallet]  = useState<string | null>(null);
  const [pw,      setPw]      = useState('');
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  const connect = async () => {
    setErr(null);
    const sol = getInjectedSolana();
    if (!sol?.connect) { setErr('Phantom wallet not detected'); return; }
    setBusy(true);
    try {
      const resp = await sol.connect();
      const pk = resp?.publicKey?.toString() ?? sol.publicKey?.toString() ?? null;
      if (!pk) { setErr('Wallet returned no public key'); return; }
      setWallet(pk);
    } catch {
      setErr('Wallet connection rejected');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!wallet || !pw || busy) return;
    setBusy(true); setErr(null);
    const ok = await login(wallet, pw);
    setBusy(false);
    if (!ok) { setErr('Wallet or password rejected'); return; }
    onSuccess();
  };

  return (
    <div style={fullscreen}>
      <form onSubmit={submit} style={panel}>
        <div style={panelTitle}>ACCESS</div>

        {!wallet && (
          <button
            type="button"
            onClick={connect}
            disabled={busy}
            style={primaryBtn(busy)}>
            {busy ? '…' : 'CONNECT WALLET'}
          </button>
        )}

        {wallet && (
          <>
            <input
              value={shortenAddress(wallet)}
              readOnly
              aria-label="wallet"
              title={wallet}
              style={{ ...inputStyle, cursor: 'default', color: '#9683dc', fontFamily: "'SF Mono','Fira Code',monospace" }}
            />
            <input
              autoFocus
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              placeholder="password"
              style={inputStyle}
            />
            <button type="submit" disabled={!pw || busy} style={primaryBtn(!pw || busy)}>
              {busy ? '…' : 'ENTER'}
            </button>
          </>
        )}

        {err && <div style={{ color: '#e06a6a', fontSize: 11 }}>{err}</div>}
      </form>
    </div>
  );
}

function ModeSelectScreen({ onSelected }: { onSelected: () => void }) {
  const [busy, setBusy] = useState<RuntimeMode | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (m: RuntimeMode) => {
    if (busy) return;
    setBusy(m); setErr(null);
    const result = await setMode(m);
    setBusy(null);
    if (result == null) {
      // 401 → auth cleared by setMode(); fall back to login via a reload.
      if (!isAuthed()) { window.location.reload(); return; }
      setErr('Could not switch mode — try again');
      return;
    }
    onSelected();
  };

  return (
    <div style={fullscreen}>
      <div style={{ ...panel, width: 320 }}>
        <div style={panelTitle}>SELECT MODE</div>
        {SELECTABLE_MODES.map(m => (
          <button
            key={m}
            onClick={() => pick(m)}
            disabled={busy != null}
            style={modeBtn(busy === m, busy != null && busy !== m)}>
            {m.replace('_', ' ').toUpperCase()}
          </button>
        ))}
        {err && <div style={{ color: '#e06a6a', fontSize: 11 }}>{err}</div>}
      </div>
    </div>
  );
}

// ── Inline styles (match the rest of the app's dark purple chrome) ─────────

const fullscreen: CSSProperties = {
  position: 'fixed', inset: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'linear-gradient(180deg, #14102a 0%, #0c0a1a 100%)',
};

const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10,
  padding: '22px 22px 18px', width: 300,
  background: 'linear-gradient(180deg, #1a1430 0%, #14102a 100%)',
  border: '1px solid rgba(168,144,232,0.22)',
  borderRadius: 10,
  boxShadow: '0 16px 40px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.3)',
};

const panelTitle: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#9683dc', letterSpacing: '1.5px',
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  padding: '10px 12px', fontSize: 13, color: '#e8e6f2',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(168,144,232,0.22)',
  borderRadius: 6, outline: 'none', fontFamily: 'inherit',
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: '9px 12px', fontSize: 12, fontWeight: 600, letterSpacing: '1px',
    color: disabled ? '#55556e' : '#0c0a1a',
    background: disabled ? 'rgba(128,104,216,0.15)' : '#a890e8',
    border: '1px solid rgba(168,144,232,0.4)',
    borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function modeBtn(active: boolean, dimmed: boolean): CSSProperties {
  return {
    padding: '11px 14px', fontSize: 12, fontWeight: 600, letterSpacing: '1px',
    color: active ? '#0c0a1a' : '#d4d4e8',
    background: active
      ? '#a890e8'
      : 'linear-gradient(180deg, rgba(128,104,216,0.14) 0%, rgba(128,104,216,0.04) 100%)',
    border: '1px solid rgba(168,144,232,0.28)',
    borderRadius: 6,
    cursor: dimmed ? 'not-allowed' : 'pointer',
    opacity: dimmed ? 0.5 : 1,
    textAlign: 'left',
  };
}

