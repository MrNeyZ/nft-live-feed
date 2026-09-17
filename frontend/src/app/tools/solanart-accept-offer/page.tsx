'use client';

// Solanart forgotten-bid Accept Offer tool — personal use only. Solanart
// (solanart.io) has been dead since ~2022 (no API, no RPC), but its
// on-chain marketplace program still holds thousands of funded, never-
// cancelled bid escrows from 2021-2022. If you own the exact NFT one of
// those bids targets, this tool builds the raw on-chain Accept Offer
// instruction directly — bypassing the dead marketplace entirely.
//
// pNFT only for now — a legacy (pre-2022 standard) target mint is refused
// with a clear error rather than silently mis-built.
//
// Single signer: only your connected wallet needs to sign (no cosigner).
// No DRY RUN/LIVE toggle — matches /tools/me-sell's model exactly (removed
// per operator request 2026-09-17): Simulate is the real pre-flight check,
// Phantom's own confirmation screen is the real human checkpoint, Sign &
// Submit always goes live. The server's SOLANART_ACCEPT_OFFER_ENABLE_LIVE
// env var is still the actual enforcement boundary — submit fails closed
// with a clear error if that's ever unset, no client-side gate needed on
// top of it.
//
// Layout matches /tools/me-sell 1:1 (same PANEL/Row/ToolTextInput/LiveDot
// primitives, same header → load-panel → info-panel → action-flow shape)
// per operator request — this page's own state machine (build → simulate
// → sign → submit) is unchanged, only the visual language moved over.

import { useEffect, useState } from 'react';
import { Transaction } from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ADDR_RE, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { CtaButton, LiveDot } from '@/soloist/shared';

const FIELDS_KEY = 'vl.solanartAcceptOffer.fields';

interface OfferInfo {
  offerKey: string; buyer: string; mint: string; priceSol: number;
  /** Best-effort only — checked against the buyer's ATA before any seller
   *  is known, so it can under-report a real pNFT as legacy. Build itself
   *  re-checks against your actual connected wallet and is authoritative. */
  tokenStandardPreview: 'pnft' | 'legacy_or_unknown';
}
interface BuildSummary {
  seller: string; offerKey: string; buyer: string; mint: string; priceSol: number;
  creators: Array<{ address: string; share: number; verified: boolean }>;
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
  if (m.includes('offer_not_found_or_already_closed')) return 'This offer no longer exists — it was already accepted or cancelled.';
  if (m.includes('offer_not_active')) return 'This offer is not currently active.';
  if (m.includes('mint_unresolvable_buyer_ata_closed')) return "Can't resolve the target NFT — the buyer's reference token account was closed. This offer's target mint is unrecoverable this way.";
  if (m.includes('legacy_token_standard_not_supported_yet')) return "This NFT is a legacy (pre-pNFT) token standard — this tool only supports pNFT targets right now.";
  if (m.includes('seller_does_not_hold_this_nft')) return "The connected wallet doesn't hold this exact NFT right now.";
  if (m.includes('no_on_chain_creators_found')) return 'Could not read an on-chain creators list for this NFT — this mint has none set, so a royalty-safe accept instruction cannot be built for it.';
  if (m.includes('invalid_offer_key')) return 'Enter a valid offer account address.';
  if (m.includes('invalid_buyer')) return 'Enter a valid bidder wallet address.';
  if (m.includes('invalid_mint')) return 'Enter a valid NFT mint address.';
  if (m.includes('offer_not_found:')) return "No active offer from this bidder on this mint — check both addresses, or the bid may have already been accepted/cancelled.";
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  if (m.includes('live_mode_disabled_server_side')) return 'LIVE mode is disabled on the server (SOLANART_ACCEPT_OFFER_ENABLE_LIVE is not set to true).';
  if (m.includes('digest_not_found_expired_or_already_used') || m.includes('digest_expired')) return 'This build expired or was already used — build again.';
  if (m.includes('signed_tx_message_does_not_match_digest')) return 'Signed transaction did not match what was built — build again.';
  if (m.includes('preflight_simulation_failed')) return 'Server-side preflight simulation failed — this would not succeed on-chain right now.';
  if (m.includes('blockhash_expired') || m.includes('blockhash_near_expiry')) return "This build's blockhash has expired or is about to — build again and sign promptly.";
  if (m.includes('invalid_signature')) return 'Signature verification failed.';
  return message;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 16px',
      borderBottom: '1px solid rgba(255,255,255,0.022)' }}>
      <div style={{ width: 140, flexShrink: 0, fontSize: 10, color: 'var(--vl-text-muted)', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.5px', paddingTop: 1 }}>{label}</div>
      <div style={{ ...MONO, fontSize: 12, color: 'var(--vl-text-primary)', fontWeight: 600, wordBreak: 'break-all', flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

export default function SolanartAcceptOfferPage() {
  const [wallet, setWallet] = useState<string | null>(null);

  const [buyerAddr, setBuyerAddr] = useState('');
  const [mintAddr, setMintAddr] = useState('');
  const [offerInfo, setOfferInfo] = useState<OfferInfo | null>(null);
  const [offerLookupError, setOfferLookupError] = useState<string | null>(null);
  const [offerLoading, setOfferLoading] = useState(false);

  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FIELDS_KEY);
      if (raw) {
        const f = JSON.parse(raw) as { buyer?: string; mint?: string };
        if (f.buyer) setBuyerAddr(f.buyer);
        if (f.mint) setMintAddr(f.mint);
      }
    } catch { /* ignore */ }
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  useEffect(() => {
    localStorage.setItem(FIELDS_KEY, JSON.stringify({ buyer: buyerAddr, mint: mintAddr }));
  }, [buyerAddr, mintAddr]);

  async function handleConnect() {
    try { setWallet(await connectPhantom()); }
    catch (err) { setUiState({ kind: 'error', message: humanizeError((err as Error).message) }); }
  }
  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    setUiState({ kind: 'idle' });
  }

  const busy = uiState.kind === 'building' || uiState.kind === 'simulating' || uiState.kind === 'signing';
  const canLoad = ADDR_RE.test(buyerAddr) && ADDR_RE.test(mintAddr) && !offerLoading && !busy;

  async function lookupOffer() {
    if (!canLoad) return;
    setOfferLookupError(null);
    setOfferInfo(null);
    setUiState({ kind: 'idle' });
    setOfferLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/tools/solanart-accept-offer/resolve-offer?buyer=${buyerAddr}&mint=${mintAddr}`, { headers: { ...authHeaders() } });
      const j = await r.json() as { ok: boolean; offer?: OfferInfo; error?: string };
      if (j.ok && j.offer) setOfferInfo(j.offer);
      else setOfferLookupError(humanizeError(j.error ?? `HTTP ${r.status}`));
    } catch (err) {
      setOfferLookupError(humanizeError((err as Error).message));
    } finally {
      setOfferLoading(false);
    }
  }

  async function handleBuild() {
    if (!wallet || !offerInfo) return;
    setUiState({ kind: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/solanart-accept-offer/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ seller: wallet, offerKey: offerInfo.offerKey, mint: offerInfo.mint }),
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
      const r = await fetch(`${API_BASE}/api/tools/solanart-accept-offer/simulate`, {
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
    if (uiState.kind !== 'built' && uiState.kind !== 'simulated') return;
    const built: Built = uiState;
    if (Date.now() > built.expiresAt) { setUiState({ kind: 'error', message: 'This build expired — build again.' }); return; }
    setUiState({ kind: 'signing', ...built });
    try {
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom wallet not found. Install the Phantom extension.');
      const tx = Transaction.from(Buffer.from(built.tx, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedTx = signed.serialize({ requireAllSignatures: true }).toString('base64');

      const r = await fetch(`${API_BASE}/api/tools/solanart-accept-offer/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ signedTx, digest: built.digest }),
      });
      const j = await r.json() as { ok: boolean; signature?: string; error?: string };
      if (!j.ok || !j.signature) { setUiState({ kind: 'error', message: humanizeError(j.error ?? `HTTP ${r.status}`) }); return; }
      setUiState({ kind: 'success', sig: j.signature });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeError((err as Error).message) });
    }
  }

  const built = uiState.kind === 'built' || uiState.kind === 'simulating' || uiState.kind === 'simulated' || uiState.kind === 'signing';
  const summary = built ? (uiState as Built).summary : null;
  const preflightLogs = built ? (uiState as Built).preflightLogs : [];
  const simulated = uiState.kind === 'simulated';
  const simFailed = simulated && uiState.simErr != null;

  // Not gated on tokenStandardPreview — that check is buyer-side and can
  // under-report a real pNFT as legacy. Build itself authoritatively
  // re-checks against the connected seller wallet and returns a clear
  // 'legacy_token_standard_not_supported_yet' error if it truly isn't one.
  const canBuild = !!wallet && !busy && !!offerInfo;

  return (
    <div className="feed-root page-transition" data-page="solanart-accept-offer">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
        <div style={{ padding: '20px 4px 40px', width: '100%', maxWidth: 720, margin: '0 auto', boxSizing: 'border-box' }}>

          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
            Solanart Accept Offer
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginBottom: 16, fontSize: 11, color: 'var(--vl-text-muted)' }}>
            <LiveDot />
            <span>accept a forgotten 2021-2022 Solanart bid — paste bidder wallet / your NFT&apos;s mint. pNFT targets only.</span>
          </div>

          <div style={{ ...PANEL, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ToolTextInput value={mintAddr} onChange={(e) => setMintAddr(e.target.value)} placeholder="your NFT's mint address" style={{ fontSize: 12 }} disabled={busy} />
            <ToolTextInput value={buyerAddr} onChange={(e) => setBuyerAddr(e.target.value)} placeholder="bidder wallet (who made the offer)" style={{ fontSize: 12 }} disabled={busy} />
            <CtaButton onClick={() => void lookupOffer()} disabled={!canLoad}>
              {offerLoading ? 'Loading…' : 'Load Offer'}
            </CtaButton>
          </div>

          {offerLookupError && (
            <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
              background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5 }}>
              {offerLookupError}
            </div>
          )}

          {offerInfo && (
            <div style={{ ...PANEL, marginTop: 16 }}>
              <Row label="Price">{offerInfo.priceSol} SOL</Row>
              <Row label="Buyer">{short(offerInfo.buyer)}</Row>
              <Row label="Target mint">{short(offerInfo.mint)}</Row>
              <Row label="Standard">
                {offerInfo.tokenStandardPreview === 'pnft'
                  ? <span style={{ color: 'var(--vl-green-primary)' }}>Programmable NFT (pNFT)</span>
                  : <span style={{ color: 'var(--vl-text-muted)' }}>unconfirmed — Build will check for real</span>}
              </Row>

              <div style={{ padding: 16, borderTop: '1px solid rgb(var(--vl-purple-tint) / 0.08)' }}>
                {!wallet ? (
                  <CtaButton onClick={() => void handleConnect()} block>Connect Phantom</CtaButton>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span>Seller wallet: <span style={{ ...MONO, color: 'var(--vl-text-primary)' }}>{short(wallet)}</span></span>
                      <DisconnectLink onClick={handleDisconnect} />
                    </div>

                    <CtaButton onClick={() => void handleBuild()} disabled={!canBuild} block>
                      {uiState.kind === 'building' ? 'Building…' : 'Build Accept Tx'}
                    </CtaButton>

                    {summary && (
                      <div style={{ marginTop: 14, borderTop: '1px solid rgb(var(--vl-purple-tint) / 0.08)', paddingTop: 14 }}>
                        <SummaryPanel summary={summary} />
                        {preflightLogs.length > 0 && (
                          <div style={{ fontSize: 10.5, color: 'var(--vl-green-primary)', marginTop: 8, marginBottom: 4 }}>
                            ✓ server-side preflight simulation passed at build time
                          </div>
                        )}

                        <div style={{ marginTop: 14 }}>
                          <CtaButton onClick={() => void handleSignSubmit()} disabled={busy} block>
                            {busy ? 'Signing…' : `Sign & Submit — ${summary.priceSol} SOL`}
                          </CtaButton>
                        </div>

                        {uiState.kind === 'success' && (
                          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 5, fontSize: 12,
                            color: 'var(--vl-green-primary)', background: 'rgb(var(--vl-green-glow) / 0.08)', border: '1px solid rgb(var(--vl-green-glow) / 0.32)' }}>
                            <div style={{ fontWeight: 700 }}>Confirmed</div>
                            <div style={{ marginTop: 6 }}>
                              <a href={`https://solscan.io/tx/${uiState.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--vl-purple-tint)', ...MONO }}>
                                {short(uiState.sig)}
                              </a>
                            </div>
                          </div>
                        )}
                        {uiState.kind === 'error' && (
                          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 5, fontSize: 12,
                            color: 'var(--vl-red-primary)', background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)' }}>
                            {uiState.message}
                          </div>
                        )}
                      </div>
                    )}

                    {!summary && uiState.kind === 'error' && (
                      <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
                        background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5 }}>
                        {uiState.message}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function SummaryPanel({ summary }: { summary: BuildSummary }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Row label="Seller (you)">{short(summary.seller)}</Row>
      <Row label="Offer">{short(summary.offerKey)}</Row>
      <Row label="Buyer">{short(summary.buyer)}</Row>
      <Row label="Mint">{short(summary.mint)}</Row>
      <Row label="Price">{summary.priceSol} SOL</Row>
      <Row label="Creators">{summary.creators.map((c) => `${short(c.address)} (${c.share}%)`).join(', ')}</Row>
    </div>
  );
}

function SimResultPanel({ err, logs, unitsConsumed }: { err: unknown; logs: string[]; unitsConsumed: number | null }) {
  const ok = err == null;
  return (
    <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 11, borderRadius: 5, ...MONO,
      color: ok ? 'var(--vl-green-primary)' : 'var(--vl-red-primary)',
      background: ok ? 'rgb(var(--vl-green-glow) / 0.08)' : 'rgb(var(--vl-red-glow) / 0.08)',
      border: `1px solid ${ok ? 'rgb(var(--vl-green-glow) / 0.32)' : 'rgb(var(--vl-red-glow) / 0.32)'}` }}>
      <div style={{ fontWeight: 700 }}>{ok ? '✓ simulation succeeded' : '✗ simulation failed'}</div>
      {!ok && <div style={{ marginTop: 4, wordBreak: 'break-all' }}>{JSON.stringify(err)}</div>}
      {unitsConsumed != null && <div style={{ opacity: 0.7, marginTop: 4 }}>units: {unitsConsumed}</div>}
      {logs.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--vl-purple-tint)' }}>program logs ({logs.length})</summary>
          <pre style={{ fontSize: 10, color: 'var(--vl-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
            {logs.join('\n')}
          </pre>
        </details>
      )}
    </div>
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
