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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getWallets } from '@wallet-standard/app';
import { isAuthed, loginWithSiws, clearAuth } from './auth';
import { fetchMode, setMode, getRuntimeChoice, setRuntimeChoice, type RuntimeMode } from './mode';
import { setMintTrackerEnabled } from './mint-tracker';
// import { VictoryLabsLogo } from '@/soloist/VictoryLabsLogo'; // preserved, not used — SVGs serve the logo
import { FloatingLayoutModeSwitcher, BottomStatusBar, TopNav } from '@/soloist/shared';
import { usePathname } from 'next/navigation';

type GateState =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'mode-select' }
  // `mode` is a display tag only (the active branch renders children
  // regardless). 'mints' = the Mint Tracker runtime (salesMode off + mint
  // tracker on), surfaced when the user explicitly chose it.
  | { kind: 'active'; mode: Exclude<RuntimeMode, 'off'> | 'mints' };

export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  // Inside multi-tab iframes (?embed=1) the switcher is owned by the
  // outer page, so we suppress this instance to keep exactly one.
  // Read window.location.search directly (not useSearchParams) so
  // Gate stays compatible with Next's static prerender — no Suspense
  // boundary required.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    setEmbedded(p.get('embed') === '1');
  }, []);

  const resolve = useCallback(async () => {
    if (!isAuthed()) { setState({ kind: 'login' }); return; }
    const mode = await fetchMode();
    if (mode != null && mode !== 'off') { setState({ kind: 'active', mode }); return; }
    // salesMode is off/unknown — but an explicit Mint Tracker choice keeps the
    // app active (mints run independently of salesMode). Otherwise prompt.
    if (getRuntimeChoice() === 'mints') { setState({ kind: 'active', mode: 'mints' }); return; }
    setState({ kind: 'mode-select' });
  }, []);

  useEffect(() => { void resolve(); }, [resolve]);

  // Watchdog — the Gate must NEVER sit on the loading shell forever. `resolve`
  // normally completes in well under a second (fetchMode itself times out at
  // 7s). If anything still leaves us in `loading` past this deadline (a hung
  // request the abort didn't catch, AbortController unavailable, etc.), fail
  // safe OUT of the loader using only synchronous local state: re-login if not
  // authed, the Mint Tracker if explicitly chosen, otherwise the mode-select
  // screen. Only acts while still loading, so the happy path is untouched.
  useEffect(() => {
    const t = setTimeout(() => {
      setState(prev => {
        if (prev.kind !== 'loading') return prev;
        if (!isAuthed()) return { kind: 'login' };
        if (getRuntimeChoice() === 'mints') return { kind: 'active', mode: 'mints' };
        return { kind: 'mode-select' };
      });
    }, 9000);
    return () => clearTimeout(t);
  }, []);

  if (state.kind === 'loading') {
    return <GateShell><div style={{ color: '#9a9ab4', fontSize: 12 }}>…</div></GateShell>;
  }
  if (state.kind === 'login') {
    return <GateShell><LoginScreen onSuccess={() => { void resolve(); }} /></GateShell>;
  }
  if (state.kind === 'mode-select') {
    return <GateShell><ModeSelectScreen /></GateShell>;
  }
  // Active app: render children plus the always-on floating layout-mode
  // switcher. It pins to the bottom-right in every mode/resolution and
  // is the only switcher in the app — TopNav no longer carries one.
  // Suppressed inside multi-tab iframes so the outer page's instance
  // stays the only one visible.
  return (
    <>
      {!embedded && <PersistentTopNav />}
      {children}
      {!embedded && <PersistentBottomStatusBar />}
      {!embedded && <FloatingLayoutModeSwitcher />}
    </>
  );
}

// ── Persistent TopNav ────────────────────────────────────────────────────
//
// One mounted instance for the whole app — mirrors PersistentBottomStatusBar.
// Lifting TopNav out of each page is the single biggest source of the
// "navigation flash" the user reported: previously every page rendered its
// own <TopNav>, which unmounted with the old route and remounted with the
// new route, leaving a 1–2 frame gap where the chrome disappeared and the
// raw body background showed through. With TopNav rendered here it stays
// in place across route changes; only the content area below transitions.
//
// Hidden on /access (auth screen has its own chrome). Visible on /multi
// (the outer multi-tab page IS the chrome that hosts iframes).
function PersistentTopNav() {
  const pathname = usePathname() ?? '';
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, [pathname]);
  if (embedded) return null;
  if (pathname.startsWith('/access')) return null;
  return <TopNav />;
}

// ── Persistent BottomStatusBar ────────────────────────────────────────────
//
// One mounted instance for the whole app — survives client-side route
// changes between /dashboard, /mints, /tools, /feed (and any other
// non-embed page) so the bar's internal state (TPS / SOL price fetch
// loop, "Incl. fees" toggle, EVENTS counter from /feed) doesn't reset
// on navigation. Hidden on /multi and on /access (no business showing
// status chrome behind the auth gate / outer multi-tab page).
//
// Position: fixed at bottom so feed-root's existing flex height math
// (`height: 100vh`, PC zoom calc) stays untouched. The companion CSS
// rule `body[data-bottombar="1"] .feed-root { padding-bottom: 36px }`
// reserves space inside the page so content doesn't scroll behind the
// bar — the same 36 px previously occupied by the in-flex bar.
function PersistentBottomStatusBar() {
  const pathname = usePathname() ?? '';
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, [pathname]);

  // Routes that never show the bar:
  //   /access     — auth screen has its own chrome.
  //   embed mode  — multi-tab iframes; outer page owns the bar.
  // /multi now SHOWS the bar (same as other pages); the data-bottombar
  // attribute below reserves 36 px on .feed-root so the 3-column grid
  // doesn't slide behind the fixed bar.
  const hidden =
    pathname.startsWith('/access') ||
    embedded;

  // Mark the body so the CSS rule reserves 36 px of bottom padding on
  // .feed-root only when the bar is actually present. Cleared on
  // unmount + on every route that doesn't show the bar.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (hidden) document.body.removeAttribute('data-bottombar');
    else        document.body.setAttribute('data-bottombar', '1');
    return () => { document.body.removeAttribute('data-bottombar'); };
  }, [hidden]);

  if (hidden) return null;
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90, pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto' }}>
        <BottomStatusBar />
      </div>
    </div>
  );
}

// ── Shell — full-screen dark-purple washes from handoff body styles ────────

function GateShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Inject the CSS verbatim. Passing GATE_CSS as a text child made React
          entity-escape it on the server (content: "" → content: &quot;&quot;;)
          while <style> is a raw-text element the browser leaves un-decoded —
          so the server text never matched the client's, triggering a
          document-level hydration bail (blank loading shell in prod).
          dangerouslySetInnerHTML emits identical raw CSS on both sides. */}
      <style dangerouslySetInnerHTML={{ __html: GATE_CSS }} />
      <div className="gate-root">{children}</div>
    </>
  );
}

// ── Wallet detection (wallet-standard) ────────────────────────────────────
// All modern Solana wallets (Phantom ≥ v22, Solflare ≥ v3, Backpack, etc.)
// self-register in the global wallet-standard registry. getWallets() enumerates
// them; no per-wallet window.* checks needed. Future wallets appear automatically.

interface StdAccount {
  address: string;       // base58 pubkey
  publicKey: Uint8Array; // raw 32-byte key
  chains: readonly string[];
  features: readonly string[];
}

interface StdWallet {
  name: string;
  icon: string;          // data: URI (svg or png)
  chains: readonly string[];
  features: Record<string, unknown>;
}

interface ConnectedWallet { wallet: StdWallet; account: StdAccount }

type ConnectFeature = {
  connect(opts?: { silent?: boolean }): Promise<{ accounts: ReadonlyArray<StdAccount> }>;
};
type SignFeature = {
  signMessage(i: { message: Uint8Array; account: StdAccount }): Promise<ReadonlyArray<{ signature: Uint8Array }>>;
};

function isSolanaWallet(w: StdWallet): boolean {
  return 'standard:connect' in w.features &&
         'solana:signMessage' in w.features &&
         w.chains.some(c => c.startsWith('solana:'));
}

function walletToSignCapable(
  { wallet, account }: ConnectedWallet,
): { signMessage: (msg: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array | string }> } {
  return {
    signMessage: async (message: Uint8Array) => {
      const feat = wallet.features['solana:signMessage'] as SignFeature;
      const [res] = await feat.signMessage({ message, account });
      return { signature: res.signature };
    },
  };
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
  // SVG export — text version preserved in VictoryLabsLogo.tsx
  return <img src="/logo-gate.svg" alt="VictoryLabs" style={{ display: 'block' }} />;
}

// ── Login ──────────────────────────────────────────────────────────────────

function WalletModal({ onSelect, onClose }: {
  onSelect: (cw: ConnectedWallet) => void;
  onClose: () => void;
}) {
  const [wallets,  setWallets]  = useState<StdWallet[]>([]);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [err,      setErr]      = useState<string | null>(null);
  const onCloseRef              = useRef(onClose);
  onCloseRef.current            = onClose;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const registry = getWallets() as unknown as {
      get(): unknown[];
      on(event: string, listener: () => void): () => void;
    };
    const refresh = () => {
      setWallets((registry.get() as StdWallet[]).filter(isSolanaWallet));
    };
    refresh();
    return registry.on('register', refresh);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const select = async (w: StdWallet) => {
    setBusyName(w.name); setErr(null);
    try {
      const feat = w.features['standard:connect'] as ConnectFeature;
      const { accounts } = await feat.connect();
      if (!accounts[0]) { setErr('No accounts returned'); setBusyName(null); return; }
      onSelect({ wallet: w, account: accounts[0] });
    } catch {
      setErr('Connection rejected');
      setBusyName(null);
    }
  };

  return (
    <div className="vl-modal-overlay" onClick={onClose}>
      <div className="vl-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="vl-modal-header">
          <span className="vl-modal-title">Connect Wallet</span>
          <button className="vl-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {wallets.length === 0 ? (
          <p className="vl-modal-empty">No wallets detected.<br />Install Phantom, Solflare, or Backpack.</p>
        ) : (
          <ul className="vl-modal-list">
            {wallets.map(w => (
              <li key={w.name}>
                <button
                  type="button"
                  className="vl-modal-wallet"
                  onClick={() => select(w)}
                  disabled={busyName != null}
                >
                  <img src={w.icon} alt="" className="vl-modal-wallet-icon" />
                  <span className="vl-modal-wallet-name">{w.name}</span>
                  <span className="vl-modal-wallet-badge">Detected</span>
                  {busyName === w.name && <Dots />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {err && (
          <div className="vl-modal-err">
            <span className="vl-err-dot" />{err.toLowerCase()}
          </div>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [connWallet, setConnWallet] = useState<ConnectedWallet | null>(null);
  const [modalOpen,  setModalOpen]  = useState(false);
  const [pw,         setPw]         = useState('');
  const [busy,       setBusy]       = useState(false);
  const [err,        setErr]        = useState<string | null>(null);

  const onWalletSelected = (cw: ConnectedWallet) => {
    setConnWallet(cw); setModalOpen(false); setErr(null);
  };

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!connWallet || !pw || busy) return;
    setBusy(true); setErr(null);
    const provider = walletToSignCapable(connWallet);
    const result = await loginWithSiws(provider, connWallet.account.address, pw);
    setBusy(false);
    if (!result.ok) {
      const msg =
        result.reason === 'no_wallet'         ? 'Wallet does not support message signing' :
        result.reason === 'wallet_rejected'   ? 'Signature cancelled' :
        result.reason === 'nonce_failed'      ? 'Could not start sign-in — try again' :
        result.reason === 'verify_failed'     ? 'Wallet or passphrase rejected' :
        result.reason === 'network'           ? 'Network error — try again' :
        result.reason === 'malformed_response'? 'Unexpected server response' :
                                                'Sign-in failed';
      setErr(msg);
      return;
    }
    onSuccess();
  };

  const reset = () => {
    setConnWallet(null); setPw(''); setErr(null);
    clearAuth();
  };

  const isConnected = connWallet != null;

  return (
    <div className="gate-stage gate-reveal">
      <Wordmark />
      <div className="gate-hero-stack">
        <h1 className="gate-headline">Access Required</h1>
        <p className="gate-sub">
          {isConnected
            ? 'Sign in with your passphrase to enter the control plane.'
            : 'Connect a Solana wallet to continue.'}
        </p>
      </div>

      {!isConnected && (
        <>
          <button type="button" className="vl-cta" onClick={() => setModalOpen(true)}>
            Connect Wallet
          </button>
          {modalOpen && (
            <WalletModal onSelect={onWalletSelected} onClose={() => setModalOpen(false)} />
          )}
        </>
      )}

      {isConnected && (
        <form className="gate-form" onSubmit={submit}>
          <div className="vl-wallet-field">
            <span className="vl-dot" />
            <span className="vl-wallet-text">{shortenAddress(connWallet.account.address)}</span>
            <input
              autoFocus
              type="text"
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

// Runtime selection. Three cards, fixed order:
//   01 FULL        — disabled (visible but inactive; FULL is temporarily off)
//   02 MINT TRACKER — salesMode off + mint tracker on → routes to /mints
//   03 SALES ONLY  — sales_only → routes to /feed
// Each active card sets the backend runtime then hard-navigates to its home
// route (the reload re-runs Gate.resolve into the active app).
function ModeSelectScreen() {
  const [busy, setBusy] = useState<'mints' | 'sales' | null>(null);
  const [err,  setErr]  = useState<string | null>(null);

  const fail = () => {
    setBusy(null);
    if (!isAuthed()) { window.location.reload(); return; }
    setErr('Could not switch mode — try again');
  };

  // MINT TRACKER: sales off, mints on. salesMode='off' is the backend's
  // "no sales ingestion" state; the mint tracker runs independently. Persist
  // the explicit choice so the Gate treats off-sales as the active Mint
  // Tracker view instead of re-prompting.
  const pickMintTracker = async () => {
    if (busy) return;
    setBusy('mints'); setErr(null);
    const result = await setMode('off');
    if (result == null) { fail(); return; }
    await setMintTrackerEnabled(true);   // ensure mints stay on (independent; default on)
    setRuntimeChoice('mints');
    window.location.href = '/mints';
  };

  // SALES ONLY: lean sale ingestion, no listings/stats pipeline → /feed.
  const pickSalesOnly = async () => {
    if (busy) return;
    setBusy('sales'); setErr(null);
    const result = await setMode('sales_only');
    if (result == null) { fail(); return; }
    setRuntimeChoice('sales');
    window.location.href = '/feed';
  };

  return (
    <div className="gate-stage gate-reveal">
      <Wordmark />
      <div className="gate-hero-stack">
        <h1 className="gate-headline">Select Runtime</h1>
        <p className="gate-sub">Choose how the pipeline should run. Switch any time from the top nav.</p>
      </div>
      <div className="gate-mode-stack">
        {/* 01 FULL — temporarily disabled. Visible but inactive (dimmed, no
            hover glow, not clickable via the shared vl-cta[disabled] styles). */}
        <button className="vl-cta vl-cta--block" disabled aria-disabled="true">
          <span className="vl-cta-label">FULL</span>
        </button>

        <button
          className="vl-cta vl-cta--block"
          onClick={pickMintTracker}
          disabled={busy != null}
          data-busy={busy === 'mints' ? 'true' : undefined}
        >
          <span className="vl-cta-label">{busy === 'mints' ? <Dots /> : 'MINT TRACKER'}</span>
        </button>

        <button
          className="vl-cta vl-cta--block"
          onClick={pickSalesOnly}
          disabled={busy != null}
          data-busy={busy === 'sales' ? 'true' : undefined}
        >
          <span className="vl-cta-label">{busy === 'sales' ? <Dots /> : 'SALES ONLY'}</span>
        </button>
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
  color: #9a9ab4;
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

/* Primary CTA — soft illuminated glass. */
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
  color: #08060c;
  background: linear-gradient(180deg, #bbaaf2 0%, #9576e8 100%);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 6px 18px -4px rgba(148, 118, 232, 0.4);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-cta:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #c8b8f6 0%, #a487ee 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 8px 22px -4px rgba(160, 130, 240, 0.5);
}
.vl-cta:active:not([disabled]) {
  transform: translateY(1px);
  background: linear-gradient(180deg, #9878ea 0%, #8468d8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
}
.vl-cta[disabled] {
  cursor: not-allowed;
  color: #241f3b;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  border-color: rgba(255, 255, 255, 0.05);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

/* Block variant — mode rows. */
.vl-cta.vl-cta--block {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 56px;
  padding: 0 28px;
  letter-spacing: 2px;
  font-size: 12.5px;
}
.vl-cta.vl-cta--block .vl-cta-label {
  font-size: 12.5px; font-weight: 700; letter-spacing: 2px; color: #08060c;
  text-transform: uppercase;
}
.vl-cta.vl-cta--block[disabled] .vl-cta-label {
  color: #241f3b;
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
  color: #a890e8;
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
  color: #f0eef8;
  caret-color: #a890e8;
  letter-spacing: 0.2px;
}
.vl-wallet-field input.vl-passphrase::placeholder {
  color: #55556a;
  letter-spacing: 0.5px;
}
.vl-wallet-field input.vl-passphrase:disabled {
  color: #9a9ab4;
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
  color: #08060c;
  background: linear-gradient(180deg, #bbaaf2 0%, #9576e8 100%);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 6px 18px -4px rgba(148, 118, 232, 0.4);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-arrow:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #c8b8f6 0%, #a487ee 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 8px 22px -4px rgba(160, 130, 240, 0.5);
}
.vl-arrow:active:not([disabled]) {
  transform: translateY(1px);
  background: linear-gradient(180deg, #9878ea 0%, #8468d8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
}
.vl-arrow[disabled] {
  cursor: not-allowed;
  color: #241f3b;
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
  color: #9a9ab4;
  padding: 4px 2px;
  transition: color 0.12s;
  align-self: flex-end;
}
.vl-change:hover { color: #a890e8; }

.vl-error {
  display: flex; align-items: center; gap: 8px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: #d96867;
  letter-spacing: 0.5px;
}
.vl-error .vl-err-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #d96867; box-shadow: 0 0 8px rgba(216, 117, 117, 0.5);
}

/* Stage + supporting layout (matches preview's v2 column) */
.gate-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  width: 100%;
  max-width: 460px;
  position: relative;
  z-index: 1;
}
.gate-stage .vl-hero,
.gate-stage > .vl-logo {
  margin-bottom: 64px;
}
.gate-hero-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 60px;
}
.gate-headline {
  font-family: 'Playfair Display', 'Georgia', serif;
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.05;
  color: #f4f2fa;
  text-align: center;
  text-shadow: 0 0 24px rgba(168, 144, 232, 0.14);
  margin: 0;
}
.gate-sub {
  font-size: 15px;
  color: #8888a8;
  letter-spacing: 0.1px;
  text-align: center;
  max-width: 340px;
  line-height: 1.65;
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

/* Wallet selector modal */
.vl-modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(5, 3, 8, 0.82);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: gateReveal 0.14s ease-out both;
}
.vl-modal {
  width: 100%; max-width: 360px; margin: 0 16px;
  background: linear-gradient(180deg, #130f20 0%, #0d0a1a 100%);
  border: 1px solid rgba(168, 144, 232, 0.18);
  border-radius: 16px;
  padding: 24px;
  box-shadow:
    0 0 0 1px rgba(168, 144, 232, 0.06),
    0 24px 64px -12px rgba(0, 0, 0, 0.85);
}
.vl-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.vl-modal-title {
  font-size: 11px; font-weight: 700; letter-spacing: 2px;
  text-transform: uppercase; color: #c4b8f0;
}
.vl-modal-close {
  background: none; border: none; cursor: pointer; font-family: inherit;
  color: #5a5880; font-size: 13px; line-height: 1;
  padding: 4px 6px; border-radius: 4px;
  transition: color 0.14s, background 0.14s;
}
.vl-modal-close:hover { color: #9a9ab4; background: rgba(255, 255, 255, 0.05); }
.vl-modal-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.vl-modal-wallet {
  width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  background: rgba(168, 144, 232, 0.05);
  border: 1px solid rgba(168, 144, 232, 0.10);
  border-radius: 10px;
  cursor: pointer; font-family: inherit;
  transition: background 0.14s, border-color 0.14s;
}
.vl-modal-wallet:hover:not([disabled]) {
  background: rgba(168, 144, 232, 0.12);
  border-color: rgba(168, 144, 232, 0.25);
}
.vl-modal-wallet[disabled] { opacity: 0.5; cursor: not-allowed; }
.vl-modal-wallet-icon { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; }
.vl-modal-wallet-name {
  font-size: 13px; font-weight: 600; color: #d4ccf0;
  flex: 1; text-align: left; letter-spacing: 0.2px;
}
.vl-modal-wallet-badge {
  font-size: 9px; font-weight: 700; letter-spacing: 1.2px;
  text-transform: uppercase; color: #43B984;
  background: rgba(67, 185, 132, 0.10);
  border: 1px solid rgba(67, 185, 132, 0.22);
  border-radius: 4px; padding: 2px 7px;
}
.vl-modal-empty {
  font-size: 12px; color: #5a5880; text-align: center;
  padding: 20px 0; margin: 0; line-height: 1.6;
}
.vl-modal-err {
  margin-top: 14px; display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: #e05a6a;
}
`;
