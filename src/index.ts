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
import { currentMintStatuses, hydrateAccumulatorFromSnapshot, hydrateCountedMints } from './mints/accumulator';
import { loadSnapshot, startSnapshotPersistence } from './mints/snapshot';
import { loadCountedLedger, flushCountedLedgerNow } from './mints/counted-ledger';
import { startMintDetector } from './mints/detector';
import { startCoreSupplyRefresher } from './mints/core-supply-refresher';
import { startCollectionCreatedResolver } from './mints/collection-created-resolver';
import { startResizeStatusResolver } from './mints/resize-status-resolver';
import { startMmmPoolTypeResolver } from './ingestion/mmm-pool-type-resolver';
import { startMintEventPersistence } from './mints/event-store';
import { isMintTrackerEnabled, getMode } from './runtime/mode';
import { startListener } from './ingestion/listener';
import { startMintReconcile } from './ingestion/mint-raw/reconcile';
import { startMintNameBackfill } from './mints/name-backfill';
import { getMintTrackerMode } from './ingestion/mint-raw/launchpad-detector';
import { startRareFeed } from './rare-feed';
import { preloadBlockedMintsFromDb } from './db/blocked-mint-cache';
import { hydrateOwnershipLoopCache } from './enrichment/ownership-loop-cache';
import { hydrateRepeatFloorBuyerCache } from './enrichment/repeat-floor-buyer-cache';
import { startTradingStatusSweep } from './mints/trading-status-sweep';
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

  // Preload the blocked-mint cache from DB so previously-flagged DRiP /
  // staratlascrew / etc. mints never flash again after a restart. Must run
  // BEFORE the first insertSaleEvent so the pre-emit gate at insert.ts:115
  // sees a populated cache. Non-fatal on failure.
  await preloadBlockedMintsFromDb(pool);

  // Seed the circular-ownership-loop cache from recent non-AMM sale_events
  // (7d window) so the check is correct for the first live sale after a
  // restart, without a live query per sale. Must run before the listener
  // starts inserting new sales. Non-fatal on failure — an empty cache just
  // means loop detection starts cold and rebuilds from live traffic.
  try {
    const seeded = await hydrateOwnershipLoopCache();
    console.log(`[ownership-loop] cache hydrated entries=${seeded}`);
  } catch (err) {
    console.warn(`[ownership-loop] hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Seed the repeat-near-floor-buyer cache the same way (7d window, non-AMM,
  // near-floor sale_events only). Non-fatal on failure — an empty cache just
  // means detection starts cold and rebuilds from live traffic.
  try {
    const seeded = await hydrateRepeatFloorBuyerCache();
    console.log(`[repeat-floor-buyer] cache hydrated entries=${seeded}`);
  } catch (err) {
    console.warn(`[repeat-floor-buyer] hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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

  // Durable mint-dedupe ledger: restore the per-(sig,mint) counted keys from
  // disk BEFORE the listener / reconcile start, so a restart can't let the
  // gap-healer re-count mints already tallied pre-restart (snapshot restores
  // the totals but not the dedupe set). Fail-soft: empty on missing/corrupt.
  const ledgerKeys = loadCountedLedger();
  hydrateCountedMints(ledgerKeys);
  console.log(`[mints/ledger] loaded entries=${ledgerKeys.length}`);
  // Graceful-shutdown flush so a hard pm2 restart inside the ~5s debounce
  // window can't lose recently-counted keys (which would let reconcile
  // re-count them). `process.on('exit')` is the order-independent net — it
  // fires synchronously even when another SIGTERM handler (snapshot) calls
  // process.exit(0). The SIGTERM/SIGINT once-handlers flush early without
  // exiting, leaving the existing shutdown chain unchanged. flushCountedLedgerNow
  // is sync + idempotent, so calling it from multiple handlers is safe.
  process.once('SIGTERM', () => flushCountedLedgerNow('SIGTERM'));
  process.once('SIGINT',  () => flushCountedLedgerNow('SIGINT'));
  process.on('exit',      () => flushCountedLedgerNow('exit'));

  // Server-side persistence for the live mint feed (Postgres source of truth).
  // Hydrates the in-memory recent-mints ring + meta buffer from `mint_events`
  // BEFORE the HTTP server accepts connections, so the SSE replay + the
  // /api/mints/recent snapshot are identical for every device and survive
  // restarts. Then subscribes to the bus to persist live events + meta patches.
  await startMintEventPersistence();

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
  // Collection-created resolver: walks getSignaturesForAddress backward
  // for each collectionAddress (capped, in-mem + DB cached) to surface
  // the real on-chain creation date in the CREATED column. Persistent
  // positive cache means a successfully-resolved collection is never
  // re-resolved across restarts.
  void startCollectionCreatedResolver();
  // Resize-status resolver (Path C): on-demand per-mint lookup driven
  // by prefilter-matching live sales (legacy/pNFT ≤ 0.03 SOL). Bounded
  // RPC: 1 gSFA + ≤20 getTransaction per unseen mint, persistent DB
  // cache. Emits a `resize_status` SSE patch when a mint resolves to
  // 'metaplex_resized_unclaimed' so the Live Feed can render the RESIZE
  // badge after the fact.
  void startResizeStatusResolver();
  // MMM pool-type resolver: AMM badge classification for live/recent MMM
  // sales only (bid_sell/pool_buy/pool_sale). No DB migration, no
  // historical backfill — see mmm-pool-type-resolver.ts header for the
  // full fail-closed design.
  startMmmPoolTypeResolver();
  // TRADING-status sweep (Commit 1 — log-only). Periodic (3 min) check of
  // recently-active collections for genuine early secondary-market activity.
  // No accumulator write, no SSE, no UI in this commit — see
  // trading-status-sweep.ts for why that's deliberate.
  startTradingStatusSweep();

  // Rare Feed — bus-listener-only (no RPC, no Helius). Subscribes to the
  // existing sale + meta events, enriches with ME rarity (DB-cached), scores,
  // and persists value sales for the /tools/rare-feed page. Safe to start at
  // boot; it only sees events once ingestion is running.
  startRareFeed();

  // Mint tracker runs 24/7 independent of trade runtime mode. When
  // `MINT_TRACKER_ENABLED` is set (default ON), the listener spins up
  // at boot so launchpad mints (LMNFT / vvv.so / Core / TM) flow into
  // /mints even before any operator selects a trade mode. The listener's
  // per-target `isTargetActive()` gate keeps sale-program subscriptions
  // dormant until trade mode flips on, so RPC usage stays scoped to
  // mint targets only.
  {
    // The listener runs 24/7 in BOTH live and warm mode — warm keeps slow
    // background pollers going so the UI retains recent mint context after a
    // re-enable. Two-line boot signal with stable substrings for log scans.
    const mtRuntime = isMintTrackerEnabled() ? 'live' : 'warm';
    console.log(`[mints] tracker mode=${mtRuntime} (${getMintTrackerMode()}) independent=true`);
    console.log(`[mints/runtime] mode=${mtRuntime} salesMode=${getMode()} independent=true`);
    startListener();
    // Bounded gap-healer for launchpad-mint misses (see reconcile.ts). Only
    // active alongside the listener, since it backfills what the listener drops.
    startMintReconcile();
    // Low-rate sweep that fills per-NFT names DAS indexed AFTER the bounded
    // collection-confirm retry window expired (see name-backfill.ts).
    startMintNameBackfill();
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
