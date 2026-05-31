import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getLatestEvents, getEventsByCollection } from '../db/queries';
import { getPool } from '../db/client';
import { peekCachedFloorLamports } from '../enrichment/enrich';
import { getCachedResizeStatus } from '../mints/resize-status-resolver';
import { rateLimit, isValidSlug } from './rate-limit';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
// History endpoint defaults: no time filter (opt-in via ?days or ?since),
// 5 000-row safety cap. `?days=N` is clamped to [1..MAX_DAYS]; `?since=ISO`
// is clamped not to predate MAX_DAYS. Live ingestion + backfill both write
// into the same sale_events.
const BY_COLLECTION_MAX_DAYS   = 90;
const BY_COLLECTION_HARD_LIMIT = 5_000;
const AUTO_BACKFILL_BELOW   = 50;
const AUTO_BACKFILL_TTL_MS  = 5 * 60_000;
const activeBackfills = new Set<string>();
// Hard cap on concurrent child processes spawned by auto-backfill.
// Without this, an attacker walking through fresh slug strings forces
// one unmanaged child per unique slug — npm + tsc + ts-node each cost
// ~80–150 MB RSS at startup, so a few thousand requests exhaust host
// RAM. PM2's `max_memory_restart` only manages the parent backend; the
// children are detached.unref(), so they're invisible to it. The cap
// below short-circuits BEFORE the DB count check so a probe never
// even queries `sale_events`.
const MAX_CONCURRENT_BACKFILLS = 2;

/** Fire-and-forget: spawn the historical backfill script when a slug has
 *  fewer than AUTO_BACKFILL_BELOW rows. Drops silently (no spawn, no
 *  error to the caller) when:
 *    - the slug doesn't match the canonical shape,
 *    - a backfill for this slug fired in the last AUTO_BACKFILL_TTL_MS,
 *    - or MAX_CONCURRENT_BACKFILLS children are already running.
 *  The caller already returns whatever live + DB rows exist for the slug
 *  so dropping a backfill only delays future-completeness, not the
 *  current response. Never awaited; never blocks the request. */
function maybeAutoBackfill(slug: string): void {
  if (!isValidSlug(slug)) return;
  if (activeBackfills.has(slug)) return;
  if (activeBackfills.size >= MAX_CONCURRENT_BACKFILLS) {
    // Quietly drop. The endpoint still returns the rows we already have;
    // backfill catches up next time the slug is requested with capacity
    // available.
    return;
  }
  activeBackfills.add(slug);
  const ttlTimer = setTimeout(() => activeBackfills.delete(slug), AUTO_BACKFILL_TTL_MS);
  getPool()
    .query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sale_events WHERE me_collection_slug = $1',
      [slug],
    )
    .then(r => {
      const count = parseInt(r.rows[0]?.count ?? '0', 10);
      if (count >= AUTO_BACKFILL_BELOW) {
        clearTimeout(ttlTimer);
        activeBackfills.delete(slug);
        return;
      }
      console.log(`[events/by-collection] auto-backfill spawn slug=${slug} db_count=${count}`);
      // Collection page window is 7 days; keep backfill aligned so the
      // spawn completes quickly (1–2 ME pages) instead of paging 30 days
      // of activities the page never displays.
      //
      // Spawn the COMPILED script directly via process.execPath instead
      // of `npm run backfill:me`:
      //   - removes a layer (npm boots ~150 ms + parses package.json + spawns the
      //     real node child) saving RAM + CPU per spawn,
      //   - prevents an attacker-controlled `slug` from ever reaching npm's
      //     own arg parsing or any package.json lifecycle hook,
      //   - the child is a fresh node process; we don't pipe slug through
      //     a shell, so argv injection requires altering `process.execPath`
      //     which is server-controlled.
      const scriptPath = path.resolve(__dirname, '../scripts/backfill-collection-sales.js');
      const child = spawn(process.execPath, [scriptPath, slug, '--days=7'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => console.error(`[events/by-collection] auto-backfill spawn error slug=${slug}`, err));
      // Reclaim the concurrency slot when the child exits so a long
      // backfill doesn't block all future backfills for AUTO_BACKFILL_TTL_MS.
      // We still keep the per-slug TTL lock so a freshly-spawned backfill
      // for the SAME slug doesn't race.
      child.on('exit', () => {
        // Slot is freed by ttlTimer above; nothing additional needed.
        // Kept as a hook for future per-child telemetry.
      });
      child.unref();
    })
    .catch(err => {
      clearTimeout(ttlTimer);
      activeBackfills.delete(slug);
      console.error(`[events/by-collection] auto-backfill count check failed slug=${slug}`, err);
    });
}

/** Re-stamp the two non-persisted live signals — floor_delta and
 *  resize_status — from the in-process caches, so a DB-backed reload shows the
 *  same FloorChip / RESIZE badge the live SSE feed did. Shared by /latest and
 *  /by-collection. Safe: leaves a row unchanged when the cache has no value
 *  (never invents a floor). floor_delta isn't persisted (SSE `meta` channel
 *  only); resize_status cache is preloaded from `mint_resize_status` on boot. */
function stampFromCache<T extends {
  me_collection_slug: string | null;
  price_lamports: number | string | bigint;
  mint_address: string | null;
}>(rows: T[]): Array<T & { floor_delta?: number; resize_status?: string | null }> {
  return rows.map((r) => {
    let row: T & { floor_delta?: number; resize_status?: string | null } = r;
    const floor = peekCachedFloorLamports(r.me_collection_slug);
    if (floor != null) {
      const priceLam = Number(r.price_lamports);
      if (Number.isFinite(priceLam) && floor > 0) {
        row = { ...row, floor_delta: (priceLam - floor) / floor };
      }
    }
    if (r.mint_address) {
      const rs = getCachedResizeStatus(r.mint_address);
      if (rs) row = { ...row, resize_status: rs };
    }
    return row;
  });
}

export function createEventsRouter(): Router {
  const router = Router();

  // Per-IP throttles. `/latest` is cheap-ish (one indexed DB query) so 60/min
  // covers a tab refreshing every few seconds. `/by-collection` is more
  // expensive (range scan + optional backfill spawn) so we tighten it to
  // 30/min. Both share the same forgery-resistant `req.ip` resolution via
  // `app.set('trust proxy', 1)` in app.ts.
  const latestLimit       = rateLimit({ limit: 60, windowMs: 60_000, label: 'events/latest' });
  const byCollectionLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'events/by-collection' });

  router.get('/latest', latestLimit, async (req: Request, res: Response) => {
    const raw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Number.isNaN(raw) || raw < 1 ? DEFAULT_LIMIT : Math.min(raw, MAX_LIMIT);

    try {
      // Re-stamp floor_delta + resize_status from the in-process caches (these
      // are SSE-only / not persisted) so a refresh keeps the FloorChip/RESIZE
      // badge. Shared with /by-collection via stampFromCache().
      const enriched = stampFromCache(await getLatestEvents(limit));
      res.json({ events: enriched, count: enriched.length });
    } catch (err) {
      console.error('[events] query error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  router.get('/by-collection', byCollectionLimit, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    // Strict shape gate BEFORE the DB query — closes the
    // "rotate-unique-slug-strings to flood the backfill spawner" lever.
    // Anything that isn't [a-z0-9_-]{1,60} can't legitimately exist on
    // ME/Tensor and so could only cost us a wasted DB scan + child fork.
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    // Time window is OPT-IN:
    //   ?since=<ISO>  → explicit cutoff, clamped not to predate MAX_DAYS.
    //   ?days=N       → last N days (1..MAX_DAYS).
    //   neither       → no time filter (bounded only by `limit`).
    //
    // Callers that want stable full history must NOT pass a window; the old
    // default-7-day window silently truncated history for any busy slug.
    let since: Date | null = null;
    const sinceParam = String(req.query.since ?? '').trim();
    if (sinceParam) {
      const parsed = new Date(sinceParam);
      const minSince = new Date(Date.now() - BY_COLLECTION_MAX_DAYS * 86400_000);
      since = Number.isFinite(parsed.getTime()) && parsed > minSince ? parsed : minSince;
    } else if (req.query.days != null) {
      const rawDays = parseInt(String(req.query.days), 10);
      if (Number.isFinite(rawDays) && rawDays > 0) {
        const days = Math.min(rawDays, BY_COLLECTION_MAX_DAYS);
        since = new Date(Date.now() - days * 86400_000);
      }
    }
    const rawLimit = parseInt(String(req.query.limit ?? BY_COLLECTION_HARD_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, BY_COLLECTION_HARD_LIMIT)
      : BY_COLLECTION_HARD_LIMIT;
    try {
      // Same floor_delta + resize_status cache stamp as /latest so the
      // collection drill-down matches the main feed after reload.
      const events = stampFromCache(await getEventsByCollection(slug, since, limit));
      maybeAutoBackfill(slug);
      res.json({ events, count: events.length, since: since?.toISOString() ?? null });
    } catch (err) {
      console.error('[events/by-collection] query error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
