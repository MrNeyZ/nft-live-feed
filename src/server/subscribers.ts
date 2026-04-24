/**
 * Cold-slug registry (heartbeat-based).
 *
 * Tracks which collection slugs currently have at least one active Collection
 * page tab. Used to gate the `listing_refresh_hint` path in listings-store:
 * cold slugs skip the expensive ensureFresh snapshot; hot slugs keep full
 * real-time behavior. Live Feed and Dashboard do NOT heartbeat — per spec
 * only Collection page viewers count as hot.
 *
 * Heartbeat model (chosen over per-tab ref-counting for robustness against
 * tab-close / network drop / page reload):
 *   - Collection page pings `/api/collections/heartbeat?slug=X` every 20 s.
 *   - A slug is "hot" if its most recent ping is within HEARTBEAT_TTL_MS.
 *   - A background sweep drops stale entries every 60 s.
 *
 * Fail-open invariants:
 *   - If no heartbeat ever arrives (e.g. frontend disabled this call),
 *     every slug is cold → refresh hints are suppressed. Not catastrophic:
 *     listings still arrive via the GET /api/collections/listings path
 *     (cached 30 s server-side) when a user actually opens the page.
 *   - The listings-store's endpoint-triggered `ensureFresh` (called from
 *     GET /listings on a hot page load) is NOT gated here — it covers the
 *     cold→hot transition the moment a user opens the collection.
 */

import { Router, Request, Response } from 'express';

const HEARTBEAT_TTL_MS = 45_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_SLUG_LEN = 200;

const lastSeen = new Map<string, number>();

export function touchSlug(slug: string): void {
  lastSeen.set(slug, Date.now());
}

export function isSlugHot(slug: string): boolean {
  const ts = lastSeen.get(slug);
  return ts != null && Date.now() - ts < HEARTBEAT_TTL_MS;
}

export function hotSlugCount(): number {
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  let n = 0;
  for (const ts of lastSeen.values()) if (ts >= cutoff) n++;
  return n;
}

setInterval(() => {
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  for (const [slug, ts] of lastSeen) if (ts < cutoff) lastSeen.delete(slug);
}, SWEEP_INTERVAL_MS).unref();

export function createSubscribersRouter(): Router {
  const router = Router();
  router.get('/heartbeat', (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug || slug.length > MAX_SLUG_LEN) {
      res.status(400).json({ error: 'missing_or_invalid_slug' });
      return;
    }
    touchSlug(slug);
    res.json({ ok: true });
  });
  return router;
}
