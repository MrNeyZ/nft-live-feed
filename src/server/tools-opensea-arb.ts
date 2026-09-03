/**
 * OpenSea Solana (OS2) ⇄ Magic Eden cross-market flip scanner.
 *
 *   GET /api/tools/opensea-arb/scan-stream?force=0
 *
 * SSE, same event contract as tools-tensor-floor-scan.ts (progress / result
 * / error). Reverse-engineered against OS2's program on-chain (no IDL
 * exists anywhere — verified via direct Anchor IDL-account lookup, empty).
 * OS2 program: 7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V.
 *
 * ── What's decoded, and how it was verified ─────────────────────────────
 *
 * LISTINGS (MPL Core only — `listcore` instruction, 317-byte accounts,
 * discriminator 4ef2598aa1ddb04b): asset pubkey at byte offset 42, price
 * (u64 LE lamports) at offset 74. Verified by cross-referencing a live
 * listing's raw bytes against its own instruction's account list — the
 * asset pubkey embedded in the account data matched the literal MPL Core
 * asset account passed into the `listcore` ix. Legacy (pre-Core) listings
 * use a different, ALT-heavy account shape and are NOT covered here.
 *
 * BIDS (collection-wide offers — `bid` instruction, 393-byte accounts,
 * discriminator 9bc50561bd3c08b7): bidder at offset 10, an opaque 32-byte
 * "collection field" at offset 42, escrow lamports minus a fixed
 * 3,626,160 rent-exempt constant = the bid price (confirmed against 5+
 * live bids). The collection field is NOT derivable — it isn't any known
 * on-chain identity (collection mint, creator, authority, symbol hash all
 * ruled out), isn't a PDA of the OS2 program under any common seed
 * pattern, and doesn't itself exist as an account. It's an opaque ID
 * OpenSea assigns off-chain; the ONLY way found to attribute a bid to a
 * collection is price-matching against a second source (ME's own top MMM
 * bid, or OpenSea's own UI). This means **general bid→collection
 * attribution does not scale** — this tool does not attempt it, and the
 * "OS дороже" table below is floor-vs-floor, not bid-vs-bid.
 *
 * ── The two tables ───────────────────────────────────────────────────────
 *
 *   cheaperOnOS  — OS2's real on-chain floor (an actual buyable listing)
 *                  undercuts ME's real top MMM pool bid (an actual
 *                  instantly-fillable sell). Buy on OS2, instant-sell into
 *                  the ME bid. Both legs are ground-truth on-chain/API
 *                  data — no heuristic involved.
 *   dearerOnOS   — ME's floor undercuts OS2's floor. Buy on ME, list on
 *                  OS2 under its current floor. This is a list-and-wait
 *                  flip, not an instant one (OS2's own top BID per
 *                  collection isn't attributable at scale — see above).
 *
 * Read-only. No wallet, no signing, no tx building.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { rpcPost, rpcUrl } from './tools-mmm-pools';
import { meAuthHeaders } from '../me-api-cooldown';

const OS2_PROGRAM = '7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V';
const LISTING_DISC_B58 = 'ECt8xkbczt2';      // base58(4ef2598aa1ddb04b)
const LISTING_SIZE = 317;

const SCAN_CACHE_TTL_MS = 20 * 60 * 1000;
const TENSOR_GAP_MS = 1100; // Tensor's authed key is a strict 1 req/sec

type Emit = (type: string, data: Record<string, unknown>) => void;

interface Pgai { pubkey: string; account: { data: [string, string] } }

async function getAssetBatch(ids: string[]): Promise<Map<string, { collection: string | null; name: string | null }>> {
  const out = new Map<string, { collection: string | null; name: string | null }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    const r = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: batch } }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json() as { result?: Array<Record<string, any>> };
    for (const a of j.result ?? []) {
      if (!a) continue;
      const coll = (a.grouping ?? []).find((g: any) => g.group_key === 'collection');
      out.set(a.id, { collection: coll?.group_value ?? null, name: a.content?.metadata?.name ?? null });
    }
  }
  return out;
}

interface ListingRow { asset: string; priceSol: number }

async function scanListings(): Promise<ListingRow[]> {
  const rows = await rpcPost('getProgramAccounts', [
    OS2_PROGRAM,
    { encoding: 'base64', filters: [{ dataSize: LISTING_SIZE }, { memcmp: { offset: 0, bytes: LISTING_DISC_B58 } }] },
  ]) as Pgai[];
  const out: ListingRow[] = [];
  for (const r of rows) {
    const buf = Buffer.from(r.account.data[0], 'base64');
    if (buf.length < 82) continue;
    const asset = new PublicKey(buf.subarray(42, 74)).toBase58();
    const priceSol = Number(buf.readBigUInt64LE(74)) / 1e9;
    if (priceSol > 0) out.push({ asset, priceSol });
  }
  return out;
}

interface CollectionFloor { collection: string; name: string | null; sampleAsset: string; count: number; osFloorSol: number }

async function groupListingsByCollection(listings: ListingRow[]): Promise<CollectionFloor[]> {
  const assetMap = await getAssetBatch(listings.map(l => l.asset));
  const byColl = new Map<string, CollectionFloor>();
  for (const l of listings) {
    const info = assetMap.get(l.asset);
    if (!info?.collection) continue;
    const cur = byColl.get(info.collection);
    if (!cur) {
      byColl.set(info.collection, { collection: info.collection, name: info.name, sampleAsset: l.asset, count: 1, osFloorSol: l.priceSol });
    } else {
      cur.count++;
      if (l.priceSol < cur.osFloorSol) { cur.osFloorSol = l.priceSol; cur.sampleAsset = l.asset; }
    }
  }
  return [...byColl.values()];
}

interface TensorMintMeta { slug: string | null; royaltyBps: number | null }

/** `sellRoyaltyFeeBPS` rides along on the same `/mint` call already needed
 *  for the slug — no extra Tensor request. This is the CREATOR royalty
 *  only; ME/OS2's own marketplace cut (~1.5-2%, both sides) is NOT
 *  included — treat profitNetSol as royalty-adjusted, not fully net. */
async function tensorMintMetaFor(mint: string): Promise<TensorMintMeta> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return { slug: null, royaltyBps: null };
  try {
    const r = await fetch(`https://api.mainnet.tensordev.io/api/v1/mint?mints=${encodeURIComponent(mint)}`, {
      headers: { 'x-tensor-api-key': key }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { slug: null, royaltyBps: null };
    const j = await r.json();
    const obj = Array.isArray(j) ? j[0] : j;
    if (!obj) return { slug: null, royaltyBps: null };
    const node = obj.mint ?? obj.data ?? obj;
    const bps = Number(node.sellRoyaltyFeeBPS);
    return {
      slug: node.slug ?? node.slugDisplay ?? null,
      royaltyBps: Number.isFinite(bps) && bps >= 0 ? bps : null,
    };
  } catch { return { slug: null, royaltyBps: null }; }
}

async function meFloorSol(slug: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json() as { floorPrice?: number };
    return typeof j.floorPrice === 'number' && j.floorPrice > 0 ? j.floorPrice / 1e9 : null;
  } catch { return null; }
}

async function meTopMmmBidSol(slug: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api-mainnet.magiceden.dev/v2/mmm/pools?collectionSymbol=${encodeURIComponent(slug)}`
      + `&showInvalid=false&limit=150&offset=0&filterOnSide=1&hideExpired=true&fundingMode=0`,
      { headers: meAuthHeaders(), signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const j = await r.json() as { results?: Array<{ poolType?: string; spotPrice?: string | number }> };
    let top = 0;
    for (const p of j.results ?? []) {
      if (p.poolType !== 'buy_sided' && p.poolType !== 'two_sided') continue;
      const sp = Number(p.spotPrice ?? 0);
      if (sp > top) top = sp;
    }
    return top > 0 ? top / 1e9 : null;
  } catch { return null; }
}

export interface OpenseaArbRow {
  name: string;
  collection: string;
  slug: string | null;
  osFloorSol: number;
  osCount: number;
  meFloorSol: number | null;
  meTopBidSol: number | null;
  /** Creator royalty in bps (Tensor's `sellRoyaltyFeeBPS`). Does NOT
   *  include either marketplace's own cut (~1.5-2%, both sides) — see
   *  tensorMintMetaFor's doc note. profitSol is gross; profitNetSol
   *  subtracts royalty only, on the sell-side price. */
  royaltyBps: number | null;
}

export interface CheaperOnOsRow extends OpenseaArbRow { meTopBidSol: number; profitSol: number; profitNetSol: number; profitPct: number }
export interface DearerOnOsRow extends OpenseaArbRow { meFloorSol: number; profitSol: number; profitNetSol: number; profitPct: number }

interface ScanCacheShape {
  builtAt: number;
  cheaperOnOS: CheaperOnOsRow[];
  dearerOnOS: DearerOnOsRow[];
  totalCollectionsScanned: number;
}

async function runFullScan(emit: Emit): Promise<ScanCacheShape> {
  emit('progress', { msg: 'Fetching live OS2 listings on-chain (getProgramAccounts)…' });
  const listings = await scanListings();
  emit('progress', { msg: `${listings.length} live MPL Core listings — resolving collections via DAS…` });
  const collections = await groupListingsByCollection(listings);
  emit('progress', { msg: `${collections.length} distinct collections found — fetching Tensor slug + ME floor/bid for each (rate-limited, ~2s/collection)…` });

  const rows: OpenseaArbRow[] = [];
  let i = 0;
  for (const c of collections) {
    i++;
    const { slug, royaltyBps } = await tensorMintMetaFor(c.sampleAsset);
    await new Promise(r => setTimeout(r, TENSOR_GAP_MS));
    const [mFloor, mBid] = slug ? await Promise.all([meFloorSol(slug), meTopMmmBidSol(slug)]) : [null, null];
    rows.push({ name: c.name ?? c.collection, collection: c.collection, slug, osFloorSol: c.osFloorSol, osCount: c.count, meFloorSol: mFloor, meTopBidSol: mBid, royaltyBps });
    if (i % 10 === 0 || i === collections.length) {
      emit('progress', { msg: `Checked ${i}/${collections.length} collections against ME…` });
    }
  }

  const cheaperOnOS: CheaperOnOsRow[] = rows
    .filter((r): r is OpenseaArbRow & { meTopBidSol: number } => r.meTopBidSol != null && r.meTopBidSol > r.osFloorSol)
    .map(r => {
      const profitSol = (r.meTopBidSol as number) - r.osFloorSol;
      const royalty = r.royaltyBps != null ? (r.meTopBidSol as number) * (r.royaltyBps / 10_000) : 0;
      return { ...r, meTopBidSol: r.meTopBidSol as number, profitSol, profitNetSol: profitSol - royalty, profitPct: ((r.meTopBidSol as number) / r.osFloorSol - 1) * 100 };
    })
    .sort((a, b) => b.profitPct - a.profitPct);

  const dearerOnOS: DearerOnOsRow[] = rows
    .filter((r): r is OpenseaArbRow & { meFloorSol: number } => r.meFloorSol != null && r.meFloorSol < r.osFloorSol)
    .map(r => {
      const profitSol = r.osFloorSol - (r.meFloorSol as number);
      const royalty = r.royaltyBps != null ? r.osFloorSol * (r.royaltyBps / 10_000) : 0;
      return { ...r, meFloorSol: r.meFloorSol as number, profitSol, profitNetSol: profitSol - royalty, profitPct: (r.osFloorSol / (r.meFloorSol as number) - 1) * 100 };
    })
    .sort((a, b) => b.profitPct - a.profitPct);

  return { builtAt: Date.now(), cheaperOnOS, dearerOnOS, totalCollectionsScanned: collections.length };
}

const SCAN_CACHE_FILE = join(__dirname, '..', '..', 'data', 'opensea-arb-scan-cache.json');

function loadScanCacheFromDisk(): ScanCacheShape | null {
  try {
    const parsed = JSON.parse(readFileSync(SCAN_CACHE_FILE, 'utf-8')) as Partial<ScanCacheShape>;
    if (parsed && Array.isArray(parsed.cheaperOnOS) && Array.isArray(parsed.dearerOnOS) && typeof parsed.builtAt === 'number') {
      return parsed as ScanCacheShape;
    }
  } catch { /* missing/corrupt — fine, first run will rebuild */ }
  return null;
}
function saveScanCacheToDisk(cache: ScanCacheShape): void {
  try { writeFileSync(SCAN_CACHE_FILE, JSON.stringify(cache)); } catch { /* best-effort */ }
}

let scanCache: ScanCacheShape | null = loadScanCacheFromDisk();
let scanInFlight: Promise<ScanCacheShape> | null = null;

export function createOpenseaArbRouter(): Router {
  const router = Router();
  const scanLimit = rateLimit({ limit: 4, windowMs: 5 * 60 * 1000, label: 'tools/opensea-arb' });

  router.get('/tools/opensea-arb/scan-stream', scanLimit, (req: Request, res: Response) => {
    const force = req.query.force === '1';
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit: Emit = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch { /* client gone */ }
    };

    void (async () => {
      try {
        if (!process.env.HELIUS_API_KEY) {
          emit('error', { msg: 'HELIUS_API_KEY not configured on the backend.' });
          res.end();
          return;
        }
        if (!force && scanCache && Date.now() - scanCache.builtAt < SCAN_CACHE_TTL_MS) {
          const ageMs = Date.now() - scanCache.builtAt;
          emit('progress', { msg: `Cached (${Math.floor(ageMs / 60_000)}m ago)` });
          emit('result', { ...scanCache, cached: true, cacheAgeMs: ageMs });
          res.end();
          return;
        }
        if (scanInFlight) {
          emit('progress', { msg: 'A scan is already running — attaching to it…' });
          const c = await scanInFlight;
          emit('result', { ...c, cached: false, cacheAgeMs: 0 });
          res.end();
          return;
        }
        scanInFlight = runFullScan(emit).finally(() => { scanInFlight = null; });
        const c = await scanInFlight;
        scanCache = c;
        saveScanCacheToDisk(c);
        emit('progress', { msg: `Done — ${c.cheaperOnOS.length} cheaper-on-OS, ${c.dearerOnOS.length} dearer-on-OS` });
        emit('result', { ...c, cached: false, cacheAgeMs: 0 });
      } catch (err) {
        console.error('[tools/opensea-arb] error', err);
        emit('error', { msg: String(err) });
      }
      res.end();
    })();
  });

  return router;
}
