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
 */

import { getPool } from '../../db/client';

const REFRESH_MS    = 30 * 60_000;
const MINTS_TTL_MS  = 6 * 60 * 60_000;
const PAGE_LIMIT    = 1000;
const MAX_PAGES     = 30;

const collToSlug = new Map<string, string>();
const slugToColl = new Map<string, string>();
const mintsLoadedAt = new Map<string, number>();
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
  return creator;
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
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await das<{ items?: Array<{ id: string; burnt?: boolean }> }>(method, { ...base, page, limit: PAGE_LIMIT });
      const items = result?.items ?? [];
      pages++;
      const mints = items.filter(i => !i.burnt).map(i => i.id);
      if (mints.length) record(mints, slug);
      total += mints.length;
      if (items.length < PAGE_LIMIT) break;
    }
    mintsLoadedAt.set(slug, Date.now());
    console.log(`[listing-stream/resolver] primed slug=${slug} by=${by} mints=${total} pages=${pages} (~${pages * 10} credits)`);
  } catch (err) {
    console.warn(`[listing-stream/resolver] prime failed slug=${slug}`, (err as Error).message);
  } finally {
    inFlight.delete(slug);
  }
}
