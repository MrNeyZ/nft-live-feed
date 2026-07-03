// Frontend auth helpers for the control-plane.
//
// Backend issues a short-lived HMAC-signed token on successful login. We
// stash it in localStorage so it persists across tabs + reloads within the
// same browser — opening a collection in a new tab mustn't re-prompt.
// `clearAuth()` (called by OFF or on any 401) wipes it and the Gate falls
// back to the login screen. The token self-expires after 12h; a 401 with
// `reason:"expired"` is treated exactly like any other 401 — we clear and
// send the user back to /access.

import { playUiLogin } from '../soloist/use-ui-sound';

const TOKEN_KEY = 'ui-auth-token';
const API_BASE  = process.env.NEXT_PUBLIC_API_URL ?? '';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private-mode: ignore */ }
}

export function clearAuth(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function isAuthed(): boolean {
  return !!getToken();
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * Audit-view flag — true only when the server-side Next middleware has
 * validated a matching `?audit=<AUDIT_BYPASS_TOKEN>` and set the read-only
 * view cookie (`vl_audit_view=1`). This unlocks ONLY the frontend view gate
 * (see Gate.tsx): it deliberately never touches TOKEN_KEY, so `getToken()` /
 * `isAuthed()` / `authHeaders()` stay empty and every backend requireAuth
 * (write) path — buy, mint, send-tx, offer-scan, runtime-mode POST — still
 * rejects an audit session. The cookie carries only a boolean marker, never
 * the secret token. Read-only by construction.
 */
export function isAuditView(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').includes('vl_audit_view=1');
}

/**
 * Attempt login with a wallet + password. Backend validates both and, on
 * success, returns an opaque HMAC-signed token that carries {wallet, iat, exp}.
 * Callers should only touch it via `getToken()` / `authHeaders()` —
 * the format is a backend-internal contract and may change.
 *
 * Legacy path: kept for environments where AUTH_REQUIRE_SIWS=false.
 * When the backend has SIWS enabled, this endpoint returns 410 and
 * `login()` resolves false so the caller falls through to
 * `loginWithSiws()` (or surfaces a UI error).
 */
export async function login(wallet: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet, password }),
    });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean; token?: string };
    if (!body.ok || typeof body.token !== 'string') return false;
    setToken(body.token);
    playUiLogin();  // explicit user-action login success — single, throttled tick
    return true;
  } catch {
    return false;
  }
}

// ── Sign-In With Solana ─────────────────────────────────────────────────────
//
// Three-step orchestrator that drives the wallet's signMessage path:
//   1. POST /api/auth/siws/nonce { wallet } → { nonce, message, expiresAt }
//   2. ask Phantom (or any signMessage-capable provider) to sign the EXACT
//      message bytes returned by the server.
//   3. POST /api/auth/siws/verify { wallet, nonce, signature, password }
//      → { ok, token } (the same 12 h HMAC bearer as legacy login).
//
// signMessage is a Phantom-defined method that takes a Uint8Array and an
// optional encoding string. It returns `{ signature: Uint8Array }`. We
// re-encode the signature as base64 for transport because URL-safe
// transport of binary in JSON is fiddly otherwise.
//
// Errors from any step are normalized to a single result type so the UI
// can branch on a small reason set instead of a free-form string.

export type SiwsErrorReason =
  | 'no_wallet'           // injected provider doesn't expose signMessage
  | 'wallet_rejected'     // user cancelled the signMessage prompt
  | 'nonce_failed'        // server refused to issue a nonce
  | 'verify_failed'       // server rejected signature/passphrase
  | 'network'             // fetch threw / non-JSON response
  | 'malformed_response'; // server response missing fields

export interface SiwsResult {
  ok: true;
}
export interface SiwsFail {
  ok: false;
  reason: SiwsErrorReason;
  /** Optional server-supplied reason code (e.g. 'bad_signature'). Never
   *  contains user input; safe to surface in a tooltip or aria-label. */
  detail?: string;
}

interface SignMessageCapable {
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array | string }>;
}

/** Base64-encode a Uint8Array using the browser's btoa(). */
function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  // btoa is browser-only; this module is "use client" via every caller.
  return btoa(s);
}

/** Hex/base58 → Uint8Array helper. Phantom returns the raw byte buffer
 *  but some forks have been observed to return a base58 string instead;
 *  we accept either shape defensively. */
function signatureToBase64(sig: Uint8Array | string): string | null {
  if (sig instanceof Uint8Array) return b64encode(sig);
  // Fallback: if a string came back, just trust it as base64 — Phantom
  // never does this in practice but the type narrowing keeps us safe.
  if (typeof sig === 'string') return sig;
  return null;
}

/**
 * Full SIWS login flow. The caller passes in the injected wallet
 * provider (already connected) and the wallet's base58 pubkey + the
 * invite passphrase. On success the same bearer token used by the
 * legacy login path is persisted to localStorage and `getToken()` /
 * `authHeaders()` start returning it immediately.
 *
 * `provider` is a minimal shape rather than a full Phantom adapter —
 * the only method we use is signMessage. This keeps the dependency
 * direction one-way: the auth module doesn't know how to connect a
 * wallet, the caller does.
 */
export async function loginWithSiws(
  provider: SignMessageCapable,
  wallet: string,
  passphrase: string,
): Promise<SiwsResult | SiwsFail> {
  if (typeof provider.signMessage !== 'function') {
    return { ok: false, reason: 'no_wallet' };
  }

  // Step 1 — nonce
  let nonceBody: { nonce?: string; message?: string };
  try {
    const res = await fetch(`${API_BASE}/api/auth/siws/nonce`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet }),
    });
    if (!res.ok) return { ok: false, reason: 'nonce_failed', detail: `http_${res.status}` };
    nonceBody = await res.json() as { nonce?: string; message?: string };
  } catch {
    return { ok: false, reason: 'network' };
  }
  const nonce   = typeof nonceBody.nonce   === 'string' ? nonceBody.nonce   : '';
  const message = typeof nonceBody.message === 'string' ? nonceBody.message : '';
  if (!nonce || !message) return { ok: false, reason: 'malformed_response' };

  // Step 2 — sign. Encode as UTF-8 since the canonical message is ASCII.
  let signatureB64: string | null = null;
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signed = await provider.signMessage(messageBytes, 'utf8');
    signatureB64 = signatureToBase64(signed.signature);
  } catch {
    return { ok: false, reason: 'wallet_rejected' };
  }
  if (!signatureB64) return { ok: false, reason: 'malformed_response' };

  // Step 3 — verify
  let verifyBody: { ok?: boolean; token?: string; reason?: string };
  try {
    const res = await fetch(`${API_BASE}/api/auth/siws/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet, nonce, signature: signatureB64, password: passphrase }),
    });
    verifyBody = await res.json() as { ok?: boolean; token?: string; reason?: string };
    if (!res.ok) return { ok: false, reason: 'verify_failed', detail: verifyBody.reason };
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!verifyBody.ok || typeof verifyBody.token !== 'string') {
    return { ok: false, reason: 'verify_failed', detail: verifyBody.reason };
  }
  setToken(verifyBody.token);
  playUiLogin();  // explicit user-action SIWS login success
  return { ok: true };
}
