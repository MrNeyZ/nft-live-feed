// Control-plane routes for the runtime-mode feature.
//
// Wallet-first gated access:
//   - Login requires BOTH a wallet (whitelist via UI_ALLOWED_WALLETS env)
//     AND the shared password (UI_AUTH_PASSWORD env).
//   - UI_ALLOWED_WALLETS: comma-separated base58 addresses. Empty / unset ⇒
//     allow any wallet (dev convenience). Production should set this.
//   - On successful login the backend issues a short-lived HMAC-signed token
//     bound to the wallet. The token carries {wallet, iat, exp}; the frontend
//     stores it in localStorage and sends it as `Authorization: Bearer …` on
//     subsequent protected calls. `requireAuth` verifies the signature and
//     expiry — the raw UI_AUTH_PASSWORD is never sent back over the wire
//     after login, and a leaked token expires on its own.
//
// Signing secret precedence:
//   UI_AUTH_SECRET   — preferred; independent of the login password
//   UI_AUTH_PASSWORD — fallback so deployments without UI_AUTH_SECRET still work
//
// Endpoints:
//   POST /api/auth/login         { wallet, password }       → 200 or 401
//   GET  /api/runtime/mode                                    → { mode }
//   POST /api/runtime/mode       { mode }    (Bearer)         → { ok, mode }

import { Router, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getMode, setMode, isRuntimeMode, isMintTrackerEnabled, setMintTrackerEnabled } from '../runtime/mode';
import { rateLimit } from './rate-limit';

// ── Idle auto-off ──────────────────────────────────────────────────────────
// If no frontend tab has checked in for IDLE_TIMEOUT_MS and a non-`off` mode
// is active, force the mode back to `off` so Helius credits stop burning when
// nobody's actually watching. The frontend posts a heartbeat from its main
// app pages (Dashboard / Feed / Collection) — never from /access.
//
// `lastSeenAt` is initialized lazily the first time a mode goes active. That
// avoids a cold-boot race where the watcher would auto-off mode before the
// first heartbeat could land.

const IDLE_TIMEOUT_MS = 90_000;
const WATCHER_TICK_MS = 10_000;

let lastSeenAt: number | null = null;
let watcherTimer: NodeJS.Timeout | null = null;

function markFrontendSeen(): void {
  lastSeenAt = Date.now();
  ensureWatcher();
}

function ensureWatcher(): void {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    if (getMode() === 'off') return;
    if (lastSeenAt == null) return;
    if (Date.now() - lastSeenAt <= IDLE_TIMEOUT_MS) return;
    console.log(`[runtime] idle auto-off: no frontend heartbeat for ${IDLE_TIMEOUT_MS}ms`);
    void setMode('off');
  }, WATCHER_TICK_MS);
  if (typeof watcherTimer.unref === 'function') watcherTimer.unref();
}

/** Resolve the shared-secret password from env. No default: an unset env
 *  var must FAIL login rather than silently accept some fallback. The
 *  login handler short-circuits to 401 when this returns null. */
function expectedPassword(): string | null {
  const v = process.env.UI_AUTH_PASSWORD;
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

/** Parse UI_ALLOWED_WALLETS into a Set. Empty / unset ⇒ `null` meaning
 *  "no whitelist, accept any wallet" (dev default). */
function allowedWallets(): Set<string> | null {
  const raw = (process.env.UI_ALLOWED_WALLETS ?? '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function isValidWallet(wallet: unknown): wallet is string {
  // Solana base58 pubkeys are 32-44 chars, charset [1-9A-HJ-NP-Za-km-z].
  return typeof wallet === 'string'
      && wallet.length >= 32 && wallet.length <= 44
      && /^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet);
}

function extractBearer(req: Request): string | null {
  const h = req.header('authorization') ?? req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

// ── Signed-token auth ──────────────────────────────────────────────────────
//
// Token layout: `<payload-b64url>.<signature-b64url>`
//   payload   = JSON.stringify({ w: wallet, iat, exp })  (seconds since epoch)
//   signature = HMAC-SHA256(secret, payload-b64url)
//
// Verified with `timingSafeEqual` so signature comparison is constant-time.

const TOKEN_LIFETIME_SEC = 12 * 60 * 60; // 12 hours

type TokenReason = 'missing' | 'malformed' | 'bad_signature' | 'expired';
type VerifyResult =
  | { ok: true;  wallet: string; exp: number }
  | { ok: false; reason: TokenReason };

function signingSecret(): string | null {
  const explicit = (process.env.UI_AUTH_SECRET ?? '').trim();
  if (explicit.length > 0) return explicit;
  // Dev convenience: fall back to the login password so `npm run dev` works
  // with just UI_AUTH_PASSWORD set. In production this fallback is refused
  // — `validateEnv()` already blocks startup with a clear message, and this
  // second guard makes sure a runtime code path can't accidentally reuse
  // the login password as the token signing secret.
  if (process.env.NODE_ENV === 'production') return null;
  const fallback = (process.env.UI_AUTH_PASSWORD ?? '').trim();
  return fallback.length > 0 ? fallback : null;
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function issueToken(wallet: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const secret = signingSecret();
  if (!secret) throw new Error('signing secret not configured');
  const payload = JSON.stringify({ w: wallet, iat: nowSec, exp: nowSec + TOKEN_LIFETIME_SEC });
  const payloadB64 = b64urlEncode(payload);
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

function verifyToken(token: string): VerifyResult {
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: 'bad_signature' };
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest();
  let presented: Buffer;
  try { presented = b64urlDecode(sigB64); } catch { return { ok: false, reason: 'malformed' }; }
  if (presented.length !== expectedSig.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(presented, expectedSig)) return { ok: false, reason: 'bad_signature' };

  let payload: { w?: unknown; iat?: unknown; exp?: unknown };
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
  catch { return { ok: false, reason: 'malformed' }; }

  const wallet = payload.w;
  const exp    = payload.exp;
  if (typeof wallet !== 'string' || typeof exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.floor(Date.now() / 1000) >= exp) return { ok: false, reason: 'expired' };
  return { ok: true, wallet, exp };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!signingSecret()) {
    res.status(500).json({ error: 'server auth misconfigured' });
    return;
  }
  const presented = extractBearer(req);
  if (!presented) {
    res.status(401).json({ error: 'unauthorized', reason: 'missing' });
    return;
  }
  const v = verifyToken(presented);
  if (!v.ok) {
    const status = v.reason === 'expired' ? 401 : 401;
    res.status(status).json({ error: 'unauthorized', reason: v.reason });
    return;
  }
  next();
}

export function createRuntimeRouter(): Router {
  const router = Router();

  // Per-endpoint rate limits — strict on login, moderate on mode, relaxed
  // on heartbeat (which fires every 20s from every live main-app tab).
  // GET /api/runtime/mode is intentionally NOT limited: it's read-only and
  // called by the Gate screen on every mount.
  const loginLimit     = rateLimit({ limit: 5,   windowMs: 5 * 60_000, label: 'auth/login'      });
  const modeLimit      = rateLimit({ limit: 20,  windowMs: 60_000,     label: 'runtime/mode'    });
  const heartbeatLimit = rateLimit({ limit: 120, windowMs: 60_000,     label: 'runtime/heartbeat' });

  router.post('/auth/login', loginLimit, (req: Request, res: Response) => {
    const wallet = req.body?.wallet;
    const pw     = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!isValidWallet(wallet)) {
      res.status(400).json({ error: 'invalid wallet' });
      return;
    }
    const allow = allowedWallets();
    if (allow && !allow.has(wallet)) {
      res.status(401).json({ error: 'wallet not permitted' });
      return;
    }
    const expected = expectedPassword();
    if (!expected) {
      res.status(500).json({ error: 'server auth misconfigured' });
      return;
    }
    if (!pw || pw !== expected) {
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    if (!signingSecret()) {
      res.status(500).json({ error: 'server auth misconfigured' });
      return;
    }
    // Issue a 12h HMAC-signed token bound to this wallet. The raw password
    // is never sent back — a leaked token self-expires and can be invalidated
    // by rotating UI_AUTH_SECRET without changing the login password.
    const nowSec = Math.floor(Date.now() / 1000);
    const token = issueToken(wallet, nowSec);
    res.json({ ok: true, token, expiresAt: (nowSec + TOKEN_LIFETIME_SEC) * 1000 });
  });

  router.get('/runtime/mode', (_req: Request, res: Response) => {
    res.json({ mode: getMode() });
  });

  router.post('/runtime/mode', modeLimit, requireAuth, async (req: Request, res: Response) => {
    const requested = req.body?.mode;
    if (!isRuntimeMode(requested)) {
      res.status(400).json({ error: 'invalid mode' });
      return;
    }
    await setMode(requested);
    // When the operator manually turns the pipeline active, give the frontend
    // a grace window so the idle watcher can't fire before the first tab
    // heartbeat arrives.
    if (requested !== 'off') markFrontendSeen();
    res.json({ ok: true, mode: getMode() });
  });

  // Frontend liveness ping. Main app pages (TopNav-bearing routes) post here
  // on a short interval; /access is intentionally excluded. Auth-gated so an
  // unauthenticated visitor can't keep the pipeline alive.
  router.post('/runtime/heartbeat', heartbeatLimit, requireAuth, (_req: Request, res: Response) => {
    markFrontendSeen();
    res.json({ ok: true, mode: getMode() });
  });

  // Mint tracker on/off — independent from trade runtime mode. GET is
  // public (no creds) so the TopNav badge can render the current state
  // without auth on every nav. POST is auth-gated and rate-limited
  // alongside the trade-mode endpoint to share back-pressure budget.
  router.get('/mints/runtime', (_req: Request, res: Response) => {
    res.json({ enabled: isMintTrackerEnabled() });
  });
  router.post('/mints/runtime', modeLimit, requireAuth, (req: Request, res: Response) => {
    const requested = req.body?.enabled;
    if (typeof requested !== 'boolean') {
      res.status(400).json({ error: 'invalid enabled flag' });
      return;
    }
    setMintTrackerEnabled(requested);
    res.json({ ok: true, enabled: isMintTrackerEnabled() });
  });

  return router;
}
