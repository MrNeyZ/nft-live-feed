/**
 * Per-collection Floor Depth / Liquidity endpoint — thin read-only adapter
 * over the existing `listings-store.ts` snapshot engine and the existing,
 * already-tested `computeFloorDepth()` pure function
 * (src/analytics/floor-depth.ts). This route adds NO new analytics math —
 * it exists purely to expose a module that was fully built and tested but
 * had zero production callers.
 *
 * Reuses the SAME unified `Listing[]` snapshot (ME direct + MMM sell-side
 * pools + Tensor active_listings) every sibling collection-analytics route
 * already reads (see collection-listings.ts, collection-bids.ts,
 * tools-me-tensor-arb.ts). `ensureFresh(slug)` only triggers a scoped
 * multi-marketplace refetch when that slug's rows are older than the
 * store's own TTL (30s default) — repeat requests on a hot collection are
 * cache-fast, never a forced refetch. No new external HTTP call is added
 * by this file; ME/MMM/Tensor are only ever reached indirectly, through
 * listings-store.ts, exactly as they already are for every other
 * collection route.
 *
 * Auth: matches every other read-only collection-analytics route
 * (collections/listings, collections/bids, tools/me-tensor-arb) — rate
 * limited only, not wallet-auth-gated. `requireAuth` (SIWS bearer) in this
 * codebase is reserved for personal-use tools that spend money or act on a
 * specific connected wallet (DotLand direct-mint, Pixel Forge, MMM pool
 * scanner) — see their router files' header comments. Floor Depth returns
 * only aggregate, non-wallet-specific market data, the same risk class as
 * its sibling collection routes, so it follows their convention instead.
 *
 * Fail-soft: a failed `ensureFresh` (one marketplace down, Tensor key
 * absent, network timeout) is caught here and logged, never surfaced as a
 * 500 — the store's last-known snapshot for the slug (fresh or
 * stale-but-cached) is used either way. `getByCollection` never throws.
 * An unknown/never-seen slug simply yields an empty snapshot, which
 * `computeFloorDepth([])` already turns into a valid, well-formed
 * (`floorSol: null`, `confidence: 'low'`) analytical response rather than
 * an error.
 */

import { Router, Request, Response } from 'express';
import { ensureFresh as ensureFreshDefault, getByCollection as getByCollectionDefault, type Listing } from './listings-store';
import { rateLimit, isValidSlug } from './rate-limit';
import { computeFloorDepth, type FloorDepthResult } from '../analytics/floor-depth';

/** Injectable seam for route-level tests only — production callers always
 *  use the real listings-store functions (the default parameter below). */
export interface FloorDepthDeps {
  ensureFresh:     (slug: string) => Promise<void>;
  getByCollection: (slug: string) => Listing[];
}

export interface FloorDepthRouteResponse {
  slug:            string;
  generatedAt:     string;
  listingSnapshot: {
    /** Raw row count as returned by listings-store BEFORE floor-depth's own
     *  structural filter (invalid price / missing mint) — distinct from
     *  `depth.listingCount`, which is the post-filter valid count. */
    rawCount:        number;
    /** Post-dedup unique-mint count — identical to `depth.uniqueMintCount`,
     *  surfaced at the top level for convenience. */
    uniqueMintCount: number;
  };
  depth: FloorDepthResult;
}

export function createCollectionFloorDepthRouter(
  deps: FloorDepthDeps = { ensureFresh: ensureFreshDefault, getByCollection: getByCollectionDefault },
): Router {
  const router = Router();
  const floorDepthLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'collections/floor-depth' });

  router.get('/floor-depth', floorDepthLimit, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid_slug' });
      return;
    }

    try {
      try {
        await deps.ensureFresh(slug);
      } catch (err) {
        // One or more marketplace refreshes failed — fall through and serve
        // whatever the store already has (fresh or stale-but-cached) rather
        // than turning a partial upstream outage into a 500.
        console.warn(`[collections/floor-depth] ensureFresh failed for slug=${slug}, serving cached snapshot`, err);
      }

      const rows  = deps.getByCollection(slug);
      const depth = computeFloorDepth(rows);

      const response: FloorDepthRouteResponse = {
        slug,
        generatedAt: new Date().toISOString(),
        listingSnapshot: {
          rawCount:        rows.length,
          uniqueMintCount: depth.uniqueMintCount,
        },
        depth,
      };
      res.json(response);
    } catch (err) {
      console.error(`[collections/floor-depth] error for slug=${slug}`, err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
