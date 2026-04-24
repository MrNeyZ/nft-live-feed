import 'dotenv/config';
import { createApp } from './server/app';
import { getPool } from './db/client';
import { trimStartupLog } from './startup-log-trim';
// Ingestion (listener + AMM gap-healer) is started on demand via the
// runtime-mode endpoint (`POST /api/runtime/mode`). The HTTP server runs
// always; ingestion subsystems are toggled without restarting the process.
// import { startRawPoller } from './ingestion/raw-poller'; // disabled — see below
// ↓ Helius enhanced poller — disabled while raw pipeline is validated.
//   Do NOT delete. Re-enable if raw path needs rollback.
// import { startPoller } from './ingestion/poller';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Keep the captured log file bounded across restarts (no-op without LOG_FILE).
  trimStartupLog();

  // Verify DB connectivity on startup
  const pool = getPool();
  await pool.query('SELECT 1');
  console.log('[db] connected');

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] SSE feed: GET  /events/stream`);
    // Helius webhook route still registered but no longer primary path.
    // Disable in dashboard once raw pipeline is confirmed working.
    console.log(`[server] webhook:  POST /webhooks/helius (standby)`);
    console.log(`[server] ingestion: idle — POST /api/runtime/mode to start`);
  });

  // Ingestion starts in `off` by default. Operator auths via /api/auth/login
  // and calls /api/runtime/mode to pick FULL / BUDGET / SALES_ONLY. Previous
  // auto-start on boot is intentionally removed so OFF is the honest initial
  // state and the UI mode-select screen is the single source of truth.

  // startPoller(); // Helius enhanced poller — disabled, see import above
}

main().catch((err) => {
  console.error('[startup] fatal', err);
  process.exit(1);
});
