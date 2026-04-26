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
import { ingestMeRaw, markSigFetched } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { Limiter, Priority } from './concurrency';
import { incPrefilterSkip, incSigListFetch } from './telemetry';
import { noteSigList } from './sig-list-audit';
import { dispatchMmmDeferred } from './mmm-prefilter';
import { HeliusEnhancedTransaction } from './helius/types';
import { trace } from '../trace';
import { getMode, currentGeneration } from '../runtime/mode';

// ─── Targets ──────────────────────────────────────────────────────────────────

type IngestFn = (
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority?: Priority,
) => Promise<void>;

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
// Gate: both limiters short-circuit the moment runtime mode flips to off,
// so queued ingest tasks from the last active window don't fire a second
// `getTransaction` after the stop.
const limiter       = new Limiter(4, 25, 0, () => getMode() !== 'off');  // listener path — 4 concurrent, 25ms gap
const pollerLimiter = new Limiter(4, 25, 0, () => getMode() !== 'off');  // poller path   — same budget

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
// TakeBidFullMeta  — tcomp bid accept — Core / pNFT
// TakeBidLegacy   — tcomp bid accept — legacy SPL NFT (anchorDisc: bc23746c00e9edc9)
// TakeBidMetaHash — tcomp bid accept — cNFT via metadata hash
// TakeBidT22      — tcomp bid accept — Token-2022 NFT
// TakeBidWns      — tcomp bid accept — WNS NFT
// Buy             — tcomp listing purchase (generic, legacy/pNFT)
// BuyLegacy       — tcomp listing purchase — explicit legacy path
// BuyCore         — tcomp listing purchase — Core NFT
// BuyT22          — tcomp listing purchase — Token-2022 NFT
// BuyWns          — tcomp listing purchase — WNS NFT
// coreFulfillBuy  — mmm Core NFT pool buy  (logged as SolMplCoreFulfillBuy)
// coreFulfillSell — mmm Core NFT pool sell (logged as SolMplCoreFulfillSell)
// executeSale     — me_v2 legacy/pNFT fixed-price sale
// coreExecuteSaleV2 — me_v2 Core fixed-price sale
// mip1ExecuteSaleV2 — me_v2 pNFT/mip1 fixed-price sale
// solMip1FulfillBuy  — mmm pNFT pool buy
// solMip1FulfillSell — mmm pNFT pool sell
// solOcpFulfillBuy/Sell — mmm OCP token pool trades
// solExtFulfillBuy/Sell — mmm extended token standard pool trades
const SALE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  // tcomp bid accepts
  'takebidfullfmeta',       // Core / pNFT bid accept (full metadata)
  'takebidlegacy',          // legacy SPL bid accept  (confirmed bc23746c...)
  'takebidmetahash',        // cNFT bid accept (meta hash)
  'takebidt22',             // Token-2022 bid accept
  'takebidwns',             // WNS bid accept
  // tcomp listing purchases
  'buy',                    // generic (legacy/pNFT) + tamm pool buy
  'buylegacy',              // explicit legacy listing purchase
  'buycore',                // Core NFT listing purchase
  'buyt22',                 // Token-2022 listing purchase
  'buywns',                 // WNS listing purchase
  // mmm (ME AMM) pool trades
  'corefulfillbuy',
  'corefulfillsell',
  'solfulfillbuy',          // legacy SPL pool buy  (confirmed 5c10e24f...)
  'solfulfillsell',         // legacy SPL pool sell
  'solmip1fulfillbuy',
  'solmip1fulfillsell',
  'solocpfulfillbuy',       // OCP token pool buy
  'solocpfulfillsell',      // OCP token pool sell
  'solextfulfillbuy',       // ext token pool buy
  'solextfulfillsell',      // ext token pool sell
  // me_v2 fixed-price
  'executesale',
  'coreexecutesalev2',
  'mip1executesalev2',
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

/**
 * Targets whose logsNotification bypasses the `hasSaleInstruction` allowlist.
 * MMM logs human-readable dispatch names (e.g. `SolMplCoreFulfillBuy`) rather
 * than the Anchor method name the parser keys on, so an allowlist there is
 * brittle and silently drops real sales. Let the parser decide instead — it
 * already rejects non-sales cheaply via `findMmmSaleIx`.
 */
const LOG_PREFILTER_BYPASS: ReadonlySet<string> = new Set(['mmm']);

// ─── S3: Tensor-only log prefilter ───────────────────────────────────────────
//
// Before dispatching a WS sig into fetchRawTx we check the tx logs for an
// Anchor `Program log: Instruction: <name>` line that matches one of Tensor's
// known SALE instructions. Anything else (list / delist / bid / cancel /
// pool-edit / pool-create / deposit / withdraw) is obvious non-sale noise we
// can skip before paying for getTransaction. Unlike MMM, TComp and TAMM both
// emit Anchor-generated log names, so the allowlist is deterministic.
//
// On skip we call markSigFetched(sig) so the primary poller (1.5 s cadence on
// the same 4 programs) does not re-dispatch the sig a moment later — that's
// what converts the skip from "queue shed" into a real fetch saved.
//
// Fail mode: a new Tensor instruction we forget to add would be dropped. Kept
// strict to the names canonicalized in `TCOMP_SALE_INSTRUCTIONS` /
// `TAMM_SALE_INSTRUCTIONS` (programs.ts); if TAMM / TComp adds a new variant,
// the 60 s skip-stats log will surface it (unexpected names are rare —
// program deploys are public).
const TENSOR_SALE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  // tcomp
  'buy', 'buylegacy', 'buycore', 'buyt22', 'buywns',
  'takebidlegacy', 'takebidcore', 'takebidfullmeta', 'takebidmetahash',
  'takebidt22', 'takebidwns',
  // tamm
  'sell', 'sellnfttradepool', 'buynfttradepool',
]);

const TENSOR_PREFILTER_TARGETS: ReadonlySet<string> = new Set(['tcomp', 'tamm']);

// ─── S5: ME v2 deny-list prefilter ───────────────────────────────────────────
//
// Conservative: only skip WS notifications whose logs contain ONE OR MORE
// Anchor `Instruction:` lines AND ALL such instruction names are in the
// deny-list below. Any unknown or load-bearing instruction present → keep
// (fail-open). This protects every sale / list / delist / cancel while
// shedding the product-irrelevant offer mechanics.
//
// Deny-list rationale:
//   BuyV2        — user places an escrowed offer (deposit step). Not a sale,
//                  not a listing-state change. We don't surface per-mint ME
//                  offers anywhere in the product.
//   CancelBuyV2  — user cancels their own offer. Same reasoning.
//   CancelBuy    — older cancel-buy variant kept for completeness.
//
// MMM is intentionally NOT gated here: programs.ts notes that MMM logs can
// use dispatch names that diverge from the Anchor method names (e.g.
// `SolMplCoreFulfillBuy`, plus one observed instruction with name unknown).
// An allowlist or deny-list without full name coverage would silently drop
// real sales, which is the exact failure mode S3's comment calls out.
const ME_V2_SAFE_SKIP_LOG_NAMES: ReadonlySet<string> = new Set([
  'buyv2',
  'cancelbuy',
  'cancelbuyv2',
]);

/**
 * Ingestion mode. `sales_only` (and, for now, `budget`) widens the WS
 * prefilter deny-lists so listing-state instructions (ME v2 sell / cancel_sell
 * / MMM pool updates) are shed before `fetchRawTx` — listings become
 * TTL-driven but Helius getTransaction volume drops sharply. `full` leaves
 * the existing prefilters unchanged.
 *
 * Single source of truth: `getMode()` from runtime/mode.ts. Every call re-reads
 * the current mode so a runtime mode switch takes effect on the next filter
 * check — no module-level constants, no `process.env` mirroring.
 */
function effectiveMode(): string { return getMode(); }

// In sales_only / budget, also shed ME v2 list / delist instructions. Sale
// fills (execute_sale / core_execute_sale_v2 / mip1_execute_sale_v2 etc.)
// are NOT in this set — they remain fail-open.
const ME_V2_SALES_ONLY_EXTRA_SKIP: ReadonlySet<string> = new Set([
  'sell', 'mip1sell', 'coresell',
  'cancelsell', 'mip1cancelsell', 'corecancelsell',
]);

const ME_V2_LEAN_SKIP: ReadonlySet<string> =
  new Set([...ME_V2_SAFE_SKIP_LOG_NAMES, ...ME_V2_SALES_ONLY_EXTRA_SKIP]);

/** Mode-aware ME v2 deny-list. `budget` ≡ `sales_only` for prefilters until
 *  per-mode gating differentiates them. */
function effectiveMeV2Skip(): ReadonlySet<string> {
  const m = effectiveMode();
  return (m === 'sales_only' || m === 'budget') ? ME_V2_LEAN_SKIP : ME_V2_SAFE_SKIP_LOG_NAMES;
}

/**
 * True when the tx logs prove this ME v2 notification is product-irrelevant
 * under the active mode (every Anchor `Instruction:` line names a known
 * skippable method). Returns false if logs are absent, contain no Instruction
 * lines, or contain any non-deny-listed name → keep the sig.
 */
function shouldSkipMeV2Logs(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length === 0) return false;
  let seenInstruction = false;
  for (const line of logs as string[]) {
    const lower = (line ?? '').toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    seenInstruction = true;
    const ix = lower.slice(LOG_IX_PREFIX.length);
    if (!effectiveMeV2Skip().has(ix)) return false;  // any load-bearing name → keep
  }
  return seenInstruction;  // only true when every seen instruction was in the deny-list
}

// ─── sales_only: MMM deny-list prefilter ─────────────────────────────────────
//
// Active only when the runtime mode is 'sales_only' / 'budget'. Pool-admin / liquidity-
// change instructions are load-bearing for the listings/bids panels in
// full mode — in sales_only we explicitly accept TTL-only listings, so
// they can be shed before getTransaction.
//
// The deny-list is a confirmed-observed subset of MMM non-sale instructions
// (see earlier MMM audit: update_pool ~58 %, set_shared_escrow ~37 %,
// withdraw/deposit_buy ~3 %, close_pool ~1.5 %, create_pool ~1 %, plus
// standard deposit_sell / withdraw_sell variants). Every MMM SALE
// instruction — including the known-unknown `coreFulfillBuyV2` log name —
// is absent from this set and therefore fails-open, preserving sale
// coverage exactly as the audit's safety review required.
const MMM_SALES_ONLY_SKIP_LOG_NAMES: ReadonlySet<string> = new Set([
  'updatepool',
  'createpool',
  'solclosepool',
  'soldepositbuy',
  'solwithdrawbuy',
  'withdrawsell',
  'depositsell',
  'soldepositsell',
  'solwithdrawsell',
  'setsharedescrow',
]);

function shouldSkipMmmLogsSalesOnly(logs: unknown): boolean {
  const m = effectiveMode();
  if (m !== 'sales_only' && m !== 'budget') return false;
  if (!Array.isArray(logs) || logs.length === 0) return false;
  let seenInstruction = false;
  for (const line of logs as string[]) {
    const lower = (line ?? '').toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    seenInstruction = true;
    const ix = lower.slice(LOG_IX_PREFIX.length);
    if (!MMM_SALES_ONLY_SKIP_LOG_NAMES.has(ix)) return false;
  }
  return seenInstruction;
}

/** Scan WS logs for a Tensor-sale Anchor instruction. Fail-open if logs absent. */
function hasTensorSaleInstruction(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length === 0) return true;
  for (const line of logs as string[]) {
    const lower = (line ?? '').toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    const ix = lower.slice(LOG_IX_PREFIX.length);
    if (TENSOR_SALE_INSTRUCTIONS.has(ix)) return true;
  }
  return false;
}

// Per-target skip counters are routed into the aggregated [telemetry] line in
// src/ingestion/telemetry.ts so the console stays at one summary line / min.

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
 * Tracks whether each target has EVER received a real logsNotification since
 * process start. Needed for the health-gated poll cadence: a fresh start
 * looks "fresh" via `lastRealNotifTs` seeds but WS has delivered nothing —
 * we must not treat that as healthy. Toggles true in the WS `message`
 * handler alongside `lastRealNotifTs.set(...)`.
 */
const wsEverReal = new Map<string, boolean>(TARGETS.map((t) => [t.name, false]));

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

/**
 * True while ingestion is meant to be live. `stopListener()` flips it to
 * false and every reconnect/poll scheduler short-circuits on the check —
 * without this, open sockets are torn down but `setTimeout`-driven reconnects
 * would immediately re-open them and leak. Restarting after a stop is fine:
 * `startListener()` flips it back to true.
 */
let running = false;

/** Handles captured from `startListener()` so `stopListener()` can clear them. */
const intervalHandles: NodeJS.Timeout[] = [];

// ─── Single-program subscription ─────────────────────────────────────────────

const BACKOFF_MIN_MS = 10_000;  // 10s minimum — avoids rapid reconnect storms
const BACKOFF_MAX_MS = 120_000; // 2 min ceiling

function openSubscription(target: Target, backoffMs = BACKOFF_MIN_MS, isReconnect = false): void {
  if (!running) return;  // stopListener() was called — don't re-open
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
        // `confirmed` matches the `commitment: 'confirmed'` we use for
        // getTransaction in fetchRawTx. Subscribing at `processed` caused
        // a ~40 % null-result rate (measured via `nullTx=/min` telemetry):
        // Helius notified immediately at processed, then our fetch raced
        // ahead of the processed→confirmed indexing window (typically 0.8-
        // 1.2 s). Waiting for confirmed on the subscribe side adds the
        // same ~0.8 s to WS notification latency but eliminates the race
        // entirely. Downstream SSE still fires within a few seconds of
        // on-chain settlement.
        { commitment: 'confirmed' },
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
    // Ignore every notification after stop — we may still hold a reference
    // to the socket until terminate() finishes flushing.
    if (!running || getMode() === 'off') return;
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
    if (!wsEverReal.get(target.name)) wsEverReal.set(target.name, true);
    stats.seen++;

    if (value.err !== null && value.err !== undefined) {
      stats.filtered++;
      return;
    }

    // Pre-filter removed for me_v2 / mmm: the listener forwards every
    // transaction that mentions a watched program and lets the parser decide.
    // The old allowlist silently dropped real sales when program logs used
    // dispatch names that differed from Anchor method identifiers (MMM).
    // `SALE_INSTRUCTIONS` / `hasSaleInstruction` / `LOG_PREFILTER_BYPASS` are
    // retained above as dead code for now — safe to delete in a later cleanup.
    void LOG_PREFILTER_BYPASS; void hasSaleInstruction;

    const sig = value.signature as string;

    // S3: Tensor-only log prefilter. Tensor programs use Anchor-generated log
    // names reliably, so we can safely skip obvious non-sale txs before paying
    // for getTransaction. markSigFetched blocks the 1.5 s primary poller from
    // re-dispatching the same sig — otherwise the saving is zero.
    if (TENSOR_PREFILTER_TARGETS.has(target.name) && !hasTensorSaleInstruction(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      markSeen(sig);        // block poller path via seenSigs FIFO
      markSigFetched(sig);  // block fetchRawTx path via recentSigs (3 min TTL)
      return;
    }

    // S5: ME v2 deny-list prefilter. MMM intentionally skipped in full/budget
    // modes — its log naming is ambiguous (see comment above). The
    // sales_only mode below widens the deny-list to also cover ME v2
    // listing-state instructions (sell / cancel_sell variants).
    if (target.name === 'me_v2' && shouldSkipMeV2Logs(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      markSeen(sig);
      markSigFetched(sig);
      return;
    }

    // sales_only: shed MMM pool-admin / liquidity-change txs before fetch.
    // Fail-open for every MMM sale family (including the known-unknown
    // coreFulfillBuyV2 log name) — see MMM_SALES_ONLY_SKIP_LOG_NAMES for
    // the confirmed deny-list scope.
    if (target.name === 'mmm' && shouldSkipMmmLogsSalesOnly(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      markSeen(sig);
      markSigFetched(sig);
      return;
    }

    stats.fired++;
    // Do NOT call markSeen here. Cross-path dedup is handled inside fetchRawTx:
    //   inFlight   — blocks concurrent double-fetch while the listener fetch is live
    //   recentSigs — 3-min TTL, set only on successful fetch
    // Calling markSeen before ingest completes would permanently block the poller
    // from retrying a sig whose raw fetch failed (429 cooldown, timeout, etc.).
    // S4: WS notifications are sub-second fresh → highest priority slot in
    // the shared rpcLimiter. The outer `limiter` here is the listener's own
    // concurrency cap for dispatching into target.ingest; priority is passed
    // through so it takes effect at fetchRawTx's shared rpcLimiter.
    limiter
      .run(() => target.ingest(sig, undefined, 'high'))
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
  if (!running) return;  // stopListener() was called
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

// ─── Primary discovery poller ─────────────────────────────────────────────────
//
// WS logsSubscribe is currently unreliable (seen=0 / fired=0 for long periods).
// This poller is the PRIMARY discovery path while WS remains degraded.
// WS listeners are kept running as a secondary path but not depended on.
//
// Cadence: 1.5s — fast enough to catch sales within a few seconds of confirmation.
// Block-age window: 10 minutes — wide enough to recover sigs missed during a
// poller restart or brief outage without re-ingesting hours-old noise.

const POLL_LIMIT        = 100;     // sigs per fetch — generous to avoid missing bursts
// ─── WS-health-gated poll cadence ───────────────────────────────────────────
// When WS logsSubscribe is healthy — defined as: both high-volume targets
// (me_v2 + mmm) have EACH received a real notification, AND each of their
// last-real-notification timestamps is younger than WS_HEALTHY_MAX_AGE_MS —
// the primary poller slows from 1.5 s to 10 s. Low-activity targets
// (tcomp/tamm) are intentionally excluded from the health signal so their
// natural quiet periods can't pin us in degraded mode.
// Any staleness on a high-volume target instantly flips the cadence back
// to fast. amm-poller still runs at 30 s as a secondary safety net.
const POLL_FAST_MS          = 1_500;
const POLL_HEALTHY_MS       = 10_000;
const WS_HEALTHY_MAX_AGE_MS = 60_000;
const WS_HEALTH_TARGETS: ReadonlySet<string> = new Set(['me_v2', 'mmm']);
const MAX_BLOCK_AGE_S   = 600;     // 10-minute recency window

function rpcHttpUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

// Per-target accumulated stats, reset each time logPollSummary() runs.
interface PollAccum { fetched: number; unseen: number; ingested: number; skipped: number; }
const pollAccum = new Map<string, PollAccum>(
  TARGETS.map((t) => [t.name, { fetched: 0, unseen: 0, ingested: 0, skipped: 0 }]),
);

/** Global per-program in-memory cursor: the newest signature this listener
 *  has observed via `getSignaturesForAddress`. Passed back as `until` on the
 *  next poll so the response is bounded to genuinely new sigs instead of
 *  re-pulling the latest 100 every cycle. Updated only on success and only
 *  with the page's newest signature. Memory-only by design — amm-poller
 *  retains the persisted DB cursor for catch-up after restarts. */
const lastSigByProgram = new Map<string, string>();

function logPollSummary(): void {
  for (const [name, a] of pollAccum) {
    console.log(
      `[poll/summary/${name}]` +
      `  fetched=${a.fetched}  unseen=${a.unseen}  ingested=${a.ingested}  skipped=${a.skipped}`,
    );
    pollAccum.set(name, { fetched: 0, unseen: 0, ingested: 0, skipped: 0 });
  }
}

// Same logic as amm-poller: in the lean modes (`sales_only` and `budget`)
// we poll only the programs that carry sale activity the prefilter keeps.
// MMM IS included — its sale instructions (`SolMplCoreFulfillBuy`, etc.)
// are not on the lean prefilter deny-list, and skipping MMM polling here
// leaves the WS as the only coverage path for fresh MMM sale sigs.
// TAMM remains excluded: its non-sale pool-admin txs are shed by the
// tensor listener prefilter, and tcomp's listener-pollAll plus the WS
// reconnect catch-up cover the rare TAMM sale.
const LISTENER_LEAN_MODE_TARGETS: ReadonlySet<string> = new Set(['me_v2', 'mmm', 'tcomp']);

async function pollTarget(target: Target): Promise<void> {
  if (!running || getMode() === 'off') return;
  // Lean modes: skip MMM/TAMM here — see note above.
  const m = getMode();
  if ((m === 'sales_only' || m === 'budget') && !LISTENER_LEAN_MODE_TARGETS.has(target.name)) return;
  const gen = currentGeneration();
  // Retry once on network/HTTP failure.
  let res: Response | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!running || getMode() === 'off' || gen !== currentGeneration()) return;
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 600));
    if (!running || getMode() === 'off' || gen !== currentGeneration()) return;
    try {
      incSigListFetch();
      noteSigList('listener', target.name);
      // Live forward feed: lastSig is the newest signature we've already
      // processed; `until` makes the RPC return ONLY signatures newer than
      // it (RPC walks newest→older and stops when it reaches `until`).
      // Each poll therefore covers a strictly newer, non-overlapping
      // window — no refetch of the same sig, no overlap with the previous
      // call's range.
      const lastSig = lastSigByProgram.get(target.program);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { limit: POLL_LIMIT, commitment: 'confirmed' };
      if (lastSig) params.until = lastSig;
      // Diagnostic: per-call line so the actual cursor + response pattern
      // is visible from logs. Watch for "until=null" or "len=100" repeating
      // — the first means cursor never advanced, the second means the
      // response is saturated and we're missing newer sigs.
      console.log(
        `[sig/listener] target=${target.name}  ` +
        `until=${lastSig ? lastSig.slice(0, 8) + '…' : 'null'}  ` +
        `limit=${POLL_LIMIT}  attempt=${attempt}`,
      );
      const r = await fetch(rpcHttpUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'getSignaturesForAddress',
          params:  [target.program, params],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) { res = r; break; }
      if (attempt === 1) {
        console.warn(`[poll/${target.name}] HTTP ${r.status}  skipping cycle`);
      }
    } catch {
      // Network error or timeout — try again (silently give up after last attempt).
    }
  }

  if (!res) return;
  if (!running || getMode() === 'off' || gen !== currentGeneration()) return;

  const json = await res.json() as {
    result?: Array<{ signature: string; err: unknown; blockTime?: number | null }>;
  };

  if (!running || getMode() === 'off' || gen !== currentGeneration()) return;
  const rows = json.result;
  if (!Array.isArray(rows)) return;

  // Diagnostic: response size per call. Persistent len≈100 means the
  // until-cursor isn't bounding the response — either lastSigByProgram
  // is empty or the cursor sig has aged out of the RPC's sig window.
  console.log(`[sig/listener] target=${target.name}  resp_len=${rows.length}`);

  // Advance the global per-program cursor on success ONLY. Newest sig is
  // first in the array (RPC returns newest-first). Skipped on empty pages
  // so a transient zero-row response doesn't roll the cursor back. Also
  // skipped when the newest sig is identical to the stored cursor — guards
  // against tight loops on RPC lag / race conditions where the same head
  // sig is returned twice.
  if (rows.length > 0 && rows[0].signature) {
    const prev = lastSigByProgram.get(target.program);
    if (rows[0].signature !== prev) {
      lastSigByProgram.set(target.program, rows[0].signature);
    }
  }

  const accum = pollAccum.get(target.name)!;
  let fetched  = 0;
  let unseen   = 0;
  let ingested = 0;
  let skipped  = 0;

  const nowSec = Date.now() / 1000;

  for (const row of rows) {
    fetched++;

    // Drop on-chain failures.
    if (!row.signature || row.err !== null) { skipped++; continue; }

    // Step 1 — sig was returned by getSignaturesForAddress (valid, non-failed tx).
    trace(row.signature, 'poll:fetched', `target=${target.name}`);

    // Drop sigs outside the recency window.
    // getSignaturesForAddress returns newest-first; low-activity programs can
    // surface sigs that are hours old. Without this gate, seenSigs FIFO eviction
    // causes those old sigs to re-enter the ingest queue as if they were new.
    if (row.blockTime && (nowSec - row.blockTime) > MAX_BLOCK_AGE_S) { skipped++; continue; }

    // Dedup: skip already-seen sigs.
    if (seenSigs.has(row.signature)) { skipped++; continue; }

    // Step 2 — sig passed age filter + seenSigs dedup.
    trace(row.signature, 'poll:unseen', `target=${target.name}`);

    unseen++;
    const sig = row.signature;
    markSeen(sig);

    // Step 3 — dispatching to target.ingest() via pollerLimiter.
    trace(sig, 'poll:ingest', `target=${target.name}`);
    ingested++;

    // Lean-mode MMM exception: poller has no log access (`getSignaturesForAddress`
    // doesn't return logs) so it can't run shouldSkipMmmLogsSalesOnly itself.
    // Defer 5 s and re-check whether the WS path's prefilter / successful
    // fetch has already marked the sig — if yes, skip without RPC; if no,
    // dispatch normally so WS-missed sigs are still recovered. Other targets
    // (or full mode) dispatch immediately as before.
    const m = getMode();
    if (target.name === 'mmm' && (m === 'sales_only' || m === 'budget')) {
      dispatchMmmDeferred(
        sig,
        (s) => pollerLimiter.run(() => target.ingest(s)),
        `poll/${target.name}`,
      );
    } else {
      pollerLimiter
        .run(() => target.ingest(sig))
        .catch((err: unknown) => {
          console.error(`[poll/${target.name}] ingest error  sig=${sig.slice(0, 12)}...`, err);
        });
    }
  }

  // Accumulate into the 60s summary.
  accum.fetched  += fetched;
  accum.unseen   += unseen;
  accum.ingested += ingested;
  accum.skipped  += skipped;

  // Immediate log when new sigs are found — don't wait for the summary interval.
  if (ingested > 0) {
    console.log(
      `[poll/${target.name}]` +
      `  fetched=${fetched}  unseen=${unseen}  ingested=${ingested}  skipped=${skipped}`,
    );
  }
}

let pollAllSeq = 0;
async function pollAll(): Promise<void> {
  pollAllSeq++;
  console.log(`[sig/listener/pollAll] seq=${pollAllSeq}  ts=${new Date().toISOString()}`);
  await Promise.allSettled(TARGETS.map(pollTarget));
}

async function seedSeenSigs(): Promise<void> {
  // Parallel — each target hits its own program; no inter-target ordering.
  // Sequentially this added ~2 s to listener boot (4 RPC round-trips back
  // to back). With Promise.allSettled the wall time is one round-trip, and
  // any single failure is tolerated by the existing `// Non-fatal` rule:
  // unfetched sigs just go through the regular poller on the first cycle.
  await Promise.allSettled(TARGETS.map(async (target) => {
    try {
      incSigListFetch();
      noteSigList('seed', target.name);
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
      if (!res.ok) return;
      const json = await res.json() as { result?: Array<{ signature: string }> };
      for (const row of json.result ?? []) {
        if (row.signature) markSeen(row.signature);
      }
    } catch {
      // Non-fatal — poller will just process these on the first cycle.
    }
  }));
  console.log(`[poller] seeded  seen=${seenSigs.size}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startListener(): void {
  if (running) { console.log('[listener] already running — skip'); return; }
  running = true;
  console.log(`[listener] starting  targets=${TARGETS.length}  concurrency=${limiter.max}  mode=${effectiveMode()}`);

  for (const target of TARGETS) openSubscription(target);
  openSlotSubscription();

  // Handles captured into `intervalHandles` so stopListener() can clear them.
  // Keeping `.unref()` so that if the process is otherwise idle it can still
  // exit, but we also now track the handle for explicit teardown.
  const heartbeat = setInterval(() => {
    console.log('[listener] alive', new Date().toISOString());
  }, 60_000);
  heartbeat.unref();
  intervalHandles.push(heartbeat);

  // Watchdog — checked every 15s, three independent tiers:
  //
  //  1. Slot stale (>20s)  → full restart: the underlying TCP connection is dead.
  //  2. Global event stale (>30s) → full restart: all subscriptions appear broken.
  //  3. Per-target stale (>120s) → targeted restart of only the silent subscription.
  //
  // Tier 3 is the critical addition: without it, a single active subscription
  // (e.g. tamm) refreshes the shared lastEventTs and masks the silent death of
  // me_v2/mmm/tcomp indefinitely — the observed 10–20 min degradation pattern.
  const watchdog = setInterval(() => {
    if (!running) return;
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
  }, 15_000);
  watchdog.unref();
  intervalHandles.push(watchdog);

  const statsLog = setInterval(logStats, 60_000);        statsLog.unref(); intervalHandles.push(statsLog);
  const pollLog  = setInterval(logPollSummary, 60_000);  pollLog.unref();  intervalHandles.push(pollLog);

  // ── Hard periodic refresh (temporary reliability workaround) ─────────────
  // Every 3 minutes, unconditionally restart every target subscription.
  const HARD_REFRESH_INTERVAL_MS = 3 * 60_000; // 3 minutes
  let hardRefreshing = false;

  const hardRefresh = setInterval(() => {
    if (!running || restarting || hardRefreshing) return;
    hardRefreshing = true;
    console.log('[listener] hard-refresh cycle start');
    try {
      for (const target of TARGETS) {
        restartTarget(target, 'hard periodic refresh (3 min)');
      }
    } finally {
      hardRefreshing = false;
    }
  }, HARD_REFRESH_INTERVAL_MS);
  hardRefresh.unref();
  intervalHandles.push(hardRefresh);

  // Primary poller — main discovery path while WS logsSubscribe is degraded.
  // Seeds seenSigs first so the first cycle doesn't replay already-processed sigs.
  seedSeenSigs().finally(() => {
    if (!running) return;
    schedulePollTick();
    console.log(
      `[poll] started (primary discovery)` +
      `  fastMs=${POLL_FAST_MS}  healthyMs=${POLL_HEALTHY_MS}` +
      `  wsHealthAge=${WS_HEALTHY_MAX_AGE_MS}ms  limit=${POLL_LIMIT}` +
      `  maxBlockAge=${MAX_BLOCK_AGE_S}s  targets=${TARGETS.length}`,
    );
  });
}

/**
 * Stop ingestion cleanly. Closes every WebSocket, clears watchdog /
 * heartbeat / hard-refresh intervals, and flips `running` so any already-
 * scheduled reconnect setTimeouts short-circuit on fire. The poll scheduler
 * (`schedulePollTick`) also checks `running` before re-arming itself, so
 * after a stop no further pollAll() calls will fire.
 */
export function stopListener(): void {
  if (!running) return;
  running = false;
  // Drop every queued ingest on both listener-scoped limiters so the
  // rpcLimiter downstream never sees them. In-flight calls will re-check
  // `getMode() === 'off'` on their next await and bail.
  const dListener = limiter.abortQueued();
  const dPoller   = pollerLimiter.abortQueued();
  console.log(`[listener] stopping  dropped_listener=${dListener}  dropped_poller=${dPoller}`);

  // Tear down program sockets.
  for (const [, ws] of activeSockets) {
    try { ws.removeAllListeners(); ws.terminate(); } catch { /* noop */ }
  }
  activeSockets.clear();

  // Tear down slot socket.
  if (slotWs) {
    try { slotWs.removeAllListeners(); slotWs.terminate(); } catch { /* noop */ }
    slotWs = null;
  }

  // Clear all intervals (heartbeat, watchdog, stats, hard-refresh).
  while (intervalHandles.length) {
    const h = intervalHandles.pop()!;
    clearInterval(h);
  }
}

// ─── WS-health check + self-rescheduling poll loop ──────────────────────────

function wsIsHealthy(): boolean {
  const now = Date.now();
  for (const name of WS_HEALTH_TARGETS) {
    if (!wsEverReal.get(name)) return false;
    const ts = lastRealNotifTs.get(name) ?? 0;
    if (now - ts > WS_HEALTHY_MAX_AGE_MS) return false;
  }
  return true;
}

let currentPollMode: 'fast' | 'healthy' | null = null;
function schedulePollTick(): void {
  if (!running) return;  // stopListener() — don't re-arm
  const healthy = wsIsHealthy();
  const nextMode: 'fast' | 'healthy' = healthy ? 'healthy' : 'fast';
  if (nextMode !== currentPollMode) {
    console.log(`[poll] mode=${nextMode}  (ws ${healthy ? 'healthy' : 'degraded'})`);
    currentPollMode = nextMode;
  }
  const delay = healthy ? POLL_HEALTHY_MS : POLL_FAST_MS;
  setTimeout(() => {
    if (!running) return;
    pollAll().catch(() => {}).finally(() => { if (running) schedulePollTick(); });
  }, delay).unref();
}
