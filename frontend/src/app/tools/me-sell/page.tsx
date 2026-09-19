'use client';

// Magic Eden item-level offer ACCEPT tool — personal use only. Counterpart
// to /tools/me-bids (which only places/cancels/withdraws OUR OWN bids).
// This page accepts an offer someone ELSE already placed on an NFT — paste
// the (mint, buyer, auctionHouse, price) tuple a separate discovery tool
// found, top up the buyer's escrow if it's short (a plain transfer, no
// permission needed — see server/tools-me-sell.ts header), then build +
// sign + submit the accept transaction.
//
// This is a real seller-side ACCEPT of an existing Magic Eden M2 offer —
// a two-instruction Sell+ExecuteSaleV2 bundle that sells a real NFT for
// real SOL, not a listing. Treat every step accordingly.
//
// 2026-09-12 hardening pass (docs/me-sell-audit-2026-09-12.md): replaces
// the old "sendRawTransaction resolving -> Submitted, done" model with an
// explicit outcome state machine (MS-4/MS-5), adds pre-sign structural +
// price authorization for the Tampermonkey bridge path (MS-1, via the new
// `/audit-bridge` endpoint — the same canonical `auditMeSellTransaction`
// the backend itself now uses on every path), an explicit supported-
// standard gate (MS-6), a frozen per-attempt intent + stale-request race
// guard (MS-3), pre-sign (fail-open) and post-sign (fail-closed) blockhash
// freshness checks, an exact-identity wallet check immediately before
// signing, and forces a fresh Load Offer (full revalidation) before any
// rebuild after a non-success terminal outcome. See ./logic.ts for the
// pure, independently-tested pieces this page only orchestrates.
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

import { useRef, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm, assertPhantomWallet } from '@/wallet/phantom';
import { requestMeSellAccept } from '@/lib/mmm-bridge';
import { CtaButton, LiveDot } from '@/soloist/shared';
import { API_BASE, ADDR_RE, MONO, PANEL, ToolTextInput, fmtSol, short } from '@/app/tools/mmm-shared';
import {
  type TxOutcome, type SignatureStatusEntry, type FrozenOfferIntent,
  classifyStatus, shouldKeepPolling, reconcileUnresolved, hasBlockhashHeadroom, planPostSignBroadcast,
  canRebuild, uiLabel, makeGenerationGuard, solToExactLamports, CONFIRMATION_POLL_INTERVAL_MS,
} from './logic';

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
  standard: 'pnft' | 'mplCore' | null;
  standardSupported: boolean;
}
interface BuiltAccept {
  source: 'bridge' | 'backend';
  digest: string | null; txBase64: string; cosignerPubkey: string | null; priceSol: number;
  lastValidBlockHeight: number;
  intent: FrozenOfferIntent;
  seller: string;
  attemptToken: number;
}
type SimState = { err: unknown; logs: string[]; unitsConsumed: number | null } | null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<T>;
}
function humanThrow(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
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
  const [outcome, setOutcome] = useState<TxOutcome | null>(null);

  // Two independent race guards (MS-3):
  //   loadGuard  — a stale resolve-offer/order-info response must never
  //                paint over a newer Load Offer call's result.
  //   attemptGuard — a stale confirmation-poll loop (from a PRIOR build+
  //                submit attempt) must never paint over a newer attempt's
  //                outcome. Bumped once per doBuild() call; the resulting
  //                token rides along inside `built` for the rest of that
  //                attempt's lifetime (submit + polling), so every
  //                background step can cheaply check `isCurrent()`.
  const loadGuard = useRef(makeGenerationGuard());
  const attemptGuard = useRef(makeGenerationGuard());

  const didInit = useState(() => {
    void eagerConnectPhantom().then(pk => { if (pk) setWallet(pk); });
  })[0];
  void didInit;

  const canLoad = ADDR_RE.test(mint) && ADDR_RE.test(buyer) && !infoBusy;

  const loadInfo = async () => {
    if (!canLoad) return;
    const token = loadGuard.current.bump();
    setInfoBusy(true); setInfoError(null); setInfo(null);
    setBuilt(null); setBuildError(null); setNeedsBridge(false); setSim(null);
    setTopupSig(null); setTopupError(null); setOutcome(null);
    try {
      const rr = await fetch(
        `${API_BASE}/api/tools/me-sell/resolve-offer?mint=${encodeURIComponent(mint)}&buyer=${encodeURIComponent(buyer)}`,
        { headers: { ...authHeaders() } },
      );
      const rj = await rr.json() as { ok: boolean; auctionHouseAddress?: string; priceSol?: number; expiry?: number; error?: string };
      if (!rr.ok || !rj.ok || !rj.auctionHouseAddress || rj.priceSol == null) {
        throw new Error(rj.error ?? `HTTP ${rr.status}`);
      }
      if (!loadGuard.current.isCurrent(token)) return; // a newer Load Offer call is already in flight — discard
      setOfferExpiry(rj.expiry ?? 0);
      const r = await fetch(
        `${API_BASE}/api/tools/me-sell/order-info?mint=${encodeURIComponent(mint)}`
        + `&buyer=${encodeURIComponent(buyer)}&auctionHouseAddress=${encodeURIComponent(rj.auctionHouseAddress)}`
        + `&priceSol=${encodeURIComponent(String(rj.priceSol))}`,
        { headers: { ...authHeaders() } },
      );
      const j = await r.json() as OrderInfo & { ok: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (!loadGuard.current.isCurrent(token)) return;
      setInfo(j);
    } catch (e) {
      if (loadGuard.current.isCurrent(token)) setInfoError((e as Error).message);
    } finally {
      if (loadGuard.current.isCurrent(token)) setInfoBusy(false);
    }
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
    } catch (e) { setTopupError(humanThrow((e as Error).message)); }
    finally { setTopupBusy(false); }
  };

  // A terminal (non-unresolved) outcome always clears `info` — forcing a
  // fresh Load Offer (full re-resolve of price/escrow/standard) before any
  // rebuild is possible. This is the revalidation-before-rebuild rule: even
  // a confirmed_success clears it, since the NFT is now sold and the old
  // `info` can never be safely reused. An `unresolved` outcome deliberately
  // does NOT clear `info` — it isn't terminal, and Re-check may still
  // resolve it without needing a full reload.
  function settleOutcome(o: TxOutcome, token: number) {
    if (!attemptGuard.current.isCurrent(token)) return;
    setOutcome(o);
    if (o.kind !== 'unresolved') setInfo(null);
  }

  // Bridge first (real magiceden.io browser session — routes around ME's
  // server-side "bidding too old to be accepted" business rule and any
  // IP-level throttling on our own backend, see server/tools-me-sell.ts
  // header), backend build-accept as fallback (works fine for
  // recently-placed offers; also useful if Tampermonkey isn't installed).
  const doBuild = async () => {
    if (!info || !wallet || !canRebuild(outcome)) return;
    if (!info.standardSupported || !info.standard) {
      setBuildError('Unsupported NFT standard — no verified-safe M2 instruction shape for this asset.');
      return;
    }
    const attemptToken = attemptGuard.current.bump();
    setBuildBusy(true); setBuildError(null); setBuilt(null); setNeedsBridge(false); setSim(null); setOutcome(null);

    // Freeze the intent NOW, from exactly the `info` this operator reviewed
    // — build/audit/submit below must never silently re-derive price/
    // standard/accounts from any later state change (MS-3).
    const seller = wallet;
    const intent: FrozenOfferIntent = {
      mint: info.mint, buyer: info.buyer, auctionHouse: info.auctionHouseAddress,
      priceLamports: solToExactLamports(info.priceSol), standard: info.standard, standardSupported: info.standardSupported,
    };
    const tokenAta = getAssociatedTokenAddressSync(new PublicKey(info.mint), new PublicKey(seller), false, TOKEN_PROGRAM_ID).toBase58();
    // Root cause of "bidding too old to be accepted" (confirmed 2026-08-24):
    // ME's batch backend treats an omitted/zero buyerExpiry as "expired at
    // Unix epoch" for offers whose own recorded expiry is 0 ("no expiry").
    // Always send a far-future sentinel instead — 2100-01-01T00:00:00Z.
    const buyerExpiryMs = offerExpiry > 0 ? offerExpiry * 1000 : 4102444800000;

    try {
      let bridgeResult: { txBase64: string; lastValidBlockHeight: number } | null = null;
      try {
        const br = await requestMeSellAccept({
          seller, tokenMint: intent.mint, tokenATA: tokenAta,
          auctionHouseAddress: intent.auctionHouse, buyer: intent.buyer,
          newPrice: info.priceSol, sellerExpiry: 0, buyerExpiry: buyerExpiryMs,
        });
        const body = br.body as {
          txSigned?: { data?: number[] }; presigned?: boolean; signature?: string;
          blockhashData?: { lastValidBlockHeight?: number };
        } | null;
        const src = body?.txSigned;
        const lvbh = body?.blockhashData?.lastValidBlockHeight;
        if (br.ok && src?.data && Array.isArray(src.data) && typeof lvbh === 'number') {
          const bytes = new Uint8Array(src.data);
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const txBase64 = btoa(bin);
          // MS-1: pre-sign structural + exact-price authorization for the
          // bridge path — bytes relayed through a Tampermonkey-driven
          // browser session are never trusted directly; independently
          // re-decode + audit them server-side (the SAME canonical
          // auditMeSellTransaction the backend runs on every other path)
          // before Simulate/Sign&Submit are ever offered.
          const audit = await postJson<{ ok: boolean; error?: string }>('/api/tools/me-sell/audit-bridge', {
            tx: txBase64, seller, tokenMint: intent.mint, auctionHouseAddress: intent.auctionHouse,
            buyer: intent.buyer, priceLamports: intent.priceLamports, standard: intent.standard,
          });
          if (!audit.ok) throw new Error(audit.error ?? 'bridge_audit_failed');
          bridgeResult = { txBase64, lastValidBlockHeight: lvbh };
        } else {
          console.warn('[me-sell] bridge path unusable (missing tx or freshness data), falling back to backend', br.error);
        }
      } catch (e) {
        console.warn('[me-sell] bridge path failed audit or threw, falling back to backend', (e as Error).message);
      }
      if (!attemptGuard.current.isCurrent(attemptToken)) return;

      if (bridgeResult) {
        setBuilt({
          source: 'bridge', digest: null, txBase64: bridgeResult.txBase64, cosignerPubkey: null,
          priceSol: info.priceSol, lastValidBlockHeight: bridgeResult.lastValidBlockHeight, intent, seller, attemptToken,
        });
        return;
      }

      const r = await fetch(`${API_BASE}/api/tools/me-sell/build-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          seller, tokenMint: intent.mint, priceSol: info.priceSol,
          auctionHouseAddress: intent.auctionHouse, buyer: intent.buyer,
          buyerExpiry: buyerExpiryMs / 1000,
        }),
      });
      const j = await r.json() as {
        ok: boolean; digest?: string; txBase64?: string; cosignerPubkey?: string; error?: string;
        needsBridge?: boolean; detail?: string; priceLamports?: string; standard?: 'pnft' | 'mplCore';
        lastValidBlockHeight?: number;
      };
      if (!r.ok || !j.ok || !j.digest || !j.txBase64 || j.lastValidBlockHeight == null) {
        if (j.needsBridge) setNeedsBridge(true);
        throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
      }
      if (!attemptGuard.current.isCurrent(attemptToken)) return;
      setBuilt({
        source: 'backend', digest: j.digest, txBase64: j.txBase64, cosignerPubkey: j.cosignerPubkey ?? null,
        priceSol: info.priceSol, lastValidBlockHeight: j.lastValidBlockHeight,
        intent: { ...intent, priceLamports: j.priceLamports ?? intent.priceLamports, standard: j.standard ?? intent.standard },
        seller, attemptToken,
      });
    } catch (e) {
      if (attemptGuard.current.isCurrent(attemptToken)) setBuildError(humanThrow((e as Error).message));
    } finally {
      if (attemptGuard.current.isCurrent(attemptToken)) setBuildBusy(false);
    }
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
    if (!built || submitBusy) return;
    const { attemptToken } = built;
    const isCurrent = () => attemptGuard.current.isCurrent(attemptToken);
    setSubmitBusy(true); setOutcome(null);
    try {
      // A — pre-sign blockhash freshness. Fails OPEN on a lookup failure —
      // Simulate already gates on-chain correctness independently of this
      // check; the post-sign check below is the one that must fail closed.
      const preStatus = await postJson<{ ok: boolean; blockHeight?: number }>('/api/tools/me-sell/status', { signatures: [] });
      const preHeight = preStatus.ok ? preStatus.blockHeight ?? null : null;
      const preFresh = preHeight == null ? true : hasBlockhashHeadroom(built.lastValidBlockHeight, preHeight);
      if (!preFresh) { settleOutcome({ kind: 'stale_before_broadcast' }, attemptToken); return; }

      // B — ONE Phantom approval. assertPhantomWallet checks the ACTIVE
      // account against the exact seller this tx was built+audited for
      // (built.seller), not just whatever `wallet` currently reads — a
      // wallet switch between Build Accept and Sign & Submit must fail
      // closed here rather than sign with the wrong fee payer/owner.
      const sol = getPhantom();
      if (!sol) throw new Error('Phantom not connected');
      assertPhantomWallet(built.seller);
      const tx = Transaction.from(Buffer.from(built.txBase64, 'base64'));
      const signed = await sol.signTransaction(tx);
      const signedB64 = signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      if (!isCurrent()) return;

      // C — POST-SIGN freshness re-check. Fails CLOSED (opposite of step
      // A) — see logic.ts's planPostSignBroadcast doc comment: past this
      // point Phantom has already signed, so refusing to broadcast only
      // costs one more approval later, whereas broadcasting a signed tx we
      // cannot prove still has headroom risks an unrecoverable ambiguous
      // real-money outcome.
      const postStatus = await postJson<{ ok: boolean; blockHeight?: number }>('/api/tools/me-sell/status', { signatures: [] });
      const postHeight = postStatus.ok ? postStatus.blockHeight ?? null : null;
      const [okToBroadcast] = planPostSignBroadcast([{ lastValidBlockHeight: built.lastValidBlockHeight }], postHeight);
      if (!okToBroadcast) { settleOutcome({ kind: 'stale_before_broadcast' }, attemptToken); return; }

      // D — send. A resolved request here means SUBMITTED, not SUCCESS —
      // there is deliberately no "done" value reachable straight from it.
      const endpoint = built.source === 'bridge' ? 'submit-bridge' : 'submit';
      const body = built.source === 'bridge'
        ? {
          signedTx: signedB64, seller: built.seller, tokenMint: built.intent.mint,
          auctionHouseAddress: built.intent.auctionHouse, buyer: built.intent.buyer,
          priceLamports: built.intent.priceLamports, standard: built.intent.standard,
          lastValidBlockHeight: built.lastValidBlockHeight,
        }
        : { signedTx: signedB64, digest: built.digest };
      let sig: string;
      try {
        const r = await postJson<{ ok: boolean; signature?: string; error?: string }>(`/api/tools/me-sell/${endpoint}`, body);
        if (!r.ok || !r.signature) { settleOutcome({ kind: 'send_failed', reason: r.error ?? 'submit rejected' }, attemptToken); return; }
        sig = r.signature;
      } catch (e) {
        settleOutcome({ kind: 'send_failed', reason: humanThrow((e as Error).message) }, attemptToken);
        return;
      }
      if (!isCurrent()) return;
      setOutcome({ kind: 'unresolved', signature: sig }); // NOT settleOutcome — info must stay intact while still pollable

      // E — bounded confirmation polling on the EXACT returned signature.
      const startedAt = Date.now();
      for (;;) {
        if (!isCurrent()) return;
        if (!shouldKeepPolling(startedAt, Date.now())) return; // left as unresolved — never inferred as failed
        await sleep(CONFIRMATION_POLL_INTERVAL_MS);
        if (!isCurrent()) return;
        const statusRes = await postJson<{ ok: boolean; blockHeight?: number; statuses?: Array<SignatureStatusEntry | null> }>(
          '/api/tools/me-sell/status', { signatures: [sig] },
        );
        if (!statusRes.ok || !statusRes.statuses) continue;
        const cls = classifyStatus(statusRes.statuses[0] ?? null);
        if (cls === 'success') { settleOutcome({ kind: 'confirmed_success', signature: sig }, attemptToken); return; }
        if (cls === 'failed') { settleOutcome({ kind: 'confirmed_failure', signature: sig, err: statusRes.statuses[0]?.err }, attemptToken); return; }
        // pending: leave as unresolved, poll again
      }
    } catch (e) {
      settleOutcome({ kind: 'send_failed', reason: humanThrow((e as Error).message) }, attemptToken);
    } finally {
      if (isCurrent()) setSubmitBusy(false);
    }
  };

  // Re-check a still-unresolved signature on demand — never blindly
  // retried/rebuilt; only reconciled against its own exact signature + its
  // own original lastValidBlockHeight.
  const handleRecheck = async () => {
    if (!built || !outcome || outcome.kind !== 'unresolved') return;
    const res = await postJson<{ ok: boolean; blockHeight?: number; statuses?: Array<SignatureStatusEntry | null> }>(
      '/api/tools/me-sell/status', { signatures: [outcome.signature] },
    );
    if (!res.ok || !res.statuses) return;
    const disposition = reconcileUnresolved(res.statuses[0] ?? null, res.blockHeight ?? null, built.lastValidBlockHeight);
    if (disposition === 'still_success') settleOutcome({ kind: 'confirmed_success', signature: outcome.signature }, built.attemptToken);
    else if (disposition === 'still_failed') settleOutcome({ kind: 'confirmed_failure', signature: outcome.signature, err: res.statuses[0]?.err }, built.attemptToken);
    else if (disposition === 'safe_to_rebuild') settleOutcome({ kind: 'expired_no_signature_seen', signature: outcome.signature }, built.attemptToken);
    // still_unresolved: leave as-is
  };

  const outcomeExplorerSig = outcome && 'signature' in outcome ? outcome.signature : null;
  const outcomeIsError = outcome != null && outcome.kind !== 'confirmed_success' && outcome.kind !== 'unresolved';
  const outcomeIsPending = outcome?.kind === 'unresolved';

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

          {outcome != null && info == null && (
            <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 11, color: 'var(--vl-gold-primary)',
              background: 'rgb(var(--vl-gold-glow, 200 160 40) / 0.08)', border: '1px solid rgba(200,160,40,0.3)', borderRadius: 5 }}>
              This attempt ended ({uiLabel(outcome)}) — press Load Offer again to revalidate price/escrow/standard before retrying.
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
              <Row label="Standard">
                {info.standardSupported
                  ? <span style={{ color: 'var(--vl-green-primary)' }}>{info.standard === 'mplCore' ? 'MPL Core' : 'Programmable NFT (pNFT)'}</span>
                  : <span style={{ color: 'var(--vl-red-primary)', fontWeight: 700 }}>
                    unsupported{info.standard ? ` (${info.standard})` : ' (unknown)'} — accept blocked
                  </span>}
              </Row>
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

                    <CtaButton onClick={() => void doBuild()} disabled={buildBusy || info.missingLamports > 0 || !info.standardSupported} block>
                      {buildBusy ? 'Building…' : 'Build Accept Tx'}
                    </CtaButton>
                    {info.missingLamports > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--vl-text-muted)', marginTop: 4 }}>Top up first — escrow can&apos;t cover price+royalty yet.</div>
                    )}
                    {!info.standardSupported && (
                      <div style={{ fontSize: 10, color: 'var(--vl-red-primary)', marginTop: 4 }}>
                        This tool only has verified-safe evidence for pNFT and MPL Core offer accepts.
                      </div>
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
                          Built via {built.source === 'bridge' ? 'Tampermonkey bridge (pre-sign audited)' : 'backend'}
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

                        {sim && !simFailed && outcome == null && (
                          <div style={{ marginTop: 14 }}>
                            <CtaButton onClick={() => void doSubmit()} disabled={submitBusy} block>
                              {submitBusy ? 'Signing & submitting…' : `Sign & Submit — ${built.priceSol} SOL`}
                            </CtaButton>
                          </div>
                        )}

                        {outcome && (
                          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 5, fontSize: 12,
                            color: outcomeIsError ? 'var(--vl-red-primary)' : outcomeIsPending ? 'var(--vl-gold-primary)' : 'var(--vl-green-primary)',
                            background: outcomeIsError ? 'rgb(var(--vl-red-glow) / 0.08)' : outcomeIsPending ? 'rgba(200,160,40,0.08)' : 'rgb(var(--vl-green-glow) / 0.08)',
                            border: `1px solid ${outcomeIsError ? 'rgb(var(--vl-red-glow) / 0.32)' : outcomeIsPending ? 'rgba(200,160,40,0.3)' : 'rgb(var(--vl-green-glow) / 0.32)'}` }}>
                            <div style={{ fontWeight: 700 }}>{uiLabel(outcome)}</div>
                            {outcome.kind === 'send_failed' && <div style={{ marginTop: 4, fontSize: 11 }}>{outcome.reason}</div>}
                            {outcome.kind === 'audit_failed' && <div style={{ marginTop: 4, fontSize: 11 }}>{outcome.reason}</div>}
                            {outcomeExplorerSig && (
                              <div style={{ marginTop: 6 }}>
                                <a href={`https://solscan.io/tx/${outcomeExplorerSig}`} target="_blank" rel="noopener noreferrer"
                                  style={{ color: 'var(--vl-purple-tint)', ...MONO }}>{short(outcomeExplorerSig)}</a>
                              </div>
                            )}
                            {outcomeIsPending && (
                              <div style={{ marginTop: 8 }}>
                                <CtaButton onClick={() => void handleRecheck()} block>Re-check</CtaButton>
                              </div>
                            )}
                          </div>
                        )}
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
