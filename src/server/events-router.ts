import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { getLatestEvents, getEventsByCollection } from '../db/queries';
import { getPool } from '../db/client';

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

/** Fire-and-forget: spawn the historical backfill script when a slug has
 *  fewer than AUTO_BACKFILL_BELOW rows. In-memory lock prevents repeated
 *  spawns for the same slug within AUTO_BACKFILL_TTL_MS. Never awaited;
 *  never blocks the request that triggered it. */
function maybeAutoBackfill(slug: string): void {
  if (activeBackfills.has(slug)) return;
  activeBackfills.add(slug);
  setTimeout(() => activeBackfills.delete(slug), AUTO_BACKFILL_TTL_MS);
  getPool()
    .query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sale_events WHERE me_collection_slug = $1',
      [slug],
    )
    .then(r => {
      const count = parseInt(r.rows[0]?.count ?? '0', 10);
      if (count >= AUTO_BACKFILL_BELOW) {
        activeBackfills.delete(slug);
        return;
      }
      console.log(`[events/by-collection] auto-backfill spawn slug=${slug} db_count=${count}`);
      // Collection page window is 7 days; keep backfill aligned so the
      // spawn completes quickly (1–2 ME pages) instead of paging 30 days of
      // activities the page never displays.
      const child = spawn('npm', ['run', 'backfill:me', '--', slug, '--days=7'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => console.error(`[events/by-collection] auto-backfill spawn error slug=${slug}`, err));
      child.unref();
    })
    .catch(err => {
      activeBackfills.delete(slug);
      console.error(`[events/by-collection] auto-backfill count check failed slug=${slug}`, err);
    });
}

export function createEventsRouter(): Router {
  const router = Router();

  router.get('/latest', async (req: Request, res: Response) => {
    const raw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Number.isNaN(raw) || raw < 1 ? DEFAULT_LIMIT : Math.min(raw, MAX_LIMIT);

    try {
      const events = await getLatestEvents(limit);
      res.json({ events, count: events.length });
    } catch (err) {
      console.error('[events] query error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  router.get('/by-collection', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) {
      res.status(400).json({ error: 'missing slug' });
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
      const events = await getEventsByCollection(slug, since, limit);
      maybeAutoBackfill(slug);
      res.json({ events, count: events.length, since: since?.toISOString() ?? null });
    } catch (err) {
      console.error('[events/by-collection] query error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
