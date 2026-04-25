/**
 * Primary polling-based ingestion source.
 *
 * Polls each watched program on a tight interval (default 2.5s, page 20) and
 * feeds every unseen signature into the existing ingest pipeline. This is the
 * authoritative source of truth for which transactions exist on-chain.
 *
 * The realtime listener (listener.ts) is still enabled and runs ahead of the
 * poller for sub-second latency — but because Helius `logsSubscribe` has been
 * observed to silently stall, the poller does not rely on it for correctness.
 * Anything the listener delivers first is absorbed by fetchRawTx's shared
 * sigSeen / inFlight dedup before it reaches a duplicate RPC call.
 *
 * Conversely, the local `localSeen` FIFO here prevents repeated dispatches of
 * the same sig across successive polls (the Helius `until=cursor` window is
 * exclusive, but we keep it as a belt-and-suspenders guard for log fidelity).
 */
import { ingestMeRaw, rpcLimiterAbortQueued } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { getLastSig, setLastSig, clearLastSig } from '../db/poller-state';
import { trace } from '../trace';
import { Priority } from './concurrency';
import { HeliusEnhancedTransaction } from './helius/types';
import { incSigListFetch } from './telemetry';
import { noteSigList } from './sig-list-audit';
import { getMode, currentGeneration } from '../runtime/mode';
import { dispatchMmmDeferred } from './mmm-prefilter';

// ─── Targets ──────────────────────────────────────────────────────────────────

type IngestFn = (
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority?: Priority,
) => Promise<void>;

interface PollTarget {
  name:    string;   // used as cursor key + log prefix
  program: string;
  ingest:  IngestFn;
}

const TARGETS: PollTarget[] = [
  { name: 'poll:me_v2', program: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', ingest: ingestMeRaw     },
  { name: 'poll:mmm',   program: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc', ingest: ingestMeRaw     },
  { name: 'poll:tcomp', program: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', ingest: ingestTensorRaw },
  { name: 'poll:tamm',  program: 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg', ingest: ingestTensorRaw },
];

// Tightened back to 2.5 s so that right after a mode switch there is at
// most a ~2.5 s wait before the first catch-up sweep lands. `startAmmPoller`
// also fires an immediate `tick()` so the very first sweep runs at t≈0.
const INTERVAL_MS = 2_500;
const PAGE_SIZE   = 20;
/** Hard ceiling on catch-up pages per sweep — protects against runaway loops. */
const MAX_PAGES_PER_SWEEP = 75; // up to 1500 sigs per sweep during bursts

// Local bounded FIFO to dedupe sigs across consecutive polls for the same
// target — keeps the skipped/unseen counters meaningful and avoids re-dispatch
// when a slot straddles the cursor boundary.
const LOCAL_SEEN_MAX = 5_000;
const localSeen = new Set<string>();
const localSeenQueue: string[] = [];

/** Returns true if this is the first time we've seen `sig`. */
function markLocalSeen(sig: string): boolean {
  if (localSeen.has(sig)) return false;
  localSeen.add(sig);
  localSeenQueue.push(sig);
  if (localSeenQueue.length > LOCAL_SEEN_MAX) {
    const evict = localSeenQueue.shift()!;
    localSeen.delete(evict);
  }
  return true;
}

// ─── RPC ──────────────────────────────────────────────────────────────────────

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo {
  signature:          string;
  err:                unknown;
  confirmationStatus: string | null;
}

async function fetchPage(
  program: string,
  until: string | null,
  before: string | null,
  targetName: string,
): Promise<SigInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { limit: PAGE_SIZE, commitment: 'confirmed' };
  if (until)  params.until  = until;
  if (before) params.before = before;

  incSigListFetch();
  noteSigList('amm', targetName);
  const res = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [program, params],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
  if (json.error) throw new Error(`getSignaturesForAddress: ${json.error.message}`);
  return json.result ?? [];
}

/**
 * Fetch every signature newer than `until`, paginating backward when a single
 * page is saturated. Without this loop, `getSignaturesForAddress` would return
 * only the `PAGE_SIZE` newest sigs and anything between that page and `until`
 * would be silently dropped on cursor advance — which was the MMM loss
 * mechanism when sig rate spiked above ~8/s (PAGE_SIZE / INTERVAL_MS).
 *
 * On first run (`until === null`) we take a single page so startup doesn't
 * walk arbitrarily deep into history.
 */
interface SweepResult {
  /** Newest-first concatenation of every page fetched in this sweep. */
  rows:      SigInfo[];
  /** True when we exited the page loop without hitting a natural floor —
   *  i.e., MAX_PAGES_PER_SWEEP was reached and the last page was full. The
   *  caller uses this to decide between "advance cursor to newest"
   *  (steady state) and "save a `before` continuation for the next sweep"
   *  (gap-recovery). False when the loop reached an empty / short page or
   *  was interrupted by mode flip / generation bump. */
  saturated: boolean;
}

async function fetchSinceCursor(
  program:     string,
  until:       string | null,
  startBefore: string | null,
  gen:         number,
  targetName:  string,
): Promise<SweepResult> {
  // First-ever run for this target: no `until` floor known yet, single page.
  if (!until) {
    const rows = await fetchPage(program, null, null, targetName);
    return { rows, saturated: false };
  }

  const all: SigInfo[] = [];

  // Catch-up "always fetch the top" guard. When `startBefore` is set, the
  // backward-walking loop below begins at that anchor and never queries
  // anything newer than it — fresh sigs that arrived since the previous
  // sweep would otherwise depend entirely on the listener WS + pollAll
  // path for coverage. One extra fetchPage with `before=null` keeps
  // amm-poller a real safety net for live sigs even mid-catchup. The
  // existing `markLocalSeen` dedup at sweepTarget skips any rows already
  // ingested via the WS path, so this never causes duplicate ingest.
  if (startBefore) {
    if (getMode() === 'off' || gen !== currentGeneration()) {
      return { rows: all, saturated: false };
    }
    const fresh = await fetchPage(program, until, null, targetName);
    if (getMode() === 'off' || gen !== currentGeneration()) {
      return { rows: all, saturated: false };
    }
    all.push(...fresh);
  }

  // `startBefore` is the catch-up continuation anchor saved by the previous
  // sweep when it saturated the page budget. In steady state it is null and
  // pagination starts from the top.
  let before: string | null = startBefore;
  let hitFloor = false;
  for (let i = 0; i < MAX_PAGES_PER_SWEEP; i++) {
    // Bail between pages if mode flipped or this sweep belongs to a prior
    // generation — prevents a deep burst from continuing to page after OFF.
    if (getMode() === 'off' || gen !== currentGeneration()) break;
    const page = await fetchPage(program, until, before, targetName);
    if (getMode() === 'off' || gen !== currentGeneration()) break;
    if (page.length === 0) { hitFloor = true; break; }
    all.push(...page);
    // Short page means we reached the `until` boundary — no gap possible.
    if (page.length < PAGE_SIZE) { hitFloor = true; break; }
    // Saturated page — page further back in time.
    before = page[page.length - 1].signature;
  }
  return { rows: all, saturated: !hitFloor };
}

// ─── Per-target sweep ─────────────────────────────────────────────────────────

/** Per-target re-entrancy guard: skip a tick if the previous sweep is still running. */
const sweepInFlight = new Map<string, boolean>();

// ─── Backlog (low-priority catch-up) queue ────────────────────────────────────
// Sigs from pages 2+ of any sweep are drained here instead of flooding the
// shared `rpcLimiter`. That keeps the limiter's slots free for the newest
// (page-1) sigs of every sweep so fresh sales don't wait behind a deep
// catch-up tail. Single-worker, 120ms inter-call gap — catch-up still
// completes, just doesn't compete with live traffic.
interface BacklogItem { sig: string; ingest: IngestFn; target: string }
const backlog: BacklogItem[] = [];
let backlogDraining = false;
/** Gap between consecutive catch-up ingest calls; keeps rpcLimiter slots available for fresh sigs. */
const BACKLOG_GAP_MS = 120;
/** When the remaining backlog is at or above this threshold, dispatch each
 *  ingest at `medium` priority instead of `low`. Rationale: the rpcLimiter
 *  drops `low` tasks at admission once their queue wait exceeds STALE_LOW_MS
 *  (20 s). At BACKLOG_GAP_MS = 120 ms per dispatch, anything past item ~166
 *  in the queue meets that drop window. Steady-state catch-up (small
 *  backlogs) wants to keep `low` so live WS work always wins; gap-recovery
 *  catch-up (large backlogs after downtime) wants `medium` so the work
 *  actually executes instead of being silently sheared off. Live WS sigs
 *  enter the rpcLimiter at `high` and are unaffected either way. */
const BACKLOG_LARGE_THRESHOLD = 200;

function kickBacklogDrain(): void {
  if (backlogDraining) return;
  backlogDraining = true;
  const startGen = currentGeneration();
  (async () => {
    try {
      while (backlog.length > 0) {
        // HARD STOP. This loop is the primary source of continuous
        // `getTransaction` traffic after OFF — one ingest call every
        // BACKLOG_GAP_MS, for however many sigs were banked from the last
        // pre-OFF sweep. Bail on mode flip or generation bump.
        if (getMode() === 'off' || startGen !== currentGeneration()) break;
        const item = backlog.shift()!;
        // Pick priority based on how much work is still queued. Small
        // backlogs stay 'low' (live WS keeps priority); large backlogs
        // promote to 'medium' so STALE_LOW_MS doesn't kill the tail.
        const priority: Priority =
          backlog.length >= BACKLOG_LARGE_THRESHOLD ? 'medium' : 'low';
        // Lean-mode MMM exception (same rationale as the fresh-path
        // branch in sweepTarget): the poller has no log access so it
        // can't shed noise pre-RPC. Hand the sig to the deferred-and-
        // recheck shim instead of dispatching directly. The shim's
        // 5 s wait gives WS time to mark the sig; on resolution we
        // skip the RPC entirely. WS-missed sigs still flow through.
        const m = getMode();
        const isMmmLean =
          item.target === 'poll:mmm' && (m === 'sales_only' || m === 'budget');
        try {
          if (isMmmLean) {
            dispatchMmmDeferred(
              item.sig,
              (s) => item.ingest(s, undefined, priority),
              item.target,
            );
          } else {
            await item.ingest(item.sig, undefined, priority);
          }
        } catch (err: unknown) {
          console.error(`[${item.target}] backlog ingest error  sig=${item.sig.slice(0, 12)}...`, err);
        }
        if (getMode() === 'off' || startGen !== currentGeneration()) break;
        await new Promise((r) => setTimeout(r, BACKLOG_GAP_MS));
      }
    } finally {
      backlogDraining = false;
    }
  })();
}

/** Catch-up state, persisted in `poller_state` under
 *  `${target.name}:catchup` as the string `"<frozen_newest>:<before>"`.
 *
 *  - `frozen_newest`: the sig that was the very newest at the moment we
 *    *first* entered catch-up. After the gap walk completes, the
 *    primary `until` cursor is advanced to this value so steady state
 *    resumes at the correct timeline anchor (instead of the deep-history
 *    sig the catch-up walk happened to end at).
 *  - `before`: the oldest sig of the most recent saturated batch. The
 *    next sweep passes this to `fetchSinceCursor` as `startBefore`, so
 *    pagination resumes from where the prior sweep stopped instead of
 *    restarting at the top. Each saturated continuation sweep advances
 *    `before` further into history; the walk terminates when a sweep
 *    returns a non-saturated batch (gap fully consumed). */
function parseCatchup(raw: string | null): { frozenNewest: string; before: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) return null;
  return { frozenNewest: raw.slice(0, idx), before: raw.slice(idx + 1) };
}

async function sweepTarget(target: PollTarget): Promise<void> {
  if (sweepInFlight.get(target.name)) return;
  if (getMode() === 'off') return;
  const gen = currentGeneration();
  sweepInFlight.set(target.name, true);

  try {
    const lastSig = await getLastSig(target.name);
    if (getMode() === 'off' || gen !== currentGeneration()) return;

    const catchup = parseCatchup(await getLastSig(`${target.name}:catchup`));
    if (getMode() === 'off' || gen !== currentGeneration()) return;

    const { rows: page, saturated } = await fetchSinceCursor(
      target.program, lastSig, catchup?.before ?? null, gen, target.name,
    );
    if (getMode() === 'off' || gen !== currentGeneration()) return;
    const fetched = page.length;
    if (fetched === 0) {
      console.log(`[${target.name}] fetched=0`);
      // An empty pull while paginating from a `before` continuation means
      // the gap has been fully consumed (no sigs older than `before` and
      // newer than `until`). Promote the frozen newest sig to the primary
      // `until` cursor and clear the catch-up marker so subsequent sweeps
      // run as steady state.
      if (catchup) {
        await setLastSig(target.name, catchup.frozenNewest);
        await clearLastSig(`${target.name}:catchup`);
        console.log(`[${target.name}] catchup complete  until=${catchup.frozenNewest.slice(0, 12)}…`);
      }
      return;
    }

    // Priority split: page-1 (the PAGE_SIZE newest sigs) is "fresh" and goes
    // straight to the shared rpcLimiter like before. Pages 2+ are catch-up
    // backlog — they enter a low-priority serial queue so they don't crowd
    // out fresh sigs arriving on subsequent sweeps. (kickBacklogDrain bumps
    // priority to medium when the backlog grows past BACKLOG_LARGE_THRESHOLD
    // so the rpcLimiter's stale-low admission drop doesn't shear off the
    // tail of a gap-recovery walk.)
    const ordered = page;
    const FRESH_CUTOFF = PAGE_SIZE;

    let unseen = 0, ingested = 0, skipped = 0, backlogged = 0;
    for (let i = 0; i < ordered.length; i++) {
      const info = ordered[i];
      if (!markLocalSeen(info.signature)) { skipped++; continue; }
      unseen++;
      if (info.err !== null && info.err !== undefined) continue; // on-chain failure: don't ingest

      trace(info.signature, 'poll:fetched', `target=${target.name}`);
      trace(info.signature, 'poll:ingest',  `target=${target.name}`);

      if (i < FRESH_CUTOFF) {
        // Fresh path — fire and forget through the shared rpcLimiter.
        // Lean-mode MMM exception: poller has no log access so it can't
        // run shouldSkipMmmLogsSalesOnly. Defer 5 s and re-check whether
        // the WS path has marked the sig (recentSigs / inFlight). If yes,
        // skip without RPC; if no, dispatch normally so WS-missed sigs
        // are still recovered. Other targets (or full mode) dispatch
        // immediately as before.
        const m = getMode();
        if (target.name === 'poll:mmm' && (m === 'sales_only' || m === 'budget')) {
          dispatchMmmDeferred(info.signature, target.ingest, target.name);
        } else {
          target.ingest(info.signature).catch((err: unknown) =>
            console.error(`[${target.name}] ingest error  sig=${info.signature.slice(0, 12)}...`, err)
          );
        }
      } else {
        // Catch-up path — enqueue for serial drain so it doesn't starve fresh.
        backlog.push({ sig: info.signature, ingest: target.ingest, target: target.name });
        backlogged++;
      }
      ingested++;
    }
    if (backlogged > 0) kickBacklogDrain();

    // Cursor advance — saturation-aware.
    //
    //   saturated + no prior catchup:  enter catch-up. Capture page[0] as
    //     frozen_newest (the timeline anchor for post-catchup steady state),
    //     save before = oldest of batch. Leave `until` untouched.
    //   saturated + prior catchup:     continue catch-up. Keep prior
    //     frozen_newest, advance before to the new oldest.
    //   non-saturated + prior catchup: catch-up just finished on this
    //     sweep. Promote frozen_newest to `until`, clear the marker.
    //   non-saturated + no catchup:    steady state. Advance until to
    //     newest of this batch (existing behaviour).
    if (saturated) {
      const newBefore = page[page.length - 1].signature;
      const fn        = catchup?.frozenNewest ?? page[0].signature;
      await setLastSig(`${target.name}:catchup`, `${fn}:${newBefore}`);
      console.log(
        `[${target.name}] sweep saturated  ${catchup ? 'continuing' : 'entering'} catchup  ` +
        `frozen_newest=${fn.slice(0, 12)}…  before=${newBefore.slice(0, 12)}…`
      );
    } else if (catchup) {
      await setLastSig(target.name, catchup.frozenNewest);
      await clearLastSig(`${target.name}:catchup`);
      console.log(`[${target.name}] catchup complete  until=${catchup.frozenNewest.slice(0, 12)}…`);
    } else {
      await setLastSig(target.name, page[0].signature);
    }

    console.log(
      `[${target.name}] fetched=${fetched} unseen=${unseen} ingested=${ingested}` +
      `  fresh=${ingested - backlogged}  backlog=${backlogged}  skipped=${skipped}` +
      (catchup || saturated ? `  catchup=${saturated ? 'active' : 'completing'}` : '')
    );
  } catch (err: unknown) {
    console.error(`[${target.name}] sweep error`, err);
  } finally {
    sweepInFlight.set(target.name, false);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

// In the lean modes (`sales_only` and `budget`) the TAMM AMM-pool program
// is deliberately NOT polled here: the listener's own pollAll already
// sweeps it, and tensor's listener prefilter sheds non-sale txs before
// fetchRawTx anyway. MMM is INCLUDED — its sale-side instructions
// (`SolMplCoreFulfillBuy`, `solFulfillBuy`, etc.) are NOT in the
// `MMM_SALES_ONLY_SKIP_LOG_NAMES` deny-list and we must keep them
// covered by both subsystems; without amm-poller as a safety net,
// transient WS stalls mean MMM sale sigs go missing in lean modes.
// Full mode keeps the behaviour unchanged.
const LEAN_MODE_TARGETS: ReadonlySet<string> = new Set(['poll:me_v2', 'poll:mmm', 'poll:tcomp']);
function isLeanMode(mode: ReturnType<typeof getMode>): boolean {
  return mode === 'sales_only' || mode === 'budget';
}

function tick(): void {
  const mode = getMode();
  if (mode === 'off') return;
  // Resume any backlog preserved across an OFF cycle. `kickBacklogDrain`
  // is a no-op when the previous drain hasn't yet flipped `backlogDraining`
  // back to false (it might still be unwinding from its own mode-off bail
  // when `startAmmPoller` ran), so we re-attempt on every tick — the next
  // tick (≤ INTERVAL_MS later) self-corrects the race.
  if (backlog.length > 0 && !backlogDraining) {
    console.log(`[poller] resuming preserved backlog  size=${backlog.length}`);
    kickBacklogDrain();
  }
  // Fire enabled targets in parallel — each has its own re-entrancy guard,
  // so overlap between ticks for the same target is prevented without
  // blocking other targets.
  for (const t of TARGETS) {
    if (isLeanMode(mode) && !LEAN_MODE_TARGETS.has(t.name)) continue;
    sweepTarget(t).catch((err) => console.error(`[${t.name}] unhandled`, err));
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Name kept for backwards-compat with existing index.ts wiring.
 * Despite the legacy name, this now covers ME v2 + MMM + TComp + TAMM and is
 * the authoritative ingestion source; listener.ts is an optional speedup.
 */
let tickHandle: NodeJS.Timeout | null = null;

export function startAmmPoller(): void {
  if (tickHandle) { console.log('[poller] already running — skip'); return; }
  console.log(
    `[poller] starting  targets=${TARGETS.map(t => t.name).join(',')}` +
    `  interval=${INTERVAL_MS / 1000}s  page=${PAGE_SIZE}`
  );
  // Fire the first sweep immediately so startup latency is bounded by the
  // RPC round-trip, not by `INTERVAL_MS`.
  tick();
  tickHandle = setInterval(tick, INTERVAL_MS);
  tickHandle.unref();
}

/** Stop the AMM gap-healer. Idempotent.
 *
 *  Stops new RPC activity within the round-trip of whatever is mid-fetch:
 *  clears the tick interval, aborts the rpcLimiter queue (so queued
 *  fetchRawTx tasks resolve null at admission instead of firing
 *  `getTransaction`), and resets the per-target re-entrancy guards. The
 *  backlog drainer's while loop re-checks `getMode() === 'off'` on its
 *  next iteration and unwinds without issuing another RPC. Combined with
 *  the generation-token check in every async boundary, this drops
 *  ingestion to 0 req/sec within seconds of OFF.
 *
 *  Intentionally PRESERVED across OFF / ON cycles:
 *    - `backlog` — already-discovered historical sigs awaiting ingest.
 *      Wiping these on OFF would silently lose every gap-recovery sig
 *      enqueued during catch-up. Items remain in memory and the next
 *      `startAmmPoller()`'s first `tick()` re-kicks the drain under the
 *      new generation.
 *    - `localSeen` / `localSeenQueue` — per-process discovery dedup.
 *      Preserving them prevents a re-sweep on ON from re-pushing the
 *      same sigs into backlog (fetchRawTx's `recentSigs` would still
 *      dedup at the RPC layer, but skipping the push is cheaper).
 *
 *  In-flight backlog item at the moment of OFF: if mode flips while
 *  `backlog.shift()` has just occurred and `await item.ingest(…)` is
 *  pending, the rpcLimiter's mode gate causes ingest to resolve null
 *  and that one shifted item is lost. Worst-case loss is O(1) per OFF
 *  event, not O(backlog.length). */
export function stopAmmPoller(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  const preservedBacklog = backlog.length;
  const droppedLimiter   = rpcLimiterAbortQueued();
  sweepInFlight.clear();
  console.log(
    `[poller] stopped  backlog_preserved=${preservedBacklog}  rpcLimiter_dropped=${droppedLimiter}`
  );
}
