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
import { ingestMeRaw } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { getLastSig, setLastSig } from '../db/poller-state';
import { trace } from '../trace';
import { Priority } from './concurrency';
import { HeliusEnhancedTransaction } from './helius/types';
import { incSigListFetch } from './telemetry';

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

// 30 s (was 2.5 s) — `listener.pollAll` already sweeps the same 4 programs at
// 1.5 s with limit=100 and `sigSeen/inFlight` collapses any duplicate discovery
// onto a single `getTransaction`. This poller's only remaining job is the
// pages-2+ catch-up when a sweep is saturated — useful occasionally, not
// every 2.5 s. 12× rate reduction, zero Live-Feed latency change. Credit
// saving: ~5 300 `getSignaturesForAddress`/hr across the 4 programs.
const INTERVAL_MS = 30_000;
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
): Promise<SigInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { limit: PAGE_SIZE, commitment: 'confirmed' };
  if (until)  params.until  = until;
  if (before) params.before = before;

  incSigListFetch();
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
async function fetchSinceCursor(program: string, until: string | null): Promise<SigInfo[]> {
  // First run: one page, no pagination — treat "now" as the starting point.
  if (!until) return fetchPage(program, null, null);

  const all: SigInfo[] = [];
  let before: string | null = null;
  for (let i = 0; i < MAX_PAGES_PER_SWEEP; i++) {
    const page = await fetchPage(program, until, before);
    if (page.length === 0) break;
    all.push(...page);
    // Short page means we reached the `until` boundary — no gap possible.
    if (page.length < PAGE_SIZE) break;
    // Saturated page — page further back in time.
    before = page[page.length - 1].signature;
  }
  return all;
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

function kickBacklogDrain(): void {
  if (backlogDraining) return;
  backlogDraining = true;
  (async () => {
    try {
      while (backlog.length > 0) {
        const item = backlog.shift()!;
        try {
          // S4: deep catch-up sigs are low-priority. If the shared rpcLimiter
          // is busy serving fresh WS/poller work when this finally reaches it,
          // and the queue wait exceeds STALE_LOW_MS, the limiter drops the
          // task and fetchRawTx returns null — fine, we wasted zero RPC spend.
          await item.ingest(item.sig, undefined, 'low');
        } catch (err: unknown) {
          console.error(`[${item.target}] backlog ingest error  sig=${item.sig.slice(0, 12)}...`, err);
        }
        await new Promise((r) => setTimeout(r, BACKLOG_GAP_MS));
      }
    } finally {
      backlogDraining = false;
    }
  })();
}

async function sweepTarget(target: PollTarget): Promise<void> {
  if (sweepInFlight.get(target.name)) return;
  sweepInFlight.set(target.name, true);

  try {
    const lastSig = await getLastSig(target.name);
    const page    = await fetchSinceCursor(target.program, lastSig);
    const fetched = page.length;
    if (fetched === 0) {
      console.log(`[${target.name}] fetched=0`);
      return;
    }

    // Priority split: page-1 (the PAGE_SIZE newest sigs) is "fresh" and goes
    // straight to the shared rpcLimiter like before. Pages 2+ are catch-up
    // backlog — they enter a low-priority serial queue so they don't crowd
    // out fresh sigs arriving on subsequent sweeps.
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
        target.ingest(info.signature).catch((err: unknown) =>
          console.error(`[${target.name}] ingest error  sig=${info.signature.slice(0, 12)}...`, err)
        );
      } else {
        // Catch-up path — enqueue for serial drain so it doesn't starve fresh.
        backlog.push({ sig: info.signature, ingest: target.ingest, target: target.name });
        backlogged++;
      }
      ingested++;
    }
    if (backlogged > 0) kickBacklogDrain();

    // Advance cursor to the newest sig in this page.
    await setLastSig(target.name, page[0].signature);

    console.log(
      `[${target.name}] fetched=${fetched} unseen=${unseen} ingested=${ingested}` +
      `  fresh=${ingested - backlogged}  backlog=${backlogged}  skipped=${skipped}`
    );
  } catch (err: unknown) {
    console.error(`[${target.name}] sweep error`, err);
  } finally {
    sweepInFlight.set(target.name, false);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

function tick(): void {
  // Fire all targets in parallel — each has its own re-entrancy guard, so
  // overlap between ticks for the same target is prevented without blocking
  // other targets. Total steady-state rate: 4 getSignaturesForAddress / 30s.
  for (const t of TARGETS) {
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
  tickHandle = setInterval(tick, INTERVAL_MS);
  tickHandle.unref();
}

/** Stop the AMM gap-healer. Idempotent. In-flight `tick()` call (if any)
 *  completes normally — each sweep is guarded by `sweepInFlight` so a late
 *  completion after stop is harmless. */
export function stopAmmPoller(): void {
  if (!tickHandle) return;
  clearInterval(tickHandle);
  tickHandle = null;
  console.log('[poller] stopped');
}
