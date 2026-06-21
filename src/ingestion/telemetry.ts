/**
 * Aggregated ingestion telemetry for validating S1-S4 in real traffic.
 *
 * One compact [telemetry] line is printed every 60 s. Silent when the interval
 * had no activity AND the rpcLimiter is idle — nothing to report, nothing
 * printed. Counters reset after each print.
 *
 * Emits:
 *   tx         — getTransaction fetch attempts issued in the interval
 *   nullTx     — those that returned a null result (tx not available)
 *   skipped    — listener WS sigs the S3 Tensor prefilter shed before dispatch
 *   staleDrop  — low-priority tasks the rpcLimiter dropped at admission (S4)
 *   q          — rpcLimiter queue depth right now + per-priority breakdown
 *
 * `fetchRawTx` is shared by the sales and mint-tracker pipelines, so the
 * aggregate `tx`/`nullTx` totals conflate both. To make sales-only Helius
 * usage measurable, the same counts are also tracked per ingestion scope
 * ('sale' | 'mint') and printed as tx_sale/tx_mint/null_sale/null_mint
 * (plus retry_sale/retry_mint). The aggregate fields are unchanged for
 * backwards compatibility.
 */

import { Limiter } from './concurrency';

/** Ingestion scope. Mirrors `FetchScope` in me-raw/ingest.ts; kept local so
 *  telemetry has no import cycle with the module that calls these counters. */
type Scope = 'sale' | 'mint';

let txFetches       = 0;
let sigListFetches  = 0;
let prefilterSkips  = 0;
let txNullResults   = 0;

// Per-scope splits of the getTransaction counters above.
const txByScope    = { sale: 0, mint: 0 };
const nullByScope  = { sale: 0, mint: 0 };
const retryByScope = { sale: 0, mint: 0 };

export function incTxFetch(scope: Scope = 'sale'): void { txFetches++;     txByScope[scope]++;    }
export function incTxNull(scope: Scope = 'sale'):  void { txNullResults++; nullByScope[scope]++;  }
export function incTxRetry(scope: Scope = 'sale'): void { retryByScope[scope]++;                  }
export function incSigListFetch():   void { sigListFetches++;  }
export function incPrefilterSkip():  void { prefilterSkips++;  }

// Real parser-accepted MPL Core mints (any ingestion source). Never reset —
// the poller idle-backoff reads deltas between consecutive snapshots so the
// absolute value is irrelevant. Kept here (not in listener.ts) to avoid the
// circular-import that would arise if mint-raw/index.ts imported listener.ts.
let mplCoreParsedMints = 0;
export function incMplCoreParsedMint(): void { mplCoreParsedMints++; }
export function getMplCoreParsedMints(): number { return mplCoreParsedMints; }

const INTERVAL_MS = 60_000;

export function startTelemetry(rpcLimiter: Limiter): void {
  setInterval(() => {
    const stale   = rpcLimiter.takeStaleDropCount();
    const depth   = rpcLimiter.depth();
    const byPrio  = rpcLimiter.depthByPriority();

    if (txFetches === 0 && sigListFetches === 0 && prefilterSkips === 0
        && txNullResults === 0 && stale === 0 && depth === 0) {
      return; // nothing worth reporting
    }

    console.log(
      `[telemetry] sigFetch=${sigListFetches}/min` +
      ` | tx=${txFetches}/min` +
      ` | nullTx=${txNullResults}/min` +
      ` | tx_sale=${txByScope.sale} tx_mint=${txByScope.mint}` +
      ` | null_sale=${nullByScope.sale} null_mint=${nullByScope.mint}` +
      ` | retry_sale=${retryByScope.sale} retry_mint=${retryByScope.mint}` +
      ` | skipped=${prefilterSkips}` +
      ` | staleDrop=${stale}` +
      ` | q=${depth} (h:${byPrio.high} m:${byPrio.medium} l:${byPrio.low})`,
    );

    txFetches      = 0;
    sigListFetches = 0;
    prefilterSkips = 0;
    txNullResults  = 0;
    txByScope.sale = 0;    txByScope.mint = 0;
    nullByScope.sale = 0;  nullByScope.mint = 0;
    retryByScope.sale = 0; retryByScope.mint = 0;
  }, INTERVAL_MS).unref();
}
