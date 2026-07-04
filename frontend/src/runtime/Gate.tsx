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
import { isAuthed, loginWithSiws, clearAuth, isAuditView } from './auth';
import { fetchMode, setMode, getRuntimeChoice, setRuntimeChoice, type RuntimeMode } from './mode';
import { setMintTrackerEnabled } from './mint-tracker';
// import { VictoryLabsLogo } from '@/soloist/VictoryLabsLogo'; // preserved, not used — SVGs serve the logo
import { FloatingLayoutModeSwitcher, BottomStatusBar, TopNav } from '@/soloist/shared';
import { CommandPalette } from '@/soloist/CommandPalette';
import { usePathname } from 'next/navigation';
// CSS is server-rendered via layout.tsx → gate-css.ts. Runtime import here
// so the bundler links Gate.tsx to gate-css.ts — changing gate-css.ts forces
// a new chunk hash, ensuring browsers fetch the updated bundle.
import { GATE_CSS as _gateCss } from './gate-css';

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
    // Audit view (read-only) unlocks the gated UI without a wallet login.
    // It never mints a token, so writes stay blocked at the backend.
    const audit = isAuditView();
    if (!isAuthed() && !audit) { setState({ kind: 'login' }); return; }
    const mode = await fetchMode();
    if (mode != null && mode !== 'off') { setState({ kind: 'active', mode }); return; }
    // salesMode is off/unknown — but an explicit Mint Tracker choice keeps the
    // app active (mints run independently of salesMode). Otherwise prompt.
    if (getRuntimeChoice() === 'mints') { setState({ kind: 'active', mode: 'mints' }); return; }
    // Audit view renders the real app even when sales mode is off/unknown, so
    // an auditor sees live UI instead of the mode-select prompt.
    if (audit) { setState({ kind: 'active', mode: 'sales_only' }); return; }
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
        if (!isAuthed() && !isAuditView()) return { kind: 'login' };
        if (getRuntimeChoice() === 'mints') return { kind: 'active', mode: 'mints' };
        if (isAuditView()) return { kind: 'active', mode: 'sales_only' };
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
      {!embedded && <CommandPalette />}
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
  // CSS is injected in the server-rendered <head> via layout.tsx (gate-css.ts)
  // so it is always present regardless of JS chunk cache state.
  return <div className="gate-root">{children}</div>;
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
  return addr.length <= 10 ? addr : `${addr.slice(0, 5)}…${addr.slice(-5)}`;
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

// ── Social icons ───────────────────────────────────────────────────────────

function IconX() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function IconDiscord() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.111 18.1.128 18.115c2.053 1.508 4.041 2.423 5.993 3.029a.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.029.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
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
      <div className="gate-top-group">
        <Wordmark />
        <div className="gate-hero-stack">
          <h1 className="gate-headline">Access Required</h1>
          <p className="gate-sub">
            {isConnected
              ? 'Sign in with your passphrase to enter the control plane.'
              : 'Connect a Solana wallet to continue.'}
          </p>
        </div>
      </div>

      {!isConnected && (
        <>
          <button type="button" className="vl-cta" onClick={() => setModalOpen(true)}>
            Connect Wallet
          </button>
          <div className="gate-helper-block">
            <p className="gate-helper-text">Don&apos;t have access? Request an invite.</p>
            <div className="gate-social-row">
              <a href="#" className="gate-social-icon" aria-label="Follow on X" target="_blank" rel="noopener noreferrer">
                <IconX />
              </a>
              <a href="#" className="gate-social-icon" aria-label="Join Discord" target="_blank" rel="noopener noreferrer">
                <IconDiscord />
              </a>
            </div>
          </div>
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
      <div className="gate-top-group">
        <Wordmark />
        <div className="gate-hero-stack">
          <h1 className="gate-headline">Select Runtime</h1>
          <p className="gate-sub">Choose how the pipeline should run. Switch any time from the top nav.</p>
        </div>
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

