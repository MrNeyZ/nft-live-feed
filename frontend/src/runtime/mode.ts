// Frontend runtime-mode client. Thin wrapper around /api/runtime/mode.

import { authHeaders, clearAuth } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export type RuntimeMode = 'off' | 'full' | 'budget' | 'sales_only';
export const SELECTABLE_MODES: ReadonlyArray<Exclude<RuntimeMode, 'off'>> =
  ['full', 'budget', 'sales_only'];

export async function fetchMode(): Promise<RuntimeMode | null> {
  try {
    const res = await fetch(`${API_BASE}/api/runtime/mode`);
    if (!res.ok) return null;
    const body = await res.json() as { mode?: RuntimeMode };
    return body.mode ?? null;
  } catch {
    return null;
  }
}

/**
 * Change the backend runtime mode. Returns the new mode on success, `null`
 * on failure. A 401 is treated as "auth expired" — we clear the token so the
 * caller re-renders into the login screen.
 */
export async function setMode(next: RuntimeMode): Promise<RuntimeMode | null> {
  try {
    const res = await fetch(`${API_BASE}/api/runtime/mode`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body:    JSON.stringify({ mode: next }),
    });
    if (res.status === 401) { clearAuth(); return null; }
    if (!res.ok) return null;
    const body = await res.json() as { mode?: RuntimeMode };
    return body.mode ?? null;
  } catch {
    return null;
  }
}
