// Runtime ingestion-mode store.
//
// One backend process stays alive; ingestion subsystems (listener + AMM
// gap-healer) start and stop in response to `setMode()`. This is the only
// module that knows how to transition between `off`, `full`, `budget`, and
// `sales_only` — the HTTP layer just calls `setMode(requested)` and the
// ingestion modules expose their own start/stop primitives. `budget` uses
// the same WS prefilter deny-lists as `sales_only` for now; further gating
// can differentiate them without touching this module.

import { startListener, stopListener } from '../ingestion/listener';
import { startAmmPoller, stopAmmPoller } from '../ingestion/amm-poller';
import { saleEventBus } from '../events/emitter';

export type RuntimeMode = 'off' | 'full' | 'budget' | 'sales_only';

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> =
  ['off', 'full', 'budget', 'sales_only'];

export function isRuntimeMode(v: unknown): v is RuntimeMode {
  return typeof v === 'string' && (RUNTIME_MODES as ReadonlyArray<string>).includes(v);
}

let current: RuntimeMode = 'off';
/** Serializes setMode() calls so two rapid requests can't interleave
 *  start/stop and leave sockets in a half-open state. */
let transition: Promise<void> = Promise.resolve();

/** Monotonically increasing counter bumped on every mode change.
 *  Long-running async pipelines (poller sweeps, limiter tasks, backlog
 *  drainers) capture the generation at start and bail if the value has
 *  advanced by the time they come back from an await. This is the hard
 *  kill switch that prevents work queued under the previous mode from
 *  continuing after OFF. */
let generation = 0;

export function getMode(): RuntimeMode { return current; }
export function currentGeneration(): number { return generation; }
export function isActive(): boolean { return current !== 'off'; }

/** Mint tracker is independent from the trade runtime mode. Initial
 *  state comes from `MINT_TRACKER_ENABLED` env (defaults ON); after
 *  boot it can be toggled from the UI via the /api/mints/runtime
 *  endpoint. When enabled, the listener stays up across mode=off
 *  transitions and continues to ingest LMNFT / vvv.so / Core / TM
 *  mints — only sale targets pause. */
let mintTrackerEnabled: boolean = process.env.MINT_TRACKER_ENABLED !== '0';
export function isMintTrackerEnabled(): boolean { return mintTrackerEnabled; }

/** Toggle the mint tracker. When the trade mode is OFF the listener
 *  itself is started/stopped to match — there's no other reason for it
 *  to be running in that state. When trade mode is on, the listener
 *  stays up either way and `isTargetActive()` handles per-target
 *  gating internally. Idempotent; safe to call from API handlers. */
export function setMintTrackerEnabled(enabled: boolean): boolean {
  if (mintTrackerEnabled === enabled) return mintTrackerEnabled;
  mintTrackerEnabled = enabled;
  console.log(`[mints/runtime] enabled=${enabled}`);
  if (current === 'off') {
    if (enabled) startListener();
    else         stopListener();
  }
  return mintTrackerEnabled;
}

/** True iff anything is currently allowed to do RPC work — i.e. either
 *  the trade runtime mode is on, OR the mint tracker is enabled. Used
 *  to gate the shared limiters so they don't hard-stop when mode → off
 *  while mint tracking is still active. */
export function isAnyIngestActive(): boolean {
  return current !== 'off' || isMintTrackerEnabled();
}

export function setMode(next: RuntimeMode): Promise<void> {
  transition = transition.then(() => applyTransition(next)).catch(err => {
    console.error('[runtime] setMode failed', err);
  });
  return transition;
}

/** Captures the timestamp of the first sale that lands after each mode
 *  start, so we can log end-to-end startup latency. Armed on every
 *  active-mode transition; disarmed once the first event fires. */
let firstEventWaiter: ((event: { signature: string }) => void) | null = null;
saleEventBus.onSale((ev) => {
  if (firstEventWaiter) {
    const fn = firstEventWaiter;
    firstEventWaiter = null;
    fn(ev);
  }
});

async function applyTransition(next: RuntimeMode): Promise<void> {
  if (next === current) return;
  const prev = current;
  // Bump BEFORE any teardown so every in-flight task whose next
  // `if (gen !== currentGeneration()) return` check runs after this point
  // sees the new value and bails.
  generation++;
  console.log(`[runtime] mode ${prev} → ${next}  generation=${generation}`);

  if (next === 'off') {
    // Mint tracker is independent of trade mode. When enabled the
    // listener stays up — its per-target gating sheds sale-target
    // notifications during mode=off but continues processing mints.
    // AMM poller is sales-only and always stops on mode=off.
    if (!isMintTrackerEnabled()) {
      stopListener();
    }
    stopAmmPoller();
    current = next;
    return;
  }

  // Going active. If currently active (mode-to-mode), stop first so the
  // listener tears down cleanly before the new mode's workers spin up.
  // Consumers read `getMode()` directly — no `process.env` side-effect.
  // When the previous state was 'off' but the listener was kept alive
  // for mint tracking, we still restart it so the watchdog/heartbeat
  // counters reset cleanly under the new mode.
  if (prev !== 'off' || isMintTrackerEnabled()) {
    stopListener();
    stopAmmPoller();
  }
  current = next;
  const startedAt = Date.now();
  console.log(`[runtime] MODE STARTED mode=${next} ts=${new Date(startedAt).toISOString()}`);
  firstEventWaiter = (ev) => {
    const elapsed = Date.now() - startedAt;
    console.log(
      `[runtime] first event after start  mode=${next}  ` +
      `elapsed=${elapsed}ms  ts=${new Date().toISOString()}  sig=${ev.signature}`
    );
  };
  startListener();
  startAmmPoller();
}
