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

/** Client IP extraction. With `app.set('trust proxy', 1)` configured in
 *  `createApp()`, Express's `req.ip` is the value nginx appended to
 *  X-Forwarded-For (i.e., the real connecting client) — NOT the first
 *  header-supplied entry, which a hostile client controls. We deliberately
 *  do NOT parse `x-forwarded-for` ourselves any more: that field arrives as
 *  `<attacker_value>, <real_ip>` and the first comma-segment is forgeable.
 *  Trusting `req.ip` is the only correct path behind this single-hop proxy
 *  topology. Falls back to the socket peer for direct-loopback dev (no
 *  proxy in front) and an `unknown` sentinel as a last resort so the
 *  rate-limit map never holds an empty key. */
function clientIp(req: Request): string {
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

// ── Shared shape validators ─────────────────────────────────────────────────
// Hoisted here so every public endpoint applies the same rule and so a
// future tweak (e.g., relax to 80 chars) only edits one place. Used to
// fail-fast at the route layer BEFORE any DB / upstream call, so a flood
// of malformed-slug probes costs only the regex test.

/** Magic Eden / Tensor collection slug. Lowercase alphanumerics +
 *  `_`/`-`, 1–60 chars. Matches the shape ME/Tensor emit in their public
 *  URLs (`/marketplace/<slug>`); anything wider is junk we don't need to
 *  forward upstream. */
const SLUG_RE = /^[a-z0-9_-]{1,60}$/;
export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s);
}

/** Solana base58 mint address (32–44 chars). Rejects anything that would
 *  blow up `new PublicKey(...)` later in the upstream client. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidMint(s: unknown): s is string {
  return typeof s === 'string' && MINT_RE.test(s);
}
