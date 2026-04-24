'use client';

// Gate — wraps the entire app in the root layout.
//
// Flow (unchanged):
//   no auth                    → <LoginScreen>
//   authed + mode === 'off'    → <ModeSelectScreen>
//   authed + mode is active    → render children normally (the app)
//
// Visuals are a 1:1 port of the VictoryLabs handoff's `gate-preview.html`
// (V2 variant). All CSS below is copied verbatim from that file; only
// the rendering layer was reshaped from vanilla DOM into React JSX.
// Functional handlers (login, setMode, wallet detect, state resolve) are
// the pre-existing ones — this file does not change auth / runtime logic.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { isAuthed, login, clearAuth } from './auth';
import { fetchMode, setMode, SELECTABLE_MODES, type RuntimeMode } from './mode';

type GateState =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'mode-select' }
  | { kind: 'active'; mode: Exclude<RuntimeMode, 'off'> };

export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  const resolve = useCallback(async () => {
    if (!isAuthed()) { setState({ kind: 'login' }); return; }
    const mode = await fetchMode();
    if (mode == null || mode === 'off') setState({ kind: 'mode-select' });
    else setState({ kind: 'active', mode });
  }, []);

  useEffect(() => { void resolve(); }, [resolve]);

  if (state.kind === 'loading') {
    return <GateShell><div style={{ color: '#55556e', fontSize: 12 }}>…</div></GateShell>;
  }
  if (state.kind === 'login') {
    return <GateShell><LoginScreen onSuccess={() => { void resolve(); }} /></GateShell>;
  }
  if (state.kind === 'mode-select') {
    return <GateShell><ModeSelectScreen onSelected={() => { window.location.href = '/dashboard'; }} /></GateShell>;
  }
  return <>{children}</>;
}

// ── Shell — full-screen dark-purple washes from handoff body styles ────────

function GateShell({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{GATE_CSS}</style>
      <div className="gate-root">{children}</div>
    </>
  );
}

// ── Wallet detection (unchanged) ───────────────────────────────────────────

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

/** Display-only: first5…last5 with the Unicode horizontal ellipsis. */
function shortenAddress(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 5)}\u2026${addr.slice(-5)}`;
}

const Dots = () => (
  <span style={{ letterSpacing: 4, fontSize: 14 }}>
    <span className="gate-dot">.</span>
    <span className="gate-dot">.</span>
    <span className="gate-dot">.</span>
  </span>
);

function Wordmark() {
  return (
    <img
      src="/brand/victorylabs.png"
      alt="VictoryLabs"
      width={264}
      height={79}
      className="vl-wordmark"
      draggable={false}
    />
  );
}

// ── Login ──────────────────────────────────────────────────────────────────

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [pw,     setPw]     = useState('');
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);

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
    if (!ok) { setErr('Wallet or passphrase rejected'); return; }
    onSuccess();
  };

  const reset = () => {
    setWallet(null); setPw(''); setErr(null);
    clearAuth();
  };

  const connected = wallet != null;

  return (
    <div className="gate-stage gate-reveal">
      <Wordmark />
      <div className="gate-hero-stack">
        <h1 className="gate-headline">Access Required</h1>
        <p className="gate-sub">
          {connected
            ? 'Sign in with your passphrase to enter the control plane.'
            : 'Connect a Solana wallet to continue.'}
        </p>
      </div>

      {!connected && (
        <button type="button" className="vl-cta" onClick={connect} disabled={busy}>
          {busy ? <Dots /> : 'Connect Wallet'}
        </button>
      )}

      {connected && (
        <form className="gate-form" onSubmit={submit}>
          <div className="vl-wallet-field">
            <span className="vl-dot" />
            <span className="vl-wallet-text" title={wallet}>{shortenAddress(wallet)}</span>
            <input
              autoFocus
              type="password"
              className="vl-passphrase"
              placeholder="enter passphrase"
              value={pw}
              onChange={e => setPw(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="vl-arrow"
              disabled={!pw || busy}
              aria-label="Enter"
            >
              {busy ? <Dots /> : '→'}
            </button>
          </div>
          <div className="gate-field-row">
            {err ? (
              <div className="vl-error">
                <span className="vl-err-dot" />
                {err.toLowerCase()}
              </div>
            ) : <span />}
            <button type="button" className="vl-change" onClick={reset}>change wallet</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Mode select ────────────────────────────────────────────────────────────

const MODE_META: Record<Exclude<RuntimeMode, 'off'>, { num: string; desc: string }> = {
  full:       { num: '01', desc: 'All sources, all filters.' },
  budget:     { num: '02', desc: 'Polling paths only.' },
  sales_only: { num: '03', desc: 'No listings, no stats pipeline.' },
};

function ModeSelectScreen({ onSelected }: { onSelected: () => void }) {
  const [busy, setBusy] = useState<RuntimeMode | null>(null);
  const [err,  setErr]  = useState<string | null>(null);

  const pick = async (m: RuntimeMode) => {
    if (busy) return;
    setBusy(m); setErr(null);
    const result = await setMode(m);
    setBusy(null);
    if (result == null) {
      if (!isAuthed()) { window.location.reload(); return; }
      setErr('Could not switch mode — try again');
      return;
    }
    onSelected();
  };

  return (
    <div className="gate-stage gate-reveal">
      <Wordmark />
      <div className="gate-hero-stack">
        <h1 className="gate-headline">Select Runtime</h1>
        <p className="gate-sub">Choose how the pipeline should run. Switch any time from the top nav.</p>
      </div>
      <div className="gate-mode-stack">
        {SELECTABLE_MODES.map(m => {
          const meta = MODE_META[m];
          const label = m.replace('_', ' ').toUpperCase();
          const dimmed = busy != null && busy !== m;
          const isBusy = busy === m;
          return (
            <button
              key={m}
              className="vl-cta vl-cta--block"
              onClick={() => pick(m)}
              disabled={busy != null}
              data-busy={isBusy ? 'true' : undefined}
            >
              <span className="vl-cta-num">{meta.num}</span>
              <span className="vl-cta-body">
                <span className="vl-cta-label">{label}</span>
                <span className="vl-cta-desc">{meta.desc}</span>
              </span>
              <span className="vl-cta-chev">
                {isBusy ? <Dots /> : '›'}
              </span>
              {/* Keep the dimmed flag in a data attribute so the visual can
               *  reflect "other rows dimmed while one is busy" without adding
               *  a second CSS class. */}
              <span style={{ display: 'none' }} data-dimmed={dimmed ? 'true' : undefined} />
            </button>
          );
        })}
      </div>
      {err && (
        <div className="vl-error">
          <span className="vl-err-dot" />
          {err.toLowerCase()}
        </div>
      )}
    </div>
  );
}

// ── Handoff CSS (verbatim port from gate-preview.html) ─────────────────────

const GATE_CSS = `
.gate-root, .gate-root *, .gate-root *::before, .gate-root *::after {
  box-sizing: border-box;
}
.gate-root {
  position: fixed; inset: 0;
  min-height: 100vh;
  padding: 60px 24px;
  display: flex; align-items: center; justify-content: center;
  color: #aaaabf;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  background: #050308;
  background-image:
    radial-gradient(ellipse 140% 55% at 65% -5%, rgba(80, 50, 150, 0.10) 0%, transparent 65%),
    radial-gradient(ellipse 70%  40% at  5% 90%, rgba(50, 30, 100, 0.07) 0%, transparent 60%);
  overflow-x: hidden;
  overflow-y: auto;
}
.gate-root::before {
  content: "";
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse 50% 40% at 50% 65%, rgba(128, 104, 216, 0.08) 0%, transparent 70%);
}

/* Animations */
@keyframes gateBusyDots {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40%           { opacity: 1;    transform: translateY(-1px); }
}
.gate-dot       { animation: gateBusyDots 1.2s infinite both; display: inline-block; }
.gate-dot:nth-child(2) { animation-delay: 0.15s; }
.gate-dot:nth-child(3) { animation-delay: 0.30s; }

@keyframes gateReveal {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.gate-reveal { animation: gateReveal 0.22s ease-out both; }

/* Wordmark — PNG asset, proportions preserved. */
.vl-wordmark {
  display: block;
  user-select: none;
}

/* Primary CTA — subtle purple gradient with 3D edge. No halo. */
.vl-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 260px;
  height: 52px;
  padding: 0 28px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: #0c0a1a;
  background: linear-gradient(180deg, #c2a8f5 0%, #9378dd 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 2px 0 rgba(22, 14, 42, 0.75),
    0 6px 14px -4px rgba(128, 104, 216, 0.45);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-cta:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #cdb6f8 0%, #9f84e8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 3px 0 rgba(22, 14, 42, 0.75),
    0 8px 16px -4px rgba(128, 104, 216, 0.55);
}
.vl-cta:active:not([disabled]) {
  transform: translateY(1px);
  background: linear-gradient(180deg, #9378dd 0%, #7a63c4 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 0 0 rgba(22, 14, 42, 0.75),
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
}
.vl-cta[disabled] {
  cursor: not-allowed;
  color: #4a4766;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  border-color: rgba(255, 255, 255, 0.05);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

/* Block variant — mode rows. */
.vl-cta.vl-cta--block {
  width: 100%;
  min-width: 0;
  height: 64px;
  padding: 0 20px;
  justify-content: space-between;
  letter-spacing: 1.8px;
  font-size: 12px;
  text-align: left;
}
.vl-cta.vl-cta--block .vl-cta-body {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  text-transform: none; letter-spacing: 0;
}
.vl-cta.vl-cta--block .vl-cta-num {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px; font-weight: 700; color: rgba(12, 10, 26, 0.55);
  letter-spacing: 1px;
}
.vl-cta.vl-cta--block .vl-cta-label {
  font-size: 13px; font-weight: 700; letter-spacing: 1.8px; color: #0c0a1a;
  text-transform: uppercase;
}
.vl-cta.vl-cta--block .vl-cta-desc {
  font-size: 10.5px; font-weight: 500; color: rgba(12, 10, 26, 0.6);
  letter-spacing: 0.1px;
}
.vl-cta.vl-cta--block .vl-cta-chev {
  font-size: 20px; font-weight: 400; color: rgba(12, 10, 26, 0.7);
  margin-left: 12px; transition: transform 0.16s ease;
}
.vl-cta.vl-cta--block:hover:not([disabled]) .vl-cta-chev { transform: translateX(3px); }
.vl-cta.vl-cta--block[disabled] .vl-cta-num,
.vl-cta.vl-cta--block[disabled] .vl-cta-label,
.vl-cta.vl-cta--block[disabled] .vl-cta-desc,
.vl-cta.vl-cta--block[disabled] .vl-cta-chev {
  color: #4a4766;
}

/* Wallet field (post-connect) */
.vl-wallet-field {
  display: flex;
  align-items: stretch;
  gap: 0;
  width: 100%;
  max-width: 420px;
  height: 52px;
  border: 1px solid rgba(168, 144, 232, 0.22);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(26, 20, 48, 0.7) 0%, rgba(18, 13, 36, 0.7) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.vl-wallet-field:focus-within {
  border-color: rgba(168, 144, 232, 0.5);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(168, 144, 232, 0.25),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
}
.vl-wallet-field .vl-dot {
  flex-shrink: 0;
  align-self: center;
  width: 6px; height: 6px;
  margin-left: 14px;
  border-radius: 50%;
  background: #a890e8;
  box-shadow: 0 0 10px rgba(168, 144, 232, 0.8);
}
.vl-wallet-field .vl-wallet-text {
  align-self: center;
  padding: 0 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12.5px;
  font-weight: 500;
  color: #c4b3f0;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid rgba(168, 144, 232, 0.14);
  margin-right: 2px;
  height: 32px; display: flex; align-items: center;
}
.vl-wallet-field input.vl-passphrase {
  flex: 1;
  min-width: 0;
  padding: 0 14px;
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13.5px;
  color: #e8e6f2;
  caret-color: #a890e8;
  letter-spacing: 0.2px;
}
.vl-wallet-field input.vl-passphrase::placeholder {
  color: #55556a;
  letter-spacing: 0.5px;
}
.vl-wallet-field input.vl-passphrase:disabled {
  color: #55556e;
}

/* 3D arrow button, right-aligned inside the wallet field */
.vl-arrow {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  align-self: center;
  margin-right: 4px;
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  color: #0c0a1a;
  background: linear-gradient(180deg, #c2a8f5 0%, #9378dd 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 2px 0 rgba(22, 14, 42, 0.75),
    0 6px 14px -4px rgba(128, 104, 216, 0.45);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-arrow:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #cdb6f8 0%, #9f84e8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 3px 0 rgba(22, 14, 42, 0.75),
    0 8px 16px -4px rgba(128, 104, 216, 0.55);
}
.vl-arrow:active:not([disabled]) {
  transform: translateY(1px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 0 0 rgba(22, 14, 42, 0.75),
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
  background: linear-gradient(180deg, #9378dd 0%, #7a63c4 100%);
}
.vl-arrow[disabled] {
  cursor: not-allowed;
  color: #4a4766;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

.vl-change {
  background: none; border: none; cursor: pointer;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: #6a6a84;
  padding: 4px 2px;
  transition: color 0.12s;
  align-self: flex-end;
}
.vl-change:hover { color: #c4b3f0; }

.vl-error {
  display: flex; align-items: center; gap: 8px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: #d87575;
  letter-spacing: 0.5px;
}
.vl-error .vl-err-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #d87575; box-shadow: 0 0 8px rgba(216, 117, 117, 0.5);
}

/* Stage + supporting layout (matches preview's v2 column) */
.gate-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 44px;
  width: 100%;
  max-width: 460px;
  position: relative;
  z-index: 1;
}
.gate-hero-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.gate-headline {
  font-family: 'Playfair Display', 'Georgia', serif;
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.05;
  color: #f4f2fa;
  text-align: center;
  text-shadow: 0 0 24px rgba(168, 144, 232, 0.14);
  margin: 0;
}
.gate-sub {
  font-size: 13px;
  color: #8888a8;
  letter-spacing: 0.2px;
  text-align: center;
  max-width: 340px;
  line-height: 1.55;
  margin: 0;
}
.gate-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: 100%;
  max-width: 420px;
}
.gate-field-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 18px;
}
.gate-mode-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 420px;
}
`;
