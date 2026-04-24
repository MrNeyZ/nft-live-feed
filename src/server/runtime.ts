// Control-plane routes for the runtime-mode feature.
//
// Wallet-first gated access:
//   - Login requires BOTH a wallet (whitelist via UI_ALLOWED_WALLETS env)
//     AND the shared password (UI_AUTH_PASSWORD env).
//   - UI_ALLOWED_WALLETS: comma-separated base58 addresses. Empty / unset ⇒
//     allow any wallet (dev convenience). Production should set this.
//   - After login, the frontend stashes the password as a Bearer token on
//     subsequent protected calls. No sessions / cookies — the "token" IS
//     the password. Wallet identity is checked only at login; that's the
//     documented simplification.
//
// Endpoints:
//   POST /api/auth/login         { wallet, password }       → 200 or 401
//   GET  /api/runtime/mode                                    → { mode }
//   POST /api/runtime/mode       { mode }    (Bearer)         → { ok, mode }

import { Router, Request, Response, NextFunction } from 'express';
import { getMode, setMode, isRuntimeMode } from '../runtime/mode';

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

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = expectedPassword();
  if (!expected) { res.status(500).json({ error: 'server auth misconfigured' }); return; }
  const got = extractBearer(req);
  if (!got || got !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function createRuntimeRouter(): Router {
  const router = Router();

  router.post('/auth/login', (req: Request, res: Response) => {
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
    // Echo the password back as the bearer token. The frontend stores it and
    // sends it on subsequent protected calls. No real session — just a
    // consistent shape so the client doesn't have to special-case it.
    res.json({ ok: true, token: pw });
  });

  router.get('/runtime/mode', (_req: Request, res: Response) => {
    res.json({ mode: getMode() });
  });

  router.post('/runtime/mode', requireAuth, async (req: Request, res: Response) => {
    const requested = req.body?.mode;
    if (!isRuntimeMode(requested)) {
      res.status(400).json({ error: 'invalid mode' });
      return;
    }
    await setMode(requested);
    res.json({ ok: true, mode: getMode() });
  });

  return router;
}
