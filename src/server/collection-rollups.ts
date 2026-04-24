/**
 * 7-day per-collection rollups — powers the dashboard's 7D FLOOR sparkline and
 * 7D VOLUME bar charts with real sale history instead of placeholders.
 *
 * Buckets: 7 contiguous 24-hour windows, oldest first, anchored to the wall
 *   clock at request time. Bucket i = [now - (7-i)·24h, now - (6-i)·24h).
 *
 *   floor7d[i] = MIN(price_sol) for events in bucket i.
 *                Empty buckets are forward-filled from the previous non-empty
 *                bucket so the sparkline is a continuous line, not a crash to 0.
 *                Collections with no events in the full 7-day window return [].
 *   vol7d[i]   = SUM(price_sol) for events in bucket i; empty buckets = 0.
 *
 * Single pooled SQL call for all requested names (`= ANY($1::text[])`),
 * bucketed in one pass per collection client-side. Server cache keyed per
 * collection name, TTL = ROLLUP_TTL_MS.
 *
 * Input names are URL-decoded and repeated `names=` query params are accepted
 * (express parses them as an array); collection names can contain commas and
 * spaces so GET-with-array is safer than comma-joining.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';

const ROLLUP_TTL_MS = 5 * 60_000;           // 5 min — 7d stats drift slowly
const BUCKET_COUNT  = 7;
const BUCKET_MS     = 24 * 60 * 60_000;     // 24h
const WINDOW_MS     = BUCKET_COUNT * BUCKET_MS;
const MAX_NAMES_PER_REQUEST = 120;

interface CachedRollup {
  floor7d: number[];       // length 0 or BUCKET_COUNT
  vol7d:   number[];       // length 0 or BUCKET_COUNT
  fetchedAt: number;
}

const cache = new Map<string, CachedRollup>();

const BUCKETS_SQL = `
  SELECT
    collection_name,
    FLOOR(EXTRACT(EPOCH FROM (NOW() - block_time)) / 86400)::int AS days_ago,
    MIN(price_sol)::float8 AS min_price,
    SUM(price_sol)::float8 AS sum_price
  FROM sale_events
  WHERE collection_name = ANY($1::text[])
    AND block_time >= NOW() - INTERVAL '7 days'
    AND price_sol > 0
  GROUP BY collection_name, days_ago
`;

interface Row {
  collection_name: string;
  days_ago:        number;
  min_price:       number;
  sum_price:       number;
}

/**
 * Forward-fill null entries in a numeric array with the nearest earlier value.
 * If there is no earlier value, back-fill with the nearest later value.
 * Fully-null → empty array so the frontend can render "no data".
 */
function forwardFill(buckets: (number | null)[]): number[] {
  if (!buckets.some((b) => b != null)) return [];
  const out = buckets.slice();
  let last: number | null = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) last = out[i];
    else if (last != null) out[i] = last;
  }
  // Back-fill leading nulls from the first non-null value
  let first: number | null = null;
  for (const v of out) if (v != null) { first = v; break; }
  for (let i = 0; i < out.length; i++) {
    if (out[i] == null) out[i] = first;
  }
  return out as number[];
}

async function computeRollups(names: string[]): Promise<Map<string, CachedRollup>> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(BUCKETS_SQL, [names]);

  // Per-name, index [0..6] oldest→newest.
  const perName = new Map<string, { floor: (number | null)[]; vol: number[] }>();
  for (const n of names) {
    perName.set(n, {
      floor: new Array<number | null>(BUCKET_COUNT).fill(null),
      vol:   new Array<number>(BUCKET_COUNT).fill(0),
    });
  }

  // days_ago: 0 = within last 24h (newest bucket at index 6), 6 = oldest.
  for (const r of rows) {
    if (r.days_ago < 0 || r.days_ago > 6) continue;
    const slot = BUCKET_COUNT - 1 - r.days_ago;
    const bucket = perName.get(r.collection_name);
    if (!bucket) continue;
    bucket.floor[slot] = r.min_price;
    bucket.vol[slot]   = r.sum_price;
  }

  const now = Date.now();
  const out = new Map<string, CachedRollup>();
  for (const [name, b] of perName) {
    out.set(name, {
      floor7d: forwardFill(b.floor),
      vol7d:   b.vol.every((v) => v === 0) ? [] : b.vol,
      fetchedAt: now,
    });
  }
  return out;
}

async function getRollupsForNames(names: string[]): Promise<Record<string, CachedRollup>> {
  const now = Date.now();
  const out: Record<string, CachedRollup> = {};
  const missing: string[] = [];

  for (const n of names) {
    const hit = cache.get(n);
    if (hit && now - hit.fetchedAt < ROLLUP_TTL_MS) out[n] = hit;
    else missing.push(n);
  }

  if (missing.length > 0) {
    const fresh = await computeRollups(missing);
    for (const [n, r] of fresh) {
      cache.set(n, r);
      out[n] = r;
    }
  }
  return out;
}

export function createCollectionRollupsRouter(): Router {
  const router = Router();

  router.get('/rollups', async (req: Request, res: Response) => {
    const raw = req.query.names;
    const list = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    const names = Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)))
      .slice(0, MAX_NAMES_PER_REQUEST);

    if (names.length === 0) {
      res.json({ rollups: {} });
      return;
    }

    try {
      const all = await getRollupsForNames(names);
      const body: Record<string, { floor7d: number[]; vol7d: number[] }> = {};
      for (const n of names) {
        const r = all[n];
        body[n] = { floor7d: r?.floor7d ?? [], vol7d: r?.vol7d ?? [] };
      }
      res.json({ rollups: body });
    } catch (err) {
      console.error('[collection-rollups] error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
