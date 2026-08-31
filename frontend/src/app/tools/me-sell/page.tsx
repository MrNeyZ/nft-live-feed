'use client';

// Magic Eden item-level offer ACCEPT tool — personal use only. Counterpart
// to /tools/me-bids (which only places/cancels/withdraws OUR OWN bids).
// This page accepts an offer someone ELSE already placed on an NFT — paste
// the (mint, buyer, auctionHouse, price) tuple a separate discovery tool
// found, top up the buyer's escrow if it's short (a plain transfer, no
// permission needed — see server/tools-me-sell.ts header), then build +
// sign + submit the accept transaction.
//
// Safety model — no separate DRY RUN/LIVE toggle in the UI (removed
// 2026-08-24 per operator request: verification now happens via the real
// Simulate step + Phantom's own preview, not a client-side gate). The
// server still hard-gates real broadcast behind ME_BIDS_ENABLE_LIVE — that
// stays the actual enforcement boundary, just without frontend friction on
// top of it.
//   - Every build-accept response is bound to a single-use digest of the
//     exact unsigned message; submit rejects on any mismatch/expiry/reuse.
//   - SELL always carries a second (ME) signature already filled in by the
//     time this page sees the tx — if it isn't, the backend refuses to
//     hand back a digest at all (`needsBridge`) rather than pretend the
//     trade can complete.

import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { requestMeSellAccept } from '@/lib/mmm-bridge';
import { CtaButton, LiveDot } from '@/soloist/shared';
import { API_BASE, ADDR_RE, MONO, PANEL, ToolTextInput, fmtSol, short } from '@/app/tools/mmm-shared';

interface OrderInfo {
  mint: string; buyer: string; auctionHouseAddress: string;
  priceLamports: number; priceSol: number;
  escrowPda: string; escrowLamports: number; escrowSol: number;
  royaltyBp: number | null; royaltyBpUnknown: boolean; royaltyLamports: number | null;
  requiredLamports: number; requiredSol: number;
  missingLamports: number; missingSol: number;
  executable: boolean;
  sellerProceedsLamports: number; sellerProceedsSol: number;
  meFeeBp: number;
  nft: { name: string | null; image: string | null };
}
interface BuiltAccept {
  source: 'bridge' | 'backend';
  digest: string | null; txBase64: string; cosignerPubkey: string | null; priceSol: number;
}
type SimState = { err: unknown; logs: string[]; unitsConsumed: number | null } | null;

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

export default function MeSellPage() {
  const [mint, setMint] = useState('');
  const [buyer, setBuyer] = useState('');

  const [info, setInfo] = useState<OrderInfo | null>(null);
  const [infoBusy, setInfoBusy] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [offerExpiry, setOfferExpiry] = useState(0);

  const [wallet, setWallet] = useState<string | null>(null);

  const [topupBusy, setTopupBusy] = useState(false);
  const [topupSig, setTopupSig] = useState<string | null>(null);
  const [topupError, setTopupError] = useState<string | null>(null);

  const [built, setBuilt] = useState<BuiltAccept | null>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [needsBridge, setNeedsBridge] = useState(false);

  const [sim, setSim] = useState<SimState>(null);
  const [simBusy, setSimBusy] = useState(false);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitSig, setSubmitSig] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const didInit = useState(() => {
    void eagerConnectPhantom().then(pk => { if (pk) setWallet(pk); });
  })[0];
  void didInit;

  const canLoad = ADDR_RE.test(mint) && ADDR_RE.test(buyer) && !infoBusy;

  const loadInfo = async () => {
    if (!canLoad) return;
    setInfoBusy(true); setInfoError(null); setInfo(null);
    setBuilt(null); setBuildError(null); setNeedsBridge(false); setSim(null);
    setTopupSig(null); setTopupError(null); setSubmitSig(null); setSubmitError(null);
    try {
      const rr = await fetch(
        `${API_BASE}/api/tools/me-sell/resolve-offer?mint=${encodeURIComponent(mint)}&buyer=${encodeURIComponent(buyer)}`,
        { headers: { ...authHeaders() } },
      );
      const rj = await rr.json() as { ok: boolean; auctionHouseAddress?: string; priceSol?: number; expiry?: number; error?: string };
      if (!rr.ok || !rj.ok || !rj.auctionHouseAddress || rj.priceSol == null) {
        throw new Error(rj.error ?? `HTTP ${rr.status}`);
      }
      setOfferExpiry(rj.expiry ?? 0);
      const r = await fetch(
        `${API_BASE}/api/tools/me-sell/order-info?mint=${encodeURIComponent(mint)}`
        + `&buyer=${encodeURIComponent(buyer)}&auctionHouseAddress=${encodeURIComponent(rj.auctionHouseAddress)}`
        + `&priceSol=${encodeURIComponent(String(rj.priceSol))}`,
        { headers: { ...authHeaders() } },
      );
      const j = await r.json() as OrderInfo & { ok: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setInfo(j);
    } catch (e) { setInfoError((e as Error).message); }
    finally { setInfoBusy(false); }
  };

  const doConnect = async () => {
    try { setWallet(await connectPhantom()); } catch (e) { alert((e as Error).message); }
  };

  const doTopup = async () => {
    if (!info || !wallet || info.missingLamports <= 0) return;
    setTopupBusy(true); setTopupError(null); setTopupSig(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/tools/me-sell/build-topup?escrowPda=${encodeURIComponent(info.escrowPda)}`
        + `&fromWallet=${encodeURIComponent(wallet)}&lamports=${info.missingLamports}`,
        { headers: { ...authHeaders() } },
      );
      const j = await r.json() as { ok: boolean; txBase64?: string; error?: string };
      if (!r.ok || !j.ok || !j.txBase64) throw new Error(j.error ?? `HTTP ${r.status}`);
      const { signature } = await signSendAndConfirm(j.txBase64);
      setTopupSig(signature);
      await loadInfo();
    } catch (e) { setTopupError((e as Error).message); }
    finally { setTopupBusy(false); }
  };

  // Bridge first (real magiceden.io browser session — routes around ME's
  // server-side "bidding too old to be accepted" business rule and any
  // IP-level throttling on our own backend, see server/tools-me-sell.ts
  // header), backend build-accept as fallback (works fine for
  // recently-placed offers; also useful if Tampermonkey isn't installed).
  const doBuild = async () => {
    if (!info || !wallet) return;
    setBuildBusy(true); setBuildError(null); setBuilt(null); setNeedsBridge(false); setSim(null);
    const tokenAta = getAssociatedTokenAddressSync(new PublicKey(info.mint), new PublicKey(wallet), false, TOKEN_PROGRAM_ID).toBase58();
    // Root cause of "bidding too old to be accepted" (confirmed 2026-08-24):
    // ME's batch backend treats an omitted/zero buyerExpiry as "expired at
    // Unix epoch" for offers whose own recorded expiry is 0 ("no expiry").
    // Always send a far-future sentinel instead — 2100-01-01T00:00:00Z.
    const buyerExpiryMs = offerExpiry > 0 ? offerExpiry * 1000 : 4102444800000;

    try {
      let bridgeSucceeded = false;
      try {
        const br = await requestMeSellAccept({
          seller: wallet, tokenMint: info.mint, tokenATA: tokenAta,
          auctionHouseAddress: info.auctionHouseAddress, buyer: info.buyer,
          newPrice: info.priceSol, sellerExpiry: 0, buyerExpiry: buyerExpiryMs,
        });
        const body = br.body as { txSigned?: { data?: number[] }; presigned?: boolean; signature?: string } | null;
        const src = body?.txSigned;
        if (br.ok && src?.data && Array.isArray(src.data)) {
          const bytes = new Uint8Array(src.data);
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          setBuilt({ source: 'bridge', digest: null, txBase64: btoa(bin), cosignerPubkey: null, priceSol: info.priceSol });
          bridgeSucceeded = true;
        } else {
          console.warn('[me-sell] bridge path failed, falling back to backend', br.error);
        }
      } catch (e) {
        console.warn('[me-sell] bridge path threw, falling back to backend', (e as Error).message);
      }
      if (bridgeSucceeded) return;

      const r = await fetch(`${API_BASE}/api/tools/me-sell/build-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          seller: wallet, tokenMint: info.mint, priceSol: info.priceSol,
          auctionHouseAddress: info.auctionHouseAddress, buyer: info.buyer,
          buyerExpiry: buyerExpiryMs / 1000,
        }),
      });
      const j = await r.json() as { ok: boolean; digest?: string; txBase64?: string; cosignerPubkey?: string; error?: string; needsBridge?: boolean; detail?: string };
      if (!r.ok || !j.ok || !j.digest || !j.txBase64) {
        if (j.needsBridge) setNeedsBridge(true);
        throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
      }
      setBuilt({ source: 'backend', digest: j.digest, txBase64: j.txBase64, cosignerPubkey: j.cosignerPubkey ?? null, priceSol: info.priceSol });
    } catch (e) { setBuildError((e as Error).message); }
    finally { setBuildBusy(false); }
  };

  const doSimulate = async () => {
    if (!built) return;
    setSimBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-sell/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tx: built.txBase64 }),
      });
      const j = await r.json() as { ok: boolean; err: unknown; logs: string[]; unitsConsumed: number | null; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSim({ err: j.err, logs: j.logs, unitsConsumed: j.unitsConsumed });
    } catch (e) { setSim({ err: (e as Error).message, logs: [], unitsConsumed: null }); }
    finally { setSimBusy(false); }
  };

  const simFailed = sim != null && sim.err != null;

  const doSubmit = async () => {
    if (!built || !info || !wallet) return;
    setSubmitBusy(true); setSubmitError(null); setSubmitSig(null);
    try {
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom not connected');
      const tx = Transaction.from(Buffer.from(built.txBase64, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedB64 = signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      const endpoint = built.source === 'bridge' ? 'submit-bridge' : 'submit';
      const body = built.source === 'bridge'
        ? { signedTx: signedB64, seller: wallet, tokenMint: info.mint, auctionHouseAddress: info.auctionHouseAddress, buyer: info.buyer }
        : { signedTx: signedB64, digest: built.digest };
      const r = await fetch(`${API_BASE}/api/tools/me-sell/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      const j = await r.json() as { ok: boolean; signature?: string; error?: string };
      if (!r.ok || !j.ok || !j.signature) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSubmitSig(j.signature);
    } catch (e) { setSubmitError((e as Error).message); }
    finally { setSubmitBusy(false); }
  };

  return (
    <div className="feed-root page-transition" data-page="tools-me-sell">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
        <div style={{ padding: '20px 4px 40px', width: '100%', maxWidth: 720, margin: '0 auto', boxSizing: 'border-box' }}>

          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
            ME Offer Accept
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginBottom: 16, fontSize: 11, color: 'var(--vl-text-muted)' }}>
            <LiveDot />
            <span>accept a personal item-level offer — paste mint / buyer / auction house / price</span>
          </div>

          <div style={{ ...PANEL, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ToolTextInput value={mint} onChange={e => setMint(e.target.value)} placeholder="NFT mint you're selling" style={{ fontSize: 12 }} />
            <ToolTextInput value={buyer} onChange={e => setBuyer(e.target.value)} placeholder="buyer wallet (who made the offer)" style={{ fontSize: 12 }} />
            <CtaButton onClick={() => void loadInfo()} disabled={!canLoad}>
              {infoBusy ? 'Loading…' : 'Load Offer'}
            </CtaButton>
          </div>

          {infoError && (
            <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
              background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5 }}>
              {infoError}
            </div>
          )}

          {info && (
            <div style={{ ...PANEL, marginTop: 16 }}>
              {info.nft.name && (
                <div style={{ padding: '10px 16px', fontSize: 13, fontWeight: 700, color: 'var(--vl-text-primary)',
                  borderBottom: '1px solid rgb(var(--vl-purple-tint) / 0.08)' }}>
                  {info.nft.name}
                </div>
              )}
              <Row label="Price">{info.priceSol} SOL</Row>
              <Row label="Escrow">
                <span>
                  {short(info.escrowPda)} — {fmtSol(info.escrowLamports)} SOL
                </span>
              </Row>
              <Row label="Royalty">
                {info.royaltyBpUnknown ? 'unknown (treated as 0 — verify manually)' : `${(info.royaltyBp! / 100).toFixed(2)}%`}
              </Row>
              <Row label="Required">{info.requiredSol.toFixed(6)} SOL (price + royalty)</Row>
              <Row label="Missing">
                {info.missingLamports > 0
                  ? <span style={{ color: 'var(--vl-red-primary)', fontWeight: 700 }}>{info.missingSol.toFixed(6)} SOL</span>
                  : <span style={{ color: 'var(--vl-green-primary)', fontWeight: 700 }}>0 — fully funded</span>}
              </Row>
              <Row label="You'd receive">{info.sellerProceedsSol.toFixed(6)} SOL (after {(info.meFeeBp / 100).toFixed(1)}% ME fee)</Row>

              <div style={{ padding: 16, borderTop: '1px solid rgb(var(--vl-purple-tint) / 0.08)' }}>
                {!wallet ? (
                  <CtaButton onClick={() => void doConnect()} block>Connect Phantom</CtaButton>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginBottom: 10 }}>
                      Seller wallet: <span style={{ ...MONO, color: 'var(--vl-text-primary)' }}>{short(wallet)}</span>
                    </div>
                    {info.missingLamports > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <CtaButton onClick={() => void doTopup()} disabled={topupBusy} block>
                          {topupBusy ? 'Topping up…' : `Top up ${info.missingSol.toFixed(6)} SOL to escrow`}
                        </CtaButton>
                        {topupSig && (
                          <div style={{ fontSize: 11, color: 'var(--vl-green-primary)', marginTop: 6 }}>
                            topped up: <a href={`https://solscan.io/tx/${topupSig}`} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--vl-purple-tint)' }}>{short(topupSig)}</a>
                          </div>
                        )}
                        {topupError && <div style={{ fontSize: 11, color: 'var(--vl-red-primary)', marginTop: 6 }}>{topupError}</div>}
                      </div>
                    )}

                    <CtaButton onClick={() => void doBuild()} disabled={buildBusy || info.missingLamports > 0} block>
                      {buildBusy ? 'Building…' : 'Build Accept Tx'}
                    </CtaButton>
                    {info.missingLamports > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', marginTop: 4 }}>Top up first — escrow can&apos;t cover price+royalty yet.</div>
                    )}

                    {buildError && (
                      <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
                        background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5 }}>
                        {buildError}
                        {needsBridge && (
                          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--vl-gold-primary)' }}>
                            Both the Tampermonkey bridge and the backend-only path failed to get a signed cosigner
                            slot from ME for this trade — check the bridge is installed/up to date and a magiceden.io
                            tab can open, or that the offer isn&apos;t rejected for another reason (e.g. too old).
                          </div>
                        )}
                      </div>
                    )}

                    {built && (
                      <div style={{ marginTop: 14, borderTop: '1px solid rgb(var(--vl-purple-tint) / 0.08)', paddingTop: 14 }}>
                        <div style={{ fontSize: 11, color: 'var(--vl-green-primary)', marginBottom: 8 }}>
                          Built via {built.source === 'bridge' ? 'Tampermonkey bridge' : 'backend'}
                          {built.cosignerPubkey && <> — ME cosigner: <span style={MONO}>{short(built.cosignerPubkey)}</span></>}
                          {' '}(pre-signed)
                        </div>
                        <CtaButton onClick={() => void doSimulate()} disabled={simBusy} block>
                          {simBusy ? 'Simulating…' : 'Simulate'}
                        </CtaButton>

                        {sim && (
                          <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 11, borderRadius: 5, ...MONO,
                            color: simFailed ? 'var(--vl-red-primary)' : 'var(--vl-green-primary)',
                            background: simFailed ? 'rgb(var(--vl-red-glow) / 0.08)' : 'rgb(var(--vl-green-glow) / 0.08)',
                            border: `1px solid ${simFailed ? 'rgb(var(--vl-red-glow) / 0.32)' : 'rgb(var(--vl-green-glow) / 0.32)'}` }}>
                            {simFailed ? `sim error: ${JSON.stringify(sim.err)}` : 'simulation OK'}
                            {sim.unitsConsumed != null && <div style={{ opacity: 0.7 }}>units: {sim.unitsConsumed}</div>}
                          </div>
                        )}

                        {sim && !simFailed && (
                          <div style={{ marginTop: 14 }}>
                            <CtaButton onClick={() => void doSubmit()} disabled={submitBusy} block>
                              {submitBusy ? 'Signing & submitting…' : `Sign & Submit — ${built.priceSol} SOL`}
                            </CtaButton>
                          </div>
                        )}

                        {submitSig && (
                          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--vl-green-primary)' }}>
                            Submitted: <a href={`https://solscan.io/tx/${submitSig}`} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--vl-purple-tint)' }}>{short(submitSig)}</a>
                          </div>
                        )}
                        {submitError && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--vl-red-primary)' }}>{submitError}</div>}
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
