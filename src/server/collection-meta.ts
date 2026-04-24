// Collection-header metadata (Twitter / Discord / website) for the
// Collection page.
//
// Primary source: the in-memory `collection_catalog` mirror. The catalog's
// paginated refresh from ME `/v2/collections` returns `twitter`, `discord`,
// `website` per item, so every verified slug already has these fields in
// our DB — zero extra ME traffic at read time.
//
// Fallback: ME's per-slug `/v2/collections/{symbol}` endpoint, used only
// when the slug isn't in our catalog (unverified or freshly listed). That
// endpoint is aggressively rate-limited to anonymous clients, so we cache
// both hits and misses; misses expire quickly so a transient 429 doesn't
// pin the slug empty until the TTL rolls.
//
// Endpoint:
//   GET /collections/meta?slug=<symbol>
//     → { twitter: string|null, discord: string|null, website: string|null }

import { Router, Request, Response } from 'express';
import { getCatalogEntry } from './collection-catalog';
import { getPool } from '../db/client';

const ME_API           = 'https://api-mainnet.magiceden.dev/v2';
const HIT_TTL_MS       = 60 * 60_000;     // 1 h for real data
const MISS_TTL_MS      = 2  * 60_000;     // 2 min for empties / 429s
const FETCH_TIMEOUT_MS = 5_000;

interface MeCollection {
  name?:    string;
  twitter?: string;
  discord?: string;
  website?: string;
}

interface Meta {
  name:    string | null;
  twitter: string | null;
  discord: string | null;
  website: string | null;
}

interface CacheEntry { data: Meta; fetchedAt: number; hit: boolean }
const cache = new Map<string, CacheEntry>();

/** Factory, NOT a shared constant. Callers mutate the returned object
 *  (`data.name = fromDb`) to backfill from the DB; if this were a single
 *  module-level const, the first slug's backfill would leak into every
 *  subsequent response that also hit the fallback path. */
function emptyMeta(): Meta { return { name: null, twitter: null, discord: null, website: null }; }

function coerce(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function isNonEmpty(s: Meta): boolean {
  return !!(s.name || s.twitter || s.discord || s.website);
}

/**
 * Best-effort display-name lookup from our own sale_events DB. Covers the
 * "uncatalogued slug" case (e.g. `loudlords`) — ME's per-slug endpoint is
 * rate-limited to anonymous clients, but we've almost certainly ingested
 * at least one sale that carried the proper mixed-case name. Used to seed
 * Meta.name when the catalog has no entry for this slug.
 */
async function fetchNameFromDb(slug: string): Promise<string | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ collection_name: string }>(
      `SELECT collection_name
         FROM sale_events
        WHERE me_collection_slug = $1
          AND collection_name IS NOT NULL
        ORDER BY block_time DESC
        LIMIT 1`,
      [slug],
    );
    return rows[0]?.collection_name ?? null;
  } catch {
    return null;
  }
}

async function fetchMeFallback(slug: string): Promise<Meta> {
  try {
    const res = await fetch(
      `${ME_API}/collections/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return emptyMeta();
    const json = await res.json() as MeCollection;
    return {
      name:    coerce(json.name),
      twitter: coerce(json.twitter),
      discord: coerce(json.discord),
      website: coerce(json.website),
    };
  } catch {
    return emptyMeta();
  }
}

export function createCollectionMetaRouter(): Router {
  const router = Router();

  router.get('/meta', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) { res.status(400).json({ error: 'missing slug' }); return; }

    // Catalog hit → return immediately, zero network.
    const catalogEntry = getCatalogEntry(slug);
    if (catalogEntry) {
      const data: Meta = {
        name:    catalogEntry.name,
        twitter: catalogEntry.twitter,
        discord: catalogEntry.discord,
        website: catalogEntry.website,
      };
      res.json(data);
      return;
    }

    const now = Date.now();
    const hit = cache.get(slug);
    if (hit) {
      const ttl = hit.hit ? HIT_TTL_MS : MISS_TTL_MS;
      if (now - hit.fetchedAt < ttl) { res.json(hit.data); return; }
    }

    const data = await fetchMeFallback(slug);
    // If ME per-slug didn't give us a name (empty, rate-limited, whatever)
    // backfill from our own ingested sales. Cheap single-row DB query.
    if (!data.name) {
      const fromDb = await fetchNameFromDb(slug);
      if (fromDb) data.name = fromDb;
    }
    cache.set(slug, { data, fetchedAt: now, hit: isNonEmpty(data) });
    res.json(data);
  });

  return router;
}
