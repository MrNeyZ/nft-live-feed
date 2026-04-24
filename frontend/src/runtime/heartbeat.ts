// Frontend-tab liveness ping.
//
// Main app pages (Dashboard / Live Feed / Collection) mount a heartbeat so
// the backend knows at least one tab is still open. If every tab closes and
// no heartbeat arrives within IDLE_TIMEOUT_MS on the server, the backend
// flips runtime mode back to `off` on its own and stops burning Helius
// credits. /access intentionally never pings.

import { authHeaders, isAuthed } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Fire-and-forget single ping. 401 ⇒ we're no longer authed; silently no-op. */
export async function sendHeartbeat(): Promise<void> {
  if (!isAuthed()) return;
  try {
    await fetch(`${API_BASE}/api/runtime/heartbeat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body:    '{}',
      keepalive: true,
    });
  } catch {
    /* network blip — next interval retries */
  }
}

export const HEARTBEAT_INTERVAL_MS = 20_000;
