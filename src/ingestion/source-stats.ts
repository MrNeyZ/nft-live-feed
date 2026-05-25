/**
 * Per-source ingestion rollup. Tracks fired (getTransaction dispatches),
 * emitted (accepted sales), and dropped (parser-dropped after fetch) counts
 * per source, logging one [sourceStats] line per active source every 5 min.
 * Counters reset on each log so the line reflects the most recent window.
 *
 * Sources are the program-target identity at the dispatch site:
 *   me_v2 / mmm / tcomp / tamm   — sale targets
 *   mpl_core / candy_guard       — mint targets (emit not tracked here)
 *
 * Read by operators to identify the highest-waste source for cost reduction.
 * Pure accounting — no behavior change.
 */

export type Source =
  | 'me_v2' | 'mmm' | 'tcomp' | 'tamm'
  | 'mpl_core' | 'candy_guard'
  | 'unknown';

const SOURCES: readonly Source[] = [
  'me_v2', 'mmm', 'tcomp', 'tamm', 'mpl_core', 'candy_guard',
];

interface Counter { fired: number; emitted: number; dropped: number; }
function newCounter(): Counter { return { fired: 0, emitted: 0, dropped: 0 }; }

const counters = new Map<Source, Counter>();
for (const s of SOURCES) counters.set(s, newCounter());

function counterFor(source: Source): Counter {
  let c = counters.get(source);
  if (!c) { c = newCounter(); counters.set(source, c); }
  return c;
}

export function incFired(source: Source): void   { counterFor(source).fired++; }
export function incEmitted(source: Source): void { counterFor(source).emitted++; }
export function incDropped(source: Source): void { counterFor(source).dropped++; }

/** Map an AMM/listener poll-target name to its canonical source. */
export function sourceFromTargetName(name: string): Source {
  switch (name) {
    case 'poll:me_v2': case 'me_v2': return 'me_v2';
    case 'poll:mmm':   case 'mmm':   return 'mmm';
    case 'poll:tcomp': case 'tcomp': return 'tcomp';
    case 'poll:tamm':  case 'tamm':  return 'tamm';
    case 'mpl_core':                 return 'mpl_core';
    case 'candy_guard':              return 'candy_guard';
    default:                         return 'unknown';
  }
}

/** Map a parser-resolved marketplace to its canonical source. */
export function sourceFromMarketplace(marketplace: string): Source {
  switch (marketplace) {
    case 'magic_eden':     return 'me_v2';
    case 'magic_eden_amm': return 'mmm';
    case 'tensor':         return 'tcomp';
    case 'tensor_amm':     return 'tamm';
    default:               return 'unknown';
  }
}

const INTERVAL_MS = 5 * 60_000;

let started = false;
export function startSourceStats(): void {
  if (started) return;
  started = true;
  const t = setInterval(() => {
    for (const source of SOURCES) {
      const c = counterFor(source);
      if (c.fired === 0 && c.emitted === 0 && c.dropped === 0) continue;
      const usefulRatio = c.fired > 0 ? (c.emitted / c.fired) * 100 : 0;
      console.log(
        `[sourceStats] source=${source}` +
        ` fired=${c.fired} emitted=${c.emitted} dropped=${c.dropped}` +
        ` useful=${usefulRatio.toFixed(2)}%`,
      );
      // Reset window so the next line reflects the most recent 5 min.
      c.fired = 0; c.emitted = 0; c.dropped = 0;
    }
  }, INTERVAL_MS);
  if (typeof t.unref === 'function') t.unref();
}
