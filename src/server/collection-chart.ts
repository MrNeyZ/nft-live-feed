/**
 * Per-collection chart data — backend is the single source of truth for
 * what the scatter chart renders. Previously the chart was derived from
 * the frontend's in-memory TRADES feed (capped at `MAX_EVENTS = 5 000`),
 * so chart fidelity was coupled to the trade card buffer: on busy
 * collections with spans wider than the buffer window (`7D` / `30D`),
 * older points were silently missing because SSE eviction had dropped
 * them before the chart could see them.
 *
 * This endpoint serves a lean `{ points: [{ ts, price, side }] }` derived
 * from `sale_events`, bounded by an explicit span window and a hard
 * `MAX_POINTS` cap to keep response sizes predictable. `side` is resolved
 * through the canonical `deriveSaleType` helper so chart dots match trade
 * rows and the `/latest` API for the same row.
 *
 * Raw points only in this first version. Bucketing / OHLC / downsampling
 * is a later concern — the endpoint shape can grow without breaking the
 * current consumer.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';
import { deriveSaleType } from '../domain/sale-type';

// Bumped 15 s → 60 s. Chart points come from sale_events aggregates; the
// resolution at which the dashboard renders (5–60 m bars) is much coarser
// than 60 s of staleness, so a longer TTL roughly quarters DB load on this
// endpoint with no visible chart lag. Errors are not cached: `cache.set`
// runs only after `computeChart` resolves successfully.
const TTL_MS       = 60_000;
const MAX_SLUG_LEN = 200;
/** Hard cap on rows returned per request. Matches the existing collection
 *  history cap so chart + trades can't accidentally ask for more rows than
 *  the DB indexes handle cheaply. */
const MAX_POINTS   = 10_000;

type Span = '1H' | '4H' | '1D' | '7D' | '30D';
const SPAN_MS: Record<Span, number> = {
  '1H':  3_600_000,
  '4H':  14_400_000,
  '1D':  86_400_000,
  '7D':  604_800_000,
  '30D': 2_592_000_000,
};

export interface ChartPoint {
  ts:    number;            // epoch ms
  price: number;            // SOL
  side:  'buy' | 'sell';
}

interface CacheEntry { points: ChartPoint[]; fetchedAt: number }
const cache    = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ChartPoint[]>>();

const CHART_SQL = `
  SELECT
    (EXTRACT(EPOCH FROM block_time) * 1000)::float8   AS ts_ms,
    price_sol::float8                                  AS price,
    raw_data->>'_parser'                                AS parser_extract,
    raw_data->>'_direction'                             AS direction_extract,
    raw_data->'events'->'nft'->>'saleType'              AS helius_sale_type_extract
  FROM sale_events
  WHERE me_collection_slug = $1
    AND block_time >= $2
    AND price_sol > 0
  ORDER BY block_time DESC
  LIMIT $3
`;

interface Row {
  ts_ms:                     number;
  price:                     number;
  parser_extract:            string | null;
  direction_extract:         string | null;
  helius_sale_type_extract:  string | null;
}

function sideFromSaleType(st: ReturnType<typeof deriveSaleType>): 'buy' | 'sell' {
  return (st === 'bid_sell' || st === 'pool_sale') ? 'sell' : 'buy';
}

async function computeChart(slug: string, span: Span): Promise<ChartPoint[]> {
  const pool   = getPool();
  const cutoff = new Date(Date.now() - SPAN_MS[span]);
  const { rows } = await pool.query<Row>(CHART_SQL, [slug, cutoff, MAX_POINTS]);
  const out: ChartPoint[] = [];
  for (const r of rows) {
    const st = deriveSaleType({
      parser:         r.parser_extract,
      direction:      r.direction_extract,
      heliusSaleType: r.helius_sale_type_extract,
    });
    out.push({ ts: r.ts_ms, price: r.price, side: sideFromSaleType(st) });
  }
  return out;
}

async function getChart(slug: string, span: Span): Promise<ChartPoint[]> {
  const key = `${slug}|${span}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.points;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const points = await computeChart(slug, span);
      cache.set(key, { points, fetchedAt: Date.now() });
      return points;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

function parseSpan(raw: unknown): Span | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return (s in SPAN_MS) ? (s as Span) : null;
}

export function createCollectionChartRouter(): Router {
  const router = Router();

  router.get('/chart', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug || slug.length > MAX_SLUG_LEN) {
      res.status(400).json({ error: 'missing_or_invalid_slug' });
      return;
    }
    const span = parseSpan(req.query.span);
    if (!span) {
      res.status(400).json({ error: 'invalid_span', allowed: Object.keys(SPAN_MS) });
      return;
    }
    try {
      const points = await getChart(slug, span);
      res.json({ points, span });
    } catch (err) {
      console.error('[collections/chart] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
