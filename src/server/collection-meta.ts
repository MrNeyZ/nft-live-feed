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
import { rateLimit, isValidSlug } from './rate-limit';
import { getMeCollectionData } from '../enrichment/me-collection-cache';

const HIT_TTL_MS       = 60 * 60_000;     // 1 h for real data
const MISS_TTL_MS      = 2  * 60_000;     // 2 min for empties / 429s

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

/**
 * URL allowlist for socials. The collection's twitter / discord / website
 * fields land in the frontend as `<a href="…" target="_blank">` chips, so
 * the value lives in href-attribute context. ME's catalog is curator-
 * supplied — verified-creator metadata, NOT a value we control. We've
 * seen creators sneak `data:text/html,…` and similar pseudo-schemes into
 * the website field; render that into an anchor and a click navigates
 * the user into attacker-rendered HTML on what looks like our origin.
 *
 * Hard rules:
 *   - must be a string
 *   - must start with `https://` (case-insensitive)
 *   - must parse as a valid URL
 *   - must not contain control characters (newline / NUL etc. could
 *     break out of the attribute)
 *   - must not embed userinfo (`https://user:pass@host/`)
 *   - must be ≤ 2048 chars (sanity cap — legit social URLs are tiny)
 * Anything that fails returns null and the frontend simply omits the chip.
 */
function coerceUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 2048) return null;
  if (!/^https:\/\//i.test(s)) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return s;
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
        ORDER BY block_time DESC, id DESC
        LIMIT 1`,
      [slug],
    );
    return rows[0]?.collection_name ?? null;
  } catch {
    return null;
  }
}

async function fetchMeFallback(slug: string): Promise<Meta> {
  // Actual GET /v2/collections/{slug} fetch, cache, in-flight dedup, timeout,
  // and cooldown integration now live in the shared me-collection-cache.ts
  // (also used by collection-search.ts). This function only narrows the
  // shared result and applies the URL-safety coercion below.
  const data = await getMeCollectionData(slug);
  return {
    name:    coerce(data.name),
    twitter: coerceUrl(data.twitter),
    discord: coerceUrl(data.discord),
    website: coerceUrl(data.website),
  };
}

export function createCollectionMetaRouter(): Router {
  const router = Router();
  const metaLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'collections/meta' });

  router.get('/meta', metaLimit, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!isValidSlug(slug)) { res.status(400).json({ error: 'invalid slug' }); return; }

    // Catalog hit → return immediately, zero network. URL fields go
    // through coerceUrl so a creator-supplied javascript:/data:/file:
    // value that survived ingestion can't reach the frontend href.
    const catalogEntry = getCatalogEntry(slug);
    if (catalogEntry) {
      const data: Meta = {
        name:    catalogEntry.name,
        twitter: coerceUrl(catalogEntry.twitter),
        discord: coerceUrl(catalogEntry.discord),
        website: coerceUrl(catalogEntry.website),
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
