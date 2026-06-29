'use client';

// VictoryLabs — Tools › MMM Bid Accept.
// Lookup an MMM pool, connect Phantom, pick an NFT, and accept the bid
// directly — bypasses ME UI when it lags. Signing happens in the browser;
// the backend only builds and proxies transactions, never holds keys.

import { useEffect, useRef, useState }                    from 'react';
import { Connection, PublicKey }                          from '@solana/web3.js';
import { getAssociatedTokenAddressSync }                  from '@solana/spl-token';
import { LiveDot }                                        from '@/soloist/shared';
import { authHeaders }                                    from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { requestMmmInstruction } from '@/lib/mmm-bridge';

const API_BASE  = process.env.NEXT_PUBLIC_API_URL ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ADDR_RE   = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ME_TOKEN_KEY = 'vl.meToken';
const MONO: React.CSSProperties = { fontFamily: "'SF Mono','Fira Code',monospace" };
const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg,#1a1530 0%,#1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06),0 16px 50px rgba(0,0,0,0.6),0 0 0 1px rgba(0,0,0,0.4),0 0 28px rgba(128,104,216,0.10)',
  overflow: 'hidden',
  marginBottom: 16,
};

// ── API types ─────────────────────────────────────────────────────────────────
interface Allowlist { type: string; pubkey: string; }
interface MmmPool {
  poolKey: string; escrowPda: string; owner: string;
  collectionName: string; collectionSymbol: string; poolType: string; isMIP1: boolean;
  spotPrice: number; spotPriceSol: number;
  bpa: number; realEscrow: number; missing: number; divergence: number;
  expiry: number; executable: boolean; underfunded: boolean; diverged: boolean;
  allowlists: Allowlist[];
}
type LookupResult =
  | { ok: true; type: 'pool';   pool: MmmPool; scannedAt: string }
  | { ok: true; type: 'escrow'; input: string; lamports: number; sol: number; scannedAt: string };
interface WalletNft { mint: string; name: string; imageUrl: string | null; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtSol(lam: number): string { return (lam / 1e9).toFixed(4); }
function short(s: string): string { return s.length > 10 ? `${s.slice(0,5)}…${s.slice(-5)}` : s; }

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
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 20px',
      borderBottom:'1px solid rgba(255,255,255,0.022)' }}>
      <div style={{ width:140, flexShrink:0, fontSize:11, color:'#9a9ab4', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'0.5px', paddingTop:1 }}>{label}</div>
      <div style={{ ...MONO, fontSize:12, color:'#f0eef8', fontWeight:600, wordBreak:'break-all', flex:1 }}>
        {children}
      </div>
    </div>
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
function Btn({ onClick, disabled, children, variant = 'primary' }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; variant?: 'primary' | 'green';
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
      padding:'7px 16px', fontSize:12, fontWeight:700, letterSpacing:'0.5px', textTransform:'uppercase',
      borderRadius:5, cursor:on ? 'pointer' : 'not-allowed',
      border:`1px solid ${border}`, background:bg, color, boxShadow:shadow, transition:'all 0.15s',
    }}>{children}</button>
  );
}
function NftThumb({ nft, selected, onClick }: { nft: WalletNft; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      cursor:'pointer', width:100, borderRadius:8, overflow:'hidden',
      border: selected ? '2px solid #43b984' : '1px solid rgba(168,144,232,0.22)',
      background: selected ? 'rgba(92,224,160,0.06)' : 'rgba(168,144,232,0.04)',
      boxShadow: selected ? '0 0 16px rgba(92,224,160,0.18)' : 'none',
      transition:'all 0.12s', flexShrink:0,
    }}>
      <div style={{ width:100, height:100, background:'rgba(28,22,48,0.8)',
        display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden', position:'relative' }}>
        {nft.imageUrl
          ? <img src={`${API_BASE}/thumb?url=${encodeURIComponent(nft.imageUrl)}&w=100`}
              alt={nft.name} width={100} height={100}
              style={{ objectFit:'cover', width:'100%', height:'100%' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          : <span style={{ fontSize:28, fontWeight:700, color:'#a890e8' }}>
              {(nft.name[0] ?? '?').toUpperCase()}
            </span>
        }
        {selected && (
          <div style={{ position:'absolute', top:4, right:4, width:18, height:18, borderRadius:'50%',
            background:'#43b984', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:11, fontWeight:700, color:'#0a0a14' }}>✓</div>
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

  const [inputVal, setInputVal]       = useState('');
  const [lookupBusy, setLookupBusy]   = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError]   = useState<string | null>(null);

  const [wallet, setWallet]           = useState<string | null>(null);
  const [nfts, setNfts]               = useState<WalletNft[] | null>(null);
  const [nftsBusy, setNftsBusy]       = useState(false);
  const [nftsError, setNftsError]     = useState<string | null>(null);
  const [selectedNft, setSelectedNft] = useState<WalletNft | null>(null);
  const [meToken, setMeToken]         = useState('');
  const [showToken, setShowToken]     = useState(false);

  interface BridgeAttempt {
    status: number | null;
    rawBody: string | null;
    elapsedMs: number;
    windowOpened: boolean;
    error: string | null;
    txFound: boolean | null;
  }
  interface BackendAttempt {
    url: string;
    status: number;
    rawBody: string | null;
    elapsedMs: number;
  }
  interface DiagLog {
    poolKey: string;
    mint: string;
    seller: string;
    assetTokenAccount: string;
    minPayment: number;
    bridgeAttempt: BridgeAttempt | null;
    backendAttempt: BackendAttempt | null;
    finalErrorSource: 'Bridge (ME origin)' | 'Backend builder' | 'Frontend validation' | null;
    finalError: string | null;
  }
  type TxSource = 'me_browser' | 'backend' | null;
  type TxPhase = null | 'building' | 'signing' | 'confirming' | { sig: string; source: TxSource } | { error: string };
  const [txPhase, setTxPhase]   = useState<TxPhase>(null);
  const [diag, setDiag]         = useState<DiagLog | null>(null);

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
  const runLookup = async () => {
    if (!canLookup) return;
    setLookupBusy(true); setLookupError(null); setLookupResult(null);
    setNfts(null); setSelectedNft(null); setTxPhase(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/tools/mmm-pools/pool?key=${encodeURIComponent(inputVal.trim())}`,
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

  // ── Accept bid ──────────────────────────────────────────────────────────────
  const acceptBid = async () => {
    if (!pool || !wallet || !selectedNft) return;
    setTxPhase('building');

    const minPayment = Math.floor(pool.spotPrice * 9800 / 10000);
    const assetTokenAccount = getAssociatedTokenAddressSync(
      new PublicKey(selectedNft.mint),
      new PublicKey(wallet),
    ).toBase58();
    const backendUrl = `${API_BASE}/api/tools/mmm-pools/bid-accept-tx`
      + `?pool=${encodeURIComponent(pool.poolKey)}`
      + `&seller=${encodeURIComponent(wallet)}`
      + `&mint=${encodeURIComponent(selectedNft.mint)}`;

    const log: DiagLog = {
      poolKey: pool.poolKey, mint: selectedNft.mint, seller: wallet,
      assetTokenAccount, minPayment,
      bridgeAttempt: null, backendAttempt: null,
      finalErrorSource: null, finalError: null,
    };
    setDiag({ ...log });

    try {
      let txBase64: string | null = null;
      let txSource: TxSource = null;

      // ── Path 1: Tampermonkey bridge (magiceden.io origin) ─────────────────
      try {
        const br = await requestMmmInstruction({
          pool: pool.poolKey, seller: wallet,
          assetMint: selectedNft.mint, assetTokenAccount, assetAmount: 1,
          minPaymentAmount: minPayment,
        });
        let txFound = false;
        if (br.ok && br.body) {
          const body = br.body as { tx?: { data?: number[] }; txSigned?: { data?: number[] } };
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
      console.log('[VL-page] calling signSendAndConfirm — txBase64 length=' + txBase64.length + ' source=' + txSource);
      const conn = new Connection(RPC_URL, 'confirmed');
      const { signature } = await signSendAndConfirm(txBase64, conn);
      console.log('[VL-page] signSendAndConfirm returned — signature=' + signature);
      setTxPhase({ sig: signature, source: txSource });
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
      <div style={{ padding:'20px 4px 72px', flexShrink:0, width:'100%',
        maxWidth:'var(--tools-max,1100px)', margin:'0 auto', boxSizing:'border-box' }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#f0eef8', letterSpacing:'-0.5px' }}>
          MMM Bid Accept
        </h1>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:6, fontSize:11, color:'#9a9ab4' }}>
          <LiveDot />
          <span>bypass ME UI · paste pool key · connect Phantom · accept bid directly</span>
        </div>

        <div style={{ display:'flex', gap:8, marginTop:14, flexWrap:'wrap' }}>
          <input type="text" value={inputVal} onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void runLookup(); }}
            placeholder="Pool key (from MMM Pool Scanner)" spellCheck={false}
            style={{ flex:1, minWidth:280, padding:'7px 12px', fontSize:12,
              ...MONO, fontWeight:500, borderRadius:5, border:'1px solid rgba(168,144,232,0.45)',
              background:'rgba(20,14,34,0.85)', color:'#f0eef8', outline:'none' }} />
          <Btn onClick={() => void runLookup()} disabled={!canLookup}>
            {lookupBusy ? 'Loading…' : 'Load Pool'}
          </Btn>
        </div>

        {lookupError && (
          <div style={{ marginTop:10, padding:'8px 12px', fontSize:12, color:'#d96867',
            background:'rgba(239,120,120,0.08)', border:'1px solid rgba(239,120,120,0.32)', borderRadius:5 }}>
            {lookupError}
          </div>
        )}
      </div>

      <div style={{ width:'100%', maxWidth:'var(--tools-max,1100px)', margin:'0 auto' }}>

        {/* Escrow-only */}
        {lookupResult?.type === 'escrow' && (
          <div style={PANEL}>
            <div style={{ padding:'12px 20px', borderBottom:'1px solid rgba(168,144,232,0.08)',
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

        {/* Pool info */}
        {pool && (
          <>
            <div style={PANEL}>
              <div style={{ padding:'12px 20px', borderBottom:'1px solid rgba(168,144,232,0.08)',
                display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <StatusPill p={pool} />
                {(pool.collectionName || pool.collectionSymbol) && (
                  <span style={{ fontSize:13, fontWeight:700, color:'#f0eef8' }}>
                    {pool.collectionName || pool.collectionSymbol}
                  </span>
                )}
                {pool.isMIP1 && pill('MIP1','#a890e8','rgba(168,144,232,0.12)','rgba(168,144,232,0.35)')}
                <span style={{ marginLeft:'auto', fontSize:10, color:'#9a9ab4', ...MONO }}>
                  {new Date(lookupResult!.scannedAt).toLocaleTimeString()}
                </span>
              </div>

              <Row label="Pool Key">
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <SolLink addr={pool.poolKey} label={pool.poolKey} />
                  <a href={`https://magiceden.io/mmm/pool/${pool.poolKey}`} target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize:10, color:'#9a9ab4', textDecoration:'none', padding:'1px 6px',
                      border:'1px solid rgba(168,144,232,0.22)', borderRadius:3,
                      background:'rgba(168,144,232,0.06)' }}
                    onMouseEnter={e=>{(e.target as HTMLElement).style.color='#a890e8';}}
                    onMouseLeave={e=>{(e.target as HTMLElement).style.color='#9a9ab4';}}>ME ↗</a>
                </div>
              </Row>

              <Row label="Escrow">
                <span>
                  <SolLink addr={pool.escrowPda} label={short(pool.escrowPda)} />
                  {'  '}
                  <span style={{ color: pool.executable ? '#43b984' : pool.realEscrow > 0 ? '#c7b479' : '#9a9ab4' }}>
                    {fmtSol(pool.realEscrow)} SOL
                  </span>
                </span>
              </Row>

              <Row label="Spot Price">
                <span style={{ fontSize:14, fontWeight:700, color:'#f0eef8' }}>
                  {fmtSol(pool.spotPrice)} SOL
                </span>
              </Row>

              {pool.allowlists.length > 0 && (
                <Row label="Accepts">
                  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                    {pool.allowlists.map((al, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontSize:10, color:'#a890e8', background:'rgba(168,144,232,0.10)',
                          border:'1px solid rgba(168,144,232,0.22)', borderRadius:3, padding:'0 5px', lineHeight:1.5 }}>
                          {al.type}
                        </span>
                        <SolLink addr={al.pubkey} label={al.pubkey} />
                      </div>
                    ))}
                  </div>
                </Row>
              )}
            </div>

            {/* Wallet panel */}
            <div style={PANEL}>
              <div style={{ padding:'12px 20px', borderBottom:'1px solid rgba(168,144,232,0.08)',
                display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <span style={{ fontSize:11, fontWeight:700, color:'#9a9ab4', textTransform:'uppercase',
                  letterSpacing:'0.5px' }}>Wallet</span>
                {wallet ? (
                  <>
                    <span style={{ ...MONO, fontSize:11, color:'#f0eef8' }}>{short(wallet)}</span>
                    <SolLink addr={wallet} label="↗" />
                    <button onClick={doDisconnect} style={{ marginLeft:'auto', fontSize:10,
                      color:'#9a9ab4', background:'none', border:'none', cursor:'pointer',
                      textDecoration:'underline' }}>disconnect</button>
                  </>
                ) : (
                  <Btn onClick={() => void doConnect()}>Connect Phantom</Btn>
                )}
              </div>

              {wallet && (
                <div style={{ padding:'16px 20px' }}>
                  {!nfts && !nftsBusy && !nftsError && (
                    <Btn onClick={() => void loadNfts()}>Find Matching NFTs</Btn>
                  )}
                  {nftsBusy && <span style={{ fontSize:12, color:'#9a9ab4' }}>Searching wallet…</span>}
                  {nftsError && !nftsBusy && (
                    <div style={{ fontSize:12, color:'#d96867' }}>
                      {nftsError}
                      <button onClick={() => { setNftsError(null); void loadNfts(); }}
                        style={{ marginLeft:10, fontSize:10, color:'#9a9ab4', background:'none',
                          border:'none', cursor:'pointer', textDecoration:'underline' }}>retry</button>
                    </div>
                  )}
                  {nfts && nfts.length > 0 && (
                    <>
                      <div style={{ fontSize:11, color:'#9a9ab4', marginBottom:12 }}>
                        {nfts.length} matching NFT{nfts.length !== 1 ? 's' : ''} — pick one to sell
                      </div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:10 }}>
                        {nfts.map(n => (
                          <NftThumb key={n.mint} nft={n}
                            selected={selectedNft?.mint === n.mint}
                            onClick={() => { setSelectedNft(n); setTxPhase(null); setDiag(null); }} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Advanced: ME auth token — only shown after 401 or if previously set */}
            {showToken && (
              <div style={{ padding:'0 4px 12px' }}>
                <div style={{ fontSize:10, color:'#c7b479', marginBottom:6, fontWeight:600 }}>
                  Advanced — ME auth token
                  {diag?.bridgeAttempt?.status === 401 && ' (ME returned 401, token required)'}
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  <input
                    type="password"
                    value={meToken}
                    onChange={e => {
                      setMeToken(e.target.value);
                      if (e.target.value) localStorage.setItem(ME_TOKEN_KEY, e.target.value);
                      else localStorage.removeItem(ME_TOKEN_KEY);
                    }}
                    placeholder="optional ME auth token, only if browser session fails"
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

            {/* Accept bid */}
            {selectedNft && (
              <div style={PANEL}>
                <div style={{ padding:'16px 20px', display:'flex', alignItems:'center',
                  gap:16, flexWrap:'wrap' }}>
                  <div>
                    <div style={{ fontSize:10, color:'#9a9ab4', marginBottom:2, fontWeight:700,
                      textTransform:'uppercase', letterSpacing:'0.5px' }}>Selling</div>
                    <div style={{ fontSize:13, fontWeight:700, color:'#f0eef8' }}>{selectedNft.name}</div>
                    <div style={{ fontSize:10, color:'#9a9ab4', ...MONO }}>{short(selectedNft.mint)}</div>
                  </div>

                  <div>
                    <div style={{ fontSize:10, color:'#9a9ab4', marginBottom:2, fontWeight:700,
                      textTransform:'uppercase', letterSpacing:'0.5px' }}>You Receive</div>
                    <div style={{ fontSize:15, fontWeight:700, color:'#43b984' }}>
                      ~{fmtSol(pool.spotPrice)} SOL
                    </div>
                    <div style={{ fontSize:10, color:'#9a9ab4' }}>spot − protocol fees</div>
                  </div>

                  <div style={{ marginLeft:'auto', display:'flex', flexDirection:'column',
                    gap:8, alignItems:'flex-end' }}>
                    {txPhase === null && (
                      <Btn onClick={() => void acceptBid()} variant="green">Accept Bid</Btn>
                    )}
                    {txPhase === 'building' && (
                      <span style={{ fontSize:12, color:'#9a9ab4' }}>Building transaction…</span>
                    )}
                    {txPhase === 'signing' && (
                      <span style={{ fontSize:12, color:'#c7b479' }}>Check Phantom to sign…</span>
                    )}
                    {txPhase === 'confirming' && (
                      <span style={{ fontSize:12, color:'#c7b479' }}>Confirming on-chain…</span>
                    )}
                    {typeof txPhase === 'object' && txPhase !== null && 'sig' in txPhase && (
                      <div style={{ textAlign:'right' }}>
                        <div style={{ fontSize:12, color:'#43b984', fontWeight:700, marginBottom:4 }}>
                          ✓ Bid accepted!
                          {txPhase.source === 'me_browser' && <span style={{ fontSize:10, color:'#9a9ab4', fontWeight:400, marginLeft:6 }}>via ME bridge</span>}
                          {txPhase.source === 'backend' && <span style={{ fontSize:10, color:'#9a9ab4', fontWeight:400, marginLeft:6 }}>via on-chain builder</span>}
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
                      <div style={{ fontSize:11, color:'#d96867', maxWidth:320, textAlign:'right' }}>
                        {txPhase.error}
                        <br />
                        <button onClick={() => setTxPhase(null)}
                          style={{ fontSize:10, color:'#9a9ab4', background:'none', border:'none',
                            cursor:'pointer', textDecoration:'underline', marginTop:4 }}>retry</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Diagnostics panel ─────────────────────────────────────── */}
            {diag && (
              <div style={{ padding:'0 4px 16px' }}>
                <div style={{ ...MONO, fontSize:11, padding:'12px 14px', borderRadius:6,
                  background:'rgba(15,10,30,0.85)', border:'1px solid rgba(168,144,232,0.18)',
                  display:'flex', flexDirection:'column', gap:8 }}>

                  {/* Request params */}
                  <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                    textTransform:'uppercase', borderBottom:'1px solid rgba(168,144,232,0.10)', paddingBottom:6 }}>
                    Attempt params
                  </div>
                  <div style={{ color:'#c4c2d4', fontSize:11, lineHeight:1.7 }}>
                    <span style={{ color:'#9a9ab4' }}>pool:    </span>{diag.poolKey}<br/>
                    <span style={{ color:'#9a9ab4' }}>mint:    </span>{diag.mint}<br/>
                    <span style={{ color:'#9a9ab4' }}>seller:  </span>{diag.seller}<br/>
                    <span style={{ color:'#9a9ab4' }}>ata:     </span>{diag.assetTokenAccount}<br/>
                    <span style={{ color:'#9a9ab4' }}>minPay:  </span>{diag.minPayment} lamports ({(diag.minPayment/1e9).toFixed(6)} SOL)
                  </div>

                  {/* Bridge attempt */}
                  <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                    textTransform:'uppercase', borderBottom:'1px solid rgba(168,144,232,0.10)', paddingBottom:6, marginTop:4 }}>
                    Path 1 — Bridge (magiceden.io origin)
                  </div>
                  {diag.bridgeAttempt ? (() => {
                    const m = diag.bridgeAttempt;
                    const ok = m.status !== null && m.status >= 200 && m.status < 300;
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        <div>
                          <span style={{ color:'#9a9ab4' }}>window:  </span>
                          <span style={{ color:'#c4c2d4' }}>{m.windowOpened ? 'opened new tab' : 'reused existing tab'}</span>
                        </div>
                        <div>
                          <span style={{ color:'#9a9ab4' }}>status:  </span>
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
                        {m.error && (
                          <div><span style={{ color:'#9a9ab4' }}>error:   </span>
                            <span style={{ color:'#d96867' }}>{m.error}</span></div>
                        )}
                        {m.rawBody !== null && (
                          <div style={{ marginTop:2 }}>
                            <span style={{ color:'#9a9ab4' }}>body:    </span>
                            <span style={{ color: ok ? '#43b984' : '#d96867' }}>
                              {m.rawBody.length > 300 ? m.rawBody.slice(0,300) + '…' : m.rawBody || '(empty)'}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })() : (
                    <div style={{ color:'#9a9ab4' }}>not attempted yet</div>
                  )}

                  {/* Backend attempt */}
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

                  {/* Final error */}
                  {diag.finalErrorSource && (
                    <>
                      <div style={{ color:'#9a9ab4', fontWeight:700, fontSize:10, letterSpacing:'0.5px',
                        textTransform:'uppercase', borderBottom:'1px solid rgba(239,120,120,0.20)', paddingBottom:6, marginTop:4 }}>
                        Error source
                      </div>
                      <div>
                        <span style={{ color:'#d96867', fontWeight:700 }}>Error source: {diag.finalErrorSource}</span>
                        <br/>
                        <span style={{ color:'#d96867' }}>{diag.finalError}</span>
                      </div>
                    </>
                  )}

                </div>
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!lookupResult && !lookupBusy && !lookupError && (
          <div style={{ ...PANEL, padding:'48px 24px', textAlign:'center', color:'#9a9ab4',
            fontSize:13, lineHeight:1.6 }}>
            Paste a pool key from{' '}
            <a href="/tools/mmm-pools" style={{ color:'#a890e8', textDecoration:'none' }}
              onMouseEnter={e=>{(e.target as HTMLElement).style.textDecoration='underline';}}
              onMouseLeave={e=>{(e.target as HTMLElement).style.textDecoration='none';}}>
              MMM Pool Scanner
            </a>{' '}and click <span style={{ color:'#a890e8', fontWeight:600 }}>Load Pool</span>.
            <br />Connect Phantom to accept the bid directly — bypasses ME UI.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
