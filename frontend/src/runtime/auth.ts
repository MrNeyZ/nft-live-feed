// Frontend auth helpers for the control-plane.
//
// "Auth" is just the shared secret the backend expects as a Bearer token.
// We stash it in localStorage so it persists across tabs + reloads within
// the same browser — opening a collection in a new tab mustn't re-prompt.
// `clearAuth()` (called by OFF or on any 401) wipes it and the Gate falls
// back to the login screen.

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
 * Attempt login with a wallet + password. Backend validates both; on success
 * we stash the bearer token (which happens to equal the password — the
 * backend has no session layer). Callers should use `getToken()` / `authHeaders()`
 * rather than relying on that coincidence.
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
    return true;
  } catch {
    return false;
  }
}
