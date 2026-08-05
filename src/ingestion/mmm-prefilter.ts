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
import { sweepOwnerCache } from './mmm-pool-type-resolver';
import { IngestOutcome } from './ingest-outcome';

const MMM_DEFER_MS = 5_000;

// ── MMM noise-shed marker ───────────────────────────────────────────────────
// Sigs the listener's MMM WS prefilter (`shouldSkipMmmLogsSalesOnly`) shed as
// obviously non-sale (UpdatePool / Deposit / Withdraw / etc.). The poller path
// (amm-poller, listener pollAll) rediscovers these sigs and currently dispatches
// a fetch after the 5-s defer because `wasRecentlyFetched` is intentionally NOT
// set on WS noise-shed (avoiding dedupe-poisoning of legitimate sales). This
// marker closes that gap WITHOUT touching the sale dedupe chain: it ONLY
// short-circuits the MMM-deferred poller dispatch, never the WS path or the
// sale ingest path. False positives (real sale logs that happen to match the
// MMM deny-list) still recover via the same fail-open rationale: the marker
// expires in MMM_NOISE_TTL_MS and the next poller sweep re-dispatches.
const MMM_NOISE_TTL_MS = 30_000;
const MMM_NOISE_MAX    = 5_000;
const mmmNoiseShed: Map<string, number> = new Map();

export function markMmmNoiseShed(sig: string): void {
  mmmNoiseShed.set(sig, Date.now());
  if (mmmNoiseShed.size > MMM_NOISE_MAX) {
    // Drop the oldest entries past TTL on overflow.
    const cutoff = Date.now() - MMM_NOISE_TTL_MS;
    for (const [s, ts] of mmmNoiseShed) {
      if (ts < cutoff) mmmNoiseShed.delete(s);
      if (mmmNoiseShed.size <= MMM_NOISE_MAX * 0.8) break;
    }
  }
}

function wasMmmNoiseShed(sig: string): boolean {
  const ts = mmmNoiseShed.get(sig);
  if (ts === undefined) return false;
  if (Date.now() - ts > MMM_NOISE_TTL_MS) { mmmNoiseShed.delete(sig); return false; }
  return true;
}

let deferred         = 0;
let wsResolved       = 0;
let fallbackFetch    = 0;
let noiseShedSkipped = 0;

const summaryTimer = setInterval(() => {
  // Piggybacked housekeeping: mmm-pool-type-resolver.ts's ownerCache has no
  // timer of its own — this is the closest ambient MMM-scoped 60 s tick.
  sweepOwnerCache();
  if (deferred === 0) return;
  const total   = wsResolved + fallbackFetch + noiseShedSkipped;
  const wsPct   = total > 0 ? Math.round((wsResolved / total) * 100) : 0;
  const noisePct = total > 0 ? Math.round((noiseShedSkipped / total) * 100) : 0;
  console.log(
    `[mmm-prefilter] mmm_prefilter_deferred=${deferred}  ` +
    `mmm_prefilter_ws_resolved=${wsResolved}  ` +
    `mmm_prefilter_noise_shed=${noiseShedSkipped}  ` +
    `mmm_prefilter_fallback_fetch=${fallbackFetch}  ` +
    `ws_resolved_pct=${wsPct}%  noise_shed_pct=${noisePct}%  defer=${MMM_DEFER_MS / 1000}s`
  );
  deferred         = 0;
  wsResolved       = 0;
  fallbackFetch    = 0;
  noiseShedSkipped = 0;
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
    // Scope='sale': only sale-pipeline fetches count as "WS already
    // resolved this MMM sig". Mint-pipeline fetches (mpl_core /
    // token_metadata mint trackers) live in a separate scope and must
    // not trip this gate — that was the MMM Core sale dedupe-poison
    // bug pre-scoped-dedupe.
    if (wasRecentlyFetched(sig, 'sale')) { wsResolved++; return; }
    // WS prefilter shed this sig as obvious MMM noise (see
    // markMmmNoiseShed). Skip the poller dispatch — the WS just told us
    // it isn't a sale. Marker has its own 30-s TTL and never poisons the
    // sale-scope dedupe maps, so a misclassified sale recovers on the
    // next sweep after the marker expires.
    if (wasMmmNoiseShed(sig)) { noiseShedSkipped++; return; }
    fallbackFetch++;
    dispatch(sig).catch((err: unknown) =>
      console.error(`[${errLabel}] mmm-deferred ingest error  sig=${sig.slice(0, 12)}…`, err)
    );
  }, MMM_DEFER_MS);
  if (typeof t.unref === 'function') t.unref();
}

/** Awaitable sibling of `dispatchMmmDeferred`, for callers that need a
 *  definitive terminal outcome — specifically amm-poller's fresh-path
 *  dispatch, which cannot advance its persisted cursor past a signature
 *  without knowing what actually happened to it.
 *
 *  Same 5 s defer + WS-recheck for cost savings, but does NOT skip on a
 *  `wasMmmNoiseShed` verdict the way the void variant does — that marker
 *  is a heuristic guess (same "unreliable, not authoritative" class as the
 *  log-based prefilters fixed in listener.ts), and a cursor-safety caller
 *  cannot fold a guess into "terminal, safe to skip forever". Only an
 *  AUTHORITATIVE `wasRecentlyFetched` hit (WS's own ingest already reached
 *  a real terminal decision for this sig) short-circuits the real fetch;
 *  everything else — including noise_shed — falls through to a real
 *  dispatch so the caller gets a genuine outcome. This trades away part of
 *  the noise-shed RPC savings for the small fresh-path slice only; the
 *  high-volume backlog path still uses the void variant unchanged. */
export function dispatchMmmDeferredAwaitable(
  sig:      string,
  dispatch: (s: string) => Promise<IngestOutcome>,
  errLabel: string,
): Promise<IngestOutcome> {
  deferred++;
  const dispatchGen = currentGeneration();
  return new Promise<IngestOutcome>((resolve) => {
    const t = setTimeout(() => {
      if (getMode() === 'off' || dispatchGen !== currentGeneration()) {
        // Aborted mid-flight — not a real verdict either way; treat as
        // retryable so the cursor-safety caller doesn't advance past it.
        resolve('retryable_error');
        return;
      }
      if (wasRecentlyFetched(sig, 'sale')) { wsResolved++; resolve('duplicate'); return; }
      fallbackFetch++;
      dispatch(sig)
        .then(resolve)
        .catch((err: unknown) => {
          console.error(`[${errLabel}] mmm-deferred ingest error  sig=${sig.slice(0, 12)}…`, err);
          resolve('retryable_error');
        });
    }, MMM_DEFER_MS);
    if (typeof t.unref === 'function') t.unref();
  });
}
