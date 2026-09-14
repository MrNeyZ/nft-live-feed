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
 * This raw on-chain decode is used ONLY for discovery (which collections
 * currently have any OS2 activity + a sample asset for the Tensor slug
 * lookup) — NOT as the row's floor. Two real failure modes were found live
 * (both reported by a user against real rows, root-caused via OpenSea's own
 * `/api/v2/listings/collection/{slug}/all` order-book endpoint):
 *   1. "Collector Crypt" — OpenSea prices this collection in USDC, not SOL;
 *      our decode still finds real on-chain-escrowed SOL "listings" that
 *      simply aren't part of OpenSea's tradeable order book at all.
 *   2. "Grimoire" — the single cheapest on-chain decode (0.59 SOL) was a
 *      structurally-valid but STALE/ghost listing absent from OpenSea's own
 *      order book (real floor 0.735625 SOL); every other decoded listing
 *      for that same collection matched the real book exactly.
 * `openseaCollectionInfo()` re-verifies the floor (and count) against that
 * same real order-book endpoint per collection, converting a USD-pegged-
 * stablecoin floor (USDC/USDT — Collector Crypt's real case) to its SOL-
 * equivalent at the live SOL/USD rate rather than dropping it — only a
 * currency we truly can't price (no live rate, or an exotic symbol) or a
 * collection with zero convertible listings gets excluded. See
 * `OpenseaCollectionInfo.verifiedFloorSol`'s doc comment for the full
 * writeup. `osFloorSol` on every row is therefore always order-book-
 * verified, never the raw decode.
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

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3';

/** Live SOL/USD rate — fetched ONCE per scan (not per collection) and
 *  reused everywhere a USDC/USDT floor needs converting to SOL-equivalent.
 *  Same Jupiter price endpoint already used elsewhere in this codebase
 *  (tools-spl20.ts, wallet-quick-balance.ts). A single transient failure
 *  here (one flaky request) would otherwise drop EVERY stablecoin-priced
 *  collection from the whole scan, so this retries once after a short
 *  delay before giving up — null only after both attempts fail, at which
 *  point callers skip stablecoin-denominated listings for that scan rather
 *  than guess a rate. */
async function fetchSolUsdPrice(): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
    const price = await fetchSolUsdPriceOnce();
    if (price != null) return price;
  }
  return null;
}

async function fetchSolUsdPriceOnce(): Promise<number | null> {
  try {
    const r = await fetch(`${JUP_PRICE_URL}?ids=${SOL_MINT}`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json() as Record<string, { usdPrice?: unknown } | null>;
    const p = j[SOL_MINT]?.usdPrice;
    return typeof p === 'number' && p > 0 ? p : null;
  } catch { return null; }
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

interface OpenseaCollectionInfo {
  /** OpenSea's own collection slug (`https://opensea.io/collection/<slug>`).
   *  Resolved via `GET /api/v2/chain/solana/contract/{address}` -> `{
   *  collection: "<slug>" }`, verified live against "Collector Crypt" ->
   *  collector-crypt and "Grimoire" -> grimoire-324808527, both resolving
   *  to a real 200 collection page. This is the ONLY slug space this tool
   *  can use for an OS2 link — Tensor's `slug` (used for the ME badge,
   *  since ME's symbol happens to match it) is a different identifier and
   *  does not resolve on OpenSea. */
  slug: string | null;
  /** The cheapest SOL-denominated price among OpenSea's own recognized
   *  ACTIVE listings for this collection (`GET
   *  /api/v2/listings/collection/{slug}/all`, which returns ascending-
   *  sorted, currency-labeled, real order-book entries — this is the same
   *  data a human buyer sees/can act on). Null when no such listing exists
   *  (currency mismatch or genuinely unlisted) or the lookup failed.
   *
   *  This REPLACES the raw on-chain `listcore` price decode as the row's
   *  floor — two real, independently-verified failure modes proved the
   *  on-chain decode alone is not trustworthy as a "floor":
   *
   *  1. Currency mismatch — "Collector Crypt" (multichain physical-card
   *     collection): our on-chain scan found real, on-chain-escrowed
   *     listings at ~0.01 SOL (asset ownership independently confirmed
   *     frozen under the exact listing PDA, so NOT stale/orphaned), yet
   *     OpenSea's own order book for this collection carries zero SOL
   *     listings — every real listing is USDC (confirmed via this same
   *     endpoint: cheapest real listing 4.49 USDC, matching their /stats
   *     floor exactly). The ~0.01 SOL accounts are real on-chain state but
   *     not part of OpenSea's tradeable order book at all.
   *  2. Stale/ghost on-chain listings — "Grimoire": our on-chain scan's
   *     cheapest decode was 0.59 SOL (also asset-ownership-confirmed
   *     escrowed under its listing PDA — structurally well-formed, NOT
   *     merely garbage bytes), yet that exact listing PDA and asset are
   *     ABSENT from OpenSea's own order book entirely — their real
   *     cheapest listing is 0.735625 SOL. Every OTHER on-chain listing we
   *     decoded for Grimoire (0.74, 0.74, 0.740439893 SOL, ...) DID match
   *     real order-book entries exactly — only the single lowest one was a
   *     ghost. No on-chain-only boolean flag reliably distinguishes this
   *     (same class of problem as the ghost-bid detector) — cross-checking
   *     against OpenSea's own book is the only reliable fix.
   *
   *  Collections without either failure mode (verified: trencher-traits)
   *  have their on-chain floor match this endpoint's floor closely, so
   *  this is a strict improvement, never a regression.
   *
   *  When the cheapest real listing is in a USD-pegged stablecoin (USDC/
   *  USDT) rather than SOL — e.g. "Collector Crypt" (4.49 USDC) — this is
   *  the SOL-equivalent of that price at the live SOL/USD rate, NOT a
   *  dropped/excluded row: a stablecoin floor is still a real, comparable
   *  price (buy in USDC — or swap SOL->USDC first — sell into ME's SOL
   *  bid), so it belongs in the table with the rest, just converted. See
   *  `osCurrency`/`osNativeFloor` for the original, unconverted figure. */
  verifiedFloorSol: number | null;
  /** Count of listings seen in the (single, ≤100-item) page fetched that
   *  were priced in a currency we could confidently convert (SOL/USDC/
   *  USDT) — a floor on the true count when more than 100 exist, not an
   *  exact total. Used for the OS2 LISTED display column instead of the
   *  on-chain scan's raw count, for the same reason as `verifiedFloorSol`:
   *  the raw on-chain count can include stale/ghost or wrong-currency
   *  accounts OpenSea itself doesn't consider live. */
  verifiedCount: number;
  /** Currency symbol of the cheapest listing actually used for
   *  `verifiedFloorSol` (e.g. "SOL", "USDC"). Null only alongside a null
   *  `verifiedFloorSol`. */
  osCurrency: string | null;
  /** The cheapest listing's price in its OWN currency, unconverted (e.g.
   *  4.49 for a 4.49 USDC listing) — for display next to the SOL-converted
   *  figure so a stablecoin-denominated floor is never silently presented
   *  as if it were priced in SOL. Equal to `verifiedFloorSol` when
   *  `osCurrency === 'SOL'`. */
  osNativeFloor: number | null;
}

interface OpenseaListingsResp {
  listings?: Array<{ price?: { current?: { currency?: string; value?: string; decimals?: number } } }>;
}

/** USD-pegged stablecoins we're willing to convert to a SOL-equivalent
 *  floor by treating them as exactly $1.00 (no extra price call needed —
 *  USDC/USDT deviate from peg by fractions of a cent, immaterial next to
 *  live SOL/USD volatility). Any OTHER non-SOL currency (ETH, a bridged
 *  token, etc.) is skipped — we have no mint address from OpenSea's
 *  listings response to price it confidently, only a symbol string. */
const USD_STABLE_SYMBOLS = new Set(['USDC', 'USDT']);

/** Two-hop lookup (contract->slug, then slug->listings) plus a `retryable`
 *  flag for the caller. `retryable=true` specifically means the SLUG
 *  resolution itself looked wrong, not just "no data": observed live —
 *  `GET /chain/solana/contract/{address}` returned slug
 *  "collector-crypt-406289238" for Collector Crypt's real on-chain
 *  address, when 10+ separate manual calls for that exact same address
 *  (before, during, and after that scan) all returned the correct
 *  "collector-crypt" — a one-off stale/wrong slug from OpenSea's own API,
 *  not a deterministic bug here. The listings call for the bad slug then
 *  404s. Re-resolving the slug from scratch is the fix; `openseaCollectionInfo`
 *  below does that retry once. */
async function openseaCollectionInfoAttempt(
  collectionAddress: string, solUsdPrice: number | null,
): Promise<{ info: OpenseaCollectionInfo; retryable: boolean }> {
  const NONE: OpenseaCollectionInfo = { slug: null, verifiedFloorSol: null, verifiedCount: 0, osCurrency: null, osNativeFloor: null };
  const key = process.env.OPENSEA_API_KEY;
  if (!key) return { info: NONE, retryable: false };
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/chain/solana/contract/${encodeURIComponent(collectionAddress)}`,
      { headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) {
      console.error(`[opensea-arb] contract lookup failed collection=${collectionAddress} status=${r.status} body=${(await r.text()).slice(0, 200)}`);
      return { info: NONE, retryable: r.status >= 500 || r.status === 429 };
    }
    const j = await r.json() as { collection?: string };
    const slug = typeof j.collection === 'string' && j.collection.length > 0 ? j.collection : null;
    if (!slug) {
      console.error(`[opensea-arb] contract lookup returned no slug collection=${collectionAddress} body=${JSON.stringify(j).slice(0, 200)}`);
      return { info: NONE, retryable: false };
    }

    const lr = await fetch(
      `https://api.opensea.io/api/v2/listings/collection/${encodeURIComponent(slug)}/all?limit=100`,
      { headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(8000) },
    );
    if (!lr.ok) {
      console.error(`[opensea-arb] listings lookup failed collection=${collectionAddress} slug=${slug} status=${lr.status} body=${(await lr.text()).slice(0, 200)}`);
      // A 404 here (slug resolved, but that exact slug has no listings
      // endpoint) is the specific stale/wrong-slug symptom — retryable.
      // Any other status (5xx/429/etc) is also worth one retry.
      return { info: { ...NONE, slug }, retryable: true };
    }
    const lj = await lr.json() as OpenseaListingsResp;
    if (!Array.isArray(lj.listings) || lj.listings.length === 0) {
      console.error(`[opensea-arb] listings lookup returned no listings slug=${slug} body=${JSON.stringify(lj).slice(0, 200)}`);
    }

    const priced = (lj.listings ?? []).flatMap(l => {
      const cur = l.price?.current;
      const symbol = cur?.currency;
      if (!symbol || cur?.value == null) return [];
      const native = Number(cur.value) / 10 ** (cur.decimals ?? 9);
      if (!Number.isFinite(native) || native <= 0) return [];
      if (symbol === 'SOL') return [{ floorSol: native, symbol, native }];
      if (USD_STABLE_SYMBOLS.has(symbol) && solUsdPrice) return [{ floorSol: native / solUsdPrice, symbol, native }];
      return []; // unconvertible currency (no live SOL/USD rate, or an unsupported symbol) — skip this listing
    });
    if (priced.length === 0 && lj.listings && lj.listings.length > 0) {
      const symbols = [...new Set(lj.listings.map(l => l.price?.current?.currency ?? 'null'))];
      console.error(`[opensea-arb] slug=${slug} had ${lj.listings.length} listings but 0 priceable (symbols seen: ${symbols.join(',')}, solUsdPrice=${solUsdPrice})`);
    }

    if (priced.length === 0) return { info: { ...NONE, slug }, retryable: false };
    priced.sort((a, b) => a.floorSol - b.floorSol);
    const cheapest = priced[0];
    return {
      info: { slug, verifiedFloorSol: cheapest.floorSol, verifiedCount: priced.length, osCurrency: cheapest.symbol, osNativeFloor: cheapest.native },
      retryable: false,
    };
  } catch { return { info: NONE, retryable: false }; }
}

async function openseaCollectionInfo(collectionAddress: string, solUsdPrice: number | null): Promise<OpenseaCollectionInfo> {
  const first = await openseaCollectionInfoAttempt(collectionAddress, solUsdPrice);
  if (!first.retryable) return first.info;
  await new Promise(r => setTimeout(r, 1000));
  const second = await openseaCollectionInfoAttempt(collectionAddress, solUsdPrice);
  return second.info;
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
  /** OpenSea's own collection slug (`opensea.io/collection/<osSlug>`) —
   *  resolved separately from `slug` (Tensor's, reused for the ME badge)
   *  since the two marketplaces don't share a slug space. Null when
   *  `OPENSEA_API_KEY` is unset or the lookup failed/missed. */
  osSlug: string | null;
  /** OpenSea's own verified order-book floor/count (`OpenseaCollectionInfo
   *  .verifiedFloorSol`/`.verifiedCount`) — see that doc comment for why
   *  this replaces the raw on-chain `listcore` decode. A row is only ever
   *  built (see runFullScan) when this resolved to a real number, so
   *  `osFloorSol` here is always OpenSea-order-book-verified, never a raw
   *  on-chain value. */
  osFloorSol: number;
  osCount: number;
  /** Currency the cheapest real OpenSea listing was actually priced in
   *  ("SOL", "USDC", "USDT"). `osFloorSol` above is always the SOL-
   *  equivalent; when this isn't "SOL", `osNativeFloor` carries the
   *  original, unconverted figure for display. */
  osCurrency: string | null;
  osNativeFloor: number | null;
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
  const [listings, solUsdPrice] = await Promise.all([scanListings(), fetchSolUsdPrice()]);
  emit('progress', { msg: `${listings.length} live MPL Core listings — resolving collections via DAS…` });
  const collections = await groupListingsByCollection(listings);
  emit('progress', { msg: `${collections.length} distinct collections found — fetching Tensor slug + ME floor/bid for each (rate-limited, ~2s/collection)…` });

  const rows: OpenseaArbRow[] = [];
  let i = 0;
  for (const c of collections) {
    i++;
    const { slug, royaltyBps } = await tensorMintMetaFor(c.sampleAsset);
    await new Promise(r => setTimeout(r, TENSOR_GAP_MS));
    const [mFloor, mBid, osInfo] = await Promise.all([
      slug ? meFloorSol(slug) : Promise.resolve(null),
      slug ? meTopMmmBidSol(slug) : Promise.resolve(null),
      openseaCollectionInfo(c.collection, solUsdPrice),
    ]);
    // Only build a row when OpenSea's OWN order book confirms a real,
    // priceable listing exists — the raw on-chain `c.osFloorSol`/`c.count`
    // (used only for discovery + picking a sampleAsset above) are provably
    // untrustworthy on their own: see OpenseaCollectionInfo.verifiedFloorSol's
    // doc comment for two independently-verified failure modes (stale/ghost
    // listing; a currency we can't convert — either no live SOL/USD rate
    // this run, or a non-SOL/USDC/USDT symbol) this skips.
    if (osInfo.verifiedFloorSol == null) continue;
    rows.push({
      name: c.name ?? c.collection, collection: c.collection, slug, osSlug: osInfo.slug,
      osFloorSol: osInfo.verifiedFloorSol, osCount: osInfo.verifiedCount,
      osCurrency: osInfo.osCurrency, osNativeFloor: osInfo.osNativeFloor,
      meFloorSol: mFloor, meTopBidSol: mBid, royaltyBps,
    });
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
