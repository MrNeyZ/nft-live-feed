/**
 * Real-time ingestion via Solana standard RPC logsSubscribe.
 *
 * Opens one WebSocket per program. On each confirmed transaction notification:
 *   1. Skip failed (err != null) transactions immediately.
 *   2. Pass the signature to the appropriate raw ingest function.
 *   3. ingestMeRaw / ingestTensorRaw fetch the full tx and run the parser.
 *
 * Uses STANDARD RPC websocket endpoint — not Helius enhanced API.
 * No Helius compute-unit cost beyond the getTransaction calls inside ingest.
 *
 * Reconnects automatically on close/error with exponential backoff (10s → 120s).
 * Slot heartbeat + dual watchdog + forced 120s restart prevent silent stalls.
 */
import WebSocket from 'ws';
import { ingestMeRaw } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { Limiter } from './concurrency';

// ─── Targets ──────────────────────────────────────────────────────────────────

type IngestFn = (sig: string) => Promise<void>;

interface Target {
  /** Short name used in log prefixes and stats output. */
  name:    string;
  program: string;
  ingest:  IngestFn;
}

const TARGETS: Target[] = [
  {
    name:    'me_v2',
    program: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
    ingest:  ingestMeRaw,
  },
  {
    name:    'mmm',
    program: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc',
    ingest:  ingestMeRaw,
  },
  {
    name:    'tcomp',
    program: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp',
    ingest:  ingestTensorRaw,
  },
  {
    name:    'tamm',
    program: 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg',
    ingest:  ingestTensorRaw,
  },
];

// ─── Concurrency limiters ─────────────────────────────────────────────────────
//
// Both paths call fetchRawTx (1–3s each).
// With Limiter(1, 150) each sig waited for the previous one to fully complete
// before starting — at 20 queued sigs × 2s each = 40s queue delay.
// Raising to 8 concurrent with no inter-call delay drains the queue in parallel.
// 8 concurrent getTransaction calls is well within Helius paid-plan limits.
const limiter       = new Limiter(4, 25);  // listener path — 4 concurrent, 25ms gap
const pollerLimiter = new Limiter(4, 25);  // poller path   — same budget

// ─── Seen-signature dedup (shared by listener + poller) ──────────────────────

// 5000 entries at ~5 genuinely-new sigs/s ≈ 1000s (16 min) before oldest evicts.
// 1000 was too small: a startup burst of 120 sigs fills it in 25s, evicting
// seeded sigs from low-activity programs (tamm/tcomp) and causing them to be
// re-ingested as "new" — the root cause of the high-blockAge stale-sig problem.
const SEEN_MAX = 5_000;
const seenSigs  = new Set<string>();
const seenQueue: string[] = [];   // insertion-order FIFO for bounded eviction

function markSeen(sig: string): void {
  if (seenSigs.has(sig)) return;
  seenSigs.add(sig);
  seenQueue.push(sig);
  if (seenQueue.length > SEEN_MAX) {
    seenSigs.delete(seenQueue.shift()!);
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

interface Stats {
  /** logsNotification received. */
  seen:     number;
  /** ingest() called — tx had err=null (on-chain success). */
  fired:    number;
  /** Skipped — tx had err!=null (on-chain failure). */
  filtered: number;
  /** ingest() threw an unexpected error. */
  errors:   number;
}

function newStats(): Stats {
  return { seen: 0, fired: 0, filtered: 0, errors: 0 };
}

// Accumulate stats per target name; log every 60 seconds.
const statsMap = new Map<string, Stats>();
for (const t of TARGETS) statsMap.set(t.name, newStats());

function logStats() {
  for (const [name, s] of statsMap) {
    // Always log every target — a line showing seen=0 makes a silent
    // subscription immediately visible in the output instead of just
    // disappearing from the logs while the process appears healthy.
    console.log(
      `[listener/${name}] seen=${s.seen} fired=${s.fired}` +
      ` filtered=${s.filtered} errors=${s.errors}`
    );
    // Reset window counts after logging
    statsMap.set(name, newStats());
  }
}

// ─── Log pre-filter ───────────────────────────────────────────────────────────
//
// logsSubscribe fires for every transaction that mentions a watched program,
// not just sales. Most are listings, cancels, bids, updates, etc.
// We inspect the log strings before calling fetchRawTx to avoid wasting RPC
// quota on transactions that cannot be sales.
//
// Match is case-insensitive and underscore-agnostic so it covers both the
// Anchor PascalCase log format ("ExecuteSale") and snake_case variants ("accept_offer").

// Exact instruction names that identify completed sales across all watched programs.
// Matched case-insensitively against the "Program log: Instruction: <name>" lines
// emitted by each Anchor program into the transaction log.
//
// TakeBidFullMeta  — tcomp bid accept — Core / pNFT (our parser name: takeBid)
// TakeBidLegacy   — tcomp bid accept — legacy SPL NFT (anchorDisc: bc23746c00e9edc9)
// Buy             — tcomp listing purchase / tamm pool buy
// coreFulfillBuy  — mmm Core NFT pool buy  (logged as SolMplCoreFulfillBuy)
// coreFulfillSell — mmm Core NFT pool sell (logged as SolMplCoreFulfillSell)
// executeSale     — me_v2 legacy/pNFT fixed-price sale
// coreExecuteSaleV2 — me_v2 Core fixed-price sale
// mip1ExecuteSaleV2 — me_v2 pNFT/mip1 fixed-price sale
// solMip1FulfillBuy  — mmm pNFT pool buy
// solMip1FulfillSell — mmm pNFT pool sell
const SALE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'takebidfullfmeta',    // tcomp bid accept — Core / pNFT
  'takebidlegacy',       // tcomp bid accept — legacy SPL NFT  ← confirmed live tx bc23746c...
  'buy',
  'corefulfillbuy',
  'corefulfillsell',
  'executesale',
  'coreexecutesalev2',   // CoreExecuteSaleV2 — me_v2 Core NFT fixed-price sale
  'mip1executesalev2',
  'solmip1fulfillbuy',
  'solmip1fulfillsell',
  'solfulfillbuy',      // mmm legacy SPL pool buy  (confirmed disc 5c10e24f1ff23576)
  'solfulfillsell',     // mmm legacy SPL pool sell (confirmed disc a4b460c067e169e8, unverified layout)
]);

const LOG_IX_PREFIX = 'program log: instruction: ';

function hasSaleInstruction(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length === 0) return false;
  for (const line of logs as string[]) {
    const lower = (line as string).toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    const ix = lower.slice(LOG_IX_PREFIX.length);
    if (SALE_INSTRUCTIONS.has(ix)) return true;
  }
  return false;
}

// ─── WebSocket URL ────────────────────────────────────────────────────────────

function wssUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}

// ─── Watchdog state ───────────────────────────────────────────────────────────

/** Last logsNotification across all program subscriptions. */
let lastEventTs = Date.now();

/**
 * Last slotNotification from the dedicated slot-heartbeat WebSocket.
 * Solana produces a new slot every ~400ms, so this going stale means the WS
 * connection itself is dead even when no NFT sales are occurring.
 */
let lastSlotTs = Date.now();

/**
 * Per-target timestamp of the last logsNotification received.
 * Tracked independently of the shared lastEventTs so the watchdog can detect
 * a specific subscription going silent while other targets remain active.
 * (tamm activity keeping lastEventTs fresh would otherwise mask me_v2/mmm/tcomp deaths.)
 */
const lastNotificationTs = new Map<string, number>(
  TARGETS.map((t) => [t.name, Date.now()]),
);

/**
 * Per-target timestamp of the LAST REAL logsNotification received.
 * Unlike lastNotificationTs, this is NEVER updated by restart/reconnect events —
 * only by genuine incoming messages. Used by the soft-refresh to distinguish
 * "target was restarted recently" (lastNotificationTs fresh, lastRealNotifTs stale)
 * from "target actually received traffic" (both fresh).
 */
const lastRealNotifTs = new Map<string, number>(
  TARGETS.map((t) => [t.name, Date.now()]),
);

/**
 * How long a single target may go without any logsNotification before its
 * subscription is torn down and reopened. Two minutes is safely above any
 * real quiet period for the high-activity programs (me_v2, mmm) while still
 * recovering within the 10-20 minute degradation window the user observes.
 */
const STALE_TARGET_MS = 120_000; // 2 minutes

/** Active program WebSocket per target name. */
const activeSockets = new Map<string, WebSocket>();

/** Dedicated slot-heartbeat WebSocket (single instance). */
let slotWs: WebSocket | null = null;

/** Guard: prevent concurrent restartListeners() calls. */
let restarting = false;

// ─── Single-program subscription ─────────────────────────────────────────────

const BACKOFF_MIN_MS = 10_000;  // 10s minimum — avoids rapid reconnect storms
const BACKOFF_MAX_MS = 120_000; // 2 min ceiling

function openSubscription(target: Target, backoffMs = BACKOFF_MIN_MS, isReconnect = false): void {
  // NOTE: lastNotificationTs is NOT reset here.
  // Resetting it on every reconnect (including automatic close-handler reconnects)
  // would mask silent subscriptions: if Helius drops idle WebSocket connections
  // every ~30s, the clock is reset on each reconnect and never ages to
  // STALE_TARGET_MS — which is exactly the me_v2/mmm/tcomp non-restart bug.
  // The clock is reset only in restartTarget (explicit watchdog restart) and
  // restartListeners (full restart), where a deliberate grace period is wanted.

  const stats = statsMap.get(target.name)!;
  let url: string;
  try {
    url = wssUrl();
  } catch (err) {
    console.error(`[listener/${target.name}] config error`, err);
    return;
  }

  const ws = new WebSocket(url);
  activeSockets.set(target.name, ws);

  ws.once('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'logsSubscribe',
      params: [
        { mentions: [target.program] },
        { commitment: 'processed' },
      ],
    }));
    backoffMs = BACKOFF_MIN_MS;
    console.log(`[listener/${target.name}] subscribed  program=${target.program.slice(0, 8)}...`);

    // Catch-up: immediately poll for sigs missed during the disconnect window.
    // The WS reconnect proves the Helius HTTP endpoint is reachable again —
    // this is the earliest safe moment to run getSignaturesForAddress.
    // Existing seenSigs + recentSigs dedup means any sig already processed by
    // the regular poller (if HTTP stayed up) is skipped at no cost.
    if (isReconnect) {
      console.log(`[listener/${target.name}] catch-up poll after reconnect`);
      pollTarget(target).catch(() => {});
    }
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.id === 1 && typeof msg.result === 'number') return;
    if (msg.method !== 'logsNotification') return;

    const value = msg.params?.result?.value;
    if (!value?.signature) return;

    lastEventTs = Date.now();
    lastNotificationTs.set(target.name, Date.now());
    lastRealNotifTs.set(target.name, Date.now()); // real traffic only — never set by restarts
    stats.seen++;

    if (value.err !== null && value.err !== undefined) {
      stats.filtered++;
      return;
    }

    // Pre-filter: skip if logs contain no recognised sale instruction.
    // Eliminates ~90% of RPC calls from listings, bids, cancels, etc.
    if (!hasSaleInstruction(value.logs)) {
      stats.filtered++;
      return;
    }

    stats.fired++;
    const sig = value.signature as string;
    // Do NOT call markSeen here. Cross-path dedup is handled inside fetchRawTx:
    //   inFlight   — blocks concurrent double-fetch while the listener fetch is live
    //   recentSigs — 3-min TTL, set only on successful fetch
    // Calling markSeen before ingest completes would permanently block the poller
    // from retrying a sig whose raw fetch failed (429 cooldown, timeout, etc.).
    limiter
      .run(() => target.ingest(sig))
      .catch((err: unknown) => {
        stats.errors++;
        console.error(`[listener/${target.name}] ingest error  sig=${sig.slice(0, 12)}...`, err);
      });
  });

  ws.on('error', (err: Error) => {
    console.error(`[listener/${target.name}] ws error`, err.message);
  });

  ws.on('close', (code: number) => {
    activeSockets.delete(target.name);
    const nextBackoff = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    console.warn(`[listener/${target.name}] disconnected (code=${code})  reconnecting in ${backoffMs / 1000}s`);
    setTimeout(() => openSubscription(target, nextBackoff, true), backoffMs);
  });
}

// ─── Slot heartbeat subscription ─────────────────────────────────────────────
//
// slotSubscribe fires ~every 400ms. If lastSlotTs goes stale it means the WS
// connection is dead regardless of whether NFT sales are happening — this
// catches silent stalls that logsNotification alone cannot detect at low volume.

function openSlotSubscription(): void {
  let url: string;
  try { url = wssUrl(); } catch { return; }

  const ws = new WebSocket(url);
  slotWs = ws;

  ws.once('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:      2,
      method:  'slotSubscribe',
    }));
    console.log('[listener/slot] subscribed');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.method === 'slotNotification') {
      lastSlotTs = Date.now();
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[listener/slot] ws error', err.message);
  });

  ws.on('close', (code: number) => {
    slotWs = null;
    console.warn(`[listener/slot] disconnected (code=${code})  reconnecting in ${BACKOFF_MIN_MS / 1000}s`);
    setTimeout(openSlotSubscription, BACKOFF_MIN_MS);
  });
}

// ─── Watchdog / forced restart ────────────────────────────────────────────────

/**
 * Tears down all active WebSocket connections and immediately re-subscribes.
 * removeAllListeners() on each socket prevents the normal close-handler from
 * scheduling a second (backoff-delayed) reconnect on top of our immediate one.
 * Guards against concurrent calls with `restarting` flag.
 */
function restartListeners(reason: string): void {
  if (restarting) return;
  restarting = true;

  console.log(`[listener] restart → ${reason}`);

  // Tear down program sockets.
  for (const [, ws] of activeSockets) {
    ws.removeAllListeners();
    ws.terminate();
  }
  activeSockets.clear();

  // Tear down slot socket.
  if (slotWs) {
    slotWs.removeAllListeners();
    slotWs.terminate();
    slotWs = null;
  }

  // Reset watchdog clocks so the next check doesn't fire again immediately.
  lastEventTs = Date.now();
  lastSlotTs  = Date.now();
  const now = Date.now();
  for (const target of TARGETS) lastNotificationTs.set(target.name, now);

  // Re-subscribe all. isReconnect=true triggers a catch-up poll on open so
  // sigs missed during the watchdog's stall window are recovered immediately.
  for (const target of TARGETS) openSubscription(target, BACKOFF_MIN_MS, true);
  openSlotSubscription();

  restarting = false;
}

/**
 * Tear down and reopen a single target's WebSocket subscription.
 * Used by the per-target watchdog when one program goes silent while others
 * remain healthy — avoids a full restartListeners() that would disrupt working
 * subscriptions unnecessarily.
 */
function restartTarget(target: Target, reason: string): void {
  if (restarting) return; // full restart already in progress — it will reopen this target too

  const ws = activeSockets.get(target.name);
  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    activeSockets.delete(target.name);
  }

  // Grant a fresh grace window so the watchdog doesn't fire again immediately.
  lastNotificationTs.set(target.name, Date.now());

  console.warn(`[listener/${target.name}] restart → ${reason}`);
  openSubscription(target, BACKOFF_MIN_MS, true);
}

// ─── Fallback poller ─────────────────────────────────────────────────────────

const POLL_LIMIT        = 60;    // covers a 3s burst without over-fetching on dev plan
const POLL_INTERVAL_MS  = 3_000; // 3s cadence — reduces getSignaturesForAddress rate pressure
const MAX_BLOCK_AGE_S   = 300;   // 5-minute window — covers BACKOFF_MAX_MS (120s) with margin.
                                  // ME v2 type=DEPOSIT sales (BuyV2+CoreExecuteSaleV2) are not
                                  // delivered by the Helius webhook or API poller; the
                                  // getSignaturesForAddress poller here is the only recovery path.

function rpcHttpUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function pollTarget(target: Target): Promise<void> {
  // Retry once on network/HTTP failure — the most common cause is the same
  // transient Helius outage that caused the WS disconnect in the first place.
  // One retry with a short pause is enough to survive brief blips without
  // introducing meaningful delay on the happy path.
  let res: Response | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 600));
    try {
      const r = await fetch(rpcHttpUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'getSignaturesForAddress',
          params:  [target.program, { limit: POLL_LIMIT, commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) { res = r; break; }
      // HTTP error (429, 5xx) — log on final attempt only to avoid spam.
      if (attempt === 1) {
        console.warn(`[poller/${target.name}] HTTP ${r.status}  skipping cycle`);
      }
    } catch {
      // Network error or timeout — try again (silently give up after last attempt).
    }
  }

  if (!res) return;

  const json = await res.json() as {
    result?: Array<{ signature: string; err: unknown; blockTime?: number | null }>;
  };

  const rows = json.result;
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    if (!row.signature || row.err !== null) continue;

    // Drop stale sigs regardless of seenSigs state.
    // getSignaturesForAddress returns newest-first; low-activity programs can
    // surface sigs hours old. Without this gate, seenSigs FIFO eviction causes
    // those old sigs to re-enter the ingest queue as if they were new.
    if (row.blockTime && (Date.now() / 1000 - row.blockTime) > MAX_BLOCK_AGE_S) continue;

    if (seenSigs.has(row.signature)) continue;

    const sig = row.signature;
    markSeen(sig);
    pollerLimiter
      .run(() => target.ingest(sig))
      .catch((err: unknown) => {
        console.error(`[poller/${target.name}] ingest error  sig=${sig.slice(0, 12)}...`, err);
      });
  }
}

async function pollAll(): Promise<void> {
  await Promise.allSettled(TARGETS.map(pollTarget));
}

async function seedSeenSigs(): Promise<void> {
  for (const target of TARGETS) {
    try {
      const res = await fetch(rpcHttpUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'getSignaturesForAddress',
          params:  [target.program, { limit: POLL_LIMIT, commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const json = await res.json() as { result?: Array<{ signature: string }> };
      for (const row of json.result ?? []) {
        if (row.signature) markSeen(row.signature);
      }
    } catch {
      // Non-fatal — poller will just process these on the first cycle.
    }
  }
  console.log(`[poller] seeded  seen=${seenSigs.size}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startListener(): void {
  console.log(`[listener] starting  targets=${TARGETS.length}  concurrency=${limiter.max}`);

  for (const target of TARGETS) openSubscription(target);
  openSlotSubscription();

  // Heartbeat — confirms the listener process is alive.
  setInterval(() => {
    console.log('[listener] alive', new Date().toISOString());
  }, 60_000).unref();

  // Watchdog — checked every 15s, three independent tiers:
  //
  //  1. Slot stale (>20s)  → full restart: the underlying TCP connection is dead.
  //  2. Global event stale (>30s) → full restart: all subscriptions appear broken.
  //  3. Per-target stale (>120s) → targeted restart of only the silent subscription.
  //
  // Tier 3 is the critical addition: without it, a single active subscription
  // (e.g. tamm) refreshes the shared lastEventTs and masks the silent death of
  // me_v2/mmm/tcomp indefinitely — the observed 10–20 min degradation pattern.
  setInterval(() => {
    const now = Date.now();
    if (now - lastSlotTs > 20_000) {
      restartListeners('stale (no slots for 20s)');
    } else if (now - lastEventTs > 30_000) {
      restartListeners('stale (no events for 30s)');
    } else {
      // Global connection is healthy — check each subscription individually.
      for (const target of TARGETS) {
        const last = lastNotificationTs.get(target.name) ?? now;
        if (now - last > STALE_TARGET_MS) {
          restartTarget(target, `stale (no notifications for ${STALE_TARGET_MS / 1000}s)`);
        }
      }
    }
  }, 15_000).unref();

  // Log aggregate stats every 60 seconds.
  setInterval(logStats, 60_000).unref();

  // ── Hard periodic refresh (temporary reliability workaround) ─────────────
  //
  // Every 3 minutes, unconditionally restart every target subscription.
  // No skip conditions — active targets are restarted the same as silent ones.
  //
  // Uses restartTarget(), which (a) terminates the existing WS, (b) resets
  // lastNotificationTs (watchdog grace window), and (c) calls openSubscription
  // with isReconnect=true so a catch-up poll fires on the new socket open.
  // seenSigs dedup prevents any re-ingestion of already-processed signatures.
  //
  // Only guard: skip if a full restartListeners() is already in progress —
  // that already restarts every target.
  const HARD_REFRESH_INTERVAL_MS = 3 * 60_000; // 3 minutes

  let hardRefreshing = false;

  setInterval(() => {
    if (restarting || hardRefreshing) return;
    hardRefreshing = true;
    console.log('[listener] hard-refresh cycle start');
    try {
      for (const target of TARGETS) {
        restartTarget(target, 'hard periodic refresh (3 min)');
      }
    } finally {
      hardRefreshing = false;
    }
  }, HARD_REFRESH_INTERVAL_MS).unref();

  // Fallback poller — starts after seeding to avoid replaying startup sigs.
  seedSeenSigs().finally(() => {
    setInterval(() => { pollAll().catch(() => {}); }, POLL_INTERVAL_MS).unref();
    console.log(`[poller] started  interval=${POLL_INTERVAL_MS}ms  limit=${POLL_LIMIT}  targets=${TARGETS.length}`);
  });
}
