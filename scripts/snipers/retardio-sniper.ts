/**
 * Retardio Cousins Classic trait sniper.
 *
 * Buys a fresh ME / Tensor listing the moment it appears when it matches:
 *   - any Niqab costume, Costume=Space Suit, Makeup=Retardio OG,
 *     Hat=Yarmulke, Hat=Retardio First, Accessories=NEET Chain   -> price <= 1.0 SOL
 *   - Accessories=Voodoo Visi                                     -> price <  0.6 SOL
 *
 * Stream: Helius `transactionSubscribe` at `processed`, filtered to the COLLECTION account
 * (every Core list tx carries it), decoded with the feed's listing decoder.
 * Tensor: own `buy_core` tx (maxAmount enforced on-chain) + Helius tip -> Sender + RPC.
 * ME: own `BuyV2 + CoreExecuteSaleV2` built from the `core_sell` ix (zero RPC, single signer —
 *     M2 needs no ME cosign for a listing buy) + Helius tip -> Sender + RPC; `buy_now` API fallback.
 *
 * LOG-ONLY by default: builds + simulates, logs latency, then records who actually bought
 * and how many slots after the listing. Real sends only with SNIPER_LIVE=true.
 *
 *   npx ts-node --transpile-only scripts/snipers/retardio-sniper.ts
 */
import { readFileSync, appendFileSync } from 'fs';
import crypto from 'crypto';
import WebSocket from 'ws';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { decodeIx, txHasSale, type ListingAction } from '../../src/ingestion/listing-stream/decode';

// ── config ──────────────────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync('/root/nft-live-feed/.env', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m![1], m![2]!.trim()]),
) as Record<string, string>;
const HELIUS_KEY = env.HELIUS_API_KEY!;
const ME_API_KEY = env.ME_API_KEY!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
// Nearest regions first; Sender forwards to validators + Jito from each.
const SENDERS = ['fra', 'ams', 'lon', 'ewr'].map((r) => `http://${r}-sender.helius-rpc.com/fast?api-key=${HELIUS_KEY}`);

const COLLECTION = '4mX8wTrn4xk77rmYHh4WZ7cnkXgCm8MMhKcYWzS7wENP';
const LIVE = process.env.SNIPER_LIVE === 'true';
const BUYER_ADDR = process.env.SNIPER_BUYER ?? '71pWAHgNXvUydZqopiadDo5a4JwzqRy6LBAu9SdvFTPs';
const KEYS_FILE = process.env.SNIPER_KEYS ?? '/root/lmnft-mint-engine/keys/retardio-user.wallets.json';
const MAX_SPEND_SOL = Number(process.env.SNIPER_MAX_SPEND_SOL ?? 5);
const PRIO_MICROLAMPORTS = Number(process.env.SNIPER_PRIO_MICROLAMPORTS ?? 25_000_000); // x80k CU = 0.002 SOL
const TIP_LAMPORTS = Number(process.env.SNIPER_TIP_LAMPORTS ?? 1_000_000);             // 0.001 SOL, Sender floor 0.0002
const LOG_FILE = process.env.SNIPER_LOG ?? '/root/nft-live-feed/data/retardio-sniper.jsonl';

type Category = 'niqab' | 'space_suit' | 'retardio_og' | 'voodoo_visi' | 'yarmulke' | 'retardio_first' | 'neet_chain';
const MAX_PRICE_LAMPORTS: Record<Category, number> = {
  niqab: 1_000_000_000,
  space_suit: 1_000_000_000,
  retardio_og: 1_000_000_000,
  voodoo_visi: 600_000_000 - 1, // strictly below 0.6
  yarmulke: 1_000_000_000,
  retardio_first: 1_000_000_000,
  neet_chain: 1_000_000_000,
};

const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  'D1Mc6j9xQWgR1o1Z7yU5nVVXFQiAYx7FG9AW1aVfwrUM', 'tKq5esiQyvgRyfFa4JEz4uAUmppKyKB1PiQD9JhyGJY',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', 'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
];

const TCOMP = new PublicKey('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp');
const FEE_PROGRAM = new PublicKey('TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const BUY_CORE_DISC = crypto.createHash('sha256').update('global:buy_core').digest().subarray(0, 8);
// ME M2 (Core listings). Constants + PDA seeds verified against a winning buy (3Y2Kiofy…, #60).
const M2 = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const ME_AH = new PublicKey('E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe');
const ME_AH_AUTHORITY = new PublicKey('autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2'); // also buyerReferral
const ME_NOTARY = new PublicKey('NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd');
const ME_PROGRAM_AS_SIGNER = new PublicKey('1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix');
const TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const anchorDisc = (n: string) => crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const BUY_V2_DISC = anchorDisc('buy_v2');
const CORE_EXEC_V2_DISC = anchorDisc('core_execute_sale_v2');
const ME_TAKER_FEE_BP = 200n; // AH taker fee (log: taker_fee = 2% of price)
const ME_CU_LIMIT = Number(process.env.SNIPER_ME_CU_LIMIT ?? 160_000);
const conn = new Connection(RPC, 'processed');
const COLLECTION_PK = new PublicKey(COLLECTION);
const CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 });
const CU_PRICE_IX = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIO_MICROLAMPORTS });
const TIP_ACCOUNTS_PK = HELIUS_TIP_ACCOUNTS.map((a) => new PublicKey(a));
// Same total priority spend as the Tensor path (PRIO x 80k CU) spread over ME's larger CU limit.
const ME_CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: ME_CU_LIMIT });
const ME_CU_PRICE_IX = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((PRIO_MICROLAMPORTS * 80_000) / ME_CU_LIMIT) });

const log = (o: Record<string, unknown>): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...o });
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
};

// ── buyer key ───────────────────────────────────────────────────────────────────────────────
function loadBuyer(): Keypair {
  const raw = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as string[];
  for (const s of raw) {
    const kp = Keypair.fromSecretKey(bs58.decode(s));
    if (kp.publicKey.toBase58() === BUYER_ADDR) return kp;
  }
  throw new Error(`buyer ${BUYER_ADDR} not in ${KEYS_FILE}`);
}
const buyer = loadBuyer();

// ── targets: mint -> category ───────────────────────────────────────────────────────────────
type Target = { category: Category; name: string; listState: PublicKey; feeVault: PublicKey; meMetadata: PublicKey; meBts: PublicKey };
let targets = new Map<string, Target>();
/** json_uri attrs we had to read ourselves (DAS blank) — cached so a refresh doesn't refetch ~175 files. */
const jsonAttrCache = new Map<string, Record<string, string>>();
let royalty = { creators: [] as PublicKey[], bps: 0 };

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

function categorize(attrs: Record<string, string>): Category | null {
  if ((attrs.Costume ?? '').includes('Niqab')) return 'niqab';
  if (attrs.Costume === 'Space Suit') return 'space_suit';
  if (attrs.Makeup === 'Retardio OG') return 'retardio_og';
  if (attrs.Accessories === 'Voodoo Visi') return 'voodoo_visi';
  if (attrs.Hat === 'Yarmulke') return 'yarmulke';
  if (attrs.Hat === 'Retardio First') return 'retardio_first';
  if (attrs.Accessories === 'NEET Chain') return 'neet_chain';
  return null;
}

async function refreshTargets(): Promise<void> {
  const next = new Map<string, Target>();
  let blank = 0;
  for (let page = 1; page < 10; page += 1) {
    const r = await rpc<{ items: any[] }>('getAssetsByGroup', { groupKey: 'collection', groupValue: COLLECTION, page, limit: 1000 });
    for (const it of r.items) {
      let attrs: Record<string, string> = {};
      for (const a of it.content?.metadata?.attributes ?? []) attrs[a.trait_type] = String(a.value);
      if (Object.keys(attrs).length === 0 && jsonAttrCache.has(it.id)) attrs = jsonAttrCache.get(it.id)!;
      if (Object.keys(attrs).length === 0 && it.content?.json_uri) {
        blank += 1; // DAS could not read the pre-reveal json (403 to its fetcher) — read it ourselves
        try {
          const j = (await (await fetch(it.content.json_uri, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })).json()) as any;
          attrs = Object.fromEntries((j.attributes ?? []).map((a: any) => [a.trait_type, String(a.value)]));
          if (Object.keys(attrs).length > 0) jsonAttrCache.set(it.id, attrs);
        } catch { /* stays unknown; retried next refresh */ }
      }
      const c = categorize(attrs);
      if (c) {
        // PDAs precomputed so the hot path does no derivation.
        const [listState] = PublicKey.findProgramAddressSync([Buffer.from('list_state'), new PublicKey(it.id).toBuffer()], TCOMP);
        const [feeVault] = PublicKey.findProgramAddressSync([Buffer.from('fee_vault'), Buffer.from([listState.toBytes()[31]])], FEE_PROGRAM);
        const assetPk = new PublicKey(it.id);
        const [meMetadata] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), TOKEN_METADATA.toBuffer(), assetPk.toBuffer()], TOKEN_METADATA);
        const [meBts] = PublicKey.findProgramAddressSync([Buffer.from('m2'), buyer.publicKey.toBuffer(), ME_AH.toBuffer(), assetPk.toBuffer()], M2);
        next.set(it.id, { category: c, name: String(it.content?.metadata?.name ?? '').trim() || it.id.slice(0, 8), listState, feeVault, meMetadata, meBts });
      }
    }
    if (r.items.length < 1000) break;
  }
  targets = next;
  const by: Record<string, number> = {};
  for (const t of next.values()) by[t.category] = (by[t.category] ?? 0) + 1;
  log({ event: 'targets', total: next.size, by, dasBlankRead: blank });
}

async function loadRoyalty(): Promise<void> {
  // Collection Royalties plugin: every asset defers to it (verified on the minted set).
  const { fetchCollectionV1 } = await import('@metaplex-foundation/mpl-core');
  const { createUmi } = await import('@metaplex-foundation/umi');
  const { web3JsRpc } = await import('@metaplex-foundation/umi-rpc-web3js');
  const { publicKey } = await import('@metaplex-foundation/umi');
  const { toWeb3JsPublicKey } = await import('@metaplex-foundation/umi-web3js-adapters');
  const umi = createUmi().use(web3JsRpc(new Connection(RPC, 'confirmed')));
  const c = await fetchCollectionV1(umi, publicKey(COLLECTION));
  const r = c.royalties;
  royalty = r ? { creators: r.creators.map((x) => toWeb3JsPublicKey(x.address)), bps: r.basisPoints } : { creators: [], bps: 0 };
  log({ event: 'royalty', bps: royalty.bps, creators: royalty.creators.map((c) => c.toBase58()) });
}

// ── blockhash cache ────────────────────────────────────────────────────────────────────────
let blockhash = '';
async function refreshBlockhash(): Promise<void> {
  try { blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; } catch { /* keep last */ }
}

// ── Tensor buy_core ────────────────────────────────────────────────────────────────────────
async function buildTensorBuy(asset: PublicKey, maxPrice: bigint): Promise<{ tx: VersionedTransaction; price: bigint; seller: string } | { skip: string }> {
  const [listState] = PublicKey.findProgramAddressSync([Buffer.from('list_state'), asset.toBuffer()], TCOMP);
  const acc = await conn.getAccountInfo(listState, 'processed');
  if (!acc || !acc.owner.equals(TCOMP)) return { skip: 'list_state_missing' };
  const d = acc.data;
  let o = 10;
  const pk = () => { const p = new PublicKey(d.subarray(o, o + 32)); o += 32; return p; };
  const opt = () => (d[o++] === 1 ? pk() : null);
  const owner = pk(); pk(); // assetId
  const amount = d.readBigUInt64LE(o); o += 8;
  const currency = opt();
  o += 8; // expiry
  const privateTaker = opt();
  const makerBroker = opt();
  const rentPayer = pk();
  const cosigner = pk();
  if (currency) return { skip: 'non_sol_currency' };
  if (!cosigner.equals(PublicKey.default)) return { skip: 'cosigned_listing' };
  if (privateTaker && !privateTaker.equals(buyer.publicKey)) return { skip: 'private_listing' };
  if (amount > maxPrice) return { skip: `price_${Number(amount) / 1e9}_above_max` };

  const [feeVault] = PublicKey.findProgramAddressSync([Buffer.from('fee_vault'), Buffer.from([listState.toBytes()[31]])], FEE_PROGRAM);
  const rentDest = rentPayer.equals(PublicKey.default) ? owner : rentPayer;
  // Omitted optional accounts = the TComp program id, read-only (Tensor client's 'programId' strategy).
  const none = () => ({ pubkey: TCOMP, isSigner: false, isWritable: false });
  const data = Buffer.alloc(16);
  BUY_CORE_DISC.copy(data, 0);
  data.writeBigUInt64LE(amount + (amount * BigInt(royalty.bps) + 9_999n) / 10_000n, 8); // exact price + royalty
  const ix = new TransactionInstruction({
    programId: TCOMP, data,
    keys: [
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: listState, isSigner: false, isWritable: true },
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(COLLECTION), isSigner: false, isWritable: false },
      { pubkey: buyer.publicKey, isSigner: false, isWritable: false },
      { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      none(), // takerBroker
      makerBroker ? { pubkey: makerBroker, isSigner: false, isWritable: true } : none(),
      { pubkey: rentDest, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: TCOMP, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none(), // cosigner
      ...royalty.creators.map((c) => ({ pubkey: c, isSigner: false, isWritable: true })),
    ],
  });
  const tip = SystemProgram.transfer({
    fromPubkey: buyer.publicKey,
    toPubkey: new PublicKey(HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)]!),
    lamports: TIP_LAMPORTS,
  });
  const msg = new TransactionMessage({
    payerKey: buyer.publicKey, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIO_MICROLAMPORTS }),
      ix, tip,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([buyer]);
  return { tx, price: amount, seller: owner.toBase58() };
}


// ── Tensor FAST path: everything from the list_core ix itself, zero RPC ──────────────────
// list_core accounts (tensor-foundation/marketplace idl): 0 asset, 1 collection, 2 listState,
// 3 owner, 4 mplCore, 5 marketplace, 6 system, 7 payer(=rent payer), 8 cosigner(opt)
// args: amount u64, expireInSec Option<u64>, currency Option<Pubkey>, privateTaker Option<Pubkey>,
//       makerBroker Option<Pubkey>

function buildTensorBuyFromListIx(accounts: string[], data: Uint8Array, maxPrice: bigint):
  { tx: VersionedTransaction; price: bigint; seller: string } | { skip: string } {
  const d = Buffer.from(data);
  let o = 8;
  const amount = d.readBigUInt64LE(o); o += 8;
  if (d[o++] === 1) o += 8;                       // expireInSec
  if (d[o++] === 1) return { skip: 'non_sol_currency' };
  let privateTaker: PublicKey | null = null;
  if (d[o++] === 1) { privateTaker = new PublicKey(d.subarray(o, o + 32)); o += 32; }
  let makerBroker: PublicKey | null = null;
  if (d[o++] === 1) { makerBroker = new PublicKey(d.subarray(o, o + 32)); o += 32; }
  if (privateTaker && !privateTaker.equals(buyer.publicKey)) return { skip: 'private_listing' };
  const cosigner = accounts[8];
  if (cosigner && cosigner !== TCOMP.toBase58()) return { skip: 'cosigned_listing' };
  if (amount > maxPrice) return { skip: `price_${Number(amount) / 1e9}_above_max` };
  const asset = accounts[0]!;
  const t = targets.get(asset);
  if (!t || accounts[2] !== t.listState.toBase58()) return { skip: 'list_state_mismatch' };
  const owner = new PublicKey(accounts[3]!);
  const rentDest = new PublicKey(accounts[7] ?? accounts[3]!);
  const none = () => ({ pubkey: TCOMP, isSigner: false, isWritable: false });
  const buf = Buffer.alloc(16);
  BUY_CORE_DISC.copy(buf, 0);
  buf.writeBigUInt64LE(amount + (amount * BigInt(royalty.bps) + 9_999n) / 10_000n, 8);
  const ix = new TransactionInstruction({
    programId: TCOMP, data: buf,
    keys: [
      { pubkey: t.feeVault, isSigner: false, isWritable: true },
      { pubkey: t.listState, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(asset), isSigner: false, isWritable: true },
      { pubkey: COLLECTION_PK, isSigner: false, isWritable: false },
      { pubkey: buyer.publicKey, isSigner: false, isWritable: false },
      { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      none(), // takerBroker
      makerBroker ? { pubkey: makerBroker, isSigner: false, isWritable: true } : none(),
      { pubkey: rentDest, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: TCOMP, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none(), // cosigner
      ...royalty.creators.map((c) => ({ pubkey: c, isSigner: false, isWritable: true })),
    ],
  });
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: buyer.publicKey, recentBlockhash: blockhash,
    instructions: [CU_LIMIT_IX, CU_PRICE_IX, ix, SystemProgram.transfer({
      fromPubkey: buyer.publicKey,
      toPubkey: TIP_ACCOUNTS_PK[Math.floor(Math.random() * TIP_ACCOUNTS_PK.length)]!,
      lamports: TIP_LAMPORTS,
    })],
  }).compileToV0Message());
  tx.sign([buyer]);
  return { tx, price: amount, seller: owner.toBase58() };
}

// ── ME FAST path: BuyV2 + CoreExecuteSaleV2 from the core_sell ix, zero RPC ────────────
// core_sell accounts (m2 idl): 0 payer, 1 wallet(seller), 2 notary, 3 programAsSigner, 4 asset,
// 5 auctionHouse, 6 sellerTradeState, 7 sellerReferral, 8 assetProgram, 9 paymentMint, 10 system, 11 collection
// args: price u64, expiry i64, compressionProof Option<bytes>
const [ME_ESCROW] = PublicKey.findProgramAddressSync([Buffer.from('m2'), ME_AH.toBuffer(), buyer.publicKey.toBuffer()], M2);
const [ME_TREASURY] = PublicKey.findProgramAddressSync([Buffer.from('m2'), ME_AH.toBuffer(), Buffer.from('treasury')], M2);

function buildMeBuyFromCoreSellIx(accounts: string[], data: Uint8Array, maxPrice: bigint):
  { tx: VersionedTransaction; price: bigint } | { skip: string } {
  const d = Buffer.from(data);
  const price = d.readBigUInt64LE(8);
  if (price > maxPrice) return { skip: `price_${Number(price) / 1e9}_above_max` };
  if (accounts[5] !== ME_AH.toBase58()) return { skip: 'me_unknown_auction_house' };
  if (accounts[11] !== COLLECTION) return { skip: 'me_collection_mismatch' };
  const asset = new PublicKey(accounts[4]!);
  const t = targets.get(accounts[4]!);
  if (!t) return { skip: 'me_not_target' };
  const seller = new PublicKey(accounts[1]!);
  const sts = new PublicKey(accounts[6]!);
  const sellerReferral = new PublicKey(accounts[7]!);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

  // BuyV2: buyerPrice, tokenSize=1, buyerStateExpiry=0, buyerCreatorRoyaltyBp=0, extraArgs=empty
  const buyData = Buffer.alloc(8 + 8 + 8 + 8 + 2 + 4);
  BUY_V2_DISC.copy(buyData, 0);
  buyData.writeBigUInt64LE(price, 8);
  buyData.writeBigUInt64LE(1n, 16);
  const buyIx = new TransactionInstruction({ programId: M2, data: buyData, keys: [
    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
    ro(ME_NOTARY), ro(asset), ro(t.meMetadata), w(ME_ESCROW), ro(ME_AH_AUTHORITY), ro(ME_AH),
    w(t.meBts), ro(ME_AH_AUTHORITY), ro(MPL_CORE), ro(SystemProgram.programId),
  ] });
  // CoreExecuteSaleV2: price, makerFeeBp=0, takerFeeBp=0 (AH config applies), compressionProof=None
  const execData = Buffer.alloc(8 + 8 + 2 + 2 + 1);
  CORE_EXEC_V2_DISC.copy(execData, 0);
  execData.writeBigUInt64LE(price, 8);
  const execIx = new TransactionInstruction({ programId: M2, data: execData, keys: [
    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
    w(buyer.publicKey), w(seller), ro(ME_NOTARY), ro(ME_PROGRAM_AS_SIGNER), w(asset), ro(ME_AH),
    w(ME_TREASURY), w(sts), w(t.meBts), w(ME_ESCROW), ro(ME_AH_AUTHORITY), ro(sellerReferral),
    ro(MPL_CORE), ro(SystemProgram.programId), ro(COLLECTION_PK),
    // SOL payment: paymentMint + 3 payment token accounts = system program, paymentTokenProgram = Token
    ro(SystemProgram.programId), ro(SystemProgram.programId), ro(SystemProgram.programId), ro(SystemProgram.programId),
    ro(TOKEN_PROGRAM),
    ...royalty.creators.map(w),
  ] });
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: buyer.publicKey, recentBlockhash: blockhash,
    instructions: [ME_CU_LIMIT_IX, ME_CU_PRICE_IX, buyIx,
      // BuyV2 only escrows `price`; CoreExecuteSaleV2 also pulls taker fee + royalty from the escrow.
      SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: ME_ESCROW,
        lamports: (price * (ME_TAKER_FEE_BP + BigInt(royalty.bps)) + 9_999n) / 10_000n }),
      execIx, SystemProgram.transfer({
      fromPubkey: buyer.publicKey,
      toPubkey: TIP_ACCOUNTS_PK[Math.floor(Math.random() * TIP_ACCOUNTS_PK.length)]!,
      lamports: TIP_LAMPORTS,
    })],
  }).compileToV0Message());
  tx.sign([buyer]);
  return { tx, price };
}

// ── ME buy_now (fallback: non-core_sell list ix) ─────────────────────────────────────────────────────────────────────────────
async function buildMeBuy(a: ListingAction): Promise<{ tx: VersionedTransaction; price: bigint } | { skip: string }> {
  if (!a.auctionHouse || !a.tokenAccount || a.priceLamports == null) return { skip: 'me_listing_fields_missing' };
  const u = new URL('https://api-mainnet.magiceden.dev/v2/instructions/buy_now');
  u.searchParams.set('buyer', buyer.publicKey.toBase58());
  u.searchParams.set('seller', a.seller);
  u.searchParams.set('auctionHouseAddress', a.auctionHouse);
  u.searchParams.set('tokenMint', a.mint!);
  u.searchParams.set('tokenATA', a.tokenAccount);
  u.searchParams.set('price', String(a.priceLamports / 1e9));
  u.searchParams.set('buyerExpiry', '-1');
  u.searchParams.set('prioFeeMicroLamports', String(PRIO_MICROLAMPORTS));
  const r = await fetch(u, { headers: { Authorization: `Bearer ${ME_API_KEY}` }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) return { skip: `me_buy_now_${r.status}` };
  const j = (await r.json()) as any;
  const f = j.v0?.txSigned ?? j.txSigned ?? j.v0?.tx ?? j.tx;
  const bytes = f?.data ? Buffer.from(f.data) : typeof f === 'string' ? Buffer.from(f, 'base64') : null;
  if (!bytes) return { skip: 'me_tx_unparseable' };
  const tx = VersionedTransaction.deserialize(bytes);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  if (!keys.includes(a.mint!)) return { skip: 'me_tx_missing_mint' };
  const need = tx.message.header.numRequiredSignatures;
  const buyerIdx = keys.indexOf(buyer.publicKey.toBase58());
  if (buyerIdx < 0 || buyerIdx >= need) return { skip: 'me_tx_buyer_not_signer' };
  tx.sign([buyer]);
  return { tx, price: BigInt(a.priceLamports) };
}

// ── send ───────────────────────────────────────────────────────────────────────────────────
async function send(tx: VersionedTransaction, viaSender: boolean): Promise<string> {
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  const body = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'sendTransaction',
    params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
  const sends = [fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(1) })];
  if (viaSender) for (const url of SENDERS) sends.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(2) }));
  await Promise.allSettled(sends);
  return bs58.encode(tx.signatures[0]!);
}

// ── follow-up: who actually bought, how many slots after the listing ──────────────────────
async function followUp(mint: string, listSlot: number, listSig: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 20_000));
  try {
    const sigs = await rpc<any[]>('getSignaturesForAddress', [mint, { limit: 5, commitment: 'confirmed' }]);
    const after = sigs.filter((s) => s.signature !== listSig && s.slot >= listSlot && !s.err).sort((a, b) => a.slot - b.slot)[0];
    if (!after) { log({ event: 'followup', mint, result: 'still_listed_or_unknown' }); return; }
    const t = await rpc<any>('getTransaction', [after.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    const logs: string[] = t?.meta?.logMessages ?? [];
    const kind = txHasSale(logs) ? 'bought' : 'other';
    const signer = t?.transaction?.message?.accountKeys?.[0] ?? '?';
    log({ event: 'followup', mint, kind, byUs: signer === buyer.publicKey.toBase58(), signer, slotsAfterList: after.slot - listSlot, sig: after.signature });
  } catch (e) { log({ event: 'followup_error', mint, error: String(e) }); }
}

// ── stream ─────────────────────────────────────────────────────────────────────────────────
let spentLamports = 0n;
/** Latest slot seen via slotSubscribe — detection lag = tipSlot - tx slot at receive time. */
let tipSlot = 0;
const lagSamples: number[] = [];
const handled = new Set<string>();

async function onListing(a: ListingAction, slot: number, sig: string, recvAt: number, raw: { accounts: string[]; data: Uint8Array } | null, lagAtRecv: number): Promise<void> {
  if (a.kind !== 'list' || !a.mint || a.priceLamports == null) return;
  const t = targets.get(a.mint);
  if (!t) return;
  const max = MAX_PRICE_LAMPORTS[t.category];
  const priceSol = a.priceLamports / 1e9;
  if (a.priceLamports > max) { log({ event: 'seen_above_max', mp: a.marketplace, mint: a.mint, name: t.name, category: t.category, priceSol }); return; }
  const key = `${a.mint}:${sig}`;
  if (handled.has(key)) return;
  handled.add(key);
  if (spentLamports + BigInt(a.priceLamports) > BigInt(Math.round(MAX_SPEND_SOL * 1e9))) {
    log({ event: 'skip_budget', mint: a.mint, priceSol, spentSol: Number(spentLamports) / 1e9 }); return;
  }
  const fastTensor = a.marketplace === 'TENSOR' && a.ix === 'list_core' && raw !== null;
  const fastMe = a.marketplace === 'ME' && a.ix === 'core_sell' && raw !== null;
  const fast = fastTensor || fastMe;
  const built = fastTensor
    ? buildTensorBuyFromListIx(raw!.accounts, raw!.data, BigInt(max))
    : fastMe
      ? buildMeBuyFromCoreSellIx(raw!.accounts, raw!.data, BigInt(max))
    : a.marketplace === 'TENSOR'
      ? await buildTensorBuy(new PublicKey(a.mint), BigInt(max))
      : await buildMeBuy(a);
  const buildMs = Date.now() - recvAt;
  if ('skip' in built) { log({ event: 'skip', reason: built.skip, mp: a.marketplace, mint: a.mint, name: t.name, category: t.category, priceSol, buildMs }); void followUp(a.mint, slot, sig); return; }
  const currentSlot = tipSlot; // local, no RPC on the hot path
  if (!LIVE) {
    const sim = await conn.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }).catch((e) => ({ value: { err: String(e), logs: [] as string[] } }));
    log({ event: 'WOULD_BUY', mp: a.marketplace, path: fast ? 'fast' : 'sender', lagAtRecv, mint: a.mint, name: t.name, category: t.category, priceSol,
      listSlot: slot, slotAtDecision: currentSlot, slotsBehind: currentSlot - slot, buildMs,
      sim: sim.value.err ? `err ${JSON.stringify(sim.value.err)}` : 'ok' });
    void followUp(a.mint, slot, sig);
    return;
  }
  spentLamports += built.price;
  // Always fan out through Helius Sender (fra/ams/lon/ewr), not just for Tensor. ME buys
  // carry a priority fee from the buy_now API but were previously sent via a single plain
  // RPC POST, landing 1-2 slots later than the Sender lane used for the mint.
  const buySig = await send(built.tx, true);
  log({ event: 'BUY_SENT', mp: a.marketplace, path: fast ? 'fast' : 'sender', mint: a.mint, name: t.name, category: t.category, priceSol, listSlot: slot, lagAtRecv, slotAtSend: currentSlot, buildMs, buySig });
  void followUp(a.mint, slot, sig);
}

function startStream(): void {
  const ws = new WebSocket(WSS);
  let lastMsg = Date.now();
  const ping = setInterval(() => {
    if (Date.now() - lastMsg > 120_000) { log({ event: 'ws_stale_reconnect' }); ws.terminate(); return; }
    try { ws.ping(); } catch { /* close handler reconnects */ }
  }, 30_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [
      { accountInclude: [COLLECTION], failed: false, vote: false },
      { commitment: 'processed', encoding: 'base64', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 },
    ] }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slotSubscribe', params: [] }));
    log({ event: 'ws_subscribed', collection: COLLECTION });
  });
  ws.on('message', (raw: WebSocket.RawData) => {
    lastMsg = Date.now();
    const recvAt = Date.now();
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === 'slotNotification') { tipSlot = Math.max(tipSlot, m.params?.result?.slot ?? 0); return; }
    const r = m.params?.result;
    if (!r) return;
    const lagAtRecv = tipSlot ? tipSlot - r.slot : -1;
    if (lagAtRecv >= 0) { lagSamples.push(lagAtRecv); if (lagSamples.length > 500) lagSamples.shift(); }
    const meta = r.transaction?.meta;
    const b64 = r.transaction?.transaction?.[0];
    if (!b64 || meta?.err) return;
    if (txHasSale(meta?.logMessages ?? [])) return;
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
      const keys = [...tx.message.staticAccountKeys.map((k) => k.toBase58()),
        ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
      const acts: { a: ListingAction; raw: { accounts: string[]; data: Uint8Array } }[] = [];
      for (const ix of tx.message.compiledInstructions) {
        const accounts = ix.accountKeyIndexes.map((i) => keys[i]!);
        const a = decodeIx(keys[ix.programIdIndex]!, accounts, ix.data);
        if (a) acts.push({ a, raw: { accounts, data: ix.data } });
      }
      for (const inner of meta.innerInstructions ?? []) for (const ix of inner.instructions ?? []) {
        const accounts = (ix.accounts ?? []).map((i: number) => keys[i]!);
        const data = bs58.decode(ix.data);
        const a = decodeIx(keys[ix.programIdIndex]!, accounts, data);
        if (a) acts.push({ a, raw: { accounts, data } });
      }
      for (const { a, raw } of acts) void onListing(a, r.slot, r.signature, recvAt, raw, lagAtRecv).catch((e) => log({ event: 'handler_error', error: String(e) }));
    } catch { /* not a tx we decode */ }
  });
  ws.on('close', () => { clearInterval(ping); log({ event: 'ws_closed_reconnect' }); setTimeout(startStream, 2_000); });
  ws.on('error', (e) => log({ event: 'ws_error', error: e.message }));
}

/** SNIPER_SELFTEST_SIG=<ME core_sell tx sig>: build the local ME buy from that listing and simulate. Never sends. */
async function selftest(sig: string): Promise<void> {
  await Promise.all([loadRoyalty(), refreshBlockhash()]);
  const t = await rpc<any>('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const tx = VersionedTransaction.deserialize(Buffer.from(t.transaction[0], 'base64'));
  const keys = [...tx.message.staticAccountKeys.map((k) => k.toBase58()), ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  for (const ix of tx.message.compiledInstructions) {
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]!);
    const a = decodeIx(keys[ix.programIdIndex]!, accounts, ix.data);
    if (!a || a.ix !== 'core_sell') continue;
    const assetPk = new PublicKey(accounts[4]!);
    targets.set(accounts[4]!, { category: 'niqab', name: 'selftest', listState: PublicKey.default, feeVault: PublicKey.default,
      meMetadata: PublicKey.findProgramAddressSync([Buffer.from('metadata'), TOKEN_METADATA.toBuffer(), assetPk.toBuffer()], TOKEN_METADATA)[0],
      meBts: PublicKey.findProgramAddressSync([Buffer.from('m2'), buyer.publicKey.toBuffer(), ME_AH.toBuffer(), assetPk.toBuffer()], M2)[0] });
    const t0 = performance.now();
    const built = buildMeBuyFromCoreSellIx(accounts, ix.data, 10n ** 12n);
    const buildMs = performance.now() - t0;
    if ('skip' in built) { console.log('skip', built.skip); return; }
    const sim = await conn.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
    console.log(JSON.stringify({ asset: accounts[4], priceSol: Number(built.price) / 1e9, buildMs: +buildMs.toFixed(2), size: built.tx.serialize().length,
      err: sim.value.err, cu: sim.value.unitsConsumed }));
    console.log((sim.value.logs ?? []).filter((l) => !l.includes('consumed')).join('\n'));
    return;
  }
  console.log('no core_sell ix in', sig);
}

async function main(): Promise<void> {
  if (process.env.SNIPER_SELFTEST_SIG) { await selftest(process.env.SNIPER_SELFTEST_SIG); process.exit(0); }
  log({ event: 'start', live: LIVE, buyer: buyer.publicKey.toBase58(), maxSpendSol: MAX_SPEND_SOL,
    prioSolPerTx: (PRIO_MICROLAMPORTS * 80_000) / 1e15, tipSol: TIP_LAMPORTS / 1e9, rules: MAX_PRICE_LAMPORTS });
  await Promise.all([refreshTargets(), loadRoyalty(), refreshBlockhash()]);
  setInterval(() => void refreshBlockhash(), 2_000);
  setInterval(() => void refreshTargets().catch((e) => log({ event: 'targets_error', error: String(e) })), 10 * 60_000);
  startStream();
  setInterval(() => {
    if (lagSamples.length === 0) return;
    const sorted = [...lagSamples].sort((x, y) => x - y);
    log({ event: 'detect_lag_slots', n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) });
  }, 10 * 60_000);
}

/** Test hook: register one target without the full DAS refresh. */
export function primeTarget(assetId: string, category: Category): void {
  const [listState] = PublicKey.findProgramAddressSync([Buffer.from('list_state'), new PublicKey(assetId).toBuffer()], TCOMP);
  const [feeVault] = PublicKey.findProgramAddressSync([Buffer.from('fee_vault'), Buffer.from([listState.toBytes()[31]])], FEE_PROGRAM);
  targets.set(assetId, { category, name: 'test', listState, feeVault });
}
export { buildTensorBuyFromListIx, loadRoyalty, refreshBlockhash, buyer };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
