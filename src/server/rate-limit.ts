/**
 * Tiny in-memory fixed-window rate limiter.
 *
 * Per-IP, per-middleware-instance. Each call returns an independent Express
 * middleware with its own counter Map — so two endpoints mounting
 * `rateLimit({...})` don't share budget. State lives in memory only: a
 * restart resets every counter (acceptable for dev + single-instance prod,
 * matched by the backend singleton lock).
 *
 * Fixed windows are simple and good enough for abuse protection: if the
 * cap is N per W ms, a given IP cannot fire more than N successful calls
 * between windowStart and windowStart+W. Transitioning across a window
 * boundary resets the count — a user can theoretically hit 2×N in a short
 * span straddling the boundary. That burst is acceptable for our limits
 * (5/5min login, 20/min mode, 120/min heartbeat, 10/min buy).
 *
 * GC: whenever a counter is touched we evict any entry whose window has
 * ended. That keeps the Map bounded by the number of *currently-active*
 * IPs, no separate sweep interval needed.
 */

import { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  /** Max allowed requests per IP in each window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Short label included in logs for operator clarity. */
  label: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Best-effort client IP extraction that's safe behind a single proxy hop
 *  (the only supported production topology). Falls back to the socket peer
 *  so localhost dev works without any proxy headers. */
function clientIp(req: Request): string {
  const xff = req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const ip  = clientIp(req);
    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;

    // Opportunistic eviction: anytime we touch the map, drop a handful of
    // stale entries. Bounded work per request, no separate timer needed.
    if (buckets.size > 256) {
      let n = 0;
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) { buckets.delete(k); if (++n >= 16) break; }
      }
    }

    if (bucket.count > opts.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(opts.limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
      console.warn(`[rate-limit] ${opts.label}  429 ip=${ip}  count=${bucket.count}/${opts.limit}  retryAfter=${retryAfterSec}s`);
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(opts.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.limit - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    next();
  };
}
