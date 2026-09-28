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

/**
 * Fetch every mint of `slug`'s collection via DAS and hand them to `record`.
 * No-op when the slug's collection address is unknown, a sweep is running,
 * or one completed within MINTS_TTL_MS.
 */
export async function primeSlugMints(slug: string, record: (mints: string[], slug: string) => void): Promise<void> {
  const coll = slugToColl.get(slug);
  if (!coll || inFlight.has(slug)) return;
  if (Date.now() - (mintsLoadedAt.get(slug) ?? 0) < MINTS_TTL_MS) return;
  const key = process.env.HELIUS_API_KEY;
  if (!key) return;
  inFlight.add(slug);
  let total = 0, pages = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'listing-stream', method: 'getAssetsByGroup',
          params: { groupKey: 'collection', groupValue: coll, page, limit: PAGE_LIMIT },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json() as { result?: { items?: Array<{ id: string; burnt?: boolean }> } };
      const items = json.result?.items ?? [];
      pages++;
      const mints = items.filter(i => !i.burnt).map(i => i.id);
      if (mints.length) record(mints, slug);
      total += mints.length;
      if (items.length < PAGE_LIMIT) break;
    }
    mintsLoadedAt.set(slug, Date.now());
    console.log(`[listing-stream/resolver] primed slug=${slug} mints=${total} pages=${pages} (~${pages * 10} credits)`);
  } catch (err) {
    console.warn(`[listing-stream/resolver] prime failed slug=${slug}`, (err as Error).message);
  } finally {
    inFlight.delete(slug);
  }
}
