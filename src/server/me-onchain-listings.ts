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
  /** Latest list / reprice time of this STS (ms), null until resolved. */
  listedAt:     number | null;
}

// ─── mint → STS cache ────────────────────────────────────────────────────────

const stsByMint = new Map<string, string>();
const dbChecked = new Set<string>();
const pendingWrites = new Map<string, { sts: string; seller: string }>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** STS → listing time (ms). Keyed by STS, not mint: a relist by another
 *  seller is a new STS and must not inherit the old time. */
const listedAtBySts = new Map<string, number>();
const pendingListedAt = new Map<string, number>();
const scheduleWrite = (): void => {
  writeTimer ??= setTimeout(() => { writeTimer = null; void flushWrites(); }, 2_000);
};

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

function remember(mint: string, sts: string, seller: string, listedAtMs?: number): void {
  // Stream time only seeds an unknown STS: a later tx on a known one is a
  // reprice, and the row's age is from the listing's start (ME semantics).
  if (listedAtMs != null && !listedAtBySts.has(sts)) setListedAt(sts, listedAtMs);
  if (stsByMint.get(mint) === sts) return;
  stsByMint.set(mint, sts);
  pendingWrites.set(mint, { sts, seller });
  scheduleWrite();
}

function setListedAt(sts: string, ms: number): void {
  if (listedAtBySts.get(sts) === ms) return;
  listedAtBySts.set(sts, ms);
  pendingListedAt.set(sts, ms);
  scheduleWrite();
}

async function flushWrites(): Promise<void> {
  const rows = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  if (rows.length) try {
    await getPool().query(
      `INSERT INTO me_listing_sts (mint, sts, seller, updated_at)
       SELECT * , NOW() FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (mint) DO UPDATE SET sts = EXCLUDED.sts, seller = EXCLUDED.seller, updated_at = NOW()`,
      [rows.map(r => r[0]), rows.map(r => r[1].sts), rows.map(r => r[1].seller)],
    );
  } catch (err) {
    console.warn('[me-onchain] sts cache write failed', (err as Error).message);
  }
  // Runs after the upsert above so a same-flush new row already exists.
  const times = Array.from(pendingListedAt.entries());
  pendingListedAt.clear();
  if (!times.length) return;
  try {
    await getPool().query(
      `UPDATE me_listing_sts t SET listed_at_ms = u.ms
         FROM UNNEST($1::text[], $2::bigint[]) AS u(sts, ms)
        WHERE t.sts = u.sts`,
      [times.map(t => t[0]), times.map(t => t[1])],
    );
  } catch (err) {
    console.warn('[me-onchain] listed_at write failed', (err as Error).message);
  }
}

async function loadFromDb(mints: string[]): Promise<void> {
  const need = mints.filter(m => !stsByMint.has(m) && !dbChecked.has(m));
  if (!need.length) return;
  try {
    const { rows } = await getPool().query<{ mint: string; sts: string; listed_at_ms: string | null }>(
      'SELECT mint, sts, listed_at_ms FROM me_listing_sts WHERE mint = ANY($1)', [need]);
    for (const r of rows) {
      stsByMint.set(r.mint, r.sts);
      if (r.listed_at_ms != null && !listedAtBySts.has(r.sts)) listedAtBySts.set(r.sts, Number(r.listed_at_ms));
    }
    for (const m of need) dbChecked.add(m);
  } catch (err) {
    console.warn('[me-onchain] sts cache read failed', (err as Error).message);
  }
}

/** Seller hint from any source that knows (seller, AH, token account).
 *  `listedAtMs` only from the listing stream (the list / reprice itself). */
export function rememberMeSeller(mint: string, seller: string, auctionHouse: string, tokenAccount: string, listedAtMs?: number): void {
  const sts = deriveSts(seller, auctionHouse, tokenAccount, mint);
  if (sts) remember(mint, sts, seller, listedAtMs);
}

/** Listing cancelled: its STS closes, and a relist by the same seller
 *  re-creates the SAME address — drop the cached start time. */
export function forgetMeListingTime(mint: string): void {
  const sts = stsByMint.get(mint);
  if (sts) { listedAtBySts.delete(sts); pendingListedAt.delete(sts); }
}

// ─── listing-time lane ───────────────────────────────────────────────────────
// Listing start = OLDEST successful tx on the STS: the account is created by
// the list and closed by a sale / cancel, while bots reprice (another sell
// ix on the same STS) as often as every ~18 min — so newest ≠ listed. Failed
// buy attempts also touch it, hence the err filter. One
// getSignaturesForAddress (1 credit, standard lane, up to 1000 sigs) per STS,
// once — persisted. If an STS has >1000 txs the oldest of that page is used
// (a lower bound on age). Own limiter so it never crowds other RPC users.

const TIME_PER_SEC = 10;
const timeQueue: Array<{ sts: string; done: () => void }> = [];
const timeQueued = new Set<string>();
let timeTimer: ReturnType<typeof setInterval> | null = null;

function queueListedAt(sts: string, done: () => void): void {
  if (listedAtBySts.has(sts) || timeQueued.has(sts)) return;
  timeQueued.add(sts);
  timeQueue.push({ sts, done });
  timeTimer ??= setInterval(drainTime, Math.ceil(1000 / TIME_PER_SEC));
}

function drainTime(): void {
  const job = timeQueue.shift();
  if (!job) { clearInterval(timeTimer!); timeTimer = null; return; }
  onchainStats.sigs++;
  void (async () => {
    try {
      const sigs = await rpcPost('getSignaturesForAddress', [job.sts, { limit: 1000 }]) as
        Array<{ err: unknown; blockTime: number | null }>;
      const ok = (sigs ?? []).slice().reverse().find(x => x.err == null && x.blockTime != null);
      if (ok) { setListedAt(job.sts, ok.blockTime! * 1000); job.done(); }
    } catch (err) {
      console.warn(`[me-onchain] listedAt lookup failed sts=${job.sts.slice(0, 8)}`, (err as Error).message.slice(0, 80));
    } finally {
      timeQueued.delete(job.sts);
    }
  })();
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
export const onchainStats = { das: 0, gma: 0, gpa: 0, gpaFound: 0, gpaRetry: 0, hintHits: 0, sigs: 0 };

// A big cold collection can miss thousands of sellers (ponk: 2.5k). Cap the
// backlog; the rest are retried by later snapshots or learned from the
// listing stream / ME hints meanwhile. 600 ≈ 2 min at 5/s, ≈ 6k credits.
const GPA_QUEUE_MAX = 600;

function queueGpa(mint: string, done: (found: boolean) => void): void {
  if (gpaQueued.has(mint) || gpaQueue.length >= GPA_QUEUE_MAX) return;
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

/** Escrowed assets of `slug`: page 1 awaited, pages 2+ (big collections —
 *  ponk has ~3.9k listings, 4 s per page on ME's huge escrow owner) fetched
 *  in parallel in the background so they never hold the first paint. */
async function escrowedAssets(slug: string): Promise<{ first: DasItem[]; rest: Promise<DasItem[]> | null } | null> {
  if (!process.env.HELIUS_API_KEY) return null;
  const group = await slugDasGroup(slug);
  if (!group) return null;
  const base: Record<string, unknown> = 'collection' in group
    ? { ownerAddress: ME_ESCROW, grouping: ['collection', group.collection] }
    : { ownerAddress: ME_ESCROW, creatorAddress: group.creator, creatorVerified: true };
  const page = async (n: number): Promise<DasItem[]> => {
    onchainStats.das++;
    const r = await das<{ items?: DasItem[] }>('searchAssets', { ...base, page: n, limit: DAS_PAGE });
    return r.items ?? [];
  };
  const p1 = await page(1);
  const first = p1.filter(i => !i.burnt);
  if (p1.length < DAS_PAGE) return { first, rest: null };
  const known = lastPageCount.get(slug) ?? DAS_MAX_PAGES;
  const rest = Promise.all(Array.from({ length: Math.max(1, known - 1) }, (_, i) => page(i + 2)))
    .then(async pages => {
      let n = 1 + pages.length;
      // Last page still full → the collection grew past our estimate.
      while (pages[pages.length - 1].length === DAS_PAGE && n < DAS_MAX_PAGES) pages.push(await page(++n));
      lastPageCount.set(slug, 1 + pages.filter(p => p.length > 0).length);
      return pages.flat().filter(i => !i.burnt);
    });
  return { first, rest };
}
const lastPageCount = new Map<string, number>();

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

function toRow(mint: string, sts: string, s: Sts, it: DasItem | undefined): OnchainMeListing {
  return {
    listedAt:     listedAtBySts.get(sts) ?? null,
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
    rows.push(toRow(mint, stsByMint.get(mint)!, s, meta.get(mint)));
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
): Promise<(OnchainMeListing[] & { partial: boolean }) | null> {
  let hintsDone = false;
  const hintsSettled = hints.catch(() => null).finally(() => { hintsDone = true; });
  const escrow = await escrowedAssets(slug);
  if (!escrow) return null;
  const items = escrow.first;
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
      for (const r of late) {
        if (r.listedAt == null) queueListedAt(stsByMint.get(r.mint)!, () => markResolved(r.mint));
      }
      if (late.length) onLate(late);
    } catch (err) {
      console.warn(`[me-onchain] late read failed slug=${slug}`, (err as Error).message);
    }
  };
  const markResolved = (mint: string): void => {
    resolved.add(mint);
    lateTimer ??= setTimeout(() => void flushLate(), LATE_FLUSH_MS);
  };

  // Rows without a known listing time: resolve in the background, then
  // re-emit them through the same late path.
  for (const r of rows) {
    if (r.listedAt == null) queueListedAt(stsByMint.get(r.mint)!, () => markResolved(r.mint));
  }
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
  // Pages 2+ of a big collection: same pipeline, delivered through onLate.
  if (escrow.rest) void escrow.rest.then(async more => {
    for (const i of more) meta.set(i.id, i);
    const extra = more.map(i => i.id);
    await loadFromDb(extra);
    if (hintsDone) applyHints(await hintsSettled);
    const { rows: late, missing: lateMissing } = await priceMints(extra, meta);
    for (const r of late) if (r.listedAt == null) queueListedAt(stsByMint.get(r.mint)!, () => markResolved(r.mint));
    for (const m of lateMissing) queueGpa(m, found => { if (found) markResolved(m); });
    if (late.length) onLate(late);
    console.log(`[me-onchain] slug=${slug} more pages: escrowed+=${extra.length} priced=${late.length} missing=${lateMissing.length}`);
  }).catch(err => console.warn(`[me-onchain] more pages failed slug=${slug}`, (err as Error).message));
  console.log(`[me-onchain] slug=${slug} escrowed=${mints.length}${escrow.rest ? '+more' : ''} priced=${rows.length} missing=${missing.length} hints=${hintsDone ? 'in-time' : 'late'}`);
  // Partial = only DAS page 1 is in `rows`; the caller must keep its other
  // stored ME rows rather than treat them as delisted.
  return Object.assign(rows, { partial: escrow.rest != null });
}

/** Background gPA lookups still queued (all slugs). */
export function gpaBacklog(): number { return gpaQueue.length; }
