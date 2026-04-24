/**
 * Aggregated ingestion telemetry for validating S1-S4 in real traffic.
 *
 * One compact [telemetry] line is printed every 60 s. Silent when the interval
 * had no activity AND the rpcLimiter is idle — nothing to report, nothing
 * printed. Counters reset after each print.
 *
 * Emits:
 *   tx         — getTransaction fetch attempts issued in the interval
 *   skipped    — listener WS sigs the S3 Tensor prefilter shed before dispatch
 *   staleDrop  — low-priority tasks the rpcLimiter dropped at admission (S4)
 *   q          — rpcLimiter queue depth right now + per-priority breakdown
 */

import { Limiter } from './concurrency';

let txFetches       = 0;
let sigListFetches  = 0;
let prefilterSkips  = 0;
let txNullResults   = 0;

export function incTxFetch():        void { txFetches++;       }
export function incSigListFetch():   void { sigListFetches++;  }
export function incPrefilterSkip():  void { prefilterSkips++;  }
export function incTxNull():         void { txNullResults++;   }

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
      ` | skipped=${prefilterSkips}` +
      ` | staleDrop=${stale}` +
      ` | q=${depth} (h:${byPrio.high} m:${byPrio.medium} l:${byPrio.low})`,
    );

    txFetches      = 0;
    sigListFetches = 0;
    prefilterSkips = 0;
    txNullResults  = 0;
  }, INTERVAL_MS).unref();
}
