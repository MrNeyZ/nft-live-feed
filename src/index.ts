import 'dotenv/config';
import { createApp } from './server/app';
import { getPool } from './db/client';
import { startListener } from './ingestion/listener';
import { startAmmPoller } from './ingestion/amm-poller';
// import { startRawPoller } from './ingestion/raw-poller'; // disabled — see below
// ↓ Helius enhanced poller — disabled while raw pipeline is validated.
//   Do NOT delete. Re-enable if raw path needs rollback.
// import { startPoller } from './ingestion/poller';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
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
  });

  // raw-poller disabled — getSignaturesForAddress is rate-limited on this RPC
  // even at soft settings. Re-enable once a higher-tier RPC is available.
  // await startRawPoller();

  // Listener-only mode: logsSubscribe WebSocket per program.
  startListener();

  // AMM gap-healer: light fallback polling for mmm + tamm only (5 min / 5 sigs).
  startAmmPoller();

  // startPoller(); // Helius enhanced poller — disabled, see import above
}

main().catch((err) => {
  console.error('[startup] fatal', err);
  process.exit(1);
});
