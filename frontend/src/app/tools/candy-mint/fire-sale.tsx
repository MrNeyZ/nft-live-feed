'use client';

// printerotc.fun fire sale — the project's own offer flow, driven from Candy
// Mint. Their cosigner (DaprcA3…) signs f-group mints only for a wallet with an
// ACTIVE offer in their database: login (signMessage) -> spin (server records
// the offer: group/price/burn, 10 min) -> prepare (server builds the tx for
// THAT offer) -> wallet signs -> sign (server cosigns the identical tx) ->
// submit. We mint exactly the offered tier; the tx is structurally checked
// against the offer + on-chain group price before Phantom is asked to sign.

import { useEffect, useRef, useState } from 'react';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { authHeaders } from '@/runtime/auth';
import { getPhantom, currentPhantomPublicKey } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, ToolButton, short } from '@/app/tools/mmm-shared';

export const PRINTER_CANDY_MACHINE = 'CVWE9UzXbXmpQjZVAiRLTJoyhhfYZwuUkgbyqYe68gmw';
const CANDY_GUARD = 'AyTaFTC2GynH43fusoWgYA5MsaWf2dBySjnaejP9ChXN';
const COLLECTION = 'E2cjysGtVPjDiL7RtfkyTgou8g2vRRfgkh4JtWtopJoA';
const SALE_RECIPIENT = '9PgeXzGiX3Tz5GzaBFcaeCFf9FULjP41SDiP1754FBcA';
const COSIGNER = 'DaprcA3JKHFeoMN1PdXGgDTtU6YHNeiNz51kWJQ3NZqX';
const PRINTER_MINT = '3e6to4qrHByU19Sij9DVKPB4AQD5RuyhH2Sj2ESLpump';
const PROG = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  coreCandyGuard: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
  coreCandyMachine: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
};
const MINT_V1_DISC = [145, 98, 192, 118, 184, 147, 118, 104];
const MAX_CU_PRICE = BigInt(250_000);

interface Quote { group: string; lamports: string; burnAtoms: string; outcome: string; wallet: string; expiresAt: number }
interface OfferMint { transaction?: string; status?: string; asset?: string; lastValidBlockHeight?: number; estimatedCostLabel?: string }
interface Offer { id: string; status: string; quote: Quote; mint?: OfferMint | null; expiresAt: number; recoveryExpiresAt?: number }
interface FireState { wallet?: string; offer?: Offer | null; available?: number; sold?: number; cap?: number; serverTime?: number; error?: string }

// Structural check of the server-built tx against the offer the user sees.
// Pure; exported for tests.
export function checkFireSaleTx(
  b64: string,
  o: { wallet: string; asset: string; quote: Quote; onchainGroupLamports: string | null },
): string | null {
  let tx: Transaction;
  try { tx = Transaction.from(Buffer.from(b64, 'base64')); } catch { return 'transaction did not parse'; }
  if (tx.feePayer?.toBase58() !== o.wallet) return 'fee payer is not your wallet';
  if (o.quote.wallet !== o.wallet) return 'offer belongs to another wallet';
  if (o.onchainGroupLamports == null || o.onchainGroupLamports !== o.quote.lamports) {
    return `offer price ${o.quote.lamports} != on-chain ${o.quote.group} price ${o.onchainGroupLamports ?? 'none'}`;
  }
  const burn = BigInt(o.quote.burnAtoms);
  const ixs = tx.instructions;
  if (ixs.length !== (burn > BigInt(0) ? 4 : 3)) return `unexpected instruction count ${ixs.length}`;
  const [lim, price] = ixs;
  if (lim.programId.toBase58() !== PROG.computeBudget || lim.data[0] !== 2 || lim.data.readUInt32LE(1) !== 800_000) return 'unexpected compute limit';
  if (price.programId.toBase58() !== PROG.computeBudget || price.data[0] !== 3 || price.data.readBigUInt64LE(1) > MAX_CU_PRICE) return 'priority fee too high';
  if (burn > BigInt(0)) {
    const b = ixs[2];
    const [ata] = PublicKey.findProgramAddressSync(
      [new PublicKey(o.wallet).toBuffer(), new PublicKey(PROG.token2022).toBuffer(), new PublicKey(PRINTER_MINT).toBuffer()],
      new PublicKey(PROG.ata),
    );
    if (b.programId.toBase58() !== PROG.token2022 || b.data.length !== 10 || b.data[0] !== 15) return 'burn is not a Token-2022 BurnChecked';
    if (b.data.readBigUInt64LE(1) !== burn || b.data[9] !== 6) return 'burn amount differs from the offer';
    if (b.keys.length !== 3 || !b.keys[0].pubkey.equals(ata) || b.keys[1].pubkey.toBase58() !== PRINTER_MINT || b.keys[2].pubkey.toBase58() !== o.wallet) {
      return 'burn is not from your own PRINTER account';
    }
  }
  const g = ixs[ixs.length - 1];
  if (g.programId.toBase58() !== PROG.coreCandyGuard) return 'last instruction is not the Core Candy Guard';
  if (!MINT_V1_DISC.every((v, i) => g.data[i] === v)) return 'not a MintV1';
  const k = (i: number) => g.keys[i]?.pubkey.toBase58();
  if (g.keys.length !== 15) return `guard has ${g.keys.length} accounts, expected 15`;
  if (k(0) !== CANDY_GUARD || k(1) !== PROG.coreCandyMachine || k(2) !== PRINTER_CANDY_MACHINE) return 'wrong candy guard/machine';
  if (k(4) !== o.wallet || k(5) !== o.wallet) return 'payer/minter is not your wallet';
  if (k(7) !== o.asset || k(8) !== COLLECTION) return 'wrong asset/collection';
  if (k(13) !== SALE_RECIPIENT || k(14) !== COSIGNER || !g.keys[14].isSigner) return 'wrong payment destination / cosigner';
  // data: disc(8) | mintArgs u32 len(=0) | Option<group>: 1 | u32 len | utf8
  const d = g.data;
  if (d.readUInt32LE(8) !== 0 || d[12] !== 1) return 'unexpected mint args';
  const glen = d.readUInt32LE(13);
  if (Buffer.from(d.subarray(17, 17 + glen)).toString('utf8') !== o.quote.group || d.length !== 17 + glen) return 'group differs from the offer';
  const msg = tx.compileMessage();
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((x) => x.toBase58()).sort();
  if (signers.join() !== [o.wallet, o.asset, COSIGNER].sort().join()) return 'unexpected signer set';
  return null;
}

async function api(path: string, token: string | null, body?: object): Promise<FireState & { token?: string; message?: string; id?: string }> {
  const r = await fetch(`${API_BASE}/api/tools/candy-mint/fire-sale/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(token ? { 'x-printer-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function tokenKey(wallet: string) { return `vl.candyMint.fireSale.${wallet}`; }
function loadToken(wallet: string): string | null {
  try {
    const raw = sessionStorage.getItem(tokenKey(wallet));
    if (!raw) return null;
    const t = JSON.parse(raw) as { token: string; expiresAt: number };
    return t.expiresAt > Date.now() + 60_000 ? t.token : null;
  } catch { return null; }
}
function saveToken(wallet: string, token: string, expiresAt: number) {
  try { sessionStorage.setItem(tokenKey(wallet), JSON.stringify({ token, expiresAt })); } catch { /* per-tab convenience only */ }
}

export function FireSalePanel({ wallet, groupLamports }: {
  wallet: string | null;
  /** label -> on-chain solPayment lamports, from the inspection. */
  groupLamports: Record<string, string | null>;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [st, setSt] = useState<FireState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const assetRef = useRef<{ offerId: string; kp: Keypair } | null>(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    setSt(null); setSig(null); setMsg(null);
    const t = wallet ? loadToken(wallet) : null;
    setToken(t);
    if (wallet && t) api('state', t, { wallet }).then(setSt).catch(() => setToken(null));
  }, [wallet]);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  function assertWallet() {
    if (!wallet || currentPhantomPublicKey() !== wallet) throw new Error('Connected wallet changed — reconnect.');
  }

  const login = () => run(async () => {
    assertWallet();
    const ph = getPhantom() as unknown as { signMessage?: (m: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array } | Uint8Array> };
    if (!ph?.signMessage) throw new Error('Wallet cannot sign messages.');
    const ch = await api('challenge', null, { wallet });
    const m = ch.message ?? '';
    if (!m.includes('Site: https://printerotc.fun\n') || !m.includes(`Wallet: ${wallet}\n`)) throw new Error('Unexpected sign-in message — not signing.');
    setMsg('Sign the free sign-in message in Phantom (no payment).');
    const s = await ph.signMessage(new TextEncoder().encode(m), 'utf8');
    const sigBytes = s instanceof Uint8Array ? s : s.signature;
    const lg = await api('login', null, { wallet, challengeId: ch.id, signature: Buffer.from(sigBytes).toString('base64') }) as { token?: string; expiresAt?: number };
    if (!lg.token) throw new Error('Login failed');
    saveToken(wallet!, lg.token, lg.expiresAt ?? Date.now() + 3_600_000);
    setToken(lg.token);
    setSt(await api('state', lg.token, { wallet }));
    setMsg(null);
  });

  const spin = () => run(async () => {
    assertWallet();
    setSt(await api('spin', token, { wallet }));
  });

  const mint = () => run(async () => {
    assertWallet();
    const offer = st?.offer;
    if (!offer) throw new Error('No active offer — spin first.');
    if (!assetRef.current || assetRef.current.offerId !== offer.id) assetRef.current = { offerId: offer.id, kp: Keypair.generate() };
    const asset = assetRef.current.kp;

    setMsg('Server is building the transaction for your offer…');
    const prepared = await api('prepare', token, { wallet, asset: asset.publicKey.toBase58() });
    setSt(prepared);
    const pm = prepared.offer?.mint;
    if (!pm?.transaction) throw new Error('Server returned no transaction.');
    const quote = prepared.offer!.quote;
    const bad = checkFireSaleTx(pm.transaction, { wallet: wallet!, asset: asset.publicKey.toBase58(), quote, onchainGroupLamports: groupLamports[quote.group] ?? null });
    if (bad) throw new Error(`Safety check failed, not signing: ${bad}`);

    const tx = Transaction.from(Buffer.from(pm.transaction, 'base64'));
    const reviewed = tx.serializeMessage();
    tx.partialSign(asset);

    // simulate (sigVerify off) — catches missing PRINTER / SOL before Phantom
    const sim = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), wallet }),
    }).then((r) => r.json() as Promise<{ ok: boolean; error?: string; botTaxDetected?: boolean }>);
    if (!sim.ok) throw new Error(`Simulation failed: ${sim.error}`);
    if (sim.botTaxDetected) throw new Error('Simulation hit the bot-tax path — not signing.');

    setMsg('Approve the mint in Phantom.');
    const ph = getPhantom();
    if (!ph) throw new Error('Phantom not connected.');
    const [signed] = await ph.signAllTransactions([tx]);
    assertWallet();
    if (!(signed as Transaction).serializeMessage().equals(reviewed)) throw new Error('Wallet changed the transaction — nothing was sent.');
    (signed as Transaction).partialSign(asset);
    const walletSigned = (signed as Transaction).serialize({ requireAllSignatures: false }).toString('base64');

    setMsg('Requesting the cosigner signature…');
    const signedState = await api('sign', token, { wallet, transaction: walletSigned });
    setSt(signedState);
    const cos = signedState.offer?.mint?.transaction;
    if (!cos) throw new Error('Cosigner returned no transaction.');
    const full = Transaction.from(Buffer.from(cos, 'base64'));
    if (!full.serializeMessage().equals(reviewed) || !full.verifySignatures(true)) throw new Error('Cosigned transaction differs or is incomplete — not sending.');
    setSig(bs58.encode(full.signature!));

    setMsg('Submitting…');
    setSt(await api('submit', token, { wallet }));
    // backup broadcast through our own proxy (same signature — harmless if duplicate)
    fetch(`${API_BASE}/api/tools/candy-mint/send-tx`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ tx: cos }),
    }).catch(() => {});

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const c = await api('check', token, { wallet }).catch(() => null);
      if (c) setSt(c);
      if (c?.offer?.status === 'redeemed' || !c?.offer?.mint) { setMsg('Minted.'); return; }
    }
    setMsg('Submitted — still confirming. Check the signature below.');
  });

  const offer = st?.offer ?? null;
  const left = offer ? Math.max(0, Math.floor((offer.expiresAt - now) / 1000)) : 0;
  const offerLive = !!offer && offer.status === 'revealed' && left > 0;

  return (
    <div style={{ ...PANEL, padding: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Fire sale (printerotc.fun offer)</div>
      <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 12 }}>
        Cosigner signs only for an active offer: sign in → spin → mint the offered tier.
        {st?.available != null && <> · {st.available} of {st.cap} promo spots left</>}
      </div>
      {!wallet && <div style={{ fontSize: 13 }}>Connect a wallet first.</div>}
      {wallet && !token && <ToolButton onClick={login} disabled={busy}>Sign in (free message)</ToolButton>}
      {wallet && token && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          {offer && (
            <div style={{ ...MONO, fontSize: 13 }}>
              {offer.quote.group} · {(Number(offer.quote.lamports) / 1e9).toFixed(3)} SOL
              {offer.quote.burnAtoms !== '0' && <> + {(Number(offer.quote.burnAtoms) / 1e6).toLocaleString('en-US')} PRINTER burn</>}
              {' · '}{offer.status}{offerLive && <> · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</>}
            </div>
          )}
          {!offerLive && offer?.status !== 'redeemed' && <ToolButton onClick={spin} disabled={busy}>Spin</ToolButton>}
          {offer?.status === 'redeemed' && <ToolButton onClick={spin} disabled={busy}>Spin again</ToolButton>}
          {offerLive && <ToolButton onClick={mint} disabled={busy}>Mint {offer!.quote.group}</ToolButton>}
        </div>
      )}
      {msg && <div style={{ marginTop: 10, fontSize: 12.5 }}>{msg}</div>}
      {sig && (
        <div style={{ ...MONO, marginTop: 6, fontSize: 12 }}>
          tx: <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer">{short(sig)}</a>
        </div>
      )}
    </div>
  );
}
