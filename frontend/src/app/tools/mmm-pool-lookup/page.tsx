'use client';

// VictoryLabs — Tools › MMM Bid Accept.
// Lookup an MMM pool, connect Phantom, pick an NFT, and accept the bid
// directly — bypasses ME UI when it lags. Signing happens in the browser;
// the backend only builds and proxies transactions, never holds keys.

import { useEffect, useRef, useState }                    from 'react';
import { PublicKey }                                      from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { LiveDot }                                        from '@/soloist/shared';
import { authHeaders }                                    from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { requestMmmInstruction } from '@/lib/mmm-bridge';
import { API_BASE, ADDR_RE, MONO, PANEL, fmtSol, short } from '@/app/tools/mmm-shared';

const ME_TOKEN_KEY = 'vl.meToken';

// ── API types ─────────────────────────────────────────────────────────────────
interface Allowlist { type: string; pubkey: string; }
interface MmmPool {
  poolKey: string; escrowPda: string; owner: string;
  collectionName: string; collectionSymbol: string; poolType: string; isMIP1: boolean; meKnown: boolean;
  spotPrice: number; spotPriceSol: number;
  bpa: number; realEscrow: number; missing: number; divergence: number;
  expiry: number; executable: boolean; underfunded: boolean; diverged: boolean;
  allowlists: Allowlist[];
  sampleCreatorsCount?: number | null;
  buysideCreatorRoyaltyBp?: number | null;
  buyOrdersAmount?: number | null;
  meUpdatedAt?: string | null;
}
type LookupResult =
  | { ok: true; type: 'pool';   pool: MmmPool; scannedAt: string }
  | { ok: true; type: 'escrow'; input: string; lamports: number; sol: number; scannedAt: string };
interface WalletNft {
  mint: string; name: string; imageUrl: string | null; compressed?: boolean;
  isPNFT: boolean; creatorsCount: number; isToken2022?: boolean;
}

// Confirmed empirically (Jun 2026): pNFT + 5 verified creators lands the legacy
// sol-fulfill-buy tx at exactly 1240 bytes — 8 over the 1232 network cap. pNFT + 3
// creators fits; Legacy-standard NFTs have much more headroom regardless of count.
function sizeRiskReason(nft: WalletNft): string | null {
  if (nft.isPNFT && nft.creatorsCount >= 5) {
    return `pNFT with ${nft.creatorsCount} creators — legacy tx likely exceeds the 1232-byte limit (confirmed at 1240B before)`;
  }
  return null;
}
// Pool-level version of the same check — every asset in a collection shares the
// same creators array from mint, so this is knowable before you own a matching
// NFT at all (sampled off one representative asset server-side, see backend).
function sizeRiskReasonForPool(p: MmmPool): string | null {
  if (p.isMIP1 && (p.sampleCreatorsCount ?? 0) >= 5) {
    return `pNFT with ${p.sampleCreatorsCount} creators (sampled) — legacy tx likely exceeds the 1232-byte limit (confirmed at 1240B before)`;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pill(label: string, color: string, bg: string, border: string): React.ReactElement {
  return <span style={{ display:'inline-block', padding:'2px 8px', fontSize:10, fontWeight:700,
    letterSpacing:'0.5px', textTransform:'uppercase', borderRadius:4, lineHeight:1.3,
    ...MONO, color, background:bg, border:`1px solid ${border}` }}>{label}</span>;
}
function StatusPill({ p }: { p: MmmPool }) {
  if (p.executable)  return pill('EXECUTABLE','#43b984','rgba(92,224,160,0.15)','rgba(92,224,160,0.45)');
  if (p.underfunded) return pill('UNDERFUNDED','#c7b479','rgba(232,193,74,0.12)','rgba(232,193,74,0.35)');
  if (p.realEscrow === 0 && p.bpa === 0) return pill('EMPTY','#9a9ab4','rgba(122,122,148,0.06)','rgba(122,122,148,0.22)');
  return pill('INACTIVE','#9a9ab4','rgba(122,122,148,0.06)','rgba(122,122,148,0.22)');
}

interface SellIssue { warn: boolean; label: string; reason: string; }
// Each check is independent — a pool can be BOTH underfunded AND ME-flagged
// invalid at once, and both facts matter (fixing one doesn't fix the other).
// Previously this was a single early-return chain, so whichever condition was
// checked first hid the rest — e.g. "Low escrow" masked "ME data stale" until
// the pool got topped up, which looked like the invalid badge only "appears"
// once the escrow warning clears. Collect every issue instead of picking one.
function getSellIssues(p: MmmPool): SellIssue[] {
  const now = Math.floor(Date.now() / 1000);
  const issues: SellIssue[] = [];
  if (p.expiry !== 0 && p.expiry <= now)
    issues.push({ warn: false, label: '✗ Not sellable', reason: 'Pool expired' });
  if (!p.executable)
    issues.push({ warn: true, label: '⚠ Low escrow', reason: 'Escrow balance too low' });
  // poolType:'invalid' is ME's own registry flag — but confirmed stale Jul 2026:
  // a pool topped up well past spotPrice (executable flipped true) still read
  // poolType:'invalid' with buyOrdersAmount:0 from a snapshot over a year old
  // (updatedAt frozen at the moment ME first marked it invalid; ME appears to
  // stop re-scanning pools once flagged). A same-royalty sibling pool from the
  // same owner was poolType:'buy_sided' — buysideCreatorRoyaltyBp alone does
  // NOT predict this. So this is a soft warning (ME's last-known read may be
  // stale), not a confirmed-permanent wall — cosigner is still required either
  // way (Anchor IDL, Signer<'info> on every *FulfillBuy variant), so the
  // on-chain fallback can't bypass it regardless.
  if (p.poolType === 'invalid') {
    const synced = p.meUpdatedAt ? new Date(p.meUpdatedAt).toLocaleDateString() : 'unknown';
    issues.push({ warn: true, label: '⚠ ME data stale',
      reason: `ME last synced ${synced} — buyOrdersAmount was ${p.buyOrdersAmount ?? '?'}, `
        + `royaltyBp ${p.buysideCreatorRoyaltyBp ?? '?'} at that time. May be outdated, cosigner still required.` });
  }
  // Correction 2026-07-02: any-allowlist alone does NOT block ME co-signing —
  // Mutantmon pool 9C9QTQ36oV4hM3ArSvpCiUJms6nZLxGzQy2bKPQupvge (any-allowlist)
  // sold successfully same day. What actually blocks ME is not knowing the
  // collection at all (collectionName === '' with meKnown true) — see the
  // acceptBid() gate below, which this now mirrors.
  const hasTypedAllowlist = p.allowlists.some(
    al => al.type !== 'any' && al.type !== 'empty'
  );
  if (!hasTypedAllowlist && p.meKnown && p.collectionName === '')
    issues.push({ warn: false, label: '✗ Not sellable', reason: 'any-allowlist + unknown collection: ME won\'t co-sign' });
  else if (!hasTypedAllowlist)
    issues.push({ warn: true, label: '⚠ any-allowlist',
      reason: 'ME co-signed this shape before (Mutantmon) — try it, don\'t assume blocked' });
  if (p.meKnown === false)
    issues.push({ warn: true, label: '⚠ ME check failed',
      reason: 'ME lookup failed/rate-limited (or genuinely unknown) — retry may differ' });
  return issues;
}
function CanSellBadge({ p }: { p: MmmPool }) {
  const issues = getSellIssues(p);
  if (!issues.length) return (
    <div style={{ display:'flex', alignItems:'center', gap:6,
      padding:'6px 12px', borderRadius:6, background:'rgba(67,185,132,0.10)',
      border:'1px solid rgba(67,185,132,0.35)' }}>
      <span style={{ color:'#43b984', fontWeight:700, fontSize:13 }}>✓ Sellable</span>
    </div>
  );
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {issues.map((res, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:6,
          padding:'6px 12px', borderRadius:6,
          background: res.warn ? 'rgba(199,180,121,0.10)' : 'rgba(220,80,80,0.10)',
          border: `1px solid ${res.warn ? 'rgba(199,180,121,0.40)' : 'rgba(220,80,80,0.30)'}` }}>
          <span style={{ color: res.warn ? '#c7b479' : '#e06060', fontWeight:700, fontSize:13 }}>
            {res.label}
          </span>
          <span style={{ color:'#9a9ab4', fontSize:11 }}>— {res.reason}</span>
        </div>
      ))}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'9px 16px',
      borderBottom:'1px solid rgba(255,255,255,0.022)' }}>
      <div style={{ width:120, flexShrink:0, fontSize:10, color:'#9a9ab4', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'0.5px', paddingTop:1 }}>{label}</div>
      <div style={{ ...MONO, fontSize:12, color:'#f0eef8', fontWeight:600, wordBreak:'break-all', flex:1 }}>
        {children}
      </div>
    </div>
  );
}
function CopyableBalance({ addr, color, children }: { addr: string; color: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(addr).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span onClick={copy} title={`Click to copy escrow address to top up: ${addr}`}
      style={{ cursor:'pointer', color: copied ? '#43b984' : color, userSelect:'none' }}>
      {copied ? 'copied!' : children}
    </span>
  );
}
function SolLink({ addr, label }: { addr: string; label?: string }) {
  return (
    <a href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer"
      style={{ color:'#a890e8', textDecoration:'none', ...MONO, fontSize:11 }}
      onMouseEnter={e=>{(e.target as HTMLElement).style.textDecoration='underline';}}
      onMouseLeave={e=>{(e.target as HTMLElement).style.textDecoration='none';}}>
      {label ?? short(addr)}
    </a>
  );
}
function Btn({ onClick, disabled, children, variant = 'primary', block }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
  variant?: 'primary' | 'green'; block?: boolean;
}) {
  const on = !disabled;
  const bg = variant === 'green'
    ? (on ? 'linear-gradient(180deg,rgba(92,224,160,0.22) 0%,rgba(92,224,160,0.12) 100%)' : 'rgba(92,224,160,0.08)')
    : (on ? 'linear-gradient(180deg,rgba(128,104,216,0.28) 0%,rgba(128,104,216,0.14) 100%)' : 'rgba(128,104,216,0.10)');
  const border = variant === 'green' ? 'rgba(92,224,160,0.45)' : 'rgba(168,144,232,0.55)';
  const color  = on ? (variant === 'green' ? '#43b984' : '#f0eef8') : '#9a9ab4';
  const shadow = on ? (variant === 'green' ? '0 0 14px rgba(92,224,160,0.18)' : '0 0 12px rgba(128,104,216,0.18)') : 'none';
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{
      display: block ? 'block' : 'inline-block',
      width: block ? '100%' : undefined,
      padding:'9px 18px', fontSize:13, fontWeight:700, letterSpacing:'0.4px', textTransform:'uppercase',
      borderRadius:7, cursor:on ? 'pointer' : 'not-allowed',
      border:`1px solid ${border}`, background:bg, color, boxShadow:shadow, transition:'all 0.15s',
    }}>{children}</button>
  );
}

function NftThumb({ nft, selected, onClick }: { nft: WalletNft; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      cursor:'pointer', width:90, borderRadius:8, overflow:'hidden',
      border: selected ? '2px solid #43b984' : '1px solid rgba(168,144,232,0.22)',
      background: selected ? 'rgba(92,224,160,0.06)' : 'rgba(168,144,232,0.04)',
      boxShadow: selected ? '0 0 16px rgba(92,224,160,0.18)' : 'none',
      transition:'all 0.12s', flexShrink:0,
    }}>
      <div style={{ width:90, height:90, background:'rgba(28,22,48,0.8)',
        display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden', position:'relative' }}>
        {nft.imageUrl
          ? <img src={`${API_BASE}/thumb?url=${encodeURIComponent(nft.imageUrl)}&w=90`}
              alt={nft.name} width={90} height={90}
              style={{ objectFit:'cover', width:'100%', height:'100%' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          : <span style={{ fontSize:26, fontWeight:700, color:'#a890e8' }}>
              {(nft.name[0] ?? '?').toUpperCase()}
            </span>
        }
        {selected && (
          <div style={{ position:'absolute', top:4, right:4, width:18, height:18, borderRadius:'50%',
            background:'#43b984', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:11, fontWeight:700, color:'#0a0a14' }}>✓</div>
        )}
        {sizeRiskReason(nft) && (
          <div title={sizeRiskReason(nft) ?? undefined}
            style={{ position:'absolute', top:4, left:4, width:18, height:18, borderRadius:'50%',
              background:'#c7b479', display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:11, fontWeight:700, color:'#0a0a14' }}>⚠</div>
        )}
      </div>
      <div style={{ padding:'4px 6px', fontSize:10, color:'#f0eef8', fontWeight:600,
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', ...MONO }}
        title={nft.name}>{nft.name}</div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MmmPoolLookupPage() {
  useEffect(() => { document.title = 'MMM Bid Accept | VictoryLabs'; }, []);

  useEffect(() => {
    const pending = typeof window !== 'undefined' ? sessionStorage.getItem('vl.pfl.pending') : null;
    if (!pending) return;
    sessionStorage.removeItem('vl.pfl.pending');
    setInputVal(pending);
    void runLookup(pending);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [inputVal, setInputVal]         = useState('');
  const [lookupBusy, setLookupBusy]     = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError]   = useState<string | null>(null);

  const [wallet, setWallet]             = useState<string | null>(null);
  const [nfts, setNfts]                 = useState<WalletNft[] | null>(null);
  const [nftsBusy, setNftsBusy]         = useState(false);
  const [nftsError, setNftsError]       = useState<string | null>(null);
  const [selectedNft, setSelectedNft]   = useState<WalletNft | null>(null);
  const [manualMint, setManualMint]     = useState('');
  const [manualBusy, setManualBusy]     = useState(false);
  const [manualError, setManualError]   = useState<string | null>(null);
  const [meToken, setMeToken]           = useState('');
  const [showToken, setShowToken]       = useState(false);
  const [diagExpanded, setDiagExpanded] = useState(false);

  interface BridgeAttempt {
    status: number | null; rawBody: string | null; elapsedMs: number;
    windowOpened: boolean; error: string | null; txFound: boolean | null;
  }
  interface BackendAttempt {
    url: string; status: number; rawBody: string | null; elapsedMs: number;
  }
  interface DiagLog {
    poolKey: string; mint: string; seller: string; assetTokenAccount: string;
    minPayment: number; bridgeAttempt: BridgeAttempt | null;
    backendAttempt: BackendAttempt | null;
    finalErrorSource: 'Bridge (ME origin)' | 'Backend builder' | 'Frontend validation' | null;
    finalError: string | null;
  }
  type TxSource = 'me_browser' | 'backend' | null;
  type TxPhase = null | 'building' | 'signing' | 'confirming' | { sig: string; source: TxSource } | { error: string };
  const [txPhase, setTxPhase] = useState<TxPhase>(null);
  const [diag, setDiag]       = useState<DiagLog | null>(null);

  const pool = lookupResult?.type === 'pool' ? lookupResult.pool : null;

  // Restore Phantom session + ME token on mount
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    void eagerConnectPhantom().then(pk => { if (pk) setWallet(pk); });
    const saved = localStorage.getItem(ME_TOKEN_KEY);
    if (saved) { setMeToken(saved); setShowToken(true); }
  }, []);

  // ── Lookup ──────────────────────────────────────────────────────────────────
  const canLookup = ADDR_RE.test(inputVal.trim()) && !lookupBusy;
  const runLookup = async (overrideKey?: string) => {
    const key = overrideKey ?? inputVal.trim();
    if (!ADDR_RE.test(key) || lookupBusy) return;
    setLookupBusy(true); setLookupError(null); setLookupResult(null);
    setNfts(null); setSelectedNft(null); setTxPhase(null); setDiag(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/tools/mmm-pools/pool?key=${encodeURIComponent(key)}`,
        { headers: { ...authHeaders() } },
      );
      if (!r.ok) {
        const b = await r.json().catch(() => null) as { error?: string } | null;
        throw new Error(r.status === 404 ? 'account not found on-chain' : (b?.error ?? `HTTP ${r.status}`));
      }
      setLookupResult(await r.json() as LookupResult);
    } catch (e) { setLookupError((e as Error).message); }
    finally { setLookupBusy(false); }
  };

  // ── Wallet connect ──────────────────────────────────────────────────────────
  const doConnect = async () => {
    try {
      const pk = await connectPhantom();
      setWallet(pk); setNfts(null); setSelectedNft(null);
    } catch (e) { alert((e as Error).message); }
  };
  const doDisconnect = () => {
    void getPhantom()?.disconnect();
    setWallet(null); setNfts(null); setSelectedNft(null); setTxPhase(null);
  };

  // ── Fetch matching NFTs ─────────────────────────────────────────────────────
  const loadNfts = async () => {
    if (!pool || !wallet) return;
    setNftsBusy(true); setNftsError(null); setNfts(null); setSelectedNft(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/tools/mmm-pools/wallet-nfts?wallet=${encodeURIComponent(wallet)}&pool=${encodeURIComponent(pool.poolKey)}`,
        { headers: { ...authHeaders() } },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { ok: true; nfts: WalletNft[] };
      setNfts(data.nfts);
      if (data.nfts.length === 0) setNftsError('No matching NFTs found in this wallet for this pool\'s allowlist.');
    } catch (e) { setNftsError((e as Error).message); }
    finally { setNftsBusy(false); }
  };

  // Fallback for when the wallet doesn't hold the target NFT yet (e.g. checking a
  // pool before buying it) — doesn't check allowlist match or ownership, same
  // "attempt for real and let the response decide" approach as 'any' pools.
  const loadManualNft = async () => {
    const mint = manualMint.trim();
    if (!mint) return;
    setManualBusy(true); setManualError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/manual-nft?mint=${encodeURIComponent(mint)}`,
        { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(r.status === 404 ? 'NFT not found' : `HTTP ${r.status}`);
      const data = await r.json() as { ok: true; nft: WalletNft };
      setNfts(prev => [data.nft, ...(prev ?? [])]);
      setSelectedNft(data.nft);
      setNftsError(null);
    } catch (e) { setManualError((e as Error).message); }
    finally { setManualBusy(false); }
  };

  // ── Accept bid ──────────────────────────────────────────────────────────────
  const acceptBid = async () => {
    if (!pool || !wallet || !selectedNft) return;
    setTxPhase('building');

    const minPayment = 0;
    const isCnft = selectedNft.compressed === true;
    // Confirmed 2026-07-02 (Mutantmon/T22): DAS `interface` reads as a plain
    // legacy NFT even when the mint is Token-2022 — deriving the ATA without
    // the T22 program id lands on a different, never-created account, which
    // ME's tx then references and fails on-chain (AccountNotInitialized).
    const assetTokenAccount = isCnft ? '' : getAssociatedTokenAddressSync(
      new PublicKey(selectedNft.mint),
      new PublicKey(wallet),
      false,
      selectedNft.isToken2022 ? TOKEN_2022_PROGRAM_ID : undefined,
    ).toBase58();
    const backendUrl = `${API_BASE}/api/tools/mmm-pools/bid-accept-tx`
      + `?pool=${encodeURIComponent(pool.poolKey)}`
      + `&seller=${encodeURIComponent(wallet)}`
      + `&mint=${encodeURIComponent(selectedNft.mint)}`;

    const log: DiagLog = {
      poolKey: pool.poolKey, mint: selectedNft.mint, seller: wallet,
      assetTokenAccount: isCnft ? '(cNFT — no ATA)' : assetTokenAccount, minPayment,
      bridgeAttempt: null, backendAttempt: null,
      finalErrorSource: null, finalError: null,
    };
    setDiag({ ...log });

    try {
      let txBase64: string | null = null;
      let txSource: TxSource = null;

      // ── Path 1: Tampermonkey bridge (magiceden.io origin) ─────────────────
      // Skipped ONLY for collectionName === '' (any-allowlist — ME has no
      // FVCA/MCC to check royalty against, structurally can't co-sign).
      //
      // Previously ALSO pre-skipped for poolType === 'invalid', on the theory
      // that ME's registry flag was a reliable "will 400 regardless of asset"
      // signal. Confirmed wrong Jul 2026: poolType:'invalid' turned out to be
      // a frozen ME snapshot (multiple pools stuck on a Feb-2025 read,
      // buyOrdersAmount:0 never re-evaluated) — NOT a live rejection. TROGG
      // sold successfully through this exact bridge while presumably carrying
      // the same flag; the only thing that reliably predicted failure across
      // TROGG/Solmap (legacy, sellable) vs BayBot/ProtoSol (pNFT, blocked) was
      // token_standard, not poolType. Rather than guess from a second
      // unreliable heuristic, always attempt the real bridge and let ME's
      // live response be the ground truth — worst case it 400s for real and
      // we fall through to the backend path exactly as before.
      // Gated on meKnown=true: our own /mmm/pools?owner=... lookup is
      // best-effort (rate-limited/times out silently -> empty result), which
      // ALSO produces collectionName===''. Without this gate a transient ME
      // fetch failure gets treated as a confirmed "any-allowlist" verdict and
      // skips the one path that can actually get a real co-sign.
      if (pool.meKnown && pool.collectionName === '') {
        log.bridgeAttempt = {
          status: null, rawBody: null, elapsedMs: 0, windowOpened: false,
          error: 'skipped — collectionName empty (any-allowlist)', txFound: false,
        };
        setDiag({ ...log });
      } else
      try {
        const br = await requestMmmInstruction({
          pool: pool.poolKey, seller: wallet,
          assetMint: selectedNft.mint,
          ...(isCnft ? {} : { assetTokenAccount }),
          assetAmount: 1,
          minPaymentAmount: minPayment,
          isMip1: pool.isMIP1 || false,
          isCnft,
        });
        let txFound = false;
        if (br.ok && br.body) {
          const body = br.body as {
            tx?: { data?: number[] }; txSigned?: { data?: number[] };
            presigned?: boolean; signature?: string;
            presignedUnsent?: boolean; signedTxBase64?: string;
          };
          // Signed in the ME popup but not yet submitted (Audit #8 M1 fix —
          // the userscript no longer holds an RPC key to send with itself).
          // Submit through the same backend proxy phantom.ts's backendSendRaw
          // already uses, then reuse the identical confirm-poll below.
          if (body.presignedUnsent && body.signedTxBase64) {
            txFound = true;
            log.bridgeAttempt = {
              status: br.status, rawBody: br.rawBody,
              elapsedMs: br.elapsedMs, windowOpened: br.windowOpened,
              error: null, txFound: true,
            };
            setDiag({ ...log });
            setTxPhase('confirming');
            void (async () => {
              let signature: string;
              try {
                const sendRes = await fetch(`${API_BASE}/api/tools/mmm-pools/send-tx`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders() },
                  body: JSON.stringify({ tx: body.signedTxBase64 }),
                });
                const sendJson = await sendRes.json() as { ok: boolean; signature?: string; message?: string };
                if (!sendJson.ok || !sendJson.signature) {
                  setTxPhase({ error: sendJson.message ?? `send-tx HTTP ${sendRes.status}` });
                  return;
                }
                signature = sendJson.signature;
              } catch (err) {
                setTxPhase({ error: (err as Error).message ?? 'send-tx failed' });
                return;
              }
              setTxPhase({ sig: signature, source: 'me_browser' });
              for (let attempt = 0; attempt < 5; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
                try {
                  const r = await fetch(
                    `${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`,
                    { headers: { ...authHeaders() } },
                  );
                  if (!r.ok) continue;
                  const d = await r.json() as { ok: boolean; found: boolean; confirmationStatus: string | null; err: unknown };
                  if (!d.ok || !d.found) continue;
                  if (d.err) { setTxPhase({ error: 'Transaction failed on-chain: ' + JSON.stringify(d.err) }); return; }
                  if (d.confirmationStatus === 'confirmed' || d.confirmationStatus === 'finalized') return;
                } catch (_) {}
              }
            })();
            return;
          }
          if (body.presigned && body.signature) {
            txFound = true;
            log.bridgeAttempt = {
              status: br.status, rawBody: br.rawBody,
              elapsedMs: br.elapsedMs, windowOpened: br.windowOpened,
              error: null, txFound: true,
            };
            setDiag({ ...log });
            setTxPhase({ sig: body.signature, source: 'me_browser' });
            void (async () => {
              const signature = body.signature!;
              for (let attempt = 0; attempt < 5; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
                try {
                  const r = await fetch(
                    `${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`,
                    { headers: { ...authHeaders() } },
                  );
                  if (!r.ok) continue;
                  const d = await r.json() as { ok: boolean; found: boolean; confirmationStatus: string | null; err: unknown };
                  if (!d.ok || !d.found) continue;
                  if (d.err) { setTxPhase({ error: 'Transaction failed on-chain: ' + JSON.stringify(d.err) }); return; }
                  if (d.confirmationStatus === 'confirmed' || d.confirmationStatus === 'finalized') return;
                } catch (_) {}
              }
            })();
            return;
          }
          const src = body.txSigned ?? body.tx;
          if (src?.data && Array.isArray(src.data)) {
            const bytes = new Uint8Array(src.data);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            txBase64 = btoa(bin);
            txSource = 'me_browser';
            txFound = true;
          }
        }
        const bridgeError = br.error
          ?? (br.ok && !txFound ? 'ME bridge returned 200 but no tx/txSigned bytes found' : null);
        log.bridgeAttempt = {
          status: br.status, rawBody: br.rawBody,
          elapsedMs: br.elapsedMs, windowOpened: br.windowOpened,
          error: bridgeError, txFound,
        };
      } catch (bridgeErr) {
        log.bridgeAttempt = {
          status: null, rawBody: null, elapsedMs: 0,
          windowOpened: false, error: (bridgeErr as Error).message, txFound: false,
        };
      }
      setDiag({ ...log });

      // ── Path 2: Backend on-chain builder ───────────────────────────────────
      if (!txBase64) {
        txSource = 'backend';
        const beT0 = performance.now();
        const r = await fetch(backendUrl, { headers: { ...authHeaders() } });
        const elapsedMs = Math.round(performance.now() - beT0);
        const rawBody = await r.text().catch(() => null);
        log.backendAttempt = { url: backendUrl, status: r.status, rawBody, elapsedMs };
        setDiag({ ...log });
        if (!r.ok) {
          const b = rawBody ? JSON.parse(rawBody) as { message?: string; error?: string } : null;
          const msg = b?.message ?? b?.error ?? `HTTP ${r.status}`;
          log.finalErrorSource = 'Backend builder';
          log.finalError = msg;
          setDiag({ ...log });
          throw new Error(msg);
        }
        const parsed = rawBody ? JSON.parse(rawBody) as { ok: true; txBase64: string } : null;
        txBase64 = parsed?.txBase64 ?? null;
      }

      if (!txBase64) {
        log.finalErrorSource = 'Backend builder';
        log.finalError = 'No transaction bytes returned';
        setDiag({ ...log });
        throw new Error('No transaction bytes returned');
      }

      setTxPhase('signing');
      const { signature } = await signSendAndConfirm(txBase64);
      setTxPhase({ sig: signature, source: txSource });

      void (async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
          try {
            const r = await fetch(
              `${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`,
              { headers: { ...authHeaders() } },
            );
            if (!r.ok) continue;
            const d = await r.json() as { ok: boolean; found: boolean; confirmationStatus: string | null; err: unknown };
            if (!d.ok || !d.found) continue;
            if (d.err) { setTxPhase({ error: 'Transaction failed on-chain: ' + JSON.stringify(d.err) }); return; }
            if (d.confirmationStatus === 'confirmed' || d.confirmationStatus === 'finalized') return;
          } catch (_) {}
        }
      })();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.toLowerCase().includes('rejected') || msg.toLowerCase().includes('cancelled')) {
        setTxPhase(null);
      } else {
        if (!log.finalErrorSource) {
          log.finalErrorSource = 'Frontend validation';
          log.finalError = msg;
          setDiag({ ...log });
        }
        setTxPhase({ error: msg });
      }
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="feed-root page-transition" data-page="tools-mmm-pool-lookup">
      <div style={{ flex:1, minHeight:0, overflowY:'auto', width:'100%' }}>
        <div style={{ padding:'20px 4px 40px', width:'100%',
          maxWidth:'var(--tools-max,1100px)', margin:'0 auto', boxSizing:'border-box' }}>

          {/* ── Header ── */}
          <h1 style={{ fontSize:22, fontWeight:700, color:'#f0eef8', letterSpacing:'-0.5px' }}>
            MMM Bid Accept
          </h1>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:6, marginBottom:16, fontSize:11, color:'#9a9ab4' }}>
            <LiveDot />
            <span>bypass ME UI · paste pool key · connect Phantom · accept bid directly</span>
          </div>

          {/* ── Pool key input ── */}
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <input type="text" value={inputVal} onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void runLookup(); }}
              placeholder="Paste pool key…" spellCheck={false}
              style={{ flex:1, minWidth:280, padding:'9px 14px', fontSize:13,
                ...MONO, fontWeight:500, borderRadius:6, border:'1px solid rgba(168,144,232,0.45)',
                background:'rgba(20,14,34,0.85)', color:'#f0eef8', outline:'none' }} />
            <button type="button" onClick={() => void runLookup()} disabled={!canLookup}
              style={{
                padding:'9px 20px', fontSize:13, fontWeight:700, letterSpacing:'0.4px',
                textTransform:'uppercase', borderRadius:6,
                cursor: canLookup ? 'pointer' : 'not-allowed',
                border:'1px solid rgba(168,144,232,0.55)',
                background: canLookup ? 'linear-gradient(180deg,rgba(128,104,216,0.28) 0%,rgba(128,104,216,0.14) 100%)' : 'rgba(128,104,216,0.08)',
                color: canLookup ? '#f0eef8' : '#9a9ab4',
                boxShadow: canLookup ? '0 0 12px rgba(128,104,216,0.18)' : 'none',
                transition:'all 0.15s',
              }}>
              {lookupBusy ? 'Loading…' : 'Load Pool'}
            </button>
          </div>

          {lookupError && (
            <div style={{ marginTop:10, padding:'8px 12px', fontSize:12, color:'#d96867',
              background:'rgba(239,120,120,0.08)', border:'1px solid rgba(239,120,120,0.32)', borderRadius:5 }}>
              {lookupError}
            </div>
          )}

          {/* ── Escrow-only ── */}
          {lookupResult?.type === 'escrow' && (
            <div style={{ ...PANEL, marginTop:16 }}>
              <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(168,144,232,0.08)',
                display:'flex', gap:10 }}>
                {pill('ESCROW ACCOUNT','#c7b479','rgba(232,193,74,0.12)','rgba(232,193,74,0.35)')}
                <span style={{ fontSize:11, color:'#9a9ab4' }}>not a pool config</span>
              </div>
              <Row label="Address"><SolLink addr={lookupResult.input} label={lookupResult.input} /></Row>
              <Row label="Balance">
                <span style={{ color: lookupResult.lamports > 0 ? '#43b984' : '#9a9ab4' }}>
                  {lookupResult.sol.toFixed(6)} SOL
                </span>
              </Row>
            </div>
          )}

          {/* ── Empty state ── */}
          {!lookupResult && !lookupBusy && !lookupError && (
            <div style={{ ...PANEL, marginTop:16, padding:'52px 24px', textAlign:'center',
              color:'#9a9ab4', fontSize:13, lineHeight:1.7 }}>
              Paste a pool key from{' '}
              <a href="/tools/mmm-pools" style={{ color:'#a890e8', textDecoration:'none' }}
                onMouseEnter={e=>{(e.target as HTMLElement).style.textDecoration='underline';}}
                onMouseLeave={e=>{(e.target as HTMLElement).style.textDecoration='none';}}>
                MMM Pool Scanner
              </a>{' '}or{' '}
              <a href="/tools/mmm-collection-scanner" style={{ color:'#a890e8', textDecoration:'none' }}
                onMouseEnter={e=>{(e.target as HTMLElement).style.textDecoration='underline';}}
                onMouseLeave={e=>{(e.target as HTMLElement).style.textDecoration='none';}}>
                Collection Scanner
              </a>
              {' '}and click <span style={{ color:'#a890e8', fontWeight:600 }}>Load Pool</span>.
              <br /><span style={{ fontSize:11 }}>Connect Phantom to accept the bid — bypasses ME UI.</span>
            </div>
          )}

          {/* ── Two-column layout when pool is loaded ── */}
          {pool && (
            <div style={{ display:'flex', gap:16, alignItems:'flex-start', marginTop:16 }}>

              {/* ── LEFT: pool info + wallet + NFT picker ── */}
              <div style={{ flex:'1 1 0', minWidth:0 }}>

                {/* Pool info */}
                <div style={PANEL}>
                  <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(168,144,232,0.08)',
                    display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                    {(pool.collectionName || pool.collectionSymbol) && (
                      <span style={{ fontSize:13, fontWeight:700, color:'#f0eef8' }}>
                        {pool.collectionName || pool.collectionSymbol}
                      </span>
                    )}
                    {pool.isMIP1 && pill('MIP1','#a890e8','rgba(168,144,232,0.12)','rgba(168,144,232,0.35)')}
                    {sizeRiskReasonForPool(pool) && (
                      <span title={sizeRiskReasonForPool(pool) ?? undefined}>
                        {pill('⚠ SIZE RISK','#c7b479','rgba(199,180,121,0.10)','rgba(199,180,121,0.40)')}
                      </span>
                    )}
                    {pool.meKnown === false && pill('ME UNKNOWN','#e06060','rgba(220,80,80,0.10)','rgba(220,80,80,0.30)')}
                    <CanSellBadge p={pool} />
                    <a href={`https://magiceden.io/mmm/pool/${pool.poolKey}`} target="_blank"
                      rel="noopener noreferrer"
                      style={{ marginLeft:'auto', fontSize:11, color:'#9a9ab4', textDecoration:'none',
                        padding:'2px 8px', border:'1px solid rgba(168,144,232,0.22)', borderRadius:4,
                        background:'rgba(168,144,232,0.06)', ...MONO }}
                      onMouseEnter={e=>{(e.target as HTMLElement).style.color='#a890e8';}}
                      onMouseLeave={e=>{(e.target as HTMLElement).style.color='#9a9ab4';}}>
                      ME ↗
                    </a>
                  </div>

                  <Row label="Pool Key">
                    <SolLink addr={pool.poolKey} label={short(pool.poolKey)} />
                  </Row>
                  <Row label="Escrow">
                    <span>
                      <SolLink addr={pool.escrowPda} label={short(pool.escrowPda)} />
                      {'  '}
                      <CopyableBalance addr={pool.escrowPda}
                        color={pool.executable ? '#43b984' : pool.realEscrow > 0 ? '#c7b479' : '#9a9ab4'}>
                        {fmtSol(pool.realEscrow)} SOL
                      </CopyableBalance>
                    </span>
                  </Row>
                  <Row label="Spot Price">
                    <span style={{ fontSize:14, fontWeight:700, color:'#f0eef8' }}>
                      {fmtSol(pool.spotPrice)} SOL
                    </span>
                  </Row>
                  <Row label="Bpa">
                    <span>
                      {fmtSol(pool.bpa)} SOL
                      {pool.divergence > 0 && (
                        <span style={{ fontSize:11, color:'#c7b479', marginLeft:6 }}>
                          (divergence {fmtSol(pool.divergence)} — realEscrow &gt; bpa, don&apos;t trust executable)
                        </span>
                      )}
                    </span>
                  </Row>
                  <Row label="Missing">
                    {pool.missing > 0 ? (
                      <span>
                        <span style={{ color:'#d96867', fontWeight:700 }}>{fmtSol(pool.missing)} SOL</span>
                        <span style={{ fontSize:11, color:'#9a9ab4', marginLeft:6 }}>
                          ({((pool.bpa / pool.spotPrice) * 100).toFixed(1)}% funded)
                        </span>
                      </span>
                    ) : (
                      <span style={{ color:'#43b984', fontWeight:700 }}>0 — fully funded</span>
                    )}
                  </Row>
                  <Row label="Owner">
                    <SolLink addr={pool.owner} label={short(pool.owner)} />
                  </Row>
                  {pool.expiry !== 0 && (
                    <Row label="Expiry">
                      <span style={{ color:'#c7b479' }}>
                        {new Date(pool.expiry * 1000).toLocaleString()}
                      </span>
                    </Row>
                  )}
                  {pool.allowlists.length > 0 && (
                    <Row label="Accepts">
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {pool.allowlists.map((al, i) => (
                          <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ fontSize:10, color:'#a890e8', background:'rgba(168,144,232,0.10)',
                              border:'1px solid rgba(168,144,232,0.22)', borderRadius:3, padding:'0 5px',
                              lineHeight:1.5, flexShrink:0 }}>
                              {al.type}
                            </span>
                            <SolLink addr={al.pubkey} label={short(al.pubkey)} />
                          </div>
                        ))}
                      </div>
                    </Row>
                  )}
                </div>

                {/* NFT grid — appears once matching NFTs are loaded */}
                {nfts && nfts.length > 0 && (
                  <div style={PANEL}>
                    <div style={{ padding:'10px 16px', borderBottom:'1px solid rgba(168,144,232,0.08)',
                      fontSize:11, color:'#9a9ab4' }}>
                      {nfts.length} matching NFT{nfts.length !== 1 ? 's' : ''} in your wallet — pick one to sell
                    </div>
                    <div style={{ padding:'14px 16px', display:'flex', flexWrap:'wrap', gap:10 }}>
                      {nfts.map(n => (
                        <NftThumb key={n.mint} nft={n}
                          selected={selectedNft?.mint === n.mint}
                          onClick={() => { setSelectedNft(n); setTxPhase(null); setDiag(null); }} />
                      ))}
                    </div>
                  </div>
                )}

                {/* ME token (advanced, hidden by default) */}
                {showToken && (
                  <div style={{ padding:'0 0 12px' }}>
                    <div style={{ fontSize:10, color:'#c7b479', marginBottom:6, fontWeight:600 }}>
                      Advanced — ME auth token
                      {diag?.bridgeAttempt?.status === 401 && ' (ME returned 401)'}
                    </div>
                    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                      <input type="password" value={meToken}
                        onChange={e => {
                          setMeToken(e.target.value);
                          if (e.target.value) localStorage.setItem(ME_TOKEN_KEY, e.target.value);
                          else localStorage.removeItem(ME_TOKEN_KEY);
                        }}
                        placeholder="optional ME auth token"
                        spellCheck={false}
                        style={{ flex:1, minWidth:260, padding:'5px 10px', fontSize:11,
                          ...MONO, borderRadius:5, border:'1px solid rgba(232,193,74,0.35)',
                          background:'rgba(20,14,34,0.85)', color:'#f0eef8', outline:'none' }}
                      />
                      {meToken && (
                        <button onClick={() => { setMeToken(''); localStorage.removeItem(ME_TOKEN_KEY); }}
                          style={{ fontSize:10, color:'#9a9ab4', background:'none', border:'none',
                            cursor:'pointer', textDecoration:'underline' }}>clear</button>
                      )}
                    </div>
                  </div>
                )}

                {/* Diagnostics (collapsible) */}
                {diag && (
                  <div style={{ marginBottom:16 }}>
                    <button type="button"
                      onClick={() => setDiagExpanded(v => !v)}
                      style={{ fontSize:10, color:'#6b6b85', background:'none', border:'none',
                        cursor:'pointer', padding:'4px 0', textTransform:'uppercase',
                        letterSpacing:'0.5px', fontWeight:600, display:'flex', alignItems:'center', gap:4 }}>
                      {diagExpanded ? '▾' : '▸'} Diagnostics
                      {diag.finalErrorSource && <span style={{ color:'#d96867', marginLeft:4 }}>· error</span>}
                    </button>

                    {diagExpanded && (
                      <div style={{ ...MONO, fontSize:11, padding:'12px 14px', borderRadius:6, marginTop:6,
                        background:'rgba(15,10,30,0.85)', border:'1px solid rgba(168,144,232,0.18)',
                        display:'flex', flexDirection:'column', gap:8 }}>

                        <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                          textTransform:'uppercase', borderBottom:'1px solid rgba(168,144,232,0.10)', paddingBottom:6 }}>
                          Attempt params
                        </div>
                        <div style={{ color:'#c4c2d4', fontSize:11, lineHeight:1.7 }}>
                          <span style={{ color:'#9a9ab4' }}>pool:    </span>{diag.poolKey}<br/>
                          <span style={{ color:'#9a9ab4' }}>mint:    </span>{diag.mint}<br/>
                          <span style={{ color:'#9a9ab4' }}>seller:  </span>{diag.seller}<br/>
                          <span style={{ color:'#9a9ab4' }}>ata:     </span>{diag.assetTokenAccount}<br/>
                          <span style={{ color:'#9a9ab4' }}>minPay:  </span>{diag.minPayment} lamports
                        </div>

                        <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                          textTransform:'uppercase', borderBottom:'1px solid rgba(168,144,232,0.10)', paddingBottom:6, marginTop:4 }}>
                          Path 1 — Bridge (magiceden.io origin)
                        </div>
                        {diag.bridgeAttempt ? (() => {
                          const m = diag.bridgeAttempt;
                          const ok = m.status !== null && m.status >= 200 && m.status < 300;
                          return (
                            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                              <div><span style={{ color:'#9a9ab4' }}>window:  </span>
                                <span style={{ color:'#c4c2d4' }}>{m.windowOpened ? 'opened new tab' : 'reused existing tab'}</span></div>
                              <div><span style={{ color:'#9a9ab4' }}>status:  </span>
                                <span style={{ color: m.error && !ok ? '#d96867' : ok ? '#43b984' : '#c7b479', fontWeight:700 }}>
                                  {m.status !== null ? `HTTP ${m.status}` : m.error ? 'ERROR (no HTTP status)' : 'pending'}
                                </span>
                                {m.elapsedMs > 0 && <span style={{ color:'#9a9ab4', marginLeft:8 }}>{m.elapsedMs}ms</span>}
                              </div>
                              {m.txFound !== null && (
                                <div><span style={{ color:'#9a9ab4' }}>tx bytes:</span>
                                  <span style={{ color: m.txFound ? '#43b984' : '#d96867', marginLeft:6, fontWeight:700 }}>
                                    {m.txFound ? 'found ✓' : 'not found'}
                                  </span>
                                </div>
                              )}
                              {m.error && <div><span style={{ color:'#9a9ab4' }}>error:   </span>
                                <span style={{ color:'#d96867' }}>{m.error}</span></div>}
                              {m.rawBody !== null && (
                                <div><span style={{ color:'#9a9ab4' }}>body:    </span>
                                  <span style={{ color: ok ? '#43b984' : '#d96867' }}>
                                    {m.rawBody.length > 300 ? m.rawBody.slice(0,300) + '…' : m.rawBody || '(empty)'}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })() : <div style={{ color:'#9a9ab4' }}>not attempted yet</div>}

                        <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                          textTransform:'uppercase', borderBottom:'1px solid rgba(168,144,232,0.10)', paddingBottom:6, marginTop:4 }}>
                          Path 2 — Backend builder
                        </div>
                        {diag.backendAttempt ? (() => {
                          const b = diag.backendAttempt;
                          const ok = b.status >= 200 && b.status < 300;
                          return (
                            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                              <div><span style={{ color:'#9a9ab4' }}>url:     </span>
                                <span style={{ color:'#a890e8', wordBreak:'break-all' }}>{b.url}</span></div>
                              <div><span style={{ color:'#9a9ab4' }}>status:  </span>
                                <span style={{ color: ok ? '#43b984' : '#d96867', fontWeight:700 }}>HTTP {b.status}</span>
                                <span style={{ color:'#9a9ab4', marginLeft:8 }}>{b.elapsedMs}ms</span>
                              </div>
                              {b.rawBody !== null && (
                                <div><span style={{ color:'#9a9ab4' }}>body:    </span>
                                  <span style={{ color: ok ? '#43b984' : '#d96867' }}>
                                    {b.rawBody.length > 400 ? b.rawBody.slice(0,400) + '…' : b.rawBody || '(empty)'}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })() : (
                          <div style={{ color:'#9a9ab4' }}>
                            {diag.bridgeAttempt?.status === 200 ? 'skipped (bridge succeeded)' : 'not attempted yet'}
                          </div>
                        )}

                        {diag.finalErrorSource && (
                          <>
                            <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                              textTransform:'uppercase', borderBottom:'1px solid rgba(239,120,120,0.20)',
                              paddingBottom:6, marginTop:4 }}>Error source</div>
                            <div>
                              <span style={{ color:'#d96867', fontWeight:700 }}>{diag.finalErrorSource}</span><br/>
                              <span style={{ color:'#d96867' }}>{diag.finalError}</span>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── RIGHT: sticky action panel ── */}
              <div style={{ width:280, flexShrink:0, position:'sticky', top:16, alignSelf:'flex-start' }}>
                <div style={{ ...PANEL, marginBottom:0 }}>

                  {/* Pool summary */}
                  <div style={{ padding:'14px 16px', borderBottom:'1px solid rgba(168,144,232,0.08)' }}>
                    <div style={{ marginBottom:10 }}><StatusPill p={pool} /></div>
                    <div style={{ fontSize:10, color:'#9a9ab4', textTransform:'uppercase',
                      letterSpacing:'0.5px', fontWeight:700, marginBottom:2 }}>Spot price</div>
                    <div style={{ fontSize:22, fontWeight:700, color:'#f0eef8', ...MONO }}>
                      {fmtSol(pool.spotPrice)}
                      <span style={{ fontSize:13, color:'#9a9ab4', marginLeft:4 }}>SOL</span>
                    </div>
                    <div style={{ fontSize:10, color: pool.executable ? '#43b984' : '#9a9ab4', marginTop:4 }}>
                      Escrow: {fmtSol(pool.realEscrow)} SOL
                      {!pool.executable && pool.missing > 0 && (
                        <span style={{ color:'#d96867' }}> · needs {fmtSol(pool.missing)} more</span>
                      )}
                    </div>
                  </div>

                  {/* Wallet section */}
                  <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(168,144,232,0.08)' }}>
                    {!wallet ? (
                      <Btn onClick={() => void doConnect()} block>Connect Phantom</Btn>
                    ) : (
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                        <div>
                          <div style={{ fontSize:10, color:'#9a9ab4', textTransform:'uppercase',
                            letterSpacing:'0.5px', fontWeight:700, marginBottom:2 }}>Wallet</div>
                          <SolLink addr={wallet} label={short(wallet)} />
                        </div>
                        <button onClick={doDisconnect} style={{ fontSize:10, color:'#9a9ab4',
                          background:'none', border:'none', cursor:'pointer', textDecoration:'underline' }}>
                          disconnect
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Action section */}
                  <div style={{ padding:'16px' }}>
                    {wallet && !nfts && !nftsBusy && !nftsError && (
                      <Btn onClick={() => void loadNfts()} block>Find Matching NFTs</Btn>
                    )}

                    {wallet && nftsBusy && (
                      <div style={{ fontSize:12, color:'#9a9ab4', textAlign:'center' }}>Searching wallet…</div>
                    )}

                    {wallet && nftsError && !nftsBusy && (
                      <div style={{ fontSize:12, color:'#d96867', marginBottom:8 }}>
                        {nftsError}
                        <button onClick={() => { setNftsError(null); void loadNfts(); }}
                          style={{ marginLeft:10, fontSize:10, color:'#9a9ab4', background:'none',
                            border:'none', cursor:'pointer', textDecoration:'underline' }}>retry</button>
                      </div>
                    )}

                    {wallet && nftsError && !nftsBusy && pool.allowlists.some(al => al.type === 'any') && (
                      <div style={{ marginTop:4 }}>
                        <div style={{ fontSize:10, color:'#9a9ab4', marginBottom:6 }}>
                          &apos;Any NFT&apos; pool — enter a mint address directly instead of
                          scanning the whole wallet.
                        </div>
                        <div style={{ display:'flex', gap:6 }}>
                          <input value={manualMint} onChange={e => setManualMint(e.target.value)}
                            placeholder="NFT mint address" disabled={manualBusy}
                            style={{ flex:1, padding:'7px 10px', fontSize:11, ...MONO, borderRadius:5,
                              border:'1px solid rgba(168,144,232,0.4)', background:'rgba(20,14,34,0.85)',
                              color:'#f0eef8', outline:'none' }}
                          />
                          <Btn onClick={() => void loadManualNft()} disabled={manualBusy || !manualMint.trim()}>
                            {manualBusy ? '…' : 'Use'}
                          </Btn>
                        </div>
                        {manualError && (
                          <div style={{ fontSize:11, color:'#d96867', marginTop:4 }}>{manualError}</div>
                        )}
                      </div>
                    )}

                    {wallet && nfts && !selectedNft && (
                      <div style={{ fontSize:12, color:'#9a9ab4', textAlign:'center', lineHeight:1.6 }}>
                        Select an NFT from the grid to sell it to this pool.
                      </div>
                    )}

                    {wallet && selectedNft && (
                      <>
                        {/* Selected NFT summary */}
                        <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:14,
                          padding:'10px', borderRadius:8, background:'rgba(168,144,232,0.05)',
                          border:'1px solid rgba(168,144,232,0.18)' }}>
                          {selectedNft.imageUrl && (
                            <img src={`${API_BASE}/thumb?url=${encodeURIComponent(selectedNft.imageUrl)}&w=48`}
                              alt={selectedNft.name} width={48} height={48}
                              style={{ borderRadius:6, objectFit:'cover', flexShrink:0 }}
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          )}
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:10, color:'#9a9ab4', textTransform:'uppercase',
                              letterSpacing:'0.5px', fontWeight:700, marginBottom:2 }}>Selling</div>
                            <div style={{ fontSize:13, fontWeight:700, color:'#f0eef8',
                              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {selectedNft.name}
                            </div>
                            <div style={{ fontSize:10, color:'#9a9ab4', ...MONO }}>{short(selectedNft.mint)}</div>
                          </div>
                        </div>

                        {/* Size-risk warning — pNFT + 5+ creators tends to bust the legacy 1232B cap */}
                        {sizeRiskReason(selectedNft) && (
                          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14,
                            padding:'6px 12px', borderRadius:6, background:'rgba(199,180,121,0.10)',
                            border:'1px solid rgba(199,180,121,0.40)' }}>
                            <span style={{ color:'#c7b479', fontWeight:700, fontSize:13 }}>⚠ Size risk</span>
                            <span style={{ color:'#9a9ab4', fontSize:11 }}>— {sizeRiskReason(selectedNft)}</span>
                          </div>
                        )}

                        {/* You receive */}
                        <div style={{ marginBottom:16 }}>
                          <div style={{ fontSize:10, color:'#9a9ab4', textTransform:'uppercase',
                            letterSpacing:'0.5px', fontWeight:700, marginBottom:4 }}>You receive</div>
                          <div style={{ fontSize:20, fontWeight:700, color:'#43b984', ...MONO }}>
                            ~{fmtSol(pool.spotPrice)}
                            <span style={{ fontSize:13, color:'#9a9ab4', marginLeft:4 }}>SOL</span>
                          </div>
                          <div style={{ fontSize:10, color:'#9a9ab4', marginTop:2 }}>
                            spot price − protocol fees
                          </div>
                        </div>

                        {/* TX controls */}
                        {txPhase === null && (
                          <Btn onClick={() => void acceptBid()} variant="green" block>
                            Accept Bid
                          </Btn>
                        )}
                        {txPhase === 'building' && (
                          <div style={{ fontSize:12, color:'#9a9ab4', textAlign:'center', padding:'8px 0' }}>
                            Building transaction…
                          </div>
                        )}
                        {txPhase === 'signing' && (
                          <div style={{ fontSize:12, color:'#c7b479', fontWeight:600, textAlign:'center', padding:'8px 0' }}>
                            Check Phantom to sign…
                          </div>
                        )}
                        {txPhase === 'confirming' && (
                          <div style={{ fontSize:12, color:'#c7b479', fontWeight:600, textAlign:'center', padding:'8px 0' }}>
                            Confirming on-chain…
                          </div>
                        )}
                        {typeof txPhase === 'object' && txPhase !== null && 'sig' in txPhase && (
                          <div style={{ padding:'12px', borderRadius:8, textAlign:'center',
                            background:'rgba(92,224,160,0.06)', border:'1px solid rgba(92,224,160,0.28)' }}>
                            <div style={{ fontSize:14, color:'#43b984', fontWeight:700, marginBottom:6 }}>
                              ✓ Bid accepted!
                            </div>
                            <div style={{ fontSize:10, color:'#9a9ab4', marginBottom:8 }}>
                              {txPhase.source === 'me_browser' ? 'via ME bridge' : 'via on-chain builder'}
                            </div>
                            <a href={`https://solscan.io/tx/${txPhase.sig}`} target="_blank"
                              rel="noopener noreferrer"
                              style={{ ...MONO, fontSize:10, color:'#a890e8', textDecoration:'none' }}
                              onMouseEnter={e=>{(e.target as HTMLElement).style.textDecoration='underline';}}
                              onMouseLeave={e=>{(e.target as HTMLElement).style.textDecoration='none';}}>
                              {short(txPhase.sig)} ↗
                            </a>
                          </div>
                        )}
                        {typeof txPhase === 'object' && txPhase !== null && 'error' in txPhase && (
                          <div style={{ padding:'10px', borderRadius:8,
                            background:'rgba(239,120,120,0.08)', border:'1px solid rgba(239,120,120,0.28)' }}>
                            <div style={{ fontSize:11, color:'#d96867', marginBottom:8, lineHeight:1.5 }}>
                              {txPhase.error}
                            </div>
                            <button onClick={() => setTxPhase(null)}
                              style={{ fontSize:11, color:'#9a9ab4', background:'none', border:'none',
                                cursor:'pointer', textDecoration:'underline' }}>retry</button>
                          </div>
                        )}

                        {/* Change selection */}
                        {(txPhase === null || (typeof txPhase === 'object' && 'error' in txPhase)) && (
                          <button onClick={() => { setSelectedNft(null); setTxPhase(null); setDiag(null); }}
                            style={{ marginTop:10, width:'100%', fontSize:10, color:'#6b6b85',
                              background:'none', border:'none', cursor:'pointer',
                              textDecoration:'underline', textAlign:'center' }}>
                            ← pick a different NFT
                          </button>
                        )}
                      </>
                    )}

                    {diag && !diagExpanded && (
                      <button type="button" onClick={() => setDiagExpanded(true)}
                        style={{ marginTop:10, fontSize:10, color:'#6b6b85',
                          background:'none', border:'none', cursor:'pointer',
                          textDecoration:'underline', display:'block' }}>
                        view diagnostics
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
