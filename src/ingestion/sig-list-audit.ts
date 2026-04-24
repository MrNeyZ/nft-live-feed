/**
 * Lightweight per-source audit for `getSignaturesForAddress` calls.
 *
 * The global `[telemetry] sigFetch=…/min` line hides which subsystem is
 * burning RPC credits. This module breaks the same counter down by
 * (source, target) so operators can tell at a glance whether the listener's
 * own pollAll or the amm-poller is dominating — and whether the breakdown
 * matches expectations for the current runtime mode.
 *
 * Call `noteSigList(source, target)` immediately before issuing each
 * getSignaturesForAddress. A background timer logs one summary every 60 s:
 *
 *   [rpc-audit/sigList] mode=sales_only
 *       listener:me_v2=6  listener:tcomp=6  amm:poll:me_v2=24  amm:poll:tcomp=24
 *
 * No impact on hot-path latency — just increments a number in a Map.
 */

import { getMode } from '../runtime/mode';

const counts = new Map<string, number>();

export type SigListSource = 'listener' | 'amm' | 'seed' | 'reconnect';

export function noteSigList(source: SigListSource, target: string): void {
  const key = `${source}:${target}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function dumpSummary(): void {
  if (counts.size === 0) return;
  const entries = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[rpc-audit/sigList] mode=${getMode()}  ` + entries.join('  '));
  counts.clear();
}

const timer = setInterval(dumpSummary, 60_000);
if (typeof timer.unref === 'function') timer.unref();
