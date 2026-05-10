// Sign-In With Solana — server-side primitives.
//
// Lifecycle of a SIWS login:
//   1. Client posts { wallet } to /api/auth/siws/nonce.
//   2. Server records (wallet, nonce, expiresAt) in `nonces`. Server returns
//      `{ nonce, message, expiresAt }`. `message` is the canonical text the
//      client wallet will be asked to sign.
//   3. Client asks Phantom (or any signMessage-capable wallet) to sign the
//      EXACT message bytes. Phantom returns a 64-byte ed25519 signature.
//   4. Client posts { wallet, signature, nonce, password } to
//      /api/auth/siws/verify.
//   5. Server reconstructs the canonical message FROM THE STORED NONCE — it
//      never trusts the client's copy. It checks nonce existence + freshness
//      + single-use, verifies the ed25519 signature against the stored
//      message bytes, validates the invite passphrase via timingSafeEqual,
//      and (on success) tells the caller to issue the existing HMAC bearer
//      token bound to this wallet.
//
// What the verify step does NOT do:
//   - It never reveals the canonical message stored in the nonce store back
//     to the client. The client's reconstruction must match byte-for-byte.
//   - It never reads the message from the request payload — message bytes
//     come from the in-memory nonce record, full stop.
//
// Threat model coverage:
//   replay        → nonces are single-use AND TTL'd (5 min); deleted in
//                   verify regardless of outcome.
//   substitution  → message is rebuilt server-side from (wallet, nonce);
//                   client cannot smuggle a different domain / wallet.
//   bruteforce    → ed25519 signatures over 256-bit keys; not feasible.
//   nonce sniping → nonce store is keyed by (wallet, nonce); issuing a
//                   fresh nonce for wallet does not invalidate other
//                   wallets' nonces.

import { randomBytes, timingSafeEqual } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ── Domain / message config ────────────────────────────────────────────────

/** Domain shown in the canonical message header — must match what the
 *  browser sees in the address bar. Falls back to the production host so
 *  a missing env doesn't accidentally accept signatures for "localhost"
 *  in production. Operators override via `SIWS_DOMAIN`. */
const DEFAULT_DOMAIN = 'victorylabs.app';
function siwsDomain(): string {
  return (process.env.SIWS_DOMAIN ?? '').trim() || DEFAULT_DOMAIN;
}
function siwsUri(): string {
  const explicit = (process.env.SIWS_URI ?? '').trim();
  return explicit || `https://${siwsDomain()}`;
}

const NONCE_TTL_MS = 5 * 60_000;
const NONCE_BYTES = 16; // 128 bits

// ── Nonce store ────────────────────────────────────────────────────────────

interface NonceRecord {
  wallet:    string;
  message:   string;
  issuedAt:  number;
  expiresAt: number;
}
/** Per-process in-memory store. Key = `<wallet>:<nonce>`. A restart wipes
 *  outstanding nonces; clients re-fetch. Bounded by opportunistic eviction
 *  triggered on every issue/verify so the map stays sized to "currently
 *  outstanding nonces", not unbounded. */
const nonces = new Map<string, NonceRecord>();
function key(wallet: string, nonce: string): string { return `${wallet}:${nonce}`; }

function evictExpired(now: number): void {
  if (nonces.size <= 256) return;
  let n = 0;
  for (const [k, v] of nonces) {
    if (v.expiresAt <= now) { nonces.delete(k); if (++n >= 16) break; }
  }
}

// ── Canonical message ──────────────────────────────────────────────────────

/** Single source of truth for the bytes a wallet must sign. Hand-written
 *  rather than depending on the SIWS NPM package so we avoid pulling in
 *  another dep and so the format is auditable inline. Whitespace and
 *  newlines are significant — Phantom shows this verbatim. */
function buildMessage(wallet: string, nonce: string, now: Date, exp: Date): string {
  const domain = siwsDomain();
  const uri    = siwsUri();
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Sign in to VictoryLabs',
    '',
    `URI: ${uri}`,
    'Version: 1',
    'Chain ID: solana:mainnet',
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${exp.toISOString()}`,
  ].join('\n');
}

// ── Input shape guards ─────────────────────────────────────────────────────

function isValidWallet(s: unknown): s is string {
  return typeof s === 'string'
      && s.length >= 32 && s.length <= 44
      && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
function isValidNonceShape(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s); // 16 bytes hex
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface IssuedNonce {
  nonce:     string;
  message:   string;
  expiresAt: number; // ms epoch
}

/** Issue a fresh nonce + canonical message for the given wallet. */
export function issueNonce(wallet: string): IssuedNonce | { error: string } {
  if (!isValidWallet(wallet)) return { error: 'invalid_wallet' };
  const now = new Date();
  const exp = new Date(now.getTime() + NONCE_TTL_MS);
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const message = buildMessage(wallet, nonce, now, exp);
  nonces.set(key(wallet, nonce), {
    wallet,
    message,
    issuedAt:  now.getTime(),
    expiresAt: exp.getTime(),
  });
  evictExpired(now.getTime());
  return { nonce, message, expiresAt: exp.getTime() };
}

export type VerifyError =
  | 'invalid_wallet'
  | 'invalid_nonce_shape'
  | 'unknown_nonce'
  | 'expired_nonce'
  | 'wallet_mismatch'
  | 'invalid_signature_shape'
  | 'bad_signature'
  | 'bad_passphrase'
  | 'passphrase_unconfigured';

export interface VerifyOk {
  ok:        true;
  wallet:    string;
}
export interface VerifyFail {
  ok:        false;
  reason:    VerifyError;
}
export type VerifyResult = VerifyOk | VerifyFail;

/** Verify a SIWS signature + invite passphrase. On any failure path the
 *  nonce is still consumed (delete-on-touch) so a bad signature can't be
 *  retried with the same nonce — the client must re-issue.
 *
 *  Callers (the runtime route) are responsible for the wallet-allowlist
 *  check and for issuing the HMAC bearer token on a true result. */
export function verifyLogin(args: {
  wallet:    unknown;
  nonce:     unknown;
  signatureB64: unknown;
  passphrase:   unknown;
}): VerifyResult {
  const { wallet, nonce, signatureB64, passphrase } = args;
  if (!isValidWallet(wallet))    return { ok: false, reason: 'invalid_wallet' };
  if (!isValidNonceShape(nonce)) return { ok: false, reason: 'invalid_nonce_shape' };

  const record = nonces.get(key(wallet, nonce));
  // Single-use: consume regardless of what we find below.
  if (record) nonces.delete(key(wallet, nonce));
  if (!record) return { ok: false, reason: 'unknown_nonce' };

  const now = Date.now();
  evictExpired(now);
  if (record.expiresAt <= now) return { ok: false, reason: 'expired_nonce' };
  if (record.wallet !== wallet) return { ok: false, reason: 'wallet_mismatch' };

  // Signature must be a base64 string decoding to 64 bytes.
  if (typeof signatureB64 !== 'string') return { ok: false, reason: 'invalid_signature_shape' };
  let sigBytes: Buffer;
  try { sigBytes = Buffer.from(signatureB64, 'base64'); }
  catch { return { ok: false, reason: 'invalid_signature_shape' }; }
  if (sigBytes.length !== 64) return { ok: false, reason: 'invalid_signature_shape' };

  // Public key from wallet address (base58 → 32 bytes).
  let pubBytes: Uint8Array;
  try { pubBytes = bs58.decode(wallet); }
  catch { return { ok: false, reason: 'invalid_wallet' }; }
  if (pubBytes.length !== 32) return { ok: false, reason: 'invalid_wallet' };

  const msgBytes = Buffer.from(record.message, 'utf8');
  const sigOk = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  // Invite passphrase — constant-time compare against UI_AUTH_PASSWORD.
  // SIWS is the real auth factor (the wallet signature); the passphrase is
  // an invite gate so we keep one operator-controlled string the audience
  // has to know before they can even try to log in. When SIWS is the
  // only required factor, the passphrase length floor is relaxed in
  // env-validation.
  const expected = (process.env.UI_AUTH_PASSWORD ?? '').trim();
  if (!expected) return { ok: false, reason: 'passphrase_unconfigured' };
  if (typeof passphrase !== 'string') return { ok: false, reason: 'bad_passphrase' };
  const a = Buffer.from(passphrase, 'utf8');
  const b = Buffer.from(expected,   'utf8');
  // timingSafeEqual requires equal-length buffers. Compare length first so
  // mismatch leaks no timing about the expected length beyond what the env
  // file would already reveal to anyone with access.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_passphrase' };
  }
  return { ok: true, wallet };
}

/** Test hook: returns the current map size. NEVER use this in a route. */
export function _outstandingNonceCount(): number { return nonces.size; }

/** Test hook: returns whether SIWS is required per env. */
export function siwsRequired(): boolean {
  return (process.env.AUTH_REQUIRE_SIWS ?? '').trim().toLowerCase() === 'true';
}
