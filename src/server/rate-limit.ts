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

/** Client IP for rate-limit bucket keying.
 *
 *  The real topology is Client → Cloudflare → nginx → Express — TWO proxy
 *  hops. `app.set('trust proxy', 1)` only unwinds ONE, so `req.ip` resolves to
 *  the Cloudflare EDGE IP (e.g. 172.68.x.x), not the real user. Keying buckets
 *  on that lumps every user behind a given edge into one bucket (false
 *  lockouts) and stops the limiter from isolating a single abuser. Mirror the
 *  SSE per-IP cap (`clientIpForCap` in sse.ts). Priority:
 *    1. CF-Connecting-IP — Cloudflare overwrites it at the edge to the true
 *       client; not client-spoofable as long as all ingress is forced through
 *       Cloudflare (the origin is not directly reachable — UFW CF-CIDR only).
 *    2. first (left-most) X-Forwarded-For entry — the original client.
 *    3. req.ip — single-hop / dev fallback.
 *    4. socket peer — direct-loopback dev with no proxy.
 *  An `unknown` sentinel is the last resort so the map never holds an empty
 *  key. Trust note: #1/#2 are trustworthy only because the origin is not
 *  directly exposed; if it were, the blast radius is just this bucket key,
 *  never auth/data. */
function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
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
