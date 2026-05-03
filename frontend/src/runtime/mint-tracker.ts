// Frontend mint-tracker client. Thin wrapper around /api/mints/runtime
// — independent from the trade runtime mode, drives the TopNav MINTS
// ON/OFF pill.

import { authHeaders, clearAuth } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function fetchMintTrackerEnabled(): Promise<boolean | null> {
  try {
    const res = await fetch(`${API_BASE}/api/mints/runtime`);
    if (!res.ok) return null;
    const body = await res.json() as { enabled?: boolean };
    return typeof body.enabled === 'boolean' ? body.enabled : null;
  } catch {
    return null;
  }
}

/** Change the backend mint-tracker enabled flag. Returns the resolved
 *  flag on success, `null` on failure. 401 → auth expired → clear
 *  token so the caller re-renders into the login screen. */
export async function setMintTrackerEnabled(enabled: boolean): Promise<boolean | null> {
  try {
    const res = await fetch(`${API_BASE}/api/mints/runtime`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body:    JSON.stringify({ enabled }),
    });
    if (res.status === 401) { clearAuth(); return null; }
    if (!res.ok) return null;
    const body = await res.json() as { enabled?: boolean };
    return typeof body.enabled === 'boolean' ? body.enabled : null;
  } catch {
    return null;
  }
}
