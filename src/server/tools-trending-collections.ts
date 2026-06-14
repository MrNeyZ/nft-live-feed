/**
 * Trending Collections Tool — read API.
 *
 *   GET /api/tools/trending-collections
 *     ?range=10m|1h|6h|1d|7d|30d   (default 1d)
 *     &sort=<ME sort enum>          (default volume)
 *     &direction=asc|desc           (default desc)
 *     &limit=<1..200>               (default 100)
 *     &offset=<0..>                 (default 0)
 *     &chain=solana                 (default solana)
 *
 *   GET /api/tools/trending-collections/:slug/sales
 *     ?range=10m|1h|6h|1d|7d|30d   (default 1d)
 *     &limit=<1..10>                (default 10, hard-capped at 10)
 *
 * Thin proxy over Magic Eden's pre-aggregated collection_stats endpoint.
 * Validates + whitelists every param locally (bad param → 400, no upstream
 * round-trip), then returns our normalized DTO — ME's raw shape never leaves
 * the backend. Read-only: no DB writes, no RPC. Cache + in-flight dedup live
 * in the adapter (me-trending-stats.ts).
 *
 * The /:slug/sales sub-route powers the trending page's hover preview. It
 * reads ONLY from the existing `sale_events` table (via getEventsByCollection)
 * — no Magic Eden call, no RPC, no writes — and returns the most recent sales
 * for that slug inside the selected timeframe.
 */
import { Router, Request, Response } from 'express';
import { rateLimit, isValidSlug } from './rate-limit';
import { getEventsByCollection } from '../db/queries';
import {
  getTrendingCollections,
  MeTrendingUpstreamError,
  MeTrendingSchemaError,
  TRENDING_RANGES,
  TRENDING_SORTS,
  TRENDING_CHAINS,
  type TrendingQuery,
  type TrendingRange,
  type TrendingSort,
  type TrendingChain,
  type TrendingDirection,
} from '../enrichment/me-trending-stats';

const DEFAULT_RANGE: TrendingRange         = '1d';
const DEFAULT_SORT: TrendingSort           = 'volume';
const DEFAULT_DIRECTION: TrendingDirection = 'desc';
const DEFAULT_CHAIN: TrendingChain         = 'solana';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT     = 200;

/** Hover-preview sales: hard ceiling of 10 rows regardless of request. */
const SALES_MAX_LIMIT = 10;
/** Window length (ms) for each timeframe — maps the range pill to a
 *  `block_time >= now-window` cutoff for the sale_events query. */
const RANGE_WINDOW_MS: Record<TrendingRange, number> = {
  '10m': 10 * 60_000,
  '1h':  60 * 60_000,
  '6h':  6 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
  '7d':  7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/** Compact sale row the hover panel renders — a normalized subset of
 *  SaleEventRow; the full DB row never leaves the backend. */
interface TrendingSaleDTO {
  signature:   string;
  blockTime:   string;          // ISO
  priceSol:    number | null;
  buyer:       string | null;
  seller:      string | null;
  nftName:     string | null;
  imageUrl:    string | null;
  marketplace: string | null;
  saleType:    string | null;
  mint:        string | null;
}

interface SalesCacheEntry { sales: TrendingSaleDTO[]; fetchedAt: number }
const salesCache = new Map<string, SalesCacheEntry>();
const SALES_TTL_MS = 60_000;

function inEnum<T extends string>(v: string, allowed: readonly T[]): v is T {
  return (allowed as readonly string[]).includes(v);
}

export function createTrendingCollectionsRouter(): Router {
  const router = Router();
  // Read-only proxy with a short upstream cache — keep the cap generous but
  // bounded so a stuck tab can't hammer ME through us.
  const limit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/trending-collections' });

  router.get('/tools/trending-collections', limit, async (req: Request, res: Response) => {
    // ── Param validation (invalid → 400, never forwarded upstream) ──────────
    const rangeRaw = String(req.query.range ?? DEFAULT_RANGE).trim();
    if (!inEnum(rangeRaw, TRENDING_RANGES)) {
      return res.status(400).json({
        ok: false, error: 'invalid_range', allowed: TRENDING_RANGES,
      });
    }

    const sortRaw = String(req.query.sort ?? DEFAULT_SORT).trim();
    if (!inEnum(sortRaw, TRENDING_SORTS)) {
      return res.status(400).json({
        ok: false, error: 'invalid_sort', allowed: TRENDING_SORTS,
      });
    }

    const directionRaw = String(req.query.direction ?? DEFAULT_DIRECTION).trim();
    if (directionRaw !== 'asc' && directionRaw !== 'desc') {
      return res.status(400).json({
        ok: false, error: 'invalid_direction', allowed: ['asc', 'desc'],
      });
    }

    const chainRaw = String(req.query.chain ?? DEFAULT_CHAIN).trim();
    if (!inEnum(chainRaw, TRENDING_CHAINS)) {
      return res.status(400).json({
        ok: false, error: 'invalid_chain', allowed: TRENDING_CHAINS,
      });
    }

    // limit / offset: numeric, bounded. Reject NaN explicitly so a typo
    // ("limit=abc") is a 400, not a silent fallback to the default.
    const limitRaw = req.query.limit;
    let limitNum = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ ok: false, error: 'invalid_limit', max: MAX_LIMIT });
      }
      limitNum = Math.min(MAX_LIMIT, Math.floor(n));
    }

    const offsetRaw = req.query.offset;
    let offsetNum = 0;
    if (offsetRaw !== undefined) {
      const n = Number(offsetRaw);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_offset' });
      }
      offsetNum = Math.floor(n);
    }

    const query: TrendingQuery = {
      chain: chainRaw,
      range: rangeRaw,
      sort: sortRaw,
      direction: directionRaw,
      limit: limitNum,
      offset: offsetNum,
    };

    try {
      const collections = await getTrendingCollections(query);
      return res.json({
        ok: true,
        source: 'magic_eden',
        chain: query.chain,
        range: query.range,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
        offset: query.offset,
        count: collections.length,
        collections,
      });
    } catch (err) {
      if (err instanceof MeTrendingUpstreamError) {
        console.warn(
          `[tools/trending-collections] upstream ${err.upstreamStatus} ` +
          `range=${query.range} sort=${query.sort}`,
        );
        return res.status(502).json({
          ok: false,
          error: 'upstream_unavailable',
          message: 'Magic Eden stats temporarily unavailable. Try again shortly.',
        });
      }
      if (err instanceof MeTrendingSchemaError) {
        // Generic, safe message — never echo the raw upstream body.
        console.warn(`[tools/trending-collections] schema mismatch: ${err.message}`);
        return res.status(502).json({
          ok: false,
          error: 'upstream_schema_mismatch',
          message: 'Magic Eden returned an unexpected response.',
        });
      }
      console.error('[tools/trending-collections] error', err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // ── Hover preview: recent sales for one collection (DB-only) ──────────────
  // Reads existing sale_events; no ME call, no RPC, no writes. Powers the
  // trending page's right-side hover panel.
  const salesLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'tools/trending-collections/sales' });

  router.get('/tools/trending-collections/:slug/sales', salesLimit, async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: 'invalid_slug' });
    }

    const rangeRaw = String(req.query.range ?? DEFAULT_RANGE).trim();
    if (!inEnum(rangeRaw, TRENDING_RANGES)) {
      return res.status(400).json({ ok: false, error: 'invalid_range', allowed: TRENDING_RANGES });
    }

    // limit: 1..10, default 10, hard-capped at 10. NaN/<1 → 400.
    let limitNum = SALES_MAX_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ ok: false, error: 'invalid_limit', max: SALES_MAX_LIMIT });
      }
      limitNum = Math.min(SALES_MAX_LIMIT, Math.floor(n));
    }

    const cacheKey = `${slug}|${rangeRaw}|${limitNum}`;
    const now = Date.now();
    const hit = salesCache.get(cacheKey);
    if (hit && now - hit.fetchedAt < SALES_TTL_MS) {
      return res.json({
        ok: true, slug, range: rangeRaw, count: hit.sales.length,
        sales: hit.sales, fromCache: true,
      });
    }

    try {
      const since = new Date(now - RANGE_WINDOW_MS[rangeRaw]);
      const rows = await getEventsByCollection(slug, since, limitNum);
      const sales: TrendingSaleDTO[] = rows.map(r => ({
        signature:   r.signature,
        blockTime:   r.block_time,
        priceSol:    r.price_sol != null && Number.isFinite(Number(r.price_sol)) ? Number(r.price_sol) : null,
        buyer:       r.buyer ?? null,
        seller:      r.seller ?? null,
        nftName:     r.nft_name ?? null,
        imageUrl:    r.image_url ?? null,
        marketplace: r.marketplace ?? null,
        saleType:    r.sale_type ?? null,
        mint:        r.mint_address ?? null,
      }));
      salesCache.set(cacheKey, { sales, fetchedAt: Date.now() });
      return res.json({ ok: true, slug, range: rangeRaw, count: sales.length, sales, fromCache: false });
    } catch (err) {
      console.error(`[tools/trending-collections/sales] slug=${slug} error`, err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  return router;
}
