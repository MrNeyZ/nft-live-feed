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

export function getMode(): RuntimeMode { return current; }

export function setMode(next: RuntimeMode): Promise<void> {
  transition = transition.then(() => applyTransition(next)).catch(err => {
    console.error('[runtime] setMode failed', err);
  });
  return transition;
}

async function applyTransition(next: RuntimeMode): Promise<void> {
  if (next === current) return;
  const prev = current;
  console.log(`[runtime] mode ${prev} → ${next}`);

  if (next === 'off') {
    stopListener();
    stopAmmPoller();
    current = next;
    return;
  }

  // Going active. If currently active (mode-to-mode), stop first so the
  // listener tears down cleanly before the new mode's workers spin up.
  // Consumers read `getMode()` directly — no `process.env` side-effect.
  if (prev !== 'off') {
    stopListener();
    stopAmmPoller();
  }
  current = next;
  startListener();
  startAmmPoller();
}
