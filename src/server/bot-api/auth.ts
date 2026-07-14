/**
 * Bearer auth for the VictoryLabs Internal Bot API (`/api/internal/bots/v1/*`).
 *
 * Deliberately separate from `src/server/runtime.ts`'s `requireAuth` (SIWS
 * wallet + HMAC session token, built for a human browser login flow) and
 * from `src/auth/siws.ts`. Bots hold one static, long-lived shared secret —
 * `BOT_API_KEY` — presented as `Authorization: Bearer <key>` on every call.
 *
 * Fail-closed: an absent/blank `BOT_API_KEY` env var makes EVERY request
 * 401, never a silent bypass. Constant-time comparison
 * (`crypto.timingSafeEqual`, same primitive `runtime.ts`/`siws.ts` already
 * use elsewhere in this codebase) so response timing can't leak how many
 * leading bytes of a guessed key were correct. The presented/expected key
 * values are never logged — only pass/fail + reason.
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

function extractBearer(req: Request): string | null {
  const h = req.header('authorization') ?? req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Re-read on every request (not cached at module load) so a key rotated
 *  via env + process restart takes effect without any code change, and so
 *  tests can flip `process.env.BOT_API_KEY` between cases. */
function expectedKey(): string | null {
  const v = (process.env.BOT_API_KEY ?? '').trim();
  return v.length > 0 ? v : null;
}

function allowedIps(): Set<string> | null {
  const raw = (process.env.BOT_API_ALLOWED_IPS ?? '').trim();
  if (!raw) return null;
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

/** Strip an IPv6-mapped IPv4 prefix so `::ffff:1.2.3.4` matches an
 *  allowlist entry of `1.2.3.4`. Mirrors the identical helper in
 *  `sse.ts` — kept as a local copy rather than an import so this module
 *  has no dependency on the public SSE route file. */
function normalizeIp(ip: string): string {
  const t = ip.trim();
  return t.startsWith('::ffff:') ? t.slice(7) : t;
}

/** Same client-IP resolution priority as `rate-limit.ts`'s `clientIp` /
 *  `sse.ts`'s `clientIpForCap`: CF-Connecting-IP (Cloudflare-set, not
 *  client-spoofable given the origin isn't directly reachable) → first
 *  X-Forwarded-For hop → `req.ip` / socket. Kept as a local copy (not
 *  imported) since neither source file exports its version. */
function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return normalizeIp(cf);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket.remoteAddress || 'unknown');
}

function timingSafeEqualStr(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal-length buffers; a length mismatch is
  // itself decided in constant time relative to the SECRET (the attacker
  // already controls `presented`'s length by construction), so returning
  // false here without a compare leaks nothing timingSafeEqual would have
  // protected — identical reasoning to auth/siws.ts's own length guard.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Express middleware. Mount on every `/api/internal/bots/v1/*` route.
 *  401 covers: BOT_API_KEY not configured, missing Authorization header,
 *  or a key that doesn't match — deliberately the same status for all
 *  three so probing can't distinguish "unconfigured" from "wrong key".
 *  403 is reserved for a configured, correct key from a non-allowlisted
 *  IP (a distinct failure the bot operator should be able to tell apart
 *  from a bad credential when debugging). */
export function requireBotAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = expectedKey();
  if (!expected) {
    res.status(401).json({ error: 'unauthorized', reason: 'not_configured' });
    return;
  }
  const presented = extractBearer(req);
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    res.status(401).json({ error: 'unauthorized', reason: presented ? 'invalid_key' : 'missing_key' });
    return;
  }

  const allow = allowedIps();
  if (allow) {
    const ip = clientIp(req);
    if (!allow.has(ip)) {
      console.warn(`[bot-api] reject reason=ip_not_allowed ip=${ip}`);
      res.status(403).json({ error: 'forbidden', reason: 'ip_not_allowed' });
      return;
    }
  }

  next();
}
