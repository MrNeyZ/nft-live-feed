// VictoryLabs — Feed: shared 1 s ticker for TimeAgo leaves.
// Extracted verbatim from page.tsx so the upcoming TimeAgo component
// split (PR #2) can import this without reaching back into the page.
// The whole module is moved as a unit: `sharedNow` + `tickListeners`
// + `tickInterval` are private state shared by `ensureTicker` /
// `subscribeTick` / `getTickSnapshot`. Splitting them across files
// would create two modules holding aliasing references to the same
// state — exactly the bug we already avoided once.
//
// Previously every TimeAgo card owned its own setInterval. With ~200
// cards that's 200 timer fires/sec doing 200 tiny rerenders —
// measurable jank on weaker hardware. One module-level interval pushes
// a single `Date.now()` snapshot into a pub-sub; each TimeAgo
// subscribes via useSyncExternalStore and rerenders exactly once per
// tick (same visible behavior, 1× the timer cost). The interval is
// lazily created when the first leaf subscribes and torn down when
// the last leaf unsubscribes — zero work on pages that don't render
// any TimeAgo.

import { useSyncExternalStore } from 'react';

let sharedNow: number = typeof window === 'undefined' ? 0 : Date.now();

// Two independent tickers sharing one `sharedNow` value: a 1 s "fast" ticker
// (default — standalone /feed) and a 10 s "slow" ticker for /multi panels,
// where ~80 cards re-rendering every second is wasted work (a coarse age
// label is fine there). Each subscriber is notified ONLY by the ticker it
// subscribed to, so slow subscribers re-render at most every 10 s. Both
// tickers refresh `sharedNow`, so whichever is running keeps the value live.
const SLOW_TICK_MS = 10_000;

const fastListeners = new Set<() => void>();
const slowListeners = new Set<() => void>();
let fastInterval: ReturnType<typeof setInterval> | null = null;
let slowInterval: ReturnType<typeof setInterval> | null = null;

function ensureFast(): void {
  if (fastInterval != null || typeof window === 'undefined') return;
  fastInterval = setInterval(() => {
    sharedNow = Date.now();
    for (const cb of Array.from(fastListeners)) cb();
  }, 1000);
}
function ensureSlow(): void {
  if (slowInterval != null || typeof window === 'undefined') return;
  slowInterval = setInterval(() => {
    sharedNow = Date.now();
    for (const cb of Array.from(slowListeners)) cb();
  }, SLOW_TICK_MS);
}
function subscribeFast(cb: () => void): () => void {
  fastListeners.add(cb);
  ensureFast();
  return () => {
    fastListeners.delete(cb);
    if (fastListeners.size === 0 && fastInterval != null) {
      clearInterval(fastInterval);
      fastInterval = null;
    }
  };
}
function subscribeSlow(cb: () => void): () => void {
  slowListeners.add(cb);
  ensureSlow();
  return () => {
    slowListeners.delete(cb);
    if (slowListeners.size === 0 && slowInterval != null) {
      clearInterval(slowInterval);
      slowInterval = null;
    }
  };
}
function getTickSnapshot(): number { return sharedNow; }
function getTickServerSnapshot(): number { return 0; }

/** Shared "now" for TimeAgo leaves. `slow` (set by the /multi panels via
 *  FeedTickContext) subscribes to the 10 s ticker instead of the 1 s one;
 *  default keeps the original 1 s cadence for standalone /feed. */
export function useSharedNow(slow = false): number {
  return useSyncExternalStore(slow ? subscribeSlow : subscribeFast, getTickSnapshot, getTickServerSnapshot);
}
