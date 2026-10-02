/**
 * Collection resolution for the listing stream — without per-event RPC.
 *
 *   collectionAddress → slug   preloaded from our own sale_events (free).
 *                              Resolves every MPL Core listing (the tx carries
 *                              the collection account) market-wide.
 *   slug → all mints           one DAS getAssetsByGroup sweep when a
 *                              collection page opens (10 credits / 1000 NFTs,
 *                              at most once per slug per MINTS_TTL_MS), so any
 *                              listing in an OPEN collection resolves.
 *                              Slugs with no collection address (legacy/pNFT
 *                              drops without a verified collection) fall back
 *                              to getAssetsByCreator on the first VERIFIED
 *                              creator of one of their sold mints (+1 getAsset).
 *   mint → slug (lazy)         for mints the sweep missed (capped big
 *                              collections, cold-primed slugs): one batched
 *                              getMultipleAccounts on Metaplex metadata PDAs
 *                              (1 credit / 100 mints) → verified collection
 *                              or first verified creator → slug.
 */

import { PublicKey } from '@solana/web3.js';
import { getPool } from '../../db/client';

const REFRESH_MS    = 30 * 60_000;
const MINTS_TTL_MS  = 6 * 60 * 60_000;
const PAGE_LIMIT    = 1000;
// Sweeps stop here; mints past the cap resolve lazily via resolveMintSlug.
const MAX_PAGES     = 10;
const PRIME_FAIL_BACKOFF_MS = 10 * 60_000;

const collToSlug = new Map<string, string>();
const slugToColl = new Map<string, string>();
const mintsLoadedAt = new Map<string, number>();
/** Non-Core slugs whose sweep stopped at MAX_PAGES — the only case where a
 *  listing of an OPEN collection can miss the mint map. */
const truncatedSlugs = new Set<string>();
export function isSlugTruncated(slug: string): boolean { return truncatedSlugs.has(slug); }
const inFlight = new Set<string>();

async function loadCollectionMap(): Promise<void> {
  try {
    // Most frequent (collection_address, slug) pair wins per address/slug.
    const { rows } = await getPool().query<{ c: string; s: string; n: string }>(`
      SELECT collection_address AS c, me_collection_slug AS s, count(*) AS n
        FROM sale_events
       WHERE collection_address IS NOT NULL AND me_collection_slug IS NOT NULL
       GROUP BY 1, 2
       ORDER BY n DESC`);
    collToSlug.clear(); slugToColl.clear();
    for (const r of rows) {
      if (!collToSlug.has(r.c)) collToSlug.set(r.c, r.s);
      if (!slugToColl.has(r.s)) slugToColl.set(r.s, r.c);
    }
    console.log(`[listing-stream/resolver] collections=${collToSlug.size}`);
  } catch (err) {
    console.warn('[listing-stream/resolver] map load failed', (err as Error).message);
  }
}

let started = false;
export function startCollectionResolver(): void {
  if (started) return;
  started = true;
  void loadCollectionMap();
  setInterval(() => void loadCollectionMap(), REFRESH_MS).unref();
}

export function slugForCollection(collection: string | null): string | null {
  return collection ? collToSlug.get(collection) ?? null : null;
}

const slugToCreator = new Map<string, string | null>();
const creatorToSlug = new Map<string, string>();

async function das<T>(method: string, params: unknown): Promise<T | undefined> {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'listing-stream', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json() as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message ?? 'rpc error'}`);
  return json.result;
}

/** First verified creator of the slug's most recently sold mint (cached, incl. misses). */
async function creatorForSlug(slug: string): Promise<string | null> {
  if (slugToCreator.has(slug)) return slugToCreator.get(slug)!;
  const { rows } = await getPool().query<{ m: string }>(
    `SELECT mint_address AS m FROM sale_events
      WHERE me_collection_slug = $1 AND mint_address IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [slug]);
  let creator: string | null = null;
  if (rows[0]) {
    const asset = await das<{ creators?: Array<{ address: string; verified: boolean }> }>('getAsset', { id: rows[0].m });
    creator = asset?.creators?.find(c => c.verified)?.address ?? null;
  }
  slugToCreator.set(slug, creator);
  if (creator) creatorToSlug.set(creator, slug);
  return creator;
}

/** DAS grouping for `slug`: its verified collection when known, else its
 *  first verified creator (same rule as primeSlugMints). */
export async function slugDasGroup(slug: string): Promise<{ collection: string } | { creator: string } | null> {
  const coll = slugToColl.get(slug);
  if (coll) return { collection: coll };
  const creator = await creatorForSlug(slug);
  return creator ? { creator } : null;
}

/**
 * Fetch every mint of `slug`'s collection via DAS and hand them to `record`.
 * Groups by collection address when known, else by first verified creator.
 * No-op when neither is known, a sweep is running, or one completed within
 * MINTS_TTL_MS.
 */
export async function primeSlugMints(slug: string, record: (mints: string[], slug: string) => void): Promise<void> {
  if (inFlight.has(slug)) return;
  if (Date.now() - (mintsLoadedAt.get(slug) ?? 0) < MINTS_TTL_MS) return;
  if (!process.env.HELIUS_API_KEY) return;
  inFlight.add(slug);
  let total = 0, pages = 0, by = 'collection';
  try {
    const coll = slugToColl.get(slug);
    let method: string, base: Record<string, unknown>;
    if (coll) {
      method = 'getAssetsByGroup';
      base = { groupKey: 'collection', groupValue: coll };
    } else {
      const creator = await creatorForSlug(slug);
      if (!creator) { mintsLoadedAt.set(slug, Date.now()); return; }
      method = 'getAssetsByCreator';
      base = { creatorAddress: creator, onlyVerified: true };
      by = `creator:${creator.slice(0, 6)}`;
    }
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await das<{ items?: Array<{ id: string; burnt?: boolean; interface?: string }> }>(method, { ...base, page, limit: PAGE_LIMIT });
      const items = result?.items ?? [];
      pages++;
      const mints = items.filter(i => !i.burnt).map(i => i.id);
      if (mints.length) record(mints, slug);
      total += mints.length;
      if (items.length < PAGE_LIMIT) break;
      // Core listing txs carry the collection account → slugForCollection
      // resolves them without a mint list; the rest of the sweep is waste.
      if (items[0]?.interface === 'MplCoreAsset') { by += '/core-skip'; break; }
      if (page === MAX_PAGES) { truncated = true; by += '/truncated'; }
    }
    if (truncated) truncatedSlugs.add(slug); else truncatedSlugs.delete(slug);
    mintsLoadedAt.set(slug, Date.now());
    console.log(`[listing-stream/resolver] primed slug=${slug} by=${by} mints=${total} pages=${pages} (~${pages * 10} credits)`);
  } catch (err) {
    // Back off instead of retrying on the very next touch — a 429 burst used
    // to re-fire the sweep on every request for the slug.
    mintsLoadedAt.set(slug, Date.now() - MINTS_TTL_MS + PRIME_FAIL_BACKOFF_MS);
    console.warn(`[listing-stream/resolver] prime failed slug=${slug}`, (err as Error).message);
  } finally {
    inFlight.delete(slug);
  }
}

// ─── Lazy mint → slug via Metaplex metadata ──────────────────────────────────

const TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const LAZY_FLUSH_MS  = 500;
const LAZY_BATCH     = 100;           // getMultipleAccounts max
const LAZY_CACHE_MAX = 100_000;
const LAZY_MISS_TTL_MS = 6 * 60 * 60_000;
const lazyCache   = new Map<string, string>();          // mint → slug
const lazyMiss    = new Map<string, number>();          // mint → miss time (slug maps grow; retry later)
const lazyWaiters = new Map<string, Array<(slug: string | null) => void>>();
let lazyTimer: NodeJS.Timeout | null = null;
export const lazyStats = { calls: 0, mints: 0, resolved: 0 };

/** Verified collection + verified creators from a MetadataV1 account (borsh). */
function parseMetadataGrouping(data: Buffer): { collection: string | null; creators: string[] } | null {
  try {
    if (data[0] !== 4) return null;
    let off = 1 + 32 + 32;
    for (let i = 0; i < 3; i++) off += 4 + data.readUInt32LE(off);   // name, symbol, uri
    off += 2;                                                          // seller_fee_basis_points
    const creators: string[] = [];
    if (data[off++] === 1) {
      const n = data.readUInt32LE(off); off += 4;
      for (let i = 0; i < n; i++, off += 34) {
        if (data[off + 32] === 1) creators.push(new PublicKey(data.subarray(off, off + 32)).toBase58());
      }
    }
    off += 2;                                                          // primary_sale_happened, is_mutable
    if (data[off++] === 1) off += 1;                                   // edition_nonce
    if (data[off++] === 1) off += 1;                                   // token_standard
    let collection: string | null = null;
    if (data[off++] === 1 && data[off] === 1) collection = new PublicKey(data.subarray(off + 1, off + 33)).toBase58();
    return { collection, creators };
  } catch {
    return null;
  }
}

/**
 * Resolve an unknown mint to a slug from its on-chain metadata. Batched and
 * cached (misses too). Core / cNFT mints have no metadata PDA → null.
 */
export function resolveMintSlug(mint: string): Promise<string | null> {
  const hit = lazyCache.get(mint);
  if (hit) return Promise.resolve(hit);
  const missAt = lazyMiss.get(mint);
  if (missAt && Date.now() - missAt < LAZY_MISS_TTL_MS) return Promise.resolve(null);
  return new Promise(resolve => {
    let w = lazyWaiters.get(mint);
    if (!w) lazyWaiters.set(mint, w = []);
    w.push(resolve);
    lazyTimer ??= setTimeout(() => void flushLazy(), LAZY_FLUSH_MS);
  });
}

async function flushLazy(): Promise<void> {
  lazyTimer = null;
  const batch = Array.from(lazyWaiters.entries()).slice(0, LAZY_BATCH);
  for (const [m] of batch) lazyWaiters.delete(m);
  if (lazyWaiters.size) lazyTimer = setTimeout(() => void flushLazy(), LAZY_FLUSH_MS);
  if (!batch.length) return;
  const out = new Map<string, string | null>();
  try {
    const pdas = batch.map(([m]) => {
      try {
        return PublicKey.findProgramAddressSync(
          [Buffer.from('metadata'), TOKEN_METADATA.toBuffer(), new PublicKey(m).toBuffer()], TOKEN_METADATA)[0].toBase58();
      } catch { return null; }
    });
    const keys = pdas.filter((p): p is string => !!p);
    lazyStats.calls++; lazyStats.mints += batch.length;
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'listing-lazy', method: 'getMultipleAccounts', params: [keys, { encoding: 'base64' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json() as { result?: { value?: Array<{ data: [string, string] } | null> } };
    const vals = json.result?.value ?? [];
    let k = 0;
    batch.forEach(([m], i) => {
      if (!pdas[i]) { out.set(m, null); return; }
      const acc = vals[k++];
      const g = acc ? parseMetadataGrouping(Buffer.from(acc.data[0], 'base64')) : null;
      let slug: string | null = null;
      if (g?.collection) slug = collToSlug.get(g.collection) ?? null;
      if (!slug && g) for (const c of g.creators) { slug = creatorToSlug.get(c) ?? null; if (slug) break; }
      out.set(m, slug);
    });
  } catch (err) {
    console.warn('[listing-stream/resolver] lazy resolve failed', (err as Error).message);
  }
  for (const [m, waiters] of batch) {
    const slug = out.get(m) ?? null;
    // Failed fetches aren't cached, so the next listing of the mint retries.
    if (out.has(m)) {
      const cache: Map<string, unknown> = slug ? lazyCache : lazyMiss;
      if (cache.size >= LAZY_CACHE_MAX) cache.delete(cache.keys().next().value!);
      if (slug) lazyCache.set(m, slug); else lazyMiss.set(m, Date.now());
    }
    if (slug) lazyStats.resolved++;
    for (const w of waiters) w(slug);
  }
}
