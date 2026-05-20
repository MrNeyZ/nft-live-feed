// Frontend runtime-mode client. Thin wrapper around /api/runtime/mode.

import { authHeaders, clearAuth } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export type RuntimeMode = 'off' | 'full' | 'budget' | 'sales_only';
export const SELECTABLE_MODES: ReadonlyArray<Exclude<RuntimeMode, 'off'>> =
  ['full', 'budget', 'sales_only'];

// The "Mint Tracker" runtime is backed by salesMode='off' + the independent
// mint tracker enabled — there is no dedicated backend mode for it. The Gate
// otherwise treats salesMode='off' as "nothing selected → show mode-select",
// so we persist the user's explicit choice locally: 'mints' makes the Gate
// treat an off-sales runtime as the active Mint Tracker view (no re-prompt);
// 'sales' is non-sticky (sales modes are in-memory backend state that resets,
// so those correctly fall back to mode-select). Cleared on logout.
export type RuntimeChoice = 'mints' | 'sales';
const RUNTIME_CHOICE_KEY = 'vl.runtimeChoice';

export function getRuntimeChoice(): RuntimeChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(RUNTIME_CHOICE_KEY);
    return v === 'mints' || v === 'sales' ? v : null;
  } catch { return null; }
}

export function setRuntimeChoice(choice: RuntimeChoice | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (choice == null) window.localStorage.removeItem(RUNTIME_CHOICE_KEY);
    else window.localStorage.setItem(RUNTIME_CHOICE_KEY, choice);
  } catch { /* ignore */ }
}

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
