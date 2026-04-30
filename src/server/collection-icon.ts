/**
 * Collection avatar resolver (reverted to simple recent-NFT-image model).
 *
 * For every slug we return the most recent `image_url` from sale_events —
 * whatever NFT image we saw last. It's a representative per-collection avatar
 * with zero dependency on rate-limited marketplace collection-logo endpoints
 * or on-chain DAS lookups. Always shows something for any slug we've ever
 * ingested; CollectionCircle placeholder covers the rest.
 *
 * Route shape and bulk-endpoint contract are unchanged (`/icon?slugs=a,b,c` →
 * `{ icons: { slug: url|null } }`) so the `useCollectionIcons` hook and every
 * Dashboard/Collection-header/Search consumer works without a frontend edit.
 * Compression (200×200 via wsrv) still happens at each render site through
 * the existing `compressImage` helper.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';
import { getByCollection } from './listings-store';

const SUCCESS_TTL_MS   = 24 * 60 * 60_000;   // 24 h — revisit only once a day
const FAILURE_TTL_MS   =      60_000;        // retry empty-DB slugs after a minute
const MAX_SLUGS        = 80;

interface CacheEntry { url: string | null; expiresAt: number; lastKnown: string | null }
const cache = new Map<string, CacheEntry>();

// Active sweep for cold entries — prevents the map from growing unboundedly
// across long uptime when slugs are requested once and never again. Only
// entries past expiry AND without a `lastKnown` fallback are removed; the
// flicker-prevention path (returning stale `lastKnown` after expiry) is
// preserved for any slug that ever resolved to an image.
const SWEEP_INTERVAL_MS = 60_000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [slug, entry] of cache) {
    if (now > entry.expiresAt && !entry.lastKnown) cache.delete(slug);
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

async function fetchIcon(slug: string): Promise<string | null> {
  const hit = cache.get(slug);
  const now = Date.now();
  if (hit && now < hit.expiresAt) return hit.url ?? hit.lastKnown;

  let url: string | null = null;

  // Priority 1 — a currently-listed NFT image from the in-memory store. Users
  // on the Collection page are almost always looking at listings, so the
  // avatar derived from the listing set feels "of-the-moment" and consistent
  // with the listings panel below it. First non-null image wins; the store's
  // iteration order is stable within a process for a given slug.
  try {
    for (const l of getByCollection(slug)) {
      if (l.imageUrl) { url = l.imageUrl; break; }
    }
  } catch { /* swallow */ }

  // Priority 2 — the LATEST NFT image we've seen trade for this slug. Falls
  // back when the listings store has nothing cached yet for the slug. 24 h
  // cache prevents refresh flicker, so "latest" only re-picks on cache miss.
  if (!url) {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ image_url: string }>(
        `SELECT image_url
           FROM sale_events
          WHERE me_collection_slug = $1
            AND image_url IS NOT NULL
          ORDER BY block_time DESC
          LIMIT 1`,
        [slug],
      );
      url = rows[0]?.image_url ?? null;
    } catch { /* swallow — treated as failure, cache null briefly */ }
  }

  cache.set(slug, {
    url,
    lastKnown: url ?? hit?.lastKnown ?? null,
    expiresAt: Date.now() + (url ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  });
  return url ?? hit?.lastKnown ?? null;
}

export function createCollectionIconRouter(): Router {
  const router = Router();

  router.get('/icon', async (req: Request, res: Response) => {
    const raw = String(req.query.slugs ?? '').trim();
    if (!raw) { res.json({ icons: {} }); return; }
    const slugs = Array.from(new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean),
    )).slice(0, MAX_SLUGS);

    try {
      const entries = await Promise.all(slugs.map(async slug => {
        const url = await fetchIcon(slug);
        return [slug, url] as const;
      }));
      res.json({ icons: Object.fromEntries(entries) });
    } catch (err) {
      console.error('[collection-icon] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
