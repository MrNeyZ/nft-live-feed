/**
 * Per-collection derived aggregates from `sale_events` — single source of
 * truth for the Collection Terminal's stat grid (Stats rows 1 and 2).
 *
 * Before: the frontend reduced the in-memory trade feed to compute
 * `sales10m` / `sales1h` / `sales24h` / `floor1h`, which under-counted any
 * collection with more than MAX_EVENTS (5 000) sales in the window and
 * required a resolved collection *name* to query a separate rollups
 * endpoint for `vol24h` / `vol7d`. Two divergent keys (slug vs name) and
 * two divergent truth sources (backend rollups + frontend reductions).
 *
 * Now: one slug-keyed endpoint derives every displayed field in a single
 * 7-day scoped scan over `sale_events`. Frontend drops its reductions and
 * its name-keyed rollups fetch on this page.
 *
 * The `/collections/rollups` endpoint stays as-is — it still powers the
 * Dashboard/Trending pages and is out of scope for this step.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';

const TTL_MS       = 30_000;
const MAX_SLUG_LEN = 200;

export interface CollectionStats {
  sales10m: number;
  sales1h:  number;
  sales24h: number;
  floor1h:  number | null;   // null when no 1h sales (caller falls back to listed floor)
  floor24h: number | null;
  vol24h:   number;          // SOL
  vol7d:    number;          // SOL
}

interface CacheEntry { stats: CollectionStats; fetchedAt: number }
const cache    = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CollectionStats>>();

// Single 7-day scoped scan; FILTER clauses bucket into sub-windows so all
// seven fields come out of one round-trip. `price_sol > 0` guards against
// fast-path rows that were inserted before their raw-parser patch filled in
// a real price (edge-case; still excluded from min/sum).
const STATS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE block_time >= NOW() - INTERVAL '10 minutes')::int8 AS sales_10m,
    COUNT(*) FILTER (WHERE block_time >= NOW() - INTERVAL '1 hour')::int8     AS sales_1h,
    COUNT(*) FILTER (WHERE block_time >= NOW() - INTERVAL '24 hours')::int8   AS sales_24h,
    MIN(price_sol) FILTER (WHERE block_time >= NOW() - INTERVAL '1 hour'   AND price_sol > 0)::float8 AS floor_1h,
    MIN(price_sol) FILTER (WHERE block_time >= NOW() - INTERVAL '24 hours' AND price_sol > 0)::float8 AS floor_24h,
    COALESCE(SUM(price_sol) FILTER (WHERE block_time >= NOW() - INTERVAL '24 hours' AND price_sol > 0), 0)::float8 AS vol_24h,
    COALESCE(SUM(price_sol) FILTER (WHERE block_time >= NOW() - INTERVAL '7 days'   AND price_sol > 0), 0)::float8 AS vol_7d
  FROM sale_events
  WHERE me_collection_slug = $1
    AND block_time >= NOW() - INTERVAL '7 days'
`;

interface Row {
  sales_10m: string;          // ::int8 comes back as string via node-postgres
  sales_1h:  string;
  sales_24h: string;
  floor_1h:  number | null;
  floor_24h: number | null;
  vol_24h:   number;
  vol_7d:    number;
}

async function computeStats(slug: string): Promise<CollectionStats> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(STATS_SQL, [slug]);
  const r = rows[0];
  return {
    sales10m: r ? parseInt(r.sales_10m, 10) : 0,
    sales1h:  r ? parseInt(r.sales_1h,  10) : 0,
    sales24h: r ? parseInt(r.sales_24h, 10) : 0,
    floor1h:  r?.floor_1h  ?? null,
    floor24h: r?.floor_24h ?? null,
    vol24h:   r?.vol_24h   ?? 0,
    vol7d:    r?.vol_7d    ?? 0,
  };
}

async function getStats(slug: string): Promise<CollectionStats> {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.stats;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async () => {
    try {
      const stats = await computeStats(slug);
      cache.set(slug, { stats, fetchedAt: Date.now() });
      return stats;
    } finally {
      inFlight.delete(slug);
    }
  })();
  inFlight.set(slug, task);
  return task;
}

export function createCollectionStatsRouter(): Router {
  const router = Router();

  router.get('/stats', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug || slug.length > MAX_SLUG_LEN) {
      res.status(400).json({ error: 'missing_or_invalid_slug' });
      return;
    }
    try {
      const stats = await getStats(slug);
      res.json({ stats });
    } catch (err) {
      console.error('[collections/stats] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
