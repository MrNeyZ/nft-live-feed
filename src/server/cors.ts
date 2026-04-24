/**
 * Origin-allowlist CORS middleware.
 *
 * Policy:
 *   - Allowlist is read from UI_ALLOWED_ORIGINS (comma-separated). Dev
 *     defaults cover http(s)://{localhost,127.0.0.1}:{3001,3002} so
 *     running `npm run dev` needs zero extra config.
 *   - Production (NODE_ENV=production) REQUIRES UI_ALLOWED_ORIGINS to be
 *     set — otherwise the server would silently be reachable by any
 *     origin, which is exactly the pre-hardening state we are replacing.
 *     We log a warning at startup in that case but still refuse to echo
 *     wildcards.
 *   - Unknown browser origins get NO CORS headers. The browser then
 *     refuses the response on its own (same-origin policy). This is a
 *     stronger signal than "200 with no allow-origin" would be: preflights
 *     fail with 403 instead of browser-surfacing a confusing CORS error.
 *   - Missing Origin header (curl, server-to-server) passes through —
 *     no allow-origin is set, which is correct: only browsers enforce
 *     CORS, and they always send Origin on cross-site XHR.
 *
 * Preflight (OPTIONS) responses explicitly set Allow-Methods and
 * Allow-Headers including Authorization so non-safelisted requests
 * (Bearer tokens) are accepted.
 */

import { Request, Response, NextFunction } from 'express';

const DEV_DEFAULTS = [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
];

const ALLOW_HEADERS = 'Content-Type, Authorization';
const ALLOW_METHODS = 'GET, POST, OPTIONS';

function parseAllowlist(): ReadonlySet<string> {
  const raw = (process.env.UI_ALLOWED_ORIGINS ?? '').trim();
  const configured = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const isProd = process.env.NODE_ENV === 'production';
  const merged = new Set<string>(configured);
  if (!isProd) for (const o of DEV_DEFAULTS) merged.add(o);
  if (isProd && merged.size === 0) {
    console.warn(
      '[cors] NODE_ENV=production but UI_ALLOWED_ORIGINS is unset — all browser ' +
      'cross-origin requests will be refused. Set UI_ALLOWED_ORIGINS=https://your-domain.com',
    );
  }
  return merged;
}

// Resolved once at startup. If operators change the env they restart the
// process anyway (nodemon re-execs on file change).
const ALLOW = parseAllowlist();

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');

  // Every response whose body can vary by Origin must declare that so
  // shared caches (reverse proxies, CDNs) don't pin one origin's
  // response to a different origin's request.
  res.setHeader('Vary', 'Origin');

  if (origin) {
    if (ALLOW.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    } else {
      // Unknown browser origin — deny preflights outright and omit
      // allow-origin on simple requests so the browser blocks the
      // response. Body is intentionally empty.
      if (req.method === 'OPTIONS') {
        res.status(403).end();
        return;
      }
      // Non-preflight from a rejected origin: continue without CORS
      // headers. The browser sees no Allow-Origin and refuses to expose
      // the response to the caller script.
    }
  }
  // No Origin header at all (curl, server-to-server, same-origin) — leave
  // the request alone. No CORS headers are needed and none are set.

  if (req.method === 'OPTIONS') {
    // Short-circuit preflight with the CORS headers above (if any) already
    // written. 204 No Content per the Fetch spec recommendation.
    res.status(204).end();
    return;
  }

  next();
}
