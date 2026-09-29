// Per-NFT offers index — the "top offer" shown on /collection listing rows.
//
//   ME      M2 BuyerTradeStateV2 (personal offer on one mint). SOL sits in a
//           per-(auctionHouse, buyer) escrow, not on the offer, so an offer is
//           only real while that escrow covers its price (me-bid-escrow.ts).
//           Legacy V1 BuyerTradeState (1.6 M accounts, years of never-
//           cancelled bids) is deliberately not indexed.
//   Tensor  TComp BidState with target = AssetId (byte 74 == 0). Funded by
//           its margin account when set, else by lamports on the bid itself.
//
// Both sets are loaded with one getProgramAccounts each (10 credits) and
// re-loaded every REFRESH_MS; that only decides WHICH accounts to look at.
// Whether an offer is live (account still exists, escrow / margin funded) is
// checked at query time with getMultipleAccounts (1 credit / 100), so a
// cancelled or drained offer never shows. New offers appear within one
// refresh. Collection bids (ME MMM / Tensor whitelist) come from
// collection-bids.ts; trait bids are not derivable on-chain (ME stores a
// merkle root, Tensor enforces traits in its cosigner) and are not included.

import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TCompSDK } from '@tensor-oss/tcomp-sdk';
import bs58 from 'bs58';
import { rpcPost, rpcUrl } from './tools-mmm-pools';
import { deriveBuyerEscrowPda, resolveEscrowBalances } from './me-bid-escrow';

const M2 = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const TCOMP = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';
const accountDisc = (name: string) =>
  bs58.encode(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));
const SOL_MINTS = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);

const REFRESH_MS = 15 * 60_000;
const LOAD_TIMEOUT_MS = 120_000;
const RESULT_TTL_MS = 60_000;
const GMA_BATCH = 100;

export interface NftOffer {
  priceSol: number;
  src:      'ME' | 'TENSOR';
}

interface Candidate {
  src:      'ME' | 'TENSOR';
  account:  string;
  lamports: number;
  expiry:   number;           // unix s, ≤ 0 = none
  /** ME: buyer escrow PDA. Tensor: margin account, or null (bid-funded). */
  fundedBy: string | null;
}

let byMint = new Map<string, Candidate[]>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
export const offersStats = { meIndexed: 0, tensorIndexed: 0, loads: 0, loadErrors: 0 };

// ─── index load ──────────────────────────────────────────────────────────────
//
// The two getProgramAccounts answers are 30–80 MB of JSON. Parsing them with
// res.json() materialised ~200k objects at once and pushed the process past
// pm2's 800 MB max_memory_restart (crash loop on boot, 2026-09-29). Instead
// the body is scanned as a stream: each account is decoded as soon as its
// bytes arrive and only the compact index entry is kept.

const ACCOUNT_RE = /"pubkey":"([1-9A-HJ-NP-Za-km-z]{32,44})","account":\{"lamports":(\d+),"data":\["([A-Za-z0-9+\/=]*)","base64"\]/g;

async function streamGpa(
  program: string,
  config: Record<string, unknown>,
  onAccount: (pubkey: string, data: Buffer) => void,
): Promise<number> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nft-offers', method: 'getProgramAccounts', params: [program, config] }),
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`getProgramAccounts HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let n = 0;
  let head = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    if (head.length < 200) head += buf.slice(0, 200 - head.length);
    ACCOUNT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = ACCOUNT_RE.exec(buf)) !== null) {
      // m[1] is a V8 sliced string pinning this chunk; push() flattens it.
      onAccount(m[1], Buffer.from(m[3], 'base64'));
      n++;
      consumed = ACCOUNT_RE.lastIndex;
    }
    buf = buf.slice(consumed);
    if (done) break;
  }
  // An RPC error (or a changed response shape) yields zero matches — fail
  // loudly instead of silently swapping in an empty index.
  if (n === 0 && !/"result":\[\]/.test(head)) throw new Error(`getProgramAccounts: no accounts parsed (${head.slice(0, 120)})`);
  return n;
}

async function loadMe(into: Map<string, Candidate[]>): Promise<number> {
  // Slice from byte 8 (after the discriminator): ah 0..32, buyer 32..64,
  // price 96..104, mint 104..136, expiry 145..153. SOL-priced only, via a
  // memcmp on paymentMint (byte 171) = System program (all zero bytes).
  const now = Date.now() / 1000;
  let n = 0;
  await streamGpa(M2, {
    encoding: 'base64',
    dataSlice: { offset: 8, length: 153 },
    filters: [
      { memcmp: { offset: 0, bytes: accountDisc('BuyerTradeStateV2') } },
      { dataSize: 320 },
      { memcmp: { offset: 171, bytes: bs58.encode(Buffer.alloc(32)) } },
    ],
  }, (pubkey, b) => {
    if (b.length < 153) return;
    const expiry = Number(b.readBigInt64LE(145));
    if (expiry > 0 && expiry < now) return;
    const lamports = Number(b.readBigUInt64LE(96));
    if (!(lamports > 0)) return;
    const escrow = deriveBuyerEscrowPda(bs58.encode(b.subarray(0, 32)), bs58.encode(b.subarray(32, 64)));
    if (!escrow) return;
    push(into, bs58.encode(b.subarray(104, 136)), { src: 'ME', account: pubkey, lamports, expiry, fundedBy: escrow });
    n++;
  });
  return n;
}

let tcompCoder: { decode: (name: string, data: Buffer) => unknown } | null = null;
function coder() {
  if (tcompCoder) return tcompCoder;
  const connection = new Connection('https://api.mainnet-beta.solana.com');
  const provider = new anchor.AnchorProvider(connection, { publicKey: PublicKey.default } as unknown as anchor.Wallet, {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tcompCoder = (new TCompSDK({ provider }) as any).program.coder.accounts;
  return tcompCoder!;
}

async function loadTensor(into: Map<string, Candidate[]>): Promise<number> {
  const now = Date.now() / 1000;
  let n = 0;
  await streamGpa(TCOMP, {
    encoding: 'base64',
    // byte 74 = Target enum; 0 = AssetId (a bid on one specific NFT).
    filters: [{ memcmp: { offset: 0, bytes: accountDisc('BidState') } }, { memcmp: { offset: 74, bytes: bs58.encode([0]) } }],
  }, (pubkey, data) => {
    let d: {
      targetId: PublicKey; amount: anchor.BN; quantity: number; filledQuantity: number;
      expiry: anchor.BN; margin: PublicKey | null; currency?: PublicKey | null;
    };
    try { d = coder().decode('bidState', data) as typeof d; } catch { return; }
    if (d.filledQuantity >= d.quantity) return;
    if (d.currency) return;                                     // SOL bids only
    const expiry = d.expiry.toNumber();
    if (expiry > 0 && expiry < now) return;
    const lamports = d.amount.toNumber();
    if (!(lamports > 0)) return;
    push(into, d.targetId.toBase58(), {
      src: 'TENSOR', account: pubkey, lamports, expiry, fundedBy: d.margin ? d.margin.toBase58() : null,
    });
    n++;
  });
  return n;
}

/** Flat copy of a string. bs58 / PublicKey.toBase58 build addresses by
 *  per-character concatenation, which V8 keeps as a rope (~1.4 KB per
 *  44-char address); the regex captures are slices pinning their chunk.
 *  Everything stored in the index goes through this (≈10× less heap). */
const flat = (x: string): string => Buffer.from(x, 'latin1').toString('latin1');

function push(m: Map<string, Candidate[]>, mint: string, c: Candidate): void {
  mint = flat(mint);
  c.account = flat(c.account);
  if (c.fundedBy) c.fundedBy = flat(c.fundedBy);
  const a = m.get(mint);
  if (a) a.push(c); else m.set(mint, [c]);
}

async function reload(): Promise<void> {
  const next = new Map<string, Candidate[]>();
  offersStats.loads++;
  // Sequential on purpose: one big response in flight at a time.
  const [me] = await Promise.allSettled([loadMe(next)]);
  const [tn] = await Promise.allSettled([loadTensor(next)]);
  // Keep the previous source's half if one load failed — a partial swap
  // would drop every offer of that marketplace until the next refresh.
  if (me.status === 'rejected' || tn.status === 'rejected') {
    offersStats.loadErrors++;
    console.warn('[nft-offers] load failed', me.status === 'rejected' ? `ME: ${(me.reason as Error).message}` : '',
      tn.status === 'rejected' ? `Tensor: ${(tn.reason as Error).message}` : '');
    for (const [mint, cs] of byMint) {
      for (const c of cs) {
        if ((c.src === 'ME' && me.status === 'rejected') || (c.src === 'TENSOR' && tn.status === 'rejected')) push(next, mint, c);
      }
    }
  }
  if (me.status === 'fulfilled') offersStats.meIndexed = me.value;
  if (tn.status === 'fulfilled') offersStats.tensorIndexed = tn.value;
  byMint = next;
  loadedAt = Date.now();
  console.log(`[nft-offers] indexed ME=${offersStats.meIndexed} Tensor=${offersStats.tensorIndexed} mints=${next.size}`);
}

function ensureIndex(): Promise<void> {
  if (Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  loading ??= reload().finally(() => { loading = null; });
  // First load: callers wait. Later refreshes run in the background.
  return loadedAt === 0 ? loading : Promise.resolve();
}

/** Warm the index at boot and keep it fresh (15 min, ~20 credits). */
export function startNftOffersIndex(): void {
  // First load 60 s after boot, clear of the startup burst (a query before
  // then triggers it itself).
  setTimeout(() => void ensureIndex().catch(() => {}), 60_000).unref();
  setInterval(() => void ensureIndex().catch(() => {}), REFRESH_MS).unref();
}

// ─── live check + query ──────────────────────────────────────────────────────

const resultCache = new Map<string, { offer: NftOffer | null; at: number }>();

async function lamportsOf(addrs: string[]): Promise<Map<string, { lamports: number; space: number } | null>> {
  const out = new Map<string, { lamports: number; space: number } | null>();
  for (let i = 0; i < addrs.length; i += GMA_BATCH) {
    const chunk = addrs.slice(i, i + GMA_BATCH);
    const r = await rpcPost('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]) as
      { value: Array<{ lamports: number; space?: number; data: [string, string] } | null> };
    chunk.forEach((a, j) => {
      const v = r.value[j];
      out.set(a, v ? { lamports: v.lamports, space: v.space ?? 0 } : null);
    });
  }
  return out;
}

/** Best LIVE, FUNDED personal offer per mint (ME or Tensor). Mints without
 *  one map to null. Cached per mint for RESULT_TTL_MS. */
export async function getTopOffers(mints: string[]): Promise<Map<string, NftOffer | null>> {
  await ensureIndex();
  const now = Date.now();
  const out = new Map<string, NftOffer | null>();
  const todo: string[] = [];
  for (const m of mints) {
    const hit = resultCache.get(m);
    if (hit && now - hit.at < RESULT_TTL_MS) out.set(m, hit.offer);
    else if (!byMint.has(m)) { out.set(m, null); resultCache.set(m, { offer: null, at: now }); }
    else todo.push(m);
  }
  if (!todo.length) return out;

  const cands = todo.flatMap(m => byMint.get(m)!.map(c => ({ mint: m, c })));
  // One pass over every account that decides liveness: the offers
  // themselves (closed = cancelled / filled) and Tensor margins.
  const accts = new Set<string>();
  for (const { c } of cands) {
    accts.add(c.account);
    if (c.src === 'TENSOR' && c.fundedBy) accts.add(c.fundedBy);
  }
  const [state, escrows] = await Promise.all([
    lamportsOf(Array.from(accts)),
    resolveEscrowBalances(Array.from(new Set(cands.filter(x => x.c.src === 'ME').map(x => x.c.fundedBy!)))),
  ]);
  const best = new Map<string, NftOffer>();
  for (const { mint, c } of cands) {
    const acct = state.get(c.account);
    if (!acct) continue;                                        // closed
    let funded: boolean;
    if (c.src === 'ME') {
      funded = (escrows.balances.get(c.fundedBy!) ?? 0) >= c.lamports;
    } else if (c.fundedBy) {
      funded = (state.get(c.fundedBy)?.lamports ?? 0) >= c.lamports;
    } else {
      // Bid-funded: the amount sits on the bid account above its rent.
      funded = acct.lamports >= c.lamports;
    }
    if (!funded) continue;
    const priceSol = c.lamports / 1e9;
    const cur = best.get(mint);
    if (!cur || priceSol > cur.priceSol) best.set(mint, { priceSol, src: c.src });
  }
  for (const m of todo) {
    const offer = best.get(m) ?? null;
    out.set(m, offer);
    resultCache.set(m, { offer, at: now });
  }
  return out;
}
