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
const tickListeners = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

function ensureTicker(): void {
  if (tickInterval != null || typeof window === 'undefined') return;
  tickInterval = setInterval(() => {
    sharedNow = Date.now();
    // Snapshot the listener set first — a subscriber that triggers a
    // synchronous unsubscribe inside its callback would otherwise mutate
    // the Set mid-iteration.
    for (const cb of Array.from(tickListeners)) cb();
  }, 1000);
}
function subscribeTick(cb: () => void): () => void {
  tickListeners.add(cb);
  ensureTicker();
  return () => {
    tickListeners.delete(cb);
    if (tickListeners.size === 0 && tickInterval != null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  };
}
function getTickSnapshot(): number { return sharedNow; }
function getTickServerSnapshot(): number { return 0; }

export function useSharedNow(): number {
  return useSyncExternalStore(subscribeTick, getTickSnapshot, getTickServerSnapshot);
}
