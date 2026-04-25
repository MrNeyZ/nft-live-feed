/**
 * MMM lean-mode dispatch deferral.
 *
 * In `sales_only` / `budget` mode the WS path runs `shouldSkipMmmLogsSalesOnly`
 * on every MMM logsNotification BEFORE issuing `fetchRawTx`, so noise txs
 * (deposit/withdraw/update_pool/etc.) are dropped without spending a
 * `getTransaction`. Every WS-shed sig also calls `markSigFetched(sig)` to
 * populate the recentSigs dedup map.
 *
 * The poller paths (amm-poller.sweepTarget and listener.pollTarget) discover
 * sigs via `getSignaturesForAddress`, whose response carries no logs — so
 * they have NO prefilter and would otherwise dispatch every MMM sig
 * straight into `fetchRawTx`, paying full RPC cost for the noise the WS
 * path drops for free.
 *
 * This shim closes that gap by holding each poller-discovered MMM sig for
 * MMM_DEFER_MS (5 s — comfortably longer than typical Helius WS delivery
 * latency of 1-3 s). At dispatch time it re-checks `wasRecentlyFetched`:
 *
 *   - true  → WS already handled this sig (prefilter-skip OR successful
 *             fetch). Increment `mmm_prefilter_skipped` and drop.
 *   - false → WS missed it (truly new sig the WS didn't deliver).
 *             Increment `mmm_prefilter_passed` and dispatch as usual.
 *
 * If the WS for MMM is healthy this shim drops the bulk of noise dispatches
 * (the WS prefilter is keying off the same logs the poller can't see). If
 * the WS is degraded, every poller dispatch still fires after the 5 s defer
 * — coverage is preserved at the cost of 5 s extra latency for genuinely
 * WS-missed sigs.
 *
 * Counters log every 60 s:
 *   mmm_prefilter_deferred       — total sigs handed to this shim
 *   mmm_prefilter_ws_resolved    — after defer, WS had marked the sig
 *                                  (prefilter-skip OR successful fetch);
 *                                  no RPC fired
 *   mmm_prefilter_fallback_fetch — after defer, WS hadn't marked it →
 *                                  we dispatched (assume WS missed)
 *
 * Steady-state expectation: ws_resolved is much larger than fallback_fetch
 * (the WS prefilter is keying off the same logs the poller can't see).
 * If fallback_fetch climbs, the WS for MMM is degraded — investigate.
 */

import { wasRecentlyFetched } from './me-raw/ingest';
import { getMode, currentGeneration } from '../runtime/mode';

const MMM_DEFER_MS = 5_000;

let deferred       = 0;
let wsResolved     = 0;
let fallbackFetch  = 0;

const summaryTimer = setInterval(() => {
  if (deferred === 0) return;
  const total   = wsResolved + fallbackFetch;
  const wsPct   = total > 0 ? Math.round((wsResolved / total) * 100) : 0;
  console.log(
    `[mmm-prefilter] mmm_prefilter_deferred=${deferred}  ` +
    `mmm_prefilter_ws_resolved=${wsResolved}  ` +
    `mmm_prefilter_fallback_fetch=${fallbackFetch}  ` +
    `ws_resolved_pct=${wsPct}%  defer=${MMM_DEFER_MS / 1000}s`
  );
  deferred      = 0;
  wsResolved    = 0;
  fallbackFetch = 0;
}, 60_000);
if (typeof summaryTimer.unref === 'function') summaryTimer.unref();

/** Defer-then-dispatch wrapper. Caller decides when to use it (lean-mode
 *  MMM only). The dispatch lambda is whatever the caller would have run
 *  immediately — typically `target.ingest(sig)` or
 *  `pollerLimiter.run(() => target.ingest(sig))`. Generation + mode gates
 *  drop the deferred dispatch on OFF or mode change so we never fire RPC
 *  after the runtime has been told to stop. */
export function dispatchMmmDeferred(
  sig:        string,
  dispatch:   (s: string) => Promise<unknown>,
  errLabel:   string,
): void {
  deferred++;
  const dispatchGen = currentGeneration();
  const t = setTimeout(() => {
    if (getMode() === 'off' || dispatchGen !== currentGeneration()) return;
    if (wasRecentlyFetched(sig)) { wsResolved++; return; }
    fallbackFetch++;
    dispatch(sig).catch((err: unknown) =>
      console.error(`[${errLabel}] mmm-deferred ingest error  sig=${sig.slice(0, 12)}…`, err)
    );
  }, MMM_DEFER_MS);
  if (typeof t.unref === 'function') t.unref();
}
