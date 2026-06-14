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
 * Thin proxy over Magic Eden's pre-aggregated collection_stats endpoint.
 * Validates + whitelists every param locally (bad param → 400, no upstream
 * round-trip), then returns our normalized DTO — ME's raw shape never leaves
 * the backend. Read-only: no DB writes, no RPC. Cache + in-flight dedup live
 * in the adapter (me-trending-stats.ts).
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
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

  return router;
}
