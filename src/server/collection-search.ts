/**
 * Global collection search.
 *
 * Local source: substring scan over `sale_events` — far wider than the
 * frontend's per-session history since the backend has ingested every slug
 * that has traded on ME v2 / MMM / Tensor / TAMM. Ranked by event frequency
 * so well-traded collections surface first.
 *
 * ME fallback: ME v2 has no public text-search endpoint, but when `q` looks
 * slug-shaped (alphanumeric + `_-`) and the DB scan missed, we try
 * `/v2/collections/{q}` as an exact-slug validator. This covers newly-launched
 * collections we haven't ingested yet.
 *
 * Per-query TTL cache (30 s) absorbs keystroke-driven duplicate queries.
 * Each result carries a `source: 'local' | 'me'` marker so the frontend can
 * display provenance if it wants to.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';
import { searchCatalog, catalogSize, refreshCatalog } from './collection-catalog';

const TTL_MS           = 30_000;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_RESULTS      = 20;
const ME_API_BASE      = 'https://api-mainnet.magiceden.dev/v2';
/** Slug-shape: what ME accepts as a collection symbol — alnum + `_-`. */
const SLUG_RE = /^[a-z0-9_-]+$/;

export interface SearchResult {
  slug:     string;
  name:     string;
  imageUrl: string | null;
  source:   'local' | 'me';
}

interface CacheEntry { results: SearchResult[]; fetchedAt: number }
const cache = new Map<string, CacheEntry>();

const DB_SEARCH_SQL = `
  SELECT
    me_collection_slug AS slug,
    MAX(collection_name) AS name,
    (array_agg(image_url ORDER BY block_time DESC) FILTER (WHERE image_url IS NOT NULL))[1] AS image_url,
    COUNT(*)::int AS freq
  FROM sale_events
  WHERE me_collection_slug IS NOT NULL
    AND (
      me_collection_slug ILIKE $1
      OR (collection_name IS NOT NULL AND collection_name ILIKE $1)
    )
  GROUP BY me_collection_slug
  ORDER BY freq DESC
  LIMIT $2
`;

interface DbRow {
  slug:       string;
  name:       string | null;
  image_url:  string | null;
  freq:       number;
}

async function dbSearch(q: string): Promise<SearchResult[]> {
  const pool = getPool();
  const { rows } = await pool.query<DbRow>(DB_SEARCH_SQL, [`%${q}%`, MAX_RESULTS]);
  return rows.map(r => ({
    slug:     r.slug,
    name:     r.name ?? r.slug,
    imageUrl: r.image_url,
    source:   'local' as const,
  }));
}

interface MeCollection { symbol?: string; name?: string; image?: string }

async function meExactSlug(slug: string): Promise<SearchResult | null> {
  try {
    const res = await fetch(
      `${ME_API_BASE}/collections/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const json = await res.json() as MeCollection;
    if (!json.symbol) return null;
    return {
      slug:     json.symbol,
      name:     json.name ?? json.symbol,
      imageUrl: json.image ?? null,
      source:   'me',
    };
  } catch {
    return null;
  }
}


export function createCollectionSearchRouter(): Router {
  const router = Router();

  router.get('/search', async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (!q || q.length < 2 || q.length > 60) {
      res.json({ results: [] });
      return;
    }
    const hit = cache.get(q);
    const now = Date.now();
    if (hit && now - hit.fetchedAt < TTL_MS) {
      res.json({ results: hit.results });
      return;
    }
    try {
      const bySlug = new Map<string, SearchResult>();
      // Source 1 — local DB substring scan. Covers everything we've ingested.
      const local = await dbSearch(q);
      for (const r of local) bySlug.set(r.slug, r);

      // Source 2 — local ME collection catalog (refreshed in background from
      // /v2/collections list pagination). Replaces the rate-limited
      // /collections/search text endpoint; search is now instant, offline,
      // and covers every collection in ME's public index. Lazy-bootstraps if
      // the catalog somehow started empty.
      if (bySlug.size < MAX_RESULTS) {
        if (catalogSize() === 0) void refreshCatalog();
        const catResults = searchCatalog(q, MAX_RESULTS - bySlug.size);
        for (const e of catResults) {
          if (!bySlug.has(e.slug)) {
            bySlug.set(e.slug, {
              slug:     e.slug,
              name:     e.name,
              imageUrl: e.image,
              source:   'me',
            });
          }
        }
      }

      // Source 3 — ME exact-slug validator when the query looks like a slug
      // and nothing else matched. Handles the brand-new-slug direct-nav case
      // for collections that landed after our last catalog refresh.
      if (bySlug.size === 0 && SLUG_RE.test(q)) {
        const me = await meExactSlug(q);
        if (me && !bySlug.has(me.slug)) bySlug.set(me.slug, me);
      }

      const results = Array.from(bySlug.values()).slice(0, MAX_RESULTS);
      // Only cache non-empty results. An empty query during the first-boot
      // catalog warm-up (~45 s to seed 30k collections) was being pinned by
      // the 30 s TTL, so users searching during the window stayed "empty"
      // for up to 30 s even after the catalog landed. Empties are cheap to
      // recompute (DB miss + in-memory scan ≈ 10 ms) — don't trap them.
      if (results.length > 0) {
        cache.set(q, { results, fetchedAt: Date.now() });
      }
      res.json({ results });
    } catch (err) {
      console.error('[collection-search] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
