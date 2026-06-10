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
import { ingestOrbisRaw } from './orbis-raw/ingest';
import { ORBIS_PROGRAM, ORBIS_SALE_INSTRUCTIONS } from './orbis-raw/programs';
import {
  ingestMintRaw,
  hasMintInstructionLog,
  MPL_CORE_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  CANDY_GUARD_PROGRAM,
} from './mint-raw';
import { Limiter, Priority } from './concurrency';
import { incPrefilterSkip, incSigListFetch } from './telemetry';
import { noteSigList } from './sig-list-audit';
import { dispatchMmmDeferred, markMmmNoiseShed } from './mmm-prefilter';
import { recordDispatch as auditRecordDispatch, startSalesPrefilterAudit } from './sales-prefilter-audit';
import { incFired, sourceFromTargetName, startSourceStats } from './source-stats';
import { isSigTarget, saleDebug } from './sale-debug';
import { HeliusEnhancedTransaction } from './helius/types';
import { trace } from '../trace';
import { getMode, currentGeneration, getMintTrackerRuntimeMode, isAnyIngestActive } from '../runtime/mode';

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
  {
    // Magic Eden cNFT marketplace. Distinct on-chain program from ME
    // v2 (`M2mx93ekt…`) — handles Bubblegum-backed compressed-NFT
    // listings via the `buy_now` Anchor instruction. Added after the
    // `wegens` coverage-gap audit found 7/8 recent ME-displayed sales
    // routed through this program were invisible to our listener.
    // Same ingestion entry as ME v2 / MMM — the parser dispatches on
    // outer-ix program ID.
    name:    'me_cnft',
    program: 'M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1',
    ingest:  ingestMeRaw,
  },
  {
    // Orbis marketplace (MPL-Core-first). Low volume; same class as ME/Tensor.
    // Delegate-mode listings settle atomically on BuyCoreV2 / BuyNft — the
    // strict sale prefilter below sheds list/delist/offer/update before RPC.
    name:    'orbis',
    program: ORBIS_PROGRAM,
    ingest:  ingestOrbisRaw,
  },
  // ─── Mint targets ─────────────────────────────────────────────────────────
  // MPL Core: low-volume, allow both WS + cursor poll like sales programs.
  {
    name:    'mpl_core',
    program: MPL_CORE_PROGRAM,
    ingest:  ingestMintRaw,
  },
  // MPL Token Metadata: very high-volume program (everything from PFP
  // updates to NFT badges). Subscribed to WS only — `MINT_NO_POLL_TARGETS`
  // (below) excludes it from the `getSignaturesForAddress` poller so we
  // don't blow the RPC budget. The aggressive log prefilter
  // (`hasMintInstructionLog`) sheds non-mint txs before fetchRawTx.
  {
    name:    'token_metadata',
    program: TOKEN_METADATA_PROGRAM,
    ingest:  ingestMintRaw,
  },
  // Metaplex Candy Guard: low-volume Anchor dispatcher fronting every
  // Candy Machine v3 mint. Subscribed directly so CG mints don't depend
  // on the Token Metadata firehose (which Helius back-pressures into
  // silence for stretches). Every CG tx is a mint candidate — the
  // per-tx `detectLaunchpadMint` resolves accept/reject downstream and
  // the prefilter is bypassed (see `MINT_PREFILTER_TARGETS` below).
  {
    name:    'candy_guard',
    program: CANDY_GUARD_PROGRAM,
    ingest:  ingestMintRaw,
  },
];

/** Targets that handle their own log shape — drop on the listener side
 *  before fetchRawTx. Same pattern as TENSOR_PREFILTER_TARGETS / the ME v2
 *  deny-list, but additive: the listener checks them in order.
 *  `candy_guard` is deliberately NOT in this set: every CG tx is a
 *  mint candidate, the per-tx detector resolves accept/reject, and
 *  CG volume is small enough that the prefilter would only add latency. */
const MINT_PREFILTER_TARGETS: ReadonlySet<string> = new Set(['mpl_core', 'token_metadata']);

/** Targets that belong to the mint tracker. These keep flowing even
 *  when trade runtime mode is OFF as long as `MINT_TRACKER_ENABLED`
 *  isn't '0'. Sales-program targets (me_v2, mmm, tcomp, tamm) are
 *  always gated on `getMode() !== 'off'`. */
const MINT_TARGET_NAMES: ReadonlySet<string> = new Set(['mpl_core', 'token_metadata', 'candy_guard']);

/** Per-target activity gate — replaces the global `getMode() !== 'off'`
 *  check at every WS / poll entry point. The two subsystems are gated
 *  INDEPENDENTLY: mint targets follow the mint-tracker flag (regardless of
 *  sales mode), sales targets follow the sales runtime mode (regardless of
 *  the mint flag). This is what makes `sales_only + mint_tracker=off` stop
 *  spending mint RPC (getTransaction) while sales keep flowing, and
 *  `off + mint_tracker=on` keep mints flowing while sales are silent. */
function isTargetActive(targetName: string): boolean {
  // Mint targets are never hard-off: they're active in live AND warm mode
  // (warm just polls slowly + skips WS-driven fetches, gated at the call
  // sites below). Sales targets follow the trade runtime mode.
  if (MINT_TARGET_NAMES.has(targetName)) return true;
  return getMode() !== 'off';
}

/** Targets the SHARED `pollAll` loop must skip.
 *
 *  Two reasons a target ends up here:
 *
 *  (a) Mint targets where shared-loop cadence would either flood RPC
 *      (`token_metadata`'s firehose) or duplicate a dedicated cursor-
 *      poll loop tuned for that surface (`mpl_core`, `candy_guard`).
 *      Those dedicated loops bypass this gate via `force: true` on
 *      every `pollTarget` call.
 *
 *  (b) Sale targets already polled by the persistent-cursor
 *      `amm-poller` (`me_v2` / `mmm` / `tcomp` / `tamm` / `me_cnft`).
 *      `amm-poller` runs every 2.5s with a DB-persisted cursor and is
 *      the canonical sales-path poller; the listener's shared pollAll
 *      previously re-fetched the same programs at 1.5s-10s intervals,
 *      doubling `getSignaturesForAddress` cost on the four programs
 *      that already had complete coverage. Removing them from the
 *      shared loop is purely a redundancy cut — amm-poller continues
 *      to backstop the WS listener exactly as before. */
const MINT_NO_POLL_TARGETS: ReadonlySet<string> = new Set([
  'mpl_core', 'token_metadata', 'candy_guard',
  'me_v2', 'mmm', 'tcomp', 'tamm', 'me_cnft',
]);

// ─── mpl_core cursor-poll fallback ──────────────────────────────────────────
// Helius WS isn't reliable enough alone for /mints — confirmed by the
// missed-mint investigation on 2bh9gtx3… The dedicated loop below runs
// `getSignaturesForAddress(mpl_core, limit=N)` every few seconds and
// dedup-feeds anything new through the same `pollTarget → fetchRawTx
// → ingestMintRaw → detectLaunchpadMint` pipeline the WS path uses.
// Defaults: enabled, 4 s interval, 30 sigs per sweep. Tunable via env
// (`MINT_MPL_CORE_POLL_*`).
const MPL_CORE_POLL_ENABLED     = process.env.MINT_MPL_CORE_POLL_ENABLED !== '0';
// Cadence relaxed 2026-05-19 (4000ms/limit=30 → 15000ms/limit=15) to
// cut idle credit drain. The WS path stays primary; this fallback
// catches Helius dropouts and the 3-min hard-refresh window — both
// of which tolerate 15s catch-up easily. Tunable via env.
const MPL_CORE_POLL_INTERVAL_MS = parseInt(process.env.MINT_MPL_CORE_POLL_INTERVAL_MS ?? '15000', 10) || 15000;
// CoREEN (the whole MPL Core program) emits ~20 sigs/15s — measured. With the
// old limit=15 the cursor poll was permanently SATURATED: it grabbed only the
// 15 newest sigs each 15s and the `until=lastSig` cursor jumped past the
// overflow (~5/15s), silently dropping launchpad mints (LMNFT-Core, vvv.so,
// CMv3, direct Core) that landed in the skipped band. Raised to 50 so the limit
// exceeds the rate with burst headroom. Cost is bounded by the ACTUAL rate (not
// the limit) because `until` caps the window to sigs newer than the cursor —
// steady-state ≈ the real ~20/15s, only ~+5/15s vs before. Live mode only;
// warm mode uses MINT_WARM_LIMIT and is unchanged.
// 2026-05-29: lowered default 50 → 25. Measured mpl_core rate is ~20 sigs/15s;
// limit=50 over-fetched by ~2.5×. 25 keeps 1.25× burst headroom over the
// observed rate while halving idle credit drain. Env override still honored.
const MPL_CORE_POLL_LIMIT       = parseInt(process.env.MINT_MPL_CORE_POLL_LIMIT       ?? '25',   10) || 25;
let   mplCorePollSweeps   = 0;
let   mplCorePollFetched  = 0;
let   mplCorePollAccepted = 0;
let   mplCorePollDeduped  = 0;
/** Wall-clock ms of the most recent successful mpl_core poll sweep
 *  (i.e. one that actually fetched signatures). Surfaced via
 *  `/api/mints/runtime` so operators can confirm the fallback poller
 *  is alive even when WS is silent. 0 until the first sweep lands. */
let   mplCorePollLastTs   = 0;
// Live-mode adaptive idle backoff for the mpl_core poll. When live sweeps
// produce no newly-accepted mints for several consecutive cycles, stretch the
// cadence (15s → 30s → 60s) to cut idle getTransaction drain; restore to 15s
// on the first accepted mint. Warm mode has its own scheduler (warmMplCore).
const MPL_CORE_IDLE_L1_CYCLES = 3;
const MPL_CORE_IDLE_L2_CYCLES = 8;
const MPL_CORE_IDLE_L1_MS     = 30_000;
const MPL_CORE_IDLE_L2_MS     = 60_000;
const liveMplCore = { nextDueTs: 0, idleStreak: 0, acceptedSnap: 0, level: 0 };

// ─── candy_guard cursor-poll fallback ───────────────────────────────────────
// Same backstop pattern as the mpl_core poller above, applied to the
// Candy Guard program. Candy Guard's on-chain volume is small (single
// digits / minute at peak), so the cursor poll can run at a relaxed
// cadence with a modest limit and still cover any Helius WS dropouts
// — the failure mode we hit in the Y2P2 / mVThyLe trace where Token
// Metadata WS went silent and Candy Guard mints fronted by Candy Guard
// disappeared from ingestion. Tunable via env (`MINT_CANDY_GUARD_POLL_*`).
const CANDY_GUARD_POLL_ENABLED     = process.env.MINT_CANDY_GUARD_POLL_ENABLED !== '0';
// Cadence relaxed 2026-05-19 (6000ms/limit=20 → 30000ms/limit=10) to
// cut idle credit drain. CG drop volume is small (single-digit
// mints/min at peak) and the WS subscription is the primary path;
// the prior 6s cadence was over-provisioned by ~5×. Tunable via env.
const CANDY_GUARD_POLL_INTERVAL_MS = parseInt(process.env.MINT_CANDY_GUARD_POLL_INTERVAL_MS ?? '30000', 10) || 30000;
// 2026-05-29: lowered default 10 → 5. CG live volume is single-digit
// sigs/min at peak; limit=10 over-fetched by ~2×. Env override kept.
const CANDY_GUARD_POLL_LIMIT       = parseInt(process.env.MINT_CANDY_GUARD_POLL_LIMIT       ?? '5',    10) || 5;
// 2026-05-29: adaptive idle backoff for the LIVE candy_guard cursor poll —
// mirrors the mpl_core L1/L2 template above. Base 30s; L1 after 3 empty
// cycles → 90s (3×); L2 after 8 empty cycles → 180s (6×). CG is so quiet
// that without this the 30s cadence runs >90% of the time on empty sweeps.
const CANDY_GUARD_IDLE_L1_CYCLES = 3;
const CANDY_GUARD_IDLE_L2_CYCLES = 8;
const CANDY_GUARD_IDLE_L1_MS     = 90_000;
const CANDY_GUARD_IDLE_L2_MS     = 180_000;
const liveCandyGuard = { nextDueTs: 0, idleStreak: 0, acceptedSnap: 0, level: 0 };
let   candyGuardPollSweeps   = 0;
let   candyGuardPollFetched  = 0;
let   candyGuardPollAccepted = 0;
let   candyGuardPollDeduped  = 0;
let   candyGuardPollLastTs   = 0;

// ── Warm (low-power) mode tuning ────────────────────────────────────────────
// In WARM mode the dedicated pollers keep running but at a long cadence and a
// tiny page size, with no WS-driven fetches and no catch-up — just enough to
// keep background awareness of what's minting. Expensive paths (enrichment /
// collection-confirm / supply refresh) stay off. The two targets are STAGGERED
// (different base intervals + a candy_guard phase offset) so their getTx bursts
// never land in the same moment — smoother Helius graph. An idle backoff
// stretches the interval (×2 then ×3, capped) when a target sees no new mints.
const MINT_WARM_LIMIT = parseInt(process.env.MINT_WARM_LIMIT ?? '2', 10) || 2;   // ≤ getTx per warm sweep
// Warm base cadences trimmed for the safe credit pass: mpl_core 3m → 5m,
// candy_guard 5m → 6m. Idle backoff (×2/×3, 10m cap) + stagger unchanged, so
// background awareness holds while idle warm spend drops further.
const MINT_WARM_MPL_CORE_INTERVAL_MS     = parseInt(process.env.MINT_WARM_MPL_CORE_INTERVAL_MS     ?? '300000', 10) || 300000; // 5 min
const MINT_WARM_CANDY_GUARD_INTERVAL_MS  = parseInt(process.env.MINT_WARM_CANDY_GUARD_INTERVAL_MS  ?? '360000', 10) || 360000; // 6 min
const MINT_WARM_CANDY_GUARD_OFFSET_MS    = parseInt(process.env.MINT_WARM_CANDY_GUARD_OFFSET_MS    ?? '90000',  10) || 90000;  // 90 s phase
const MINT_WARM_MAX_INTERVAL_MS          = parseInt(process.env.MINT_WARM_MAX_INTERVAL_MS          ?? '600000', 10) || 600000; // 10 min cap

interface WarmSched { nextDueTs: number; idleStreak: number; acceptedSnap: number; }
const warmMplCore:    WarmSched = { nextDueTs: 0, idleStreak: 0, acceptedSnap: 0 };
const warmCandyGuard: WarmSched = { nextDueTs: 0, idleStreak: 0, acceptedSnap: 0 };

/** Idle backoff multiplier: base interval ×1 normally, ×2 after 3 empty
 *  sweeps, ×3 after 6 — capped by MINT_WARM_MAX_INTERVAL_MS at the call site. */
function warmIntervalMultiplier(idleStreak: number): number {
  if (idleStreak >= 6) return 3;
  if (idleStreak >= 3) return 2;
  return 1;
}

/** Decide whether a warm sweep is due for a target, updating its schedule.
 *  `acceptedNow` is the target's cumulative poll-accepted counter; the delta
 *  since the previous sweep drives the idle streak (no pollTarget changes —
 *  reads the existing audit counter). Returns true iff the caller should poll.
 *  Logs one low-noise line per actual sweep. */
function warmSweepDue(
  s: WarmSched, baseMs: number, offsetMs: number, acceptedNow: number,
  now: number, targetName: string,
): boolean {
  if (s.nextDueTs === 0) {
    // First scheduling — apply the stagger offset before the first sweep so
    // the two targets don't fire together at boot.
    s.nextDueTs    = now + offsetMs;
    s.acceptedSnap = acceptedNow;
    if (offsetMs > 0) return false;
  }
  if (now < s.nextDueTs) return false;
  const delta = acceptedNow - s.acceptedSnap;
  s.acceptedSnap = acceptedNow;
  if (delta > 0) s.idleStreak = 0;
  else           s.idleStreak += 1;
  const mult     = warmIntervalMultiplier(s.idleStreak);
  const interval = Math.min(baseMs * mult, MINT_WARM_MAX_INTERVAL_MS);
  s.nextDueTs    = now + interval;
  console.log(`[mints/warm] sweep target=${targetName} limit=${MINT_WARM_LIMIT} interval=${interval}`);
  if (mult > 1) console.log(`[mints/warm] idle target=${targetName} streak=${s.idleStreak} interval=${interval}`);
  return true;
}

/** Mint-prefilter pass counter. Logs the first hit per target (so we
 *  immediately see the wiring is alive) and then samples 1-in-50 to
 *  show ongoing volume without flooding. Reset is deliberate-never:
 *  total counts since process start are useful in retro debugging. */
const mintPrefilterPassCount = new Map<string, number>();
function noteMintPrefilterPass(targetName: string): void {
  const n = (mintPrefilterPassCount.get(targetName) ?? 0) + 1;
  mintPrefilterPassCount.set(targetName, n);
  if (n === 1 || n % 50 === 0) {
    console.log(`[mints/prefilter] target=${targetName} pass=${n}`);
  }
}

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
const limiter       = new Limiter(4, 25, 0, () => isAnyIngestActive());  // listener path — 4 concurrent, 25ms gap
const pollerLimiter = new Limiter(4, 25, 0, () => isAnyIngestActive());  // poller path   — same budget

// ─── Seen-signature dedup (shared by listener + poller) ──────────────────────

// 25 000 entries at ~70 sigs/s aggregate across 6 watched programs ≈ ~6 min
// before oldest evicts — safely past the 10 min `MAX_BLOCK_AGE_S` recency
// gate even during a sustained mpl_core mint launch. Previously 5 000:
// sufficient for steady state but could wrap inside the 10 min window under
// a hot mpl_core + simultaneous me_v2 burst, causing the same sig to be
// dispatched to fetchRawTx twice (one extra getTransaction credit per
// wrap). Memory cost is trivial (each sig string ~88 B → ~2.2 MB at full
// capacity, vs. 800M `max_memory_restart`). The earlier eviction-of-seeded-
// sigs problem the original comment described is now over-engineered for.
const SEEN_MAX = 25_000;
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
  // `sellnfttradepoolcore` (log `SellNftTradePoolCore`, disc 25cd8d3556f52d4e
  // = parser `sell` def) and `buynftcore` (log `BuyNftCore`, disc
  // a3663a6bb804a979 = parser `buy` def) are the MPL-Core pool sell/buy paths.
  // Without these entries the WS prefilter dropped every Core pool trade
  // before fetchRawTx.
  'sell', 'sellnfttradepool', 'sellnfttradepoolcore',
  'buynfttradepool', 'buynft', 'buynftcore',
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
  // Allowlist-management admin op — pure non-sale (observed alone in 2.9k WS
  // drops, never alongside a fill). A sale tx that also carries it still keeps
  // (the fill ix isn't denied → not all-denied → not skipped). Safe to shed.
  'updateallowlists',
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

// ─── Orbis log prefilter ──────────────────────────────────────────────────────
//
// Same shape as the Tensor prefilter: Orbis emits Anchor `Instruction: <name>`
// log lines, so we can shed every non-sale tx (list / delist / offer / update /
// cancel) before paying for getTransaction. Only the two verified buy paths
// (BuyCoreV2 / BuyNft) pass. Fail-OPEN when logs are absent so a sale is never
// silently dropped — the parser's "sold for" check is the final authority.
const ORBIS_PREFILTER_TARGETS: ReadonlySet<string> = new Set(['orbis']);

/** Scan WS logs for an Orbis-sale Anchor instruction. Fail-open if logs absent. */
function hasOrbisSaleInstruction(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length === 0) return true;
  for (const line of logs as string[]) {
    const lower = (line ?? '').toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    const ix = lower.slice(LOG_IX_PREFIX.length);
    if (ORBIS_SALE_INSTRUCTIONS.has(ix)) return true;
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

// ─── WS connect audit ────────────────────────────────────────────────────────

const wsConnectCount  = new Map<string, number>();
const wsLastConnectTs = new Map<string, number>();
function noteWsConnect(name: string): void {
  const now  = Date.now();
  const prev = wsLastConnectTs.get(name);
  const count = (wsConnectCount.get(name) ?? 0) + 1;
  wsConnectCount.set(name, count);
  wsLastConnectTs.set(name, now);
  if (prev) {
    console.log(`[ws/connect] target=${name} sinceLast=${now - prev}ms count=${count}`);
  }
}
const wsConnectSummary = setInterval(() => {
  if (wsConnectCount.size === 0) return;
  const parts = [...wsConnectCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[ws/connect-summary] ${parts}`);
  wsConnectCount.clear();
}, 60_000);
wsConnectSummary.unref();

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
const STALE_TARGET_MS = 120_000; // 2 minutes — busy targets (me_v2, mmm, tcomp, …)
// Naturally low-volume programs go minutes between real notifications during
// quiet hours. Restarting them on the 120s timer just churns the WS and fires
// a wasted catch-up getSignaturesForAddress sweep for no benefit. Give them a
// much longer stale threshold; the global tier-1/tier-2 watchdog (slot 20s /
// event 30s) still catches a genuinely dead connection because the busy
// targets keep `lastEventTs`/`lastSlotTs` fresh.
const QUIET_TARGETS: ReadonlySet<string> = new Set(['candy_guard', 'tamm', 'me_cnft']);
const STALE_TARGET_QUIET_MS = 10 * 60_000; // 10 minutes
function staleThresholdMs(name: string): number {
  return QUIET_TARGETS.has(name) ? STALE_TARGET_QUIET_MS : STALE_TARGET_MS;
}

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

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 25_000);
  pingTimer.unref();

  ws.once('open', () => {
    noteWsConnect(target.name);
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
      // Warm mode: skip the catch-up sweep for mint targets (keeps RPC low —
      // warm explicitly tolerates incomplete/delayed coverage).
      if (MINT_TARGET_NAMES.has(target.name) && getMintTrackerRuntimeMode() !== 'live') {
        // no catch-up in warm
      } else {
        console.log(`[listener/${target.name}] catch-up poll after reconnect`);
        pollTarget(target).catch(() => {});
      }
    }
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    // Ignore every notification after stop — we may still hold a reference
    // to the socket until terminate() finishes flushing. Per-target gate
    // so mint targets keep flowing across mode=off when the env-gated
    // mint tracker is enabled.
    if (!running || !isTargetActive(target.name)) return;
    // Warm mode: do NOT process WS-driven mint notifications — each one would
    // trigger a getTransaction fetch. Warm background discovery comes from the
    // slow poller only. Sales targets are unaffected (live/warm is mint-only).
    if (MINT_TARGET_NAMES.has(target.name) && getMintTrackerRuntimeMode() !== 'live') return;
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

    // Targeted sale-pipeline diagnostics — emit `ws_arrival` for any sig
    // in the SALE_DEBUG_SIGS allowlist before any prefilter shed runs,
    // so the operator sees both the path AND the prefilter decision.
    if (isSigTarget(sig)) {
      saleDebug('ws_arrival', sig, { program: target.name });
    }

    // S3: Tensor-only log prefilter. Tensor programs use Anchor-generated log
    // names reliably, so we can safely skip obvious non-sale txs before paying
    // for getTransaction. markSigFetched blocks the 1.5 s primary poller from
    // re-dispatching the same sig — otherwise the saving is zero.
    if (TENSOR_PREFILTER_TARGETS.has(target.name) && !hasTensorSaleInstruction(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      if (isSigTarget(sig)) {
        saleDebug('prefilter_skip', sig, { program: target.name, reason: 'tensor_no_sale_ix' });
        saleDebug('mark_fetched',   sig, { reason: 'tensor_prefilter_skip' });
      }
      markSeen(sig);        // block poller path via seenSigs FIFO
      markSigFetched(sig);  // block fetchRawTx path via recentSigs (3 min TTL)
      return;
    }

    // Orbis log prefilter. Same deterministic Anchor-log basis as Tensor —
    // skip non-sale Orbis txs (list/delist/offer/update) before fetchRawTx.
    if (ORBIS_PREFILTER_TARGETS.has(target.name) && !hasOrbisSaleInstruction(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      if (isSigTarget(sig)) {
        saleDebug('prefilter_skip', sig, { program: target.name, reason: 'orbis_no_sale_ix' });
        saleDebug('mark_fetched',   sig, { reason: 'orbis_prefilter_skip' });
      }
      markSeen(sig);
      markSigFetched(sig);
      return;
    }

    // S5: ME v2 deny-list prefilter. MMM intentionally skipped in full/budget
    // modes — its log naming is ambiguous (see comment above). The
    // sales_only mode below widens the deny-list to also cover ME v2
    // listing-state instructions (sell / cancel_sell variants).
    if (target.name === 'me_v2' && shouldSkipMeV2Logs(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      if (isSigTarget(sig)) {
        saleDebug('prefilter_skip', sig, { program: target.name, reason: 'me_v2_deny_list' });
        saleDebug('mark_fetched',   sig, { reason: 'me_v2_prefilter_skip' });
      }
      markSeen(sig);
      markSigFetched(sig);
      return;
    }

    // sales_only: shed MMM pool-admin / liquidity-change txs before fetch.
    // Fail-open for every MMM sale family (including the known-unknown
    // coreFulfillBuyV2 log name) — see MMM_SALES_ONLY_SKIP_LOG_NAMES for
    // the confirmed deny-list scope.
    //
    // IMPORTANT: do NOT markSigFetched on this skip — same dedupe-poisoning
    // class as the mint-prefilter fix (commit 65295c3). The MMM log
    // heuristic is fragile: a real sale whose visible "Instruction:" lines
    // happen to all be in the deny-list (truncated logs, unknown sale-ix
    // variant whose log name collides with deny-list, or a sale ix that
    // appears only as an inner CPI not present in this log slice) would
    // be permanently lost — every recovery path (amm-poller.sweepTarget
    // + listener.pollTarget) defers 5 s and rechecks `wasRecentlyFetched`,
    // which `markSigFetched` poisons. `markSeen` is still set so the
    // listener's own poll loop skips re-dispatch of WS-shed sigs, but
    // amm-poller (independent dedup) keeps its safety-net role: it will
    // dispatch via dispatchMmmDeferred → fetchRawTx, and the parser will
    // cheaply DROP true noise while recovering false-positive sales.
    if (target.name === 'mmm' && shouldSkipMmmLogsSalesOnly(value.logs)) {
      stats.filtered++;
      incPrefilterSkip();
      if (isSigTarget(sig)) {
        saleDebug('prefilter_skip', sig, { program: target.name, reason: 'mmm_sales_only_deny_list' });
      }
      markSeen(sig);
      // Tell the deferred poller-path dispatcher that WS classified this sig
      // as MMM noise; it will skip the 5-s-later fetch instead of paying RPC.
      markMmmNoiseShed(sig);
      return;
    }

    // Mint-target prefilter — only fetch txs whose logs mention one of
    // the recognized mint instruction discriminators. This is the
    // largest knob keeping Token Metadata's firehose under control;
    // without it we would burn `getTransaction` on every metadata
    // update / verify / pNFT badge tx the program produces.
    //
    // IMPORTANT: do NOT markSeen / markSigFetched on a mint-prefilter
    // skip — Token Metadata is invoked as an inner program by virtually
    // every NFT sale on ME / Tensor (NFT transfer + collection verify).
    // If we poisoned the shared dedup state here, the sales WS path
    // would see fetchRawTx return null on the very same sig and the
    // sale would silently fail to ingest. Cursor polling for these
    // targets is already disabled (MINT_NO_POLL_TARGETS), so there is
    // no other path to suppress.
    if (MINT_PREFILTER_TARGETS.has(target.name)) {
      if (!hasMintInstructionLog(value.logs)) {
        stats.filtered++;
        incPrefilterSkip();
        return;
      }
      // Sampled debug: log first hit per target then every 50th hit so
      // we can see the prefilter is wired but don't spam under volume.
      noteMintPrefilterPass(target.name);
    }

    stats.fired++;
    if (isSigTarget(sig)) {
      saleDebug('prefilter_pass', sig, { program: target.name, path: 'ws_listener', priority: 'high' });
    }
    // OBSERVE-only: record the WS instruction logs of every sales-target tx that
    // passed prefilters and is about to trigger getTransaction. The ingest path
    // reports the parser outcome back via recordOutcome → 60s aggregated audit.
    // No behavior change; no tx skipped. Stage-1 evidence for a future WS deny-list.
    auditRecordDispatch(sig, target.name, value.logs);
    incFired(sourceFromTargetName(target.name));
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
        if (isSigTarget(sig)) {
          saleDebug('insert_skip', sig, { reason: 'ws_ingest_error', err: String((err as Error)?.message ?? err) });
        }
        console.error(`[listener/${target.name}] ingest error  sig=${sig.slice(0, 12)}...`, err);
      });
  });

  ws.on('error', (err: Error) => {
    console.error(`[listener/${target.name}] ws error`, err.message);
  });

  ws.on('close', (code: number) => {
    clearInterval(pingTimer);
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

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 25_000);
  pingTimer.unref();

  ws.once('open', () => {
    noteWsConnect('slot');
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
    clearInterval(pingTimer);
    slotWs = null;
    console.warn(`[listener/slot] disconnected (code=${code})  reconnecting in ${BACKOFF_MIN_MS / 1000}s`);
    setTimeout(openSlotSubscription, BACKOFF_MIN_MS);
  });
}

// ─── Watchdog / forced restart ────────────────────────────────────────────────

/** Per-target stagger applied when restartListeners reopens every subscription
 *  at once. Each reopen fires an isReconnect=true catch-up poll on socket-open;
 *  without a gap, 3+ catch-up sigList calls + their tx dispatch bursts land in
 *  the same Helius dashboard 1-s bucket and visually spike RPS. The stagger
 *  smooths the dashboard display — it does not reduce average load and adds
 *  ≤ (TARGETS.length - 1) × this many ms to full-restart recovery latency.
 *  Hard-refresh has its own stagger (HARD_REFRESH_STAGGER_MS); the per-target
 *  watchdog (restartTarget) already reopens one target at a time. */
const RESTART_STAGGER_MS = 250;

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
  // Staggered RESTART_STAGGER_MS apart so the catch-up sig polls + tx
  // dispatches don't all land in the same Helius 1-s bucket.
  TARGETS.forEach((target, i) => {
    const delay = i * RESTART_STAGGER_MS;
    if (delay === 0) {
      openSubscription(target, BACKOFF_MIN_MS, true);
      return;
    }
    const t = setTimeout(() => {
      if (!running) return;
      openSubscription(target, BACKOFF_MIN_MS, true);
    }, delay);
    t.unref();
  });
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

async function pollTarget(
  target: Target,
  opts?: { force?: boolean; limitOverride?: number },
): Promise<void> {
  if (!running || !isTargetActive(target.name)) return;
  // High-volume mint targets (Token Metadata) opt out of cursor polling
  // entirely — WS subscription is the only path. mpl_core also lives
  // in MINT_NO_POLL_TARGETS for the shared pollAll loop, but the
  // dedicated mpl_core poll loop bypasses via `opts.force=true`.
  if (!opts?.force && MINT_NO_POLL_TARGETS.has(target.name)) return;
  // Lean modes: skip MMM/TAMM here — see note above. Force bypass
  // because the mint tracker is independent of trade runtime mode.
  if (!opts?.force) {
    const m = getMode();
    if ((m === 'sales_only' || m === 'budget') && !LISTENER_LEAN_MODE_TARGETS.has(target.name)) return;
  }
  const effectiveLimit = opts?.limitOverride ?? POLL_LIMIT;
  const gen = currentGeneration();
  // Retry once on network/HTTP failure.
  let res: Response | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!running || !isTargetActive(target.name) || gen !== currentGeneration()) return;
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 600));
    if (!running || !isTargetActive(target.name) || gen !== currentGeneration()) return;
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
      const params: any = { limit: effectiveLimit, commitment: 'confirmed' };
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
  if (!running || !isTargetActive(target.name) || gen !== currentGeneration()) return;

  const json = await res.json() as {
    result?: Array<{ signature: string; err: unknown; blockTime?: number | null }>;
  };

  if (!running || !isTargetActive(target.name) || gen !== currentGeneration()) return;
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

  // Per-sweep counters for the dedicated fallback paths (mpl_core +
  // candy_guard). Only tallied when `opts.force` is set so the existing
  // pollAll loop's shared accumulators don't double-count.
  const isMplCoreForce    = !!opts?.force && target.name === 'mpl_core';
  const isCandyGuardForce = !!opts?.force && target.name === 'candy_guard';

  for (const row of rows) {
    fetched++;
    if (isMplCoreForce)    mplCorePollFetched++;
    if (isCandyGuardForce) candyGuardPollFetched++;

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
    if (seenSigs.has(row.signature)) {
      skipped++;
      if (isMplCoreForce) {
        mplCorePollDeduped++;
        // Sampled — every 10th dedupe to confirm WS-poll dedup is
        // working without flooding under traffic.
        if (mplCorePollDeduped <= 5 || mplCorePollDeduped % 10 === 0) {
          console.log(`[mints/dedupe] sig=${row.signature.slice(0, 12)}… source=poll reason=seen`);
        }
      }
      if (isCandyGuardForce) {
        candyGuardPollDeduped++;
        if (candyGuardPollDeduped <= 5 || candyGuardPollDeduped % 10 === 0) {
          console.log(`[mints/dedupe] sig=${row.signature.slice(0, 12)}… source=poll/cg reason=seen`);
        }
      }
      continue;
    }

    // Step 2 — sig passed age filter + seenSigs dedup.
    trace(row.signature, 'poll:unseen', `target=${target.name}`);

    unseen++;
    const sig = row.signature;
    markSeen(sig);
    if (isMplCoreForce) {
      mplCorePollAccepted++;
      // The whole point: every NEW mpl_core sig the poller catches is
      // a sig the WS firehose missed (or hasn't processed yet). Log
      // each so an operator can verify the fallback is doing real work.
      console.log(`[mints/poller] caught_missed sig=${sig} source=poll`);
    }
    if (isCandyGuardForce) {
      candyGuardPollAccepted++;
      console.log(`[mints/poller] caught_missed sig=${sig} source=poll/cg`);
    }

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
        (s) => { incFired(sourceFromTargetName(target.name)); return pollerLimiter.run(() => target.ingest(s)); },
        `poll/${target.name}`,
      );
    } else {
      incFired(sourceFromTargetName(target.name));
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
  // Per-sweep summary for the dedicated mpl_core fallback. Always
  // emitted so quiet sweeps still confirm the loop is alive.
  if (isMplCoreForce) {
    console.log(
      `[mints/poller] sweep target=mpl_core sigs=${rows.length} fetched=${fetched} ` +
      `accepted=${unseen} rejected=0 skipped=${skipped}`,
    );
  }
}

let pollAllSeq = 0;
async function pollAll(): Promise<void> {
  pollAllSeq++;
  console.log(`[sig/listener/pollAll] seq=${pollAllSeq}  ts=${new Date().toISOString()}`);
  await Promise.allSettled(TARGETS.map(t => pollTarget(t)));
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

  // Dedicated mpl_core cursor-poll fallback — backstop for Helius WS
  // misses on launchpad mints. Runs at a fixed cadence regardless of
  // WS health (which can lie). Gated by the env flag and the
  // mint-tracker runtime toggle. Single shared timer; no per-client
  // pollers. Token Metadata stays WS-only — its volume would explode
  // getSignaturesForAddress usage and the prefilter only helps after
  // the sig list is already on the wire.
  if (MPL_CORE_POLL_ENABLED) {
    const mplCoreTarget = TARGETS.find(t => t.name === 'mpl_core');
    if (mplCoreTarget) {
      console.log(
        `[mints/poller] start target=mpl_core interval=${MPL_CORE_POLL_INTERVAL_MS}ms ` +
        `limit=${MPL_CORE_POLL_LIMIT}`,
      );
      const tick = setInterval(() => {
        if (!running)                    return;
        if (!isTargetActive('mpl_core')) return;
        const now = Date.now();
        if (getMintTrackerRuntimeMode() !== 'live') {
          // WARM: staggered + adaptive cadence, ≤MINT_WARM_LIMIT getTx/sweep,
          // no catch-up. Enrichment / confirm / supply stay gated off
          // (isMintTrackerEnabled === false). offset=0 → fires first.
          if (!warmSweepDue(warmMplCore, MINT_WARM_MPL_CORE_INTERVAL_MS, 0, mplCorePollAccepted, now, 'mpl_core')) return;
          mplCorePollSweeps++;
          mplCorePollLastTs = now;
          pollTarget(mplCoreTarget, { force: true, limitOverride: MINT_WARM_LIMIT })
            .catch(() => { /* fail-soft */ });
          return;
        }
        // LIVE adaptive idle backoff. The 15s tick gates the actual sweep:
        // skip until nextDueTs, which stretches with the zero-accepted streak.
        if (now < liveMplCore.nextDueTs) return;
        const accepted = mplCorePollAccepted;
        if (liveMplCore.nextDueTs !== 0) {
          if (accepted - liveMplCore.acceptedSnap > 0) liveMplCore.idleStreak = 0;
          else                                          liveMplCore.idleStreak += 1;
        }
        liveMplCore.acceptedSnap = accepted;
        const lvl = liveMplCore.idleStreak >= MPL_CORE_IDLE_L2_CYCLES ? 2
                  : liveMplCore.idleStreak >= MPL_CORE_IDLE_L1_CYCLES ? 1 : 0;
        const intervalMs = lvl === 2 ? MPL_CORE_IDLE_L2_MS
                         : lvl === 1 ? MPL_CORE_IDLE_L1_MS : MPL_CORE_POLL_INTERVAL_MS;
        if (lvl !== liveMplCore.level) {
          if (lvl > liveMplCore.level) console.log(`[mints/backoff] target=mpl_core idleLevel=${lvl} interval=${intervalMs}`);
          else                         console.log(`[mints/backoff] target=mpl_core recovered interval=${intervalMs} accepted=${accepted}`);
          liveMplCore.level = lvl;
        }
        liveMplCore.nextDueTs = now + intervalMs;
        mplCorePollSweeps++;
        mplCorePollLastTs = now;
        pollTarget(mplCoreTarget, { force: true, limitOverride: MPL_CORE_POLL_LIMIT })
          .catch(() => { /* fail-soft; next tick retries */ });
      }, MPL_CORE_POLL_INTERVAL_MS);
      tick.unref();
      intervalHandles.push(tick);

      // 60 s audit — confirms the fallback is doing real work and lets
      // the operator see WS-vs-poll dedup ratios at a glance. Skipped
      // on a fully-quiet minute so quiet hours stay quiet.
      const audit = setInterval(() => {
        if (mplCorePollSweeps === 0 && mplCorePollFetched === 0) return;
        console.log(
          `[mints/poller-audit] target=mpl_core sweeps=${mplCorePollSweeps} ` +
          `fetched=${mplCorePollFetched} accepted=${mplCorePollAccepted} ` +
          `deduped=${mplCorePollDeduped}`,
        );
      }, 60_000);
      audit.unref();
      intervalHandles.push(audit);
    } else {
      console.log('[mints/poller] cannot start — mpl_core target not found');
    }
  } else {
    console.log('[mints/poller] disabled (MINT_MPL_CORE_POLL_ENABLED=0)');
  }

  // Dedicated candy_guard cursor-poll fallback — backstops Helius WS
  // dropouts on the Candy Guard subscription (same failure mode that
  // killed Token Metadata WS during the Y2P2 / mVThyLe investigation).
  // CG volume is small enough that a 6 s / 20-sig sweep keeps up
  // cheaply and the dedup-by-seenSigs prevents double ingestion when
  // both WS and poller deliver the same sig.
  if (CANDY_GUARD_POLL_ENABLED) {
    const cgTarget = TARGETS.find(t => t.name === 'candy_guard');
    if (cgTarget) {
      console.log(
        `[mints/poller] start target=candy_guard interval=${CANDY_GUARD_POLL_INTERVAL_MS}ms ` +
        `limit=${CANDY_GUARD_POLL_LIMIT}`,
      );
      const tick = setInterval(() => {
        if (!running)                       return;
        if (!isTargetActive('candy_guard')) return;
        const now = Date.now();
        if (getMintTrackerRuntimeMode() !== 'live') {
          // WARM: staggered (90s phase offset) + adaptive cadence,
          // ≤MINT_WARM_LIMIT getTx/sweep, no catch-up.
          if (!warmSweepDue(warmCandyGuard, MINT_WARM_CANDY_GUARD_INTERVAL_MS, MINT_WARM_CANDY_GUARD_OFFSET_MS, candyGuardPollAccepted, now, 'candy_guard')) return;
          candyGuardPollSweeps++;
          candyGuardPollLastTs = now;
          pollTarget(cgTarget, { force: true, limitOverride: MINT_WARM_LIMIT })
            .catch(() => { /* fail-soft */ });
          return;
        }
        // LIVE adaptive idle backoff — same shape as the mpl_core branch
        // above. The 30s tick gates the actual sweep; skip until
        // nextDueTs, which stretches with the zero-accepted streak.
        if (now < liveCandyGuard.nextDueTs) return;
        const accepted = candyGuardPollAccepted;
        if (liveCandyGuard.nextDueTs !== 0) {
          if (accepted - liveCandyGuard.acceptedSnap > 0) liveCandyGuard.idleStreak = 0;
          else                                            liveCandyGuard.idleStreak += 1;
        }
        liveCandyGuard.acceptedSnap = accepted;
        const cgLvl = liveCandyGuard.idleStreak >= CANDY_GUARD_IDLE_L2_CYCLES ? 2
                    : liveCandyGuard.idleStreak >= CANDY_GUARD_IDLE_L1_CYCLES ? 1 : 0;
        const cgIntervalMs = cgLvl === 2 ? CANDY_GUARD_IDLE_L2_MS
                           : cgLvl === 1 ? CANDY_GUARD_IDLE_L1_MS : CANDY_GUARD_POLL_INTERVAL_MS;
        if (cgLvl !== liveCandyGuard.level) {
          if (cgLvl > liveCandyGuard.level) console.log(`[mints/backoff] target=candy_guard idleLevel=${cgLvl} interval=${cgIntervalMs}`);
          else                              console.log(`[mints/backoff] target=candy_guard recovered interval=${cgIntervalMs} accepted=${accepted}`);
          liveCandyGuard.level = cgLvl;
        }
        liveCandyGuard.nextDueTs = now + cgIntervalMs;
        candyGuardPollSweeps++;
        candyGuardPollLastTs = now;
        pollTarget(cgTarget, { force: true, limitOverride: CANDY_GUARD_POLL_LIMIT })
          .catch(() => { /* fail-soft; next tick retries */ });
      }, CANDY_GUARD_POLL_INTERVAL_MS);
      tick.unref();
      intervalHandles.push(tick);

      const audit = setInterval(() => {
        if (candyGuardPollSweeps === 0 && candyGuardPollFetched === 0) return;
        console.log(
          `[mints/poller-audit] target=candy_guard sweeps=${candyGuardPollSweeps} ` +
          `fetched=${candyGuardPollFetched} accepted=${candyGuardPollAccepted} ` +
          `deduped=${candyGuardPollDeduped}`,
        );
      }, 60_000);
      audit.unref();
      intervalHandles.push(audit);
    } else {
      console.log('[mints/poller] cannot start — candy_guard target not found');
    }
  } else {
    console.log('[mints/poller/cg] disabled (MINT_CANDY_GUARD_POLL_ENABLED=0)');
  }

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
      // Quiet targets use a longer threshold so their natural silence doesn't
      // trigger pointless restarts (see staleThresholdMs / QUIET_TARGETS).
      for (const target of TARGETS) {
        const last = lastNotificationTs.get(target.name) ?? now;
        const threshold = staleThresholdMs(target.name);
        if (now - last > threshold) {
          restartTarget(target, `stale (no notifications for ${threshold / 1000}s)`);
        }
      }
    }
  }, 15_000);
  watchdog.unref();
  intervalHandles.push(watchdog);

  const statsLog = setInterval(logStats, 60_000);        statsLog.unref(); intervalHandles.push(statsLog);
  const pollLog  = setInterval(logPollSummary, 60_000);  pollLog.unref();  intervalHandles.push(pollLog);
  startSalesPrefilterAudit();  // OBSERVE-only WS instruction-usefulness audit
  startSourceStats();           // 5-min per-source FIRED/EMITTED/DROP rollup

  // ── Hard periodic refresh (reliability backstop) ─────────────────────────
  // Unconditionally cycle every target subscription on a slow interval. The
  // watchdog above is the PRIMARY recovery path; this is a backstop for the
  // silent-WS failure mode it can't always see. Raised 3 min → 15 min to cut
  // the periodic getSignaturesForAddress/getTransaction catch-up burst, and
  // the per-target restarts are STAGGERED with jitter so all subscriptions no
  // longer tear down + reconnect (+ fire catch-up sweeps) in the same instant.
  const HARD_REFRESH_INTERVAL_MS = 15 * 60_000; // 15 minutes (was 3 min)
  const HARD_REFRESH_STAGGER_MS  = 1_500;       // base gap between per-target restarts

  const hardRefresh = setInterval(() => {
    if (!running || restarting) return;
    console.log('[listener] hard-refresh cycle start (staggered, 15 min)');
    TARGETS.forEach((target, i) => {
      // i*step + random jitter within one step → spread the reconnect storm
      // across ~TARGETS.length × step seconds instead of a single instant.
      const delay = i * HARD_REFRESH_STAGGER_MS + Math.floor(Math.random() * HARD_REFRESH_STAGGER_MS);
      const t = setTimeout(() => {
        if (!running || restarting) return;
        restartTarget(target, 'hard periodic refresh (15 min)');
      }, delay);
      t.unref();
    });
  }, HARD_REFRESH_INTERVAL_MS);
  hardRefresh.unref();
  intervalHandles.push(hardRefresh);

  // Primary poller — main discovery path while WS logsSubscribe is degraded.
  // Seeds seenSigs first so the first cycle doesn't replay already-processed sigs.
  // Capture the current poll-chain epoch up front; stopListener bumps it so an
  // in-flight chain from a prior startListener cannot survive a stop/start race.
  const epoch = pollChainEpoch;
  seedSeenSigs().finally(() => {
    if (!running || epoch !== pollChainEpoch) return;
    schedulePollTick(epoch);
    console.log(
      `[poll] started (primary discovery)  epoch=${epoch}` +
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
  // Invalidate any in-flight pollAll chains: their .finally re-arm will see
  // a stale epoch and bail even if a subsequent startListener has already
  // flipped `running` back to true. Without this, a rapid stop→start cycle
  // accumulates one parallel poll chain per cycle.
  pollChainEpoch++;
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

/** Snapshot of mint-side listener health for `/api/mints/runtime`.
 *  Reads in-process state (no RPC). `wsRunning` is true whenever the
 *  `mpl_core` or `token_metadata` program WebSocket is currently
 *  open; `pollerRunning` reflects the dedicated `mpl_core` cursor-poll
 *  fallback (alive when MPL_CORE_POLL_ENABLED is on AND the listener
 *  is running). `lastPollAt` is the wall-clock ms of the most
 *  recent fallback sweep tick (0 if none). */
export function getMintListenerStatus(): {
  wsRunning: boolean;
  pollerRunning: boolean;
  lastPollAt: number;
} {
  const wsRunning =
    activeSockets.has('mpl_core')
    || activeSockets.has('token_metadata')
    || activeSockets.has('candy_guard');
  const pollerRunning = running && (MPL_CORE_POLL_ENABLED || CANDY_GUARD_POLL_ENABLED);
  // Most recent fallback sweep across either dedicated poller. Either
  // one alive is enough to claim the backstop is doing work, so we
  // report the max.
  const lastPollAt = Math.max(mplCorePollLastTs, candyGuardPollLastTs);
  return { wsRunning, pollerRunning, lastPollAt };
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

// ─── Sales-WS-dead detector (emergency cost guard) ──────────────────────────
// True when EVERY sales-side logsSubscribe target has gone silent (no REAL
// notification) for longer than SALES_WS_DEAD_MS. Used by amm-poller to
// degrade sales polling — when WS delivers nothing, polling fetches a
// getTransaction for every program-touching sig (mostly non-sale), burning
// Helius credits. `lastRealNotifTs` is seeded to boot time and only advanced
// by genuine WS messages, so this naturally grants a SALES_WS_DEAD_MS grace
// after start AND can never be masked by polling activity (recovery is
// strictly WS-driven). Mint targets (mpl_core/candy_guard/token_metadata) are
// intentionally NOT included — the mint tracker is unaffected.
const SALES_WS_TARGETS: ReadonlySet<string> = new Set(['me_v2', 'mmm', 'tcomp', 'tamm']);
const SALES_WS_DEAD_MS = 5 * 60_000; // 5 minutes
export function isSalesWsDead(): boolean {
  const now = Date.now();
  for (const name of SALES_WS_TARGETS) {
    const ts = lastRealNotifTs.get(name) ?? 0;
    // Any sales target with recent real WS traffic ⇒ WS is alive.
    if (now - ts <= SALES_WS_DEAD_MS) return false;
  }
  return true;
}

let currentPollMode: 'fast' | 'healthy' | null = null;
// Epoch token preventing stale poll chains from re-arming after a stop/start
// cycle. stopListener bumps this; startListener captures it; the chain's
// setTimeout + .finally re-arm both bail when the captured epoch no longer
// matches. Without this guard, a fast OFF→ON mode toggle (runtime/mode.ts)
// can leave an in-flight pollAll whose .finally fires AFTER startListener
// has flipped `running` back to true — the old chain's `if (running)` check
// passed and it re-armed, accumulating one parallel pollAll chain per toggle.
let pollChainEpoch = 0;
function schedulePollTick(epoch: number): void {
  if (!running) return;  // stopListener() — don't re-arm
  if (epoch !== pollChainEpoch) {
    console.log(`[poll] stale chain epoch=${epoch} current=${pollChainEpoch} — not re-arming`);
    return;
  }
  const healthy = wsIsHealthy();
  const nextMode: 'fast' | 'healthy' = healthy ? 'healthy' : 'fast';
  if (nextMode !== currentPollMode) {
    console.log(`[poll] mode=${nextMode}  (ws ${healthy ? 'healthy' : 'degraded'})`);
    currentPollMode = nextMode;
  }
  const delay = healthy ? POLL_HEALTHY_MS : POLL_FAST_MS;
  setTimeout(() => {
    if (!running || epoch !== pollChainEpoch) return;
    pollAll().catch(() => {}).finally(() => schedulePollTick(epoch));
  }, delay).unref();
}
