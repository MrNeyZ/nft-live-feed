/**
 * Startup environment validation.
 *
 * Production refuses to boot if any hard-required secret is missing or
 * empty — the goal is to make "we accidentally deployed with dev defaults"
 * a loud failure at start, not a silent security regression at runtime.
 *
 * Development mode only warns, to keep `npm run dev` friction-free.
 *
 * This module never logs a secret's value. Everything it prints is either
 * a variable NAME or a boolean/length summary.
 */

interface EnvRequirement {
  name: string;
  /** Why it's required. Shown in the error/warning line. */
  purpose: string;
  /** Optional extra predicate beyond "set and non-empty". */
  extra?: (value: string) => string | null;
}

const REQUIRED: ReadonlyArray<EnvRequirement> = [
  { name: 'UI_AUTH_PASSWORD', purpose: 'shared login passphrase' },
  {
    name: 'UI_AUTH_SECRET',
    purpose: 'HMAC signing secret for auth tokens',
    // Below ~32 hex chars (~128 bits) is trivially brute-forceable for a
    // production deployment. Reject obviously weak values at boot.
    extra: (v) => v.length < 16 ? 'must be at least 16 characters' : null,
  },
  { name: 'UI_ALLOWED_WALLETS',  purpose: 'comma-separated wallet whitelist' },
  { name: 'UI_ALLOWED_ORIGINS',  purpose: 'comma-separated CORS origin whitelist' },
  { name: 'HELIUS_API_KEY',      purpose: 'Solana RPC credentials' },
  { name: 'DATABASE_URL',        purpose: 'Postgres connection string' },
];

function trimmed(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const missing: Array<{ name: string; purpose: string }> = [];
  const weak:    Array<{ name: string; reason: string }> = [];

  for (const req of REQUIRED) {
    const v = trimmed(req.name);
    if (!v) { missing.push({ name: req.name, purpose: req.purpose }); continue; }
    if (req.extra) {
      const reason = req.extra(v);
      if (reason) weak.push({ name: req.name, reason });
    }
  }

  // Production-only: UI_AUTH_SECRET must NOT silently fall back to
  // UI_AUTH_PASSWORD. The runtime helper honours this, but we also flag
  // it here so the message is plain at startup rather than subtle later.
  if (isProd && !trimmed('UI_AUTH_SECRET') && trimmed('UI_AUTH_PASSWORD')) {
    missing.push({
      name:    'UI_AUTH_SECRET',
      purpose: 'distinct from UI_AUTH_PASSWORD — token signing must not reuse the login secret in production',
    });
  }

  if (isProd && (missing.length > 0 || weak.length > 0)) {
    console.error('[env] production startup refused — required environment not satisfied');
    for (const m of missing) console.error(`[env]   MISSING  ${m.name}  (${m.purpose})`);
    for (const w of weak)    console.error(`[env]   INVALID  ${w.name}  ${w.reason}`);
    console.error('[env] populate the variables above (see .env.production.example) and restart.');
    process.exit(1);
  }

  if (!isProd) {
    // Dev: warn but don't fail. Listing NAMES only — values never appear.
    for (const m of missing) console.warn(`[env] dev default in use for ${m.name}  (${m.purpose})`);
    for (const w of weak)    console.warn(`[env] dev-weak ${w.name}  ${w.reason}`);

    // Additional dev hints that don't block boot.
    if (!trimmed('UI_AUTH_SECRET') && trimmed('UI_AUTH_PASSWORD')) {
      console.warn('[env] UI_AUTH_SECRET unset — token signing falls back to UI_AUTH_PASSWORD (dev only)');
    }
    if (!trimmed('UI_ALLOWED_WALLETS')) {
      console.warn('[env] UI_ALLOWED_WALLETS empty — any wallet may log in (dev only)');
    }
    if (!trimmed('UI_ALLOWED_ORIGINS')) {
      console.warn('[env] UI_ALLOWED_ORIGINS empty — using localhost dev defaults only');
    }
  }

  console.log(`[env] startup validation ok  mode=${isProd ? 'production' : 'development'}`);
}
