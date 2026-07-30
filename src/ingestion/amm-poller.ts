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
import { ingestOrbisRaw } from './orbis-raw/ingest';
import { ORBIS_PROGRAM } from './orbis-raw/programs';
import { getLastSig, setLastSig, clearLastSig } from '../db/poller-state';
import { trace } from '../trace';
import { Priority } from './concurrency';
import { HeliusEnhancedTransaction } from './helius/types';
import { incSigListFetch } from './telemetry';
import { noteSigList } from './sig-list-audit';
import { getMode, currentGeneration } from '../runtime/mode';
import { dispatchMmmDeferred } from './mmm-prefilter';
import { isSalesWsDead } from './listener';
import { getAcceptedCount } from './poll-useful';
import { incFired, sourceFromTargetName } from './source-stats';

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
  { name: 'poll:orbis', program: ORBIS_PROGRAM,                                  ingest: ingestOrbisRaw  },
];

// Healthy-state sweep cadence. The poller is the AMM gap-healer/backstop —
// the logsSubscribe sales listener is the primary live path — so when the
// listener is healthy this can be relatively slow without missing sales.
// Raised 5 s → 10 s (env-tunable via AMM_POLLER_INTERVAL_MS) to roughly halve
// the baseline getSignaturesForAddress credit spend. `startAmmPoller` still
// fires an immediate `tick()` so the first sweep runs at t≈0; the saturation
// (SLOW_INTERVAL_MS) and WS-dead (DEGRADED_INTERVAL_MS) overrides are unchanged.
function envIntMs(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const INTERVAL_MS      = envIntMs('AMM_POLLER_INTERVAL_MS', 10_000);
// Emergency cost guard: when the sales-side logsSubscribe is dead (see
// isSalesWsDead), polling is the only path AND it fetches a getTransaction
// for every program-touching sig — mostly non-sale on me_v2/mmm/tcomp. To
// avoid burning credits we degrade: slower cadence + drop the lower-signal
// programs (tcomp/tamm), keeping the two highest-volume sale programs
// (me_v2, mmm) on a 15s cadence until WS recovers. Mint ingestion is in
// listener.ts and is unaffected.
const DEGRADED_INTERVAL_MS = 15_000;
const DEGRADED_TARGETS: ReadonlySet<string> = new Set(['poll:me_v2', 'poll:mmm']);
let salesWsDegraded = false;
/** Intra-tick stagger: space the per-target sweeps within a single tick so
 *  the 4 programs don't fire getSignaturesForAddress in the same instant
 *  (de-bursts the RPS graph). 4 targets × 600 ms ≈ 1.8 s max offset, well
 *  inside INTERVAL_MS; each target keeps its own re-entrancy guard. */
const TICK_STAGGER_MS  = 600;
/** Slow tick cadence applied when at least one target is in catch-up
 *  (saturated). Caps RPC during gap-recovery so a sustained backlog
 *  drain can't spam getSignaturesForAddress at full 2.5 s rate. */
const SLOW_INTERVAL_MS = 10_000;
const PAGE_SIZE   = 20;
/** Hard ceiling on catch-up pages per sweep — protects against runaway loops. */
// Per-sweep page budget — mode-dependent.
//   Full mode      : up to 20 pages (catch-up ceiling for backlog drain)
//   Lean modes     : hard cap at 5 pages so a sustained catch-up burst
//                    in sales_only / budget can never push RPC above
//                    ~5 calls × 24 sweeps/min × 3 targets ≈ 360/min.
// Combined with the new "low-page = not saturated" rule below, ordinary
// near-realtime operation makes 1–2 pages per sweep, well under cap.
const MAX_PAGES_FULL = 20;
const MAX_PAGES_LEAN = 5;
/** Per-target hard cap, applied AFTER mode cap (clamps further). MMM is the
 *  largest cost source per the sourceStats audit (~95% parser-dropped); cap
 *  its catch-up walk at 2 pages so a saturated burst can never enqueue more
 *  than PAGE_SIZE × 2 = 40 sigs in one sweep. Other targets unchanged. */
const MAX_PAGES_BY_TARGET: Record<string, number> = {
  'poll:mmm': 2,
};
function maxPagesForMode(): number {
  const m = getMode();
  return (m === 'sales_only' || m === 'budget') ? MAX_PAGES_LEAN : MAX_PAGES_FULL;
}
function maxPagesForTarget(name: string): number {
  const mode = maxPagesForMode();
  const cap  = MAX_PAGES_BY_TARGET[name];
  return cap != null ? Math.min(mode, cap) : mode;
}
/** Per-target fresh-path cutoff. Fresh-path sigs dispatch synchronously
 *  into rpcLimiter (page-1 fan-out); the rest go to the serial backlog
 *  drain. Lowering MMM's cutoff from PAGE_SIZE (20) to 10 cuts the
 *  worst-case 5-s tick burst in half without changing throughput. */
const FRESH_CUTOFF_BY_TARGET: Record<string, number> = {
  'poll:mmm': 10,
};
function freshCutoffForTarget(name: string): number {
  return FRESH_CUTOFF_BY_TARGET[name] ?? PAGE_SIZE;
}
/** Below this page count, a sweep is treated as near-realtime and never
 *  flagged as `saturated` even if every page returned full. Ordinary
 *  bursts of 4–5 full-page responses no longer trigger catch-up. */
const LOW_PAGE_THRESHOLD = 5;
/** After this many consecutive low-page sweeps, any active catch-up
 *  marker for the target is cleared so steady-state mode resumes. */
const LOW_PAGE_STREAK_TO_EXIT = 3;

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
  return `https://beta.helius-rpc.com/?api-key=${key}`;
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
  // Diagnostic: every fetchPage logs its inputs. Run a 5-min capture and
  // check the log for repeated `before=…` lines from the same target —
  // that's the catch-up loop paginating deep, the most likely cause of
  // the spike. `until=null` here means first run (cold cursor), which is
  // expected exactly once per target after a restart.
  console.log(
    `[sig/amm] target=${targetName}  ` +
    `until=${until ? until.slice(0, 8) + '…' : 'null'}  ` +
    `before=${before ? before.slice(0, 8) + '…' : 'null'}  ` +
    `limit=${PAGE_SIZE}`,
  );
  const res = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [program, params],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
  if (json.error) throw new Error(`getSignaturesForAddress: ${json.error.message}`);
  const rows = json.result ?? [];
  console.log(`[sig/amm] target=${targetName}  resp_len=${rows.length}`);
  return rows;
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
  /** True when this sweep walked the full per-mode page budget AND
   *  consumed strictly more than LOW_PAGE_THRESHOLD pages. The caller
   *  uses this to decide between "advance cursor to newest" (steady
   *  state) and "save a `before` continuation for the next sweep"
   *  (gap-recovery). Ordinary bursts of 4–5 full-page responses fall
   *  below the threshold and do NOT trigger catch-up. */
  saturated: boolean;
  /** Page count actually consumed this sweep (≤ maxPagesForMode()).
   *  Used by sweepTarget to track the low-page streak and exit any
   *  stale catch-up after a few quiet sweeps. */
  pages: number;
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
    return { rows, saturated: false, pages: 1 };
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
      return { rows: all, saturated: false, pages: 0 };
    }
    const fresh = await fetchPage(program, until, null, targetName);
    if (getMode() === 'off' || gen !== currentGeneration()) {
      return { rows: all, saturated: false, pages: 0 };
    }
    all.push(...fresh);
  }

  // `startBefore` is the catch-up continuation anchor saved by the previous
  // sweep when it saturated the page budget. In steady state it is null and
  // pagination starts from the top.
  const maxPages = maxPagesForTarget(targetName);
  let before: string | null = startBefore;
  let hitFloor = false;
  let pages = 0;
  let lastBefore: string | null = startBefore;
  for (let i = 0; i < maxPages; i++) {
    // Bail between pages if mode flipped or this sweep belongs to a prior
    // generation — prevents a deep burst from continuing to page after OFF.
    if (getMode() === 'off' || gen !== currentGeneration()) break;
    const page = await fetchPage(program, until, before, targetName);
    pages++;
    if (getMode() === 'off' || gen !== currentGeneration()) break;
    if (page.length === 0) { hitFloor = true; break; }
    all.push(...page);
    // Short page means we reached the `until` boundary — no gap possible.
    if (page.length < PAGE_SIZE) { hitFloor = true; break; }
    // Saturated page — page further back in time.
    before = page[page.length - 1].signature;
    lastBefore = before;
  }
  // Saturation is now strict: only true when we hit the page ceiling
  // AND the sweep walked more than LOW_PAGE_THRESHOLD pages. Ordinary
  // near-realtime bursts of 4–5 full-page responses no longer flip
  // catch-up mode and no longer cause RPC spam.
  const saturated = !hitFloor && pages === maxPages && pages > LOW_PAGE_THRESHOLD;
  const sweepMode = saturated ? 'catchup' : 'normal';
  console.log(
    `[sig/amm/sweep] target=${targetName}  ` +
    `pages=${pages}  rows=${all.length}  saturated=${saturated}  mode=${sweepMode}  ` +
    `entered_with_before=${startBefore ? startBefore.slice(0, 8) + '…' : 'null'}  ` +
    `last_before=${lastBefore ? lastBefore.slice(0, 8) + '…' : 'null'}`,
  );
  return { rows: all, saturated, pages };
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
        const backlogSource = sourceFromTargetName(item.target);
        try {
          if (isMmmLean) {
            // deferred dispatch may skip the fetch; count fired from inside.
            dispatchMmmDeferred(
              item.sig,
              (s) => { incFired(backlogSource); return item.ingest(s, undefined, priority); },
              item.target,
            );
          } else {
            incFired(backlogSource);
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

/** Per-target consecutive low-page streak tracker. Bumped on every
 *  sweep that consumes ≤ LOW_PAGE_THRESHOLD pages; reset on every
 *  larger sweep. When the streak reaches LOW_PAGE_STREAK_TO_EXIT, any
 *  active catch-up marker is force-cleared so steady-state mode
 *  resumes. Memory-only, in-process. */
const lowPageStreak: Map<string, number> = new Map();

/** Set of targets whose most recent sweep returned `saturated=true`.
 *  When non-empty, the next tick is delayed (see SLOW_INTERVAL_MS) so
 *  catch-up doesn't burn 24 sweeps/min × N targets × full page budget.
 *  Targets remove themselves once they return non-saturated. */
const saturatedTargets: Set<string> = new Set();

// ─── Per-target useful-ratio backoff ─────────────────────────────────────────
//
// Only poll:mmm and poll:me_v2 — the two high-volume programs whose poll-path
// getTransaction was measured ~94-100% parser-dropped during low-sale windows
// (the poll path has no logs, so it can't shed non-sale sigs before fetch).
//
// A target accrues an "idle streak" ONLY on sweeps that dispatched > 0 sigs yet
// produced 0 accepted sales (v1 is conservative: empty sweeps on a quiet target
// do NOT degrade cadence). After 3 such sweeps it stretches 5s → 15s; after 8,
// → 30s. The FIRST accepted sale snaps it back to 5s. Backoff is force-disabled
// whenever the safety net matters most: WS dead, mid-catch-up (saturated),
// pending backlog, or first run. Latency added only during proven-idle periods;
// coverage is never reduced (sweeps still run, just less often).
const BACKOFF_L0_MS = 5_000;

// Per-target backoff tuning. mmm is stronger (it was ~95-100% parser-dropped:
// ~299 dispatched / ~0 accepted in the audit window) so it ramps sooner and
// further; me_v2 has real fixed-price sales so it stays conservative.
//
// L3 (`l3Ms` / `l3Streak`) is an optional aggressive fallback: after l3Streak
// further idle sweeps past L2, cadence stretches to l3Ms (effectively a
// "useful ratio stayed at 0% across the L2 window" auto-aggressive mode).
// First accepted sale snaps any level back to L0. WS-dead / catch-up /
// backlog / first-run still force-normal as before.
interface BackoffCfg {
  l1Ms: number; l2Ms: number;
  l1Streak: number; l2Streak: number;
  /** Optional L3 — aggressive cadence after sustained 0% useful at L2. */
  l3Ms?: number; l3Streak?: number;
}
const BACKOFF_CFG: Record<string, BackoffCfg> = {
  // mmm tightened: was 20s/60s @ 2/5 streaks; now 30s/120s @ 1/4 with
  // 300s (5min) aggressive mode after 10 cumulative idle sweeps
  // (~20 min at L2 cadence) — matches the user's 1%/20min guard intent.
  'poll:mmm':   { l1Ms: 30_000, l2Ms: 120_000, l3Ms: 300_000, l1Streak: 1, l2Streak: 4, l3Streak: 10 },
  // me_v2 has real fixed-price ME sales whose discovery rides this cadence
  // (the WS prefilter passes only ~8% of ME sales; the poller recovers the
  // rest). Softened 2026-06-18 to cut the regular-ME latency tail: stay at
  // L0 (5s) longer (l1Streak 3→5, l2Streak 8→12) and shrink the backed-off
  // intervals (l1 15s→10s, l2 30s→20s). Trades a modest increase in cheap
  // getSignaturesForAddress sweeps during ME lulls — getTransaction count is
  // unchanged (same sales fetched once) — for a ~15–30s → ~10–20s tail.
  'poll:me_v2': { l1Ms: 10_000, l2Ms: 20_000,  l1Streak: 5, l2Streak: 12 },
};
const BACKOFF_TARGETS: ReadonlySet<string> = new Set(Object.keys(BACKOFF_CFG));

type BackoffLevel = 0 | 1 | 2 | 3;
interface BackoffState {
  level:        BackoffLevel;
  idleStreak:   number;
  acceptedSnap: number;  // cumulative accepted count at last evaluation
  nextDueTs:    number;  // sweep skipped while now < nextDueTs
}
const backoffState: Map<string, BackoffState> = new Map();
function backoffFor(name: string): BackoffState {
  let s = backoffState.get(name);
  if (!s) {
    s = { level: 0, idleStreak: 0, acceptedSnap: getAcceptedCount(name), nextDueTs: 0 };
    backoffState.set(name, s);
  }
  return s;
}
function intervalForLevel(name: string, level: BackoffLevel): number {
  if (level === 0) return BACKOFF_L0_MS;
  const cfg = BACKOFF_CFG[name];
  if (level === 3 && cfg.l3Ms != null) return cfg.l3Ms;
  return level === 2 ? cfg.l2Ms : cfg.l1Ms;
}

/** True when a backoff target's sweep is NOT yet due (skip it this tick).
 *  Always false for non-backoff targets and when force-normal conditions hold. */
function backoffSkip(name: string, now: number): boolean {
  if (!BACKOFF_TARGETS.has(name)) return false;
  const s = backoffFor(name);
  if (s.level === 0) return false;
  return now < s.nextDueTs;
}

/** Re-evaluate a backoff target's cadence after a sweep completes.
 *  `dispatched` = sigs handed to ingest this sweep; `forceNormal` collapses
 *  the level to 0 (catch-up / backlog / WS-dead / first-run). Logs transitions
 *  only. */
function evaluateBackoff(
  name: string, dispatched: number, forceNormal: boolean, now: number,
): void {
  if (!BACKOFF_TARGETS.has(name)) return;
  const s = backoffFor(name);
  const acceptedNow   = getAcceptedCount(name);
  const acceptedDelta = acceptedNow - s.acceptedSnap;
  s.acceptedSnap = acceptedNow;
  const prevLevel = s.level;

  if (acceptedDelta > 0) {
    // Recovery — a real sale landed. Snap back to fast cadence immediately.
    s.idleStreak = 0;
    s.level = 0;
    s.nextDueTs = now + BACKOFF_L0_MS;
    if (prevLevel !== 0) {
      console.log(`[poll/backoff] target=${name} recovered interval=${BACKOFF_L0_MS} accepted=${acceptedDelta}`);
    }
    return;
  }

  if (forceNormal) {
    // Coverage-critical window — keep full cadence, don't accrue idle.
    s.idleStreak = 0;
    s.level = 0;
    s.nextDueTs = now + BACKOFF_L0_MS;
    return;
  }

  // v1 conservative: only a sweep that did work (dispatched>0) but yielded no
  // sale counts as "bad". Empty sweeps on a quiet target are NOT idle-accruing.
  if (dispatched > 0 && acceptedDelta === 0) {
    s.idleStreak += 1;
  }

  const cfg = BACKOFF_CFG[name];
  const newLevel: BackoffLevel =
    (cfg.l3Streak != null && cfg.l3Ms != null && s.idleStreak >= cfg.l3Streak) ? 3 :
    s.idleStreak >= cfg.l2Streak ? 2 :
    s.idleStreak >= cfg.l1Streak ? 1 : 0;
  s.level = newLevel;
  s.nextDueTs = now + intervalForLevel(name, newLevel);
  if (newLevel !== prevLevel && newLevel > 0) {
    console.log(`[poll/backoff] target=${name} level=${newLevel} interval=${intervalForLevel(name, newLevel)} useful=0.0%`);
  }
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

    const { rows: page, saturated, pages } = await fetchSinceCursor(
      target.program, lastSig, catchup?.before ?? null, gen, target.name,
    );

    // Track low-page streak per target. Three quiet sweeps in a row
    // force-exit any stale catch-up — covers the case where the
    // saturated detection happened to flicker on a one-shot burst.
    let forceExitCatchup = false;
    if (pages <= LOW_PAGE_THRESHOLD) {
      const streak = (lowPageStreak.get(target.name) ?? 0) + 1;
      lowPageStreak.set(target.name, streak);
      if (catchup && streak >= LOW_PAGE_STREAK_TO_EXIT) {
        forceExitCatchup = true;
      }
    } else {
      lowPageStreak.set(target.name, 0);
    }
    // Track saturation per-target so the tick scheduler can slow down
    // the sweep cadence when at least one target is in catch-up.
    if (saturated) saturatedTargets.add(target.name);
    else           saturatedTargets.delete(target.name);
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
      // Empty sweep: dispatched=0 → never idle-accrues in v1, but still let a
      // WS-driven sale recover the cadence (acceptedDelta>0) and refresh due-ts.
      evaluateBackoff(
        target.name, 0,
        isSalesWsDead() || saturated || backlog.length > 0 || lastSig === null,
        Date.now(),
      );
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
    const FRESH_CUTOFF = freshCutoffForTarget(target.name);
    const sourceLabel = sourceFromTargetName(target.name);

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
          // dispatchMmmDeferred may skip the fetch (WS-resolved or noise-shed);
          // incFired is therefore done from inside the deferred dispatch lambda.
          dispatchMmmDeferred(
            info.signature,
            (s) => { incFired(sourceLabel); return target.ingest(s); },
            target.name,
          );
        } else {
          incFired(sourceLabel);
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
    } else if (catchup && forceExitCatchup) {
      // Streak exit — three consecutive low-page sweeps with a stale
      // catch-up marker. Promote frozen_newest to `until` and clear.
      await setLastSig(target.name, catchup.frozenNewest);
      await clearLastSig(`${target.name}:catchup`);
      console.log(
        `[${target.name}] catchup force-exit (low-page streak)  ` +
        `until=${catchup.frozenNewest.slice(0, 12)}…`,
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

    // Useful-ratio backoff (poll:mmm / poll:me_v2 only). dispatched=ingested.
    // Force-normal when coverage matters most: WS dead, mid-catch-up, pending
    // backlog, or first run (cold cursor). Otherwise idle-accrue on a sweep
    // that did work but produced no sale.
    evaluateBackoff(
      target.name, ingested,
      isSalesWsDead() || saturated || backlog.length > 0 || lastSig === null,
      Date.now(),
    );
  } catch (err: unknown) {
    console.error(`[${target.name}] sweep error`, err);
  } finally {
    sweepInFlight.set(target.name, false);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

// In the lean modes (`sales_only` and `budget`) the AMM poller doubles
// as a safety net for transient WS stalls. MMM was already included
// because its sale-side instructions aren't in the deny-list; for the
// same reason TAMM (Tensor AMM) is INCLUDED here too — `sellNftTradePool`
// / `buyNftTradePool` log names DO pass the tensor prefilter, but
// Helius WS still drops them under burst load (confirmed against
//   5gg7cMUaXStgQY4UsujwC5DHgz4SNUsxnY8e7kWfcYxi1qNwBHEUvncKZ27HANDYg4oTJkR3YJVLVxGhEjzxZCQq
// and 3 sibling sigs from the same `5XDWm4…eiCL` SCOUT bid-dump where
// 4 of 8 TAMM sales went missing in /feed). The earlier "listener
// pollAll already sweeps tamm" claim doesn't survive lean mode, where
// pollAll is itself rate-shaped. Cost is small: tamm sale volume is
// modest and the tensor prefilter still shed non-sale txs before
// fetchRawTx for the WS path; the poller path lacks logs but the
// tensor-raw parser DROPs unrecognised ixs cheaply.
// Full mode keeps the behaviour unchanged (all targets polled).
const LEAN_MODE_TARGETS: ReadonlySet<string> = new Set(['poll:me_v2', 'poll:mmm', 'poll:tcomp', 'poll:tamm']);
function isLeanMode(mode: ReturnType<typeof getMode>): boolean {
  return mode === 'sales_only' || mode === 'budget';
}

let tickSeq = 0;
function tick(): void {
  const mode = getMode();
  if (mode === 'off') return;
  tickSeq++;
  console.log(`[sig/amm/tick] seq=${tickSeq}  ts=${new Date().toISOString()}  mode=${mode}`);
  // Resume any backlog preserved across an OFF cycle. `kickBacklogDrain`
  // is a no-op when the previous drain hasn't yet flipped `backlogDraining`
  // back to false (it might still be unwinding from its own mode-off bail
  // when `startAmmPoller` ran), so we re-attempt on every tick — the next
  // tick (≤ INTERVAL_MS later) self-corrects the race.
  if (backlog.length > 0 && !backlogDraining) {
    console.log(`[poller] resuming preserved backlog  size=${backlog.length}`);
    kickBacklogDrain();
  }
  // Emergency cost guard: degrade sales polling when the sales WS is dead.
  // Log once per state transition.
  const dead = isSalesWsDead();
  if (dead !== salesWsDegraded) {
    salesWsDegraded = dead;
    console.log(dead
      ? '[poller] sales WS dead → degraded polling (15s, me_v2+mmm only)'
      : '[poller] sales WS recovered → normal polling (5s, all targets)');
  }

  // Fire enabled targets — each has its own re-entrancy guard, so overlap
  // between ticks for the same target is prevented without blocking other
  // targets. Staggered by TICK_STAGGER_MS so the per-program sig calls don't
  // all land in the same instant (the first target still fires immediately).
  let slot = 0;
  const now = Date.now();
  for (const t of TARGETS) {
    if (isLeanMode(mode) && !LEAN_MODE_TARGETS.has(t.name)) continue;
    // While sales WS is dead, only poll the high-signal programs.
    if (dead && !DEGRADED_TARGETS.has(t.name)) continue;
    // Per-target useful-ratio backoff: skip a backed-off target until its
    // stretched cadence comes due. Non-backoff targets (tcomp/tamm) and the
    // global tick cadence are unaffected.
    if (backoffSkip(t.name, now)) continue;
    const offset = slot * TICK_STAGGER_MS;
    slot++;
    if (offset === 0) {
      sweepTarget(t).catch((err) => console.error(`[${t.name}] unhandled`, err));
    } else {
      const h = setTimeout(() => {
        if (getMode() === 'off') return; // mode flipped during the stagger window
        sweepTarget(t).catch((err) => console.error(`[${t.name}] unhandled`, err));
      }, offset);
      if (typeof h.unref === 'function') h.unref();
    }
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
    `  interval=${INTERVAL_MS / 1000}s/${SLOW_INTERVAL_MS / 1000}s  page=${PAGE_SIZE}`
  );
  // Self-rescheduling tick. Picks the next delay based on saturation
  // state: fast (5 s) in steady state, slow (10 s) when at least one
  // target reported `saturated=true` on its last sweep. setTimeout +
  // re-arm rather than setInterval so the cadence can flex tick-by-tick
  // without a separate timer-management state machine.
  const arm = (delay: number): void => {
    tickHandle = setTimeout(() => {
      tick();
      // Degraded cadence wins when sales WS is dead; otherwise slow on
      // saturation, else normal.
      const next = isSalesWsDead() ? DEGRADED_INTERVAL_MS
                 : saturatedTargets.size > 0 ? SLOW_INTERVAL_MS
                 : INTERVAL_MS;
      arm(next);
    }, delay);
    if (typeof tickHandle.unref === 'function') tickHandle.unref();
  };
  // Fire the first sweep immediately so startup latency is bounded by the
  // RPC round-trip, not by `INTERVAL_MS`.
  tick();
  arm(INTERVAL_MS);
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
    // tickHandle is now a setTimeout handle (self-rescheduling cadence);
    // clearTimeout is the matching teardown.
    clearTimeout(tickHandle);
    tickHandle = null;
  }
  const preservedBacklog = backlog.length;
  const droppedLimiter   = rpcLimiterAbortQueued();
  sweepInFlight.clear();
  console.log(
    `[poller] stopped  backlog_preserved=${preservedBacklog}  rpcLimiter_dropped=${droppedLimiter}`
  );
}
