import 'dotenv/config';
import * as path from 'path';
import { createApp } from './server/app';
import { getPool } from './db/client';
import { trimStartupLog } from './startup-log-trim';
import { acquireSingleton } from './runtime/lock';
import { validateEnv } from './runtime/env-validation';
// Side-effect import: source-health subscribes to the sale event bus and
// starts its 15s staleness tick. Must load before any SSE client connects.
import './health/source-health';
// Side-effect import: mint accumulator runs its 30s sweep timer. Detector
// is started below in main() once the bus is wired.
import './mints/accumulator';
import { currentMintStatuses, hydrateAccumulatorFromSnapshot } from './mints/accumulator';
import { loadSnapshot, startSnapshotPersistence } from './mints/snapshot';
import { startMintDetector } from './mints/detector';
import { startCoreSupplyRefresher } from './mints/core-supply-refresher';
import { isMintTrackerEnabled, getMode } from './runtime/mode';
import { startListener } from './ingestion/listener';
import { getMintTrackerMode } from './ingestion/mint-raw/launchpad-detector';
// Ingestion (listener + AMM gap-healer) is started on demand via the
// runtime-mode endpoint (`POST /api/runtime/mode`). The HTTP server runs
// always; ingestion subsystems are toggled without restarting the process.
// import { startRawPoller } from './ingestion/raw-poller'; // disabled — see below
// ↓ Helius enhanced poller — disabled while raw pipeline is validated.
//   Do NOT delete. Re-enable if raw path needs rollback.
// import { startPoller } from './ingestion/poller';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Environment validation runs first. In production this exits(1) before
  // the lock is even acquired if any required secret is missing — the goal
  // is to make "deployed with dev defaults" an immediate, visible failure.
  validateEnv();

  // Single-instance guard — refuse to start if another backend owns the lock.
  // Running side-by-side would double every Helius subscription / poller call.
  // Lock lives under project root so it works identically on macOS and Linux
  // without relying on OS-specific paths (/var/run etc. would need sudo).
  acquireSingleton(path.join(process.cwd(), '.runtime', 'backend.lock'));

  // Keep the captured log file bounded across restarts (no-op without LOG_FILE).
  trimStartupLog();

  // Verify DB connectivity on startup
  const pool = getPool();
  await pool.query('SELECT 1');
  console.log('[db] connected');

  // Restore /mints accumulator from the on-disk snapshot so quiet
  // collections survive a pm2 restart / deploy. Must run BEFORE the
  // HTTP server starts accepting connections — the SSE bootstrap
  // in `currentMintStatuses()` ships whatever's in the map at the
  // moment a client connects. Fail-soft: a missing / corrupt file
  // returns null and we proceed with an empty map (the prior
  // pre-snapshot behaviour). Periodic save + graceful-shutdown
  // flush start right after so we don't drift if no fresh mints
  // arrive before the next restart.
  const snapshotRows = loadSnapshot();
  if (snapshotRows && snapshotRows.length > 0) {
    const n = hydrateAccumulatorFromSnapshot(snapshotRows);
    console.log(`[mints/snapshot] hydrated rows=${n}`);
  }
  startSnapshotPersistence(() => currentMintStatuses());

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] SSE feed: GET  /events/stream`);
    // Helius webhook route only registered when HELIUS_WEBHOOK_AUTH is
    // configured (see src/server/app.ts). Without the secret the route
    // is unmounted, so requests get a 404 from Express even though
    // nginx forwards /webhooks/.
    if ((process.env.HELIUS_WEBHOOK_AUTH ?? '').trim().length > 0) {
      console.log(`[server] webhook:  POST /webhooks/helius (standby, auth required)`);
    } else {
      console.log(`[server] webhook:  disabled (HELIUS_WEBHOOK_AUTH unset)`);
    }
    console.log(`[server] ingestion: idle — POST /api/runtime/mode to start`);
  });

  // Mint detector is bus-listener-only (zero RPC cost), so we start it
  // unconditionally at boot — it'll only see events once a runtime mode
  // is selected and the listener begins emitting.
  startMintDetector();
  // Core-supply refresher polls MPL Core CollectionV1 accounts in
  // ≤100-address batches every 30s to populate the SUPPLY column for
  // Core/VVV/GRAVE rows. Bounded RPC cost (one getMultipleAccounts per
  // tick); no effect when /mints is empty.
  startCoreSupplyRefresher();

  // Mint tracker runs 24/7 independent of trade runtime mode. When
  // `MINT_TRACKER_ENABLED` is set (default ON), the listener spins up
  // at boot so launchpad mints (LMNFT / vvv.so / Core / TM) flow into
  // /mints even before any operator selects a trade mode. The listener's
  // per-target `isTargetActive()` gate keeps sale-program subscriptions
  // dormant until trade mode flips on, so RPC usage stays scoped to
  // mint targets only.
  if (isMintTrackerEnabled()) {
    // Two-line boot signal so log scans can confirm 24/7 mint coverage
    // without needing to know which trade mode the operator booted in.
    // Format matches the runtime task spec: stable substrings the
    // operator can grep for in pm2 logs after a restart.
    console.log(`[mints] tracker enabled mode=${getMintTrackerMode()} independent=true`);
    console.log(`[mints/runtime] enabled=true salesMode=${getMode()} independent=true`);
    startListener();
  } else {
    console.log('[mints] tracker disabled');
  }

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
