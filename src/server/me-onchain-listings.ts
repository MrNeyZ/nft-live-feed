// On-chain ME (M2) listing snapshot for one collection.
//
//   which NFTs are listed  DAS searchAssets owner=ME escrow (1BWutm…) +
//                          collection/creator — ghost-free: an NFT only sits
//                          in the escrow while its listing is live.
//   price / seller         SellerTradeStateV2 account, read in bulk via
//                          getMultipleAccounts (1 credit / 100).
//   mint → STS address     me_listing_sts (memory + Postgres). Learned from
//                          ME /listings rows, the listing stream, or — for
//                          whatever is still missing — one getProgramAccounts
//                          per mint in the background, behind its own limiter
//                          so it can't eat the shared Helius gPA budget.
//
// The ME API is only a seller hint here; prices always come from chain.

import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { getPool } from '../db/client';
import { rpcPost } from './tools-mmm-pools';
import { slugDasGroup } from '../ingestion/listing-stream/collection-resolver';

export const ME_ESCROW = '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix';
const M2 = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const accountDisc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const STS_V2_DISC = accountDisc('SellerTradeStateV2');
const STS_V2_LEN = 384;
// Pre-V2 listings (years old, usually far above floor) are still live while
// the NFT sits in escrow. Same field layout up to `expiry`, no paymentMint.
const STS_V1_DISC = accountDisc('SellerTradeState');
const STS_V1_LEN = 193;
const SYSTEM = '11111111111111111111111111111111';

const DAS_PAGE = 1000;
const DAS_MAX_PAGES = 5;
const GMA_BATCH = 100;
// gPA lane: Helius Developer = 25 req/s shared by every service on the key.
const GPA_PER_SEC = 5;

export interface OnchainMeListing {
  mint:         string;
  seller:       string;
  priceSol:     number;
  auctionHouse: string;
  tokenAccount: string;
  nftName:      string | null;
  imageUrl:     string | null;
}

// ─── mint → STS cache ────────────────────────────────────────────────────────

const stsByMint = new Map<string, string>();
const dbChecked = new Set<string>();
const pendingWrites = new Map<string, { sts: string; seller: string }>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function deriveSts(seller: string, auctionHouse: string, tokenAccount: string, mint: string): string | null {
  try {
    return PublicKey.findProgramAddressSync([
      Buffer.from('m2'),
      new PublicKey(seller).toBuffer(),
      new PublicKey(auctionHouse).toBuffer(),
      new PublicKey(tokenAccount).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ], M2)[0].toBase58();
  } catch {
    return null;
  }
}

function remember(mint: string, sts: string, seller: string): void {
  if (stsByMint.get(mint) === sts) return;
  stsByMint.set(mint, sts);
  pendingWrites.set(mint, { sts, seller });
  writeTimer ??= setTimeout(() => { writeTimer = null; void flushWrites(); }, 2_000);
}

async function flushWrites(): Promise<void> {
  const rows = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  if (!rows.length) return;
  try {
    await getPool().query(
      `INSERT INTO me_listing_sts (mint, sts, seller, updated_at)
       SELECT * , NOW() FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (mint) DO UPDATE SET sts = EXCLUDED.sts, seller = EXCLUDED.seller, updated_at = NOW()`,
      [rows.map(r => r[0]), rows.map(r => r[1].sts), rows.map(r => r[1].seller)],
    );
  } catch (err) {
    console.warn('[me-onchain] sts cache write failed', (err as Error).message);
  }
}

async function loadFromDb(mints: string[]): Promise<void> {
  const need = mints.filter(m => !stsByMint.has(m) && !dbChecked.has(m));
  if (!need.length) return;
  try {
    const { rows } = await getPool().query<{ mint: string; sts: string }>(
      'SELECT mint, sts FROM me_listing_sts WHERE mint = ANY($1)', [need]);
    for (const r of rows) stsByMint.set(r.mint, r.sts);
    for (const m of need) dbChecked.add(m);
  } catch (err) {
    console.warn('[me-onchain] sts cache read failed', (err as Error).message);
  }
}

/** Seller hint from any source that knows (seller, AH, token account). */
export function rememberMeSeller(mint: string, seller: string, auctionHouse: string, tokenAccount: string): void {
  const sts = deriveSts(seller, auctionHouse, tokenAccount, mint);
  if (sts) remember(mint, sts, seller);
}

// ─── STS decode ──────────────────────────────────────────────────────────────

interface Sts {
  auctionHouse: string;
  seller:       string;
  priceLamports: bigint;
  mint:         string;
  tokenAccount: string;
}

function decodeSts(d: Buffer): Sts | null {
  const v2 = d.length === STS_V2_LEN && d.subarray(0, 8).equals(STS_V2_DISC);
  const v1 = d.length === STS_V1_LEN && d.subarray(0, 8).equals(STS_V1_DISC);
  if (!v2 && !v1) return null;                         // BuyerTradeState (bids) share the mint offset
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
  const expiry = d.readBigInt64LE(185);
  if (expiry > 0n && expiry < BigInt(Math.floor(Date.now() / 1000))) return null;
  if (v2 && pk(193) !== SYSTEM) return null;           // SOL-priced only
  return {
    auctionHouse:  pk(8),
    seller:        pk(40),
    priceLamports: d.readBigUInt64LE(104),
    mint:          pk(112),
    tokenAccount:  pk(144),
  };
}

// ─── gPA fallback lane ───────────────────────────────────────────────────────

const gpaQueue: Array<{ mint: string; done: (found: boolean) => void; tries: number }> = [];
const GPA_MAX_TRIES = 3;
const gpaQueued = new Set<string>();
let gpaTimer: ReturnType<typeof setInterval> | null = null;
export const onchainStats = { das: 0, gma: 0, gpa: 0, gpaFound: 0, gpaRetry: 0, hintHits: 0 };

function queueGpa(mint: string, done: (found: boolean) => void): void {
  if (gpaQueued.has(mint)) return;
  gpaQueued.add(mint);
  gpaQueue.push({ mint, done, tries: 0 });
  gpaTimer ??= setInterval(drainGpa, Math.ceil(1000 / GPA_PER_SEC));
}

function drainGpa(): void {
  const job = gpaQueue.shift();
  if (!job) { clearInterval(gpaTimer!); gpaTimer = null; return; }
  onchainStats.gpa++;
  void (async () => {
    let found = false;
    try {
      const res = await rpcPost('getProgramAccounts', [M2.toBase58(), {
        encoding: 'base64',
        // memcmp only — adding dataSize made Helius answer "account index
        // service overloaded" for ~25% of calls; size is checked in decodeSts.
        filters: [{ memcmp: { offset: 112, bytes: job.mint } }],
      }]) as Array<{ pubkey: string; account: { data: [string, string] } }>;
      for (const a of res ?? []) {
        const s = decodeSts(Buffer.from(a.account.data[0], 'base64'));
        // The live listing is the one whose token account ME's escrow holds;
        // with a single V2 state per mint (the norm) that's just it.
        if (s && s.mint === job.mint) { remember(job.mint, a.pubkey, s.seller); found = true; }
      }
    } catch (err) {
      // Transient (Helius "overloaded" / 429): back of the queue, bounded.
      if (++job.tries < GPA_MAX_TRIES) {
        onchainStats.gpaRetry++;
        gpaQueue.push(job);
        gpaTimer ??= setInterval(drainGpa, Math.ceil(1000 / GPA_PER_SEC));
        return;
      }
      console.warn(`[me-onchain] gPA gave up mint=${job.mint.slice(0, 8)}`, (err as Error).message.slice(0, 80));
    }
    gpaQueued.delete(job.mint);
    if (found) onchainStats.gpaFound++;
    job.done(found);
  })();
}

// ─── DAS ─────────────────────────────────────────────────────────────────────

interface DasItem {
  id: string;
  burnt?: boolean;
  content?: { metadata?: { name?: string }; links?: { image?: string }; files?: Array<{ uri?: string; cdn_uri?: string }> };
}

async function das<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'me-onchain', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json() as { result?: T; error?: { message?: string } };
  if (json.error || !json.result) throw new Error(`${method}: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json.result;
}

async function escrowedAssets(slug: string): Promise<DasItem[] | null> {
  if (!process.env.HELIUS_API_KEY) return null;
  const group = await slugDasGroup(slug);
  if (!group) return null;
  const base: Record<string, unknown> = 'collection' in group
    ? { ownerAddress: ME_ESCROW, grouping: ['collection', group.collection] }
    : { ownerAddress: ME_ESCROW, creatorAddress: group.creator, creatorVerified: true };
  const out: DasItem[] = [];
  for (let page = 1; page <= DAS_MAX_PAGES; page++) {
    onchainStats.das++;
    const r = await das<{ items?: DasItem[] }>('searchAssets', { ...base, page, limit: DAS_PAGE });
    const items = r.items ?? [];
    out.push(...items.filter(i => !i.burnt));
    if (items.length < DAS_PAGE) break;
  }
  return out;
}

async function readStsBatch(addrs: string[]): Promise<Map<string, Sts>> {
  const out = new Map<string, Sts>();
  for (let i = 0; i < addrs.length; i += GMA_BATCH) {
    const chunk = addrs.slice(i, i + GMA_BATCH);
    onchainStats.gma++;
    const r = await rpcPost('getMultipleAccounts', [chunk, { encoding: 'base64' }]) as
      { value: Array<{ data: [string, string]; owner: string } | null> };
    chunk.forEach((addr, j) => {
      const acc = r.value[j];
      if (!acc || acc.owner !== M2.toBase58()) return;
      const s = decodeSts(Buffer.from(acc.data[0], 'base64'));
      if (s) out.set(addr, s);
    });
  }
  return out;
}

// ─── Public ──────────────────────────────────────────────────────────────────

export interface SellerHint { mint: string; seller: string; auctionHouse: string; tokenAta: string }

const HINT_WAIT_MS = 1_500;
const LATE_FLUSH_MS = 2_000;

function toRow(mint: string, s: Sts, it: DasItem | undefined): OnchainMeListing {
  return {
    mint,
    seller:       s.seller,
    priceSol:     Number(s.priceLamports) / 1e9,
    auctionHouse: s.auctionHouse,
    tokenAccount: s.tokenAccount,
    nftName:      it?.content?.metadata?.name ?? null,
    imageUrl:     it?.content?.links?.image ?? it?.content?.files?.[0]?.uri ?? null,
  };
}

/** Price `mints` from their cached STS. Returns rows + mints that still
 *  need a seller (unknown, closed, or re-used by another listing). */
async function priceMints(mints: string[], meta: Map<string, DasItem>): Promise<{ rows: OnchainMeListing[]; missing: string[] }> {
  const known = mints.filter(m => stsByMint.has(m));
  const states = await readStsBatch(known.map(m => stsByMint.get(m)!));
  const rows: OnchainMeListing[] = [];
  const missing = mints.filter(m => !stsByMint.has(m));
  for (const mint of known) {
    const s = states.get(stsByMint.get(mint)!);
    if (!s || s.mint !== mint) { stsByMint.delete(mint); missing.push(mint); continue; }
    rows.push(toRow(mint, s, meta.get(mint)));
  }
  return { rows, missing };
}

/**
 * Live ME listings for `slug`, straight from chain. `hints` = ME API rows,
 * used only to learn sellers; awaited at most HINT_WAIT_MS (ME may be slow
 * or rate-limited). Anything resolved later — late hints or background gPA —
 * is read and handed to `onLate` in ~2 s batches for the caller to merge.
 * Returns null when the collection can't be addressed via DAS.
 */
export async function snapshotMeOnchain(
  slug: string,
  hints: Promise<SellerHint[] | null>,
  onLate: (rows: OnchainMeListing[]) => void,
): Promise<OnchainMeListing[] | null> {
  let hintsDone = false;
  const hintsSettled = hints.catch(() => null).finally(() => { hintsDone = true; });
  const items = await escrowedAssets(slug);
  if (!items) return null;
  const meta = new Map(items.map(i => [i.id, i]));
  const mints = items.map(i => i.id);

  const applyHints = (hs: SellerHint[] | null): void => {
    for (const h of hs ?? []) {
      if (!meta.has(h.mint) || !h.auctionHouse || !h.tokenAta) continue;
      if (!stsByMint.has(h.mint)) onchainStats.hintHits++;
      rememberMeSeller(h.mint, h.seller, h.auctionHouse, h.tokenAta);
    }
  };
  await loadFromDb(mints);
  // Only wait on ME when the cache can't price everything by itself.
  if (mints.some(m => !stsByMint.has(m))) {
    await Promise.race([hintsSettled, new Promise(r => setTimeout(r, HINT_WAIT_MS))]);
  }
  if (hintsDone) applyHints(await hintsSettled);
  const { rows, missing } = await priceMints(mints, meta);

  // Late path: collect newly resolved mints, read just those, hand them over.
  const resolved = new Set<string>();
  let lateTimer: ReturnType<typeof setTimeout> | null = null;
  const flushLate = async (): Promise<void> => {
    lateTimer = null;
    const batch = Array.from(resolved); resolved.clear();
    try {
      const { rows: late } = await priceMints(batch, meta);
      if (late.length) onLate(late);
    } catch (err) {
      console.warn(`[me-onchain] late read failed slug=${slug}`, (err as Error).message);
    }
  };
  const markResolved = (mint: string): void => {
    resolved.add(mint);
    lateTimer ??= setTimeout(() => void flushLate(), LATE_FLUSH_MS);
  };

  const stillMissing = new Set(missing);
  if (!hintsDone && stillMissing.size) {
    // Give ME a head start on the stragglers before spending gPA on them.
    void hintsSettled.then(hs => {
      applyHints(hs);
      for (const m of Array.from(stillMissing)) if (stsByMint.has(m)) { stillMissing.delete(m); markResolved(m); }
      for (const m of stillMissing) queueGpa(m, found => { if (found) markResolved(m); });
    });
  } else {
    for (const m of stillMissing) queueGpa(m, found => { if (found) markResolved(m); });
  }
  console.log(`[me-onchain] slug=${slug} escrowed=${mints.length} priced=${rows.length} missing=${missing.length} hints=${hintsDone ? 'in-time' : 'late'}`);
  return rows;
}

/** Background gPA lookups still queued (all slugs). */
export function gpaBacklog(): number { return gpaQueue.length; }
