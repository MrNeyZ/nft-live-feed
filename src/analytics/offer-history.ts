/**
 * Offer History / Diffing — pure snapshot model + pure transition/hysteresis
 * core + a thin I/O wrapper that reuses existing venue fetchers.
 *
 * ── Source audit (verified against live endpoints and source, not assumed) ─
 *
 * ME_COLLECTION (src/enrichment/enrich.ts's `getCollectionTopOfferLamports`,
 * `GET /v2/collections/{slug}/offers?limit=20`):
 *   - STATUS AS OF THIS AUDIT: the endpoint returns HTTP 400 body
 *     "Not Found." for every collection tested (claynosaurz, okay_bears,
 *     mad_lads — with key, without key, several URL variants), routed
 *     through ME's real API gateway (Kong request id + live rate-limit
 *     headers present, so this is a real deprecation, not a network
 *     hiccup). `offerDelta` / the feed's OFFER badge have therefore been
 *     silently returning null in production since this changed. Not fixed
 *     here — out of scope for Stage 4 — but this is why ME_COLLECTION
 *     will show `confidence:'low'` with a warning on every live snapshot
 *     until ME restores or replaces this route.
 *   - Even when live, the existing code only ever read `.price` off each
 *     returned offer and took the max — there is no trait/attribute filter.
 *     If the endpoint's payload includes trait-conditional offers (it does
 *     on ME's own site UI), a collection's "top offer" could be a
 *     trait-specific bid that a plain/common NFT could never fill. This
 *     could not be re-verified live (endpoint is down), so it's flagged as
 *     a standing risk, not a confirmed fact — hence `confidence` never
 *     exceeds 'medium' for this venue even if the endpoint recovers, unless
 *     a future stage adds trait-awareness.
 *   - No funding/expiry visible in the shape this project reads today.
 *
 * MMM (src/server/collection-bids.ts's `fetchMmmTopBid`,
 * `GET /v2/mmm/pools?collectionSymbol={slug}`) — confirmed live and working:
 *   - Field treated as top bid: `spotPrice` (lamports) on the pool with the
 *     highest spot among pools where `poolType` is 'buy'/'two_sided' AND
 *     `buysidePaymentAmount > 0`.
 *   - Pool ALLOWLISTS are not inspected at all — a pool's bid can be
 *     restricted to a subset of the collection (specific traits/mints) via
 *     an FVCA/allowlist this fetcher never reads. A collection-wide "top
 *     MMM bid" may not be fillable by an arbitrary NFT in that collection.
 *     (Project history note: this codebase's OWN prior allowlist-based
 *     block heuristics were later found to be overcautious/wrong for MMM
 *     pool *eligibility* scanning — but that does not make allowlists
 *     disappear; it means "restricted" is a real state this fetcher simply
 *     doesn't check, in either direction.)
 *   - `spotPrice` is a gross, fee-exclusive curve quote — same semantics
 *     floor-depth.ts already documents for MMM pool asks.
 *   - "Funded" here = ME's own indexer reporting `buysidePaymentAmount > 0`
 *     — a real fact, but not an independent RPC balance check (unlike
 *     tools-retardio-offers.ts's per-mint escrow verification, which reads
 *     the buyer's own escrow PDA balance directly via RPC). Exposed as
 *     `funded: boolean` (medium confidence), not RPC-verified.
 *
 * TENSOR (src/server/collection-bids.ts's `fetchTensorTopBid`,
 * `find_collection` stats, `stats.sellNowPrice`) — confirmed live/working
 * when TENSOR_API_KEY is set:
 *   - `sellNowPrice`, per that file's own comment, is "what you'd get
 *     *selling now* into the top collection bid" — phrasing that suggests
 *     an effective/net figure, not necessarily the same gross basis as
 *     MMM's `spotPrice`. Cross-venue amount comparisons should be read as
 *     approximate, not cent-for-cent equivalent, until independently
 *     confirmed.
 *   - Collection-wide by construction (one stats number); no per-NFT/trait
 *     executability signal exists at this endpoint.
 *   - No offer id / owner / expiry / funding exposed at this endpoint.
 *   - API key + caching are already centralized: `resolveTensorMeta()` and
 *     `tensorFetch()` (both in listings-store.ts) are the single shared
 *     slug-resolution cache and the single global ≥1 req/sec gate for
 *     every Tensor call in the project — this module reuses both via
 *     collection-bids.ts, adding no new Tensor traffic pattern.
 *
 * ── Hard rule shared with floor-depth.ts / cross-market.ts ─────────────────
 * None of these three venues prove a SPECIFIC NFT can fill the reported
 * amount — every value here is collection-level corroboration, never
 * per-NFT proof. See the doc comment on `observeCollectionOffers` and the
 * Mispriced-NFT compatibility notes at the bottom of this file.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fetchMmmTopBid, fetchTensorTopBid } from '../server/collection-bids';
import { getCollectionTopOfferLamports } from '../enrichment/enrich';

// ─── Normalized snapshot model ───────────────────────────────────────────────

export type OfferVenue = 'ME_COLLECTION' | 'MMM' | 'TENSOR';
export type Confidence = 'high' | 'medium' | 'low';

export interface VenueOfferSnapshot {
  venue:        OfferVenue;
  amountSol:    number | null;
  observedAtMs: number;

  offerId?:     string | null;
  poolAddress?: string | null;
  owner?:       string | null;
  expiresAtMs?: number | null;
  funded?:      boolean | null;

  confidence: Confidence;
  warnings:   string[];
}

export interface CollectionOfferSnapshot {
  collectionKey: string;
  observedAtMs:  number;

  venues: {
    meCollection: VenueOfferSnapshot | null;
    mmm:          VenueOfferSnapshot | null;
    tensor:       VenueOfferSnapshot | null;
  };

  best: { venue: OfferVenue; amountSol: number } | null;
}

function isValidAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Pure snapshot builder for one venue. Invalid/non-positive/NaN amounts are
 * treated as "no offer observed" (returns null), never as a real offer —
 * matches the same discipline floor-depth.ts and cross-market.ts already
 * apply to listing prices.
 */
export function buildVenueSnapshot(
  venue: OfferVenue,
  amountSol: number | null | undefined,
  observedAtMs: number,
  extra: Partial<Pick<VenueOfferSnapshot, 'offerId' | 'poolAddress' | 'owner' | 'expiresAtMs' | 'funded'>> = {},
  confidence: Confidence = 'medium',
  warnings: string[] = [],
): VenueOfferSnapshot | null {
  if (!isValidAmount(amountSol)) return null;
  return { venue, amountSol, observedAtMs, confidence, warnings, ...extra };
}

/**
 * Pure snapshot normalizer — assembles the per-venue snapshots into one
 * `CollectionOfferSnapshot`, picking the best (highest `amountSol`) across
 * whichever venues are non-null. Deterministic: iterates a FIXED venue
 * order (meCollection, mmm, tensor) rather than depending on the caller's
 * object key order, so shuffling how the venues object is constructed can
 * never change the result. Exact ties keep the first-encountered venue in
 * that fixed order (meCollection > mmm > tensor).
 */
export function buildCollectionOfferSnapshot(
  collectionKey: string,
  observedAtMs: number,
  meCollection: VenueOfferSnapshot | null,
  mmm: VenueOfferSnapshot | null,
  tensor: VenueOfferSnapshot | null,
): CollectionOfferSnapshot {
  let best: { venue: OfferVenue; amountSol: number } | null = null;
  for (const v of [meCollection, mmm, tensor]) {
    if (!v || !isValidAmount(v.amountSol)) continue;
    if (!best || v.amountSol > best.amountSol) best = { venue: v.venue, amountSol: v.amountSol };
  }
  return {
    collectionKey,
    observedAtMs,
    venues: { meCollection, mmm, tensor },
    best,
  };
}

// ─── Pure transition computation ─────────────────────────────────────────────

export type OfferTransitionKind =
  | 'first_offer'
  | 'offer_increase'
  | 'offer_decrease'
  | 'offer_removed'
  | 'best_venue_changed'
  | 'unchanged';

export interface OfferTransition {
  kind: OfferTransitionKind;

  previousBestSol: number | null;
  currentBestSol:  number | null;

  absoluteDeltaSol: number | null;
  relativeDeltaPct: number | null;

  previousVenue: OfferVenue | null;
  currentVenue:  OfferVenue | null;

  candidateJump: boolean;
  reasons: string[];

  observedAtMs: number;
}

export interface OfferHistoryConfig {
  /** e.g. 0.15 = top offer must rise >=15% to be jump-worthy. */
  minRelativeIncreasePct: number;
  /** e.g. 0.05 SOL — guards low-price collections from tiny absolute moves
   *  reading as a "jump" purely because the relative % looks big. */
  minAbsoluteIncreaseSol: number;
  /** Absolute-SOL tolerance below which two amounts are "the same price". */
  epsilonSol: number;
}

export const DEFAULT_OFFER_HISTORY_CONFIG: OfferHistoryConfig = {
  minRelativeIncreasePct: 0.15,
  minAbsoluteIncreaseSol: 0.05,
  epsilonSol: 1e-6,
};

/**
 * Pure, deterministic diff between two collection-level offer snapshots.
 * Makes no network/DB calls, never mutates its inputs. `candidateJump` is
 * NOT a confirmed jump — see `stepOfferHistory` for the persistence/
 * hysteresis layer that decides confirmation.
 */
export function computeOfferTransition(
  previous: CollectionOfferSnapshot | null,
  current: CollectionOfferSnapshot,
  config: OfferHistoryConfig = DEFAULT_OFFER_HISTORY_CONFIG,
): OfferTransition {
  const prevBest = previous?.best ?? null;
  const currBest = current.best ?? null;
  const previousBestSol = prevBest && isValidAmount(prevBest.amountSol) ? prevBest.amountSol : null;
  const currentBestSol  = currBest && isValidAmount(currBest.amountSol) ? currBest.amountSol : null;
  const previousVenue = previousBestSol != null ? prevBest!.venue : null;
  const currentVenue  = currentBestSol  != null ? currBest!.venue : null;
  const observedAtMs = current.observedAtMs;

  const base = { previousBestSol, currentBestSol, previousVenue, currentVenue, observedAtMs };

  if (previousBestSol == null && currentBestSol == null) {
    return { ...base, kind: 'unchanged', absoluteDeltaSol: null, relativeDeltaPct: null, candidateJump: false, reasons: ['no offers before or after'] };
  }
  if (previousBestSol == null && currentBestSol != null) {
    return { ...base, kind: 'first_offer', absoluteDeltaSol: null, relativeDeltaPct: null, candidateJump: false, reasons: ['first buy-side liquidity observed'] };
  }
  if (previousBestSol != null && currentBestSol == null) {
    return { ...base, kind: 'offer_removed', absoluteDeltaSol: null, relativeDeltaPct: null, candidateJump: false, reasons: ['top offer disappeared'] };
  }

  // Both non-null from here on.
  const absoluteDeltaSol = currentBestSol! - previousBestSol!;
  const relativeDeltaPct = previousBestSol! > 0 ? absoluteDeltaSol / previousBestSol! : null;

  if (Math.abs(absoluteDeltaSol) <= config.epsilonSol) {
    if (previousVenue !== currentVenue) {
      return {
        ...base, kind: 'best_venue_changed', absoluteDeltaSol, relativeDeltaPct, candidateJump: false,
        reasons: [`best venue changed from ${previousVenue} to ${currentVenue} at approximately the same price — not an offer jump`],
      };
    }
    return { ...base, kind: 'unchanged', absoluteDeltaSol, relativeDeltaPct, candidateJump: false, reasons: ['price unchanged within epsilon'] };
  }

  if (absoluteDeltaSol > 0) {
    const reasons: string[] = [];
    const passRel = relativeDeltaPct != null && relativeDeltaPct >= config.minRelativeIncreasePct;
    const passAbs = absoluteDeltaSol >= config.minAbsoluteIncreaseSol;
    if (!passRel) reasons.push(`relative increase ${relativeDeltaPct != null ? (relativeDeltaPct * 100).toFixed(1) + '%' : 'n/a'} below ${(config.minRelativeIncreasePct * 100).toFixed(0)}% threshold`);
    if (!passAbs) reasons.push(`absolute increase ${absoluteDeltaSol.toFixed(4)} SOL below ${config.minAbsoluteIncreaseSol} SOL threshold`);
    const candidateJump = passRel && passAbs;
    if (candidateJump) reasons.push('passes both relative and absolute thresholds — candidate jump');
    return { ...base, kind: 'offer_increase', absoluteDeltaSol, relativeDeltaPct, candidateJump, reasons };
  }

  return { ...base, kind: 'offer_decrease', absoluteDeltaSol, relativeDeltaPct, candidateJump: false, reasons: ['top offer decreased'] };
}

// ─── Persistence / hysteresis state machine ─────────────────────────────────

export interface PendingCandidate {
  targetAmountSol: number;
  targetVenue:     OfferVenue;
  firstSeenAtMs:   number;
  confirmations:   number;
}

export interface OfferHistoryState {
  lastStableSnapshot: CollectionOfferSnapshot | null;
  pendingCandidate:   PendingCandidate | null;
  armed:              boolean;
  lastConfirmedJumpAtMs: number | null;
  /** Best-offer value immediately BEFORE the most recently confirmed jump —
   *  the re-arm baseline. Null until a jump has ever confirmed. */
  preJumpBaselineSol: number | null;
}

export function initialOfferHistoryState(): OfferHistoryState {
  return { lastStableSnapshot: null, pendingCandidate: null, armed: true, lastConfirmedJumpAtMs: null, preJumpBaselineSol: null };
}

export interface HysteresisConfig {
  /** Consecutive qualifying observations required before a candidate jump
   *  confirms. */
  requiredConfirmations: number;
  /** Re-arm once the current best falls back to <= preJumpBaselineSol *
   *  (1 + this ratio) — i.e. the price has genuinely reset, not just
   *  ticked down slightly. */
  reArmToleranceRatio: number;
}

export const DEFAULT_HYSTERESIS_CONFIG: HysteresisConfig = {
  requiredConfirmations: 2,
  reArmToleranceRatio: 0.02,
};

export interface OfferHistoryStepResult {
  nextState:     OfferHistoryState;
  transition:    OfferTransition;
  confirmedJump: boolean;
}

/**
 * Pure state-machine step: given the current persisted state and a fresh
 * snapshot, returns the next state plus the raw transition plus whether
 * THIS observation confirms a jump. No network/DB access — the I/O wrapper
 * (`observeCollectionOffers`) is responsible for loading/saving state.
 */
export function stepOfferHistory(
  state: OfferHistoryState,
  current: CollectionOfferSnapshot,
  config: OfferHistoryConfig = DEFAULT_OFFER_HISTORY_CONFIG,
  hysteresis: HysteresisConfig = DEFAULT_HYSTERESIS_CONFIG,
): OfferHistoryStepResult {
  // `baseline` is the comparison anchor — NOT necessarily "the last raw
  // observation". While a candidate is pending (not yet confirmed, not yet
  // discarded), the baseline stays FROZEN at the pre-candidate value, so a
  // second consecutive observation at the same candidate level is measured
  // against the same pre-jump reference and reads as another qualifying
  // `offer_increase` (confirming), not as `unchanged` against itself. The
  // baseline only moves once a candidate resolves (confirms -> moves to the
  // new level; discarded -> moves to whatever the new reality is).
  const baseline = state.lastStableSnapshot;
  const transition = computeOfferTransition(baseline, current, config);

  let pendingCandidate = state.pendingCandidate;
  let armed = state.armed;
  let lastConfirmedJumpAtMs = state.lastConfirmedJumpAtMs;
  let preJumpBaselineSol = state.preJumpBaselineSol;
  let confirmedJump = false;
  let nextStableSnapshot = state.lastStableSnapshot;

  // Re-arm: only once the price has genuinely reset back down near the
  // pre-jump baseline — oscillating near the post-jump level never re-arms.
  if (!armed && preJumpBaselineSol != null && current.best != null) {
    if (current.best.amountSol <= preJumpBaselineSol * (1 + hysteresis.reArmToleranceRatio)) {
      armed = true;
    }
  }

  if (transition.kind === 'offer_increase' && transition.candidateJump) {
    if (!armed) {
      // A jump-shaped move while disarmed (already fired recently, no reset
      // yet) never starts a new candidate — this is exactly what prevents
      // re-firing while oscillating near the confirmed level. The baseline
      // still tracks reality (moves to current) so a LATER genuine reset/
      // re-arm is measured against the true current price, not a stale one.
      pendingCandidate = null;
      nextStableSnapshot = current;
    } else {
      const target = current.best!;
      const samecandidate = pendingCandidate != null
        && Math.abs(pendingCandidate.targetAmountSol - target.amountSol) <= config.epsilonSol
        && pendingCandidate.targetVenue === target.venue;
      pendingCandidate = samecandidate
        ? { ...pendingCandidate!, confirmations: pendingCandidate!.confirmations + 1 }
        : { targetAmountSol: target.amountSol, targetVenue: target.venue, firstSeenAtMs: current.observedAtMs, confirmations: 1 };

      if (pendingCandidate.confirmations >= hysteresis.requiredConfirmations) {
        confirmedJump = true;
        armed = false;
        lastConfirmedJumpAtMs = current.observedAtMs;
        preJumpBaselineSol = baseline?.best?.amountSol ?? null;
        pendingCandidate = null;
        nextStableSnapshot = current; // baseline now moves to the newly-confirmed level
      }
      // Still pending (not yet confirmed): baseline stays frozen at the
      // pre-candidate value — nextStableSnapshot is left as state.lastStableSnapshot.
    }
  } else {
    // Anything that isn't a qualifying increase (unchanged, decrease,
    // removal, first_offer, venue-only rotation, or a sub-threshold
    // increase) discards any in-flight candidate — this is what makes a
    // reverting/oscillating move fail to confirm — and the baseline moves
    // to reflect the new reality.
    pendingCandidate = null;
    nextStableSnapshot = current;
  }

  return {
    nextState: { lastStableSnapshot: nextStableSnapshot, pendingCandidate, armed, lastConfirmedJumpAtMs, preJumpBaselineSol },
    transition,
    confirmedJump,
  };
}

// ─── Disk-persisted warm-start cache ─────────────────────────────────────────
// Same convention as tools-mmm-pools.ts's fvcaInfoCache / knownPoolFirstSeen:
// in-memory Map is the live state; disk is a debounced snapshot so a
// restart doesn't make every collection look like `first_offer` again.
// Deliberately NOT a time series — one row per collection, overwritten.

const STATE_FILE = path.join(__dirname, '../../data/offer-history-state.json');
export const MAX_COLLECTION_KEYS = 2_000;
/** Entries whose last observation is older than this are dropped on load —
 *  explicit staleness handling, not unbounded accumulation of abandoned
 *  collections. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const stateByCollection = new Map<string, OfferHistoryState>();
const insertionOrder: string[] = []; // FIFO eviction order, mirrors listings-store.ts's mintToSlugQueue pattern

export interface LoadResult {
  entries:      Array<[string, OfferHistoryState]>;
  skippedStale: number;
  /** True when the file existed but couldn't be parsed (malformed JSON,
   *  wrong shape) — distinguishes "first boot, no file yet" from "the file
   *  is actually corrupt", for callers that want to log the difference.
   *  Both fail soft to an empty result either way. */
  malformed: boolean;
}

/** Pure-ish (fs read is the only side effect) parse + stale-filter step,
 *  extracted so it's independently testable with an arbitrary file path —
 *  malformed-file and stale-pruning behavior don't require restarting the
 *  real process or touching the production state file. */
export function loadOfferHistoryStateFile(filePath: string, now: number = Date.now()): LoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { entries: [], skippedStale: 0, malformed: false }; // no file yet — first boot
  }
  let parsed: Array<[string, OfferHistoryState]>;
  try {
    parsed = JSON.parse(raw) as Array<[string, OfferHistoryState]>;
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch {
    return { entries: [], skippedStale: 0, malformed: true }; // corrupt file — fail soft, start empty
  }
  const entries: Array<[string, OfferHistoryState]> = [];
  let skippedStale = 0;
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [key, value] = pair;
    if (typeof key !== 'string' || !key) continue;
    const lastObservedAtMs = value?.lastStableSnapshot?.observedAtMs ?? 0;
    if (now - lastObservedAtMs > STALE_AFTER_MS) { skippedStale++; continue; }
    entries.push([key, value]);
  }
  return { entries, skippedStale, malformed: false };
}

(function loadStateFromDisk(): void {
  const { entries, skippedStale, malformed } = loadOfferHistoryStateFile(STATE_FILE);
  for (const [key, value] of entries) {
    stateByCollection.set(key, value);
    insertionOrder.push(key);
  }
  if (malformed) console.warn('[offer-history] state file was malformed — starting empty (non-fatal)');
  console.log(`[offer-history] loaded ${entries.length} collection state(s) from disk (${skippedStale} stale, dropped)`);
})();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveStateDebounced(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const entries = [...stateByCollection.entries()];
    fsp.writeFile(STATE_FILE, JSON.stringify(entries), 'utf8').catch(() => { /* non-fatal */ });
  }, 2_000);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/**
 * Direct state write, bounded by `MAX_COLLECTION_KEYS` (FIFO eviction of the
 * oldest untouched collection key). Used internally by
 * `observeCollectionOffers` after a real fetch, and exported so tests /
 * future tooling (e.g. a warm-migration script) can inject or restore state
 * without going through a network fetch.
 */
export function setOfferHistoryState(collectionKey: string, state: OfferHistoryState): void {
  if (!stateByCollection.has(collectionKey)) {
    insertionOrder.push(collectionKey);
    if (insertionOrder.length > MAX_COLLECTION_KEYS) {
      const evict = insertionOrder.shift();
      if (evict) stateByCollection.delete(evict);
    }
  }
  stateByCollection.set(collectionKey, state);
  saveStateDebounced();
}

/** Read-only access to current state — never mutates, never fetches. */
export function getOfferHistoryState(collectionKey: string): OfferHistoryState | null {
  return stateByCollection.get(collectionKey) ?? null;
}

// ─── I/O wrapper ──────────────────────────────────────────────────────────────

export interface ObserveOfferOptions {
  config?: OfferHistoryConfig;
  hysteresis?: HysteresisConfig;
}

export interface ObserveOfferResult {
  snapshot:      CollectionOfferSnapshot;
  transition:    OfferTransition;
  confirmedJump: boolean;
}

/**
 * Fetches all three venues for `slug` (reusing collection-bids.ts's and
 * enrich.ts's EXISTING fetchers/caches — no new raw fetch call sites, no
 * new polling loop), builds a normalized snapshot, steps the persisted
 * hysteresis state machine for `collectionKey`, and persists the result
 * (debounced). Does NOT prove any specific NFT can fill the reported
 * amount — every venue here is collection-level corroboration only (see
 * this module's top-of-file audit and the Mispriced-NFT compatibility
 * notes below).
 *
 * `collectionKey` and `slug` are separate on purpose: today they're the
 * same ME slug, but this keeps the door open for a future non-ME-slugged
 * collection key (e.g. an on-chain collection address) without a shape
 * change.
 */
export async function observeCollectionOffers(
  collectionKey: string,
  slug: string,
  opts: ObserveOfferOptions = {},
): Promise<ObserveOfferResult> {
  const observedAtMs = Date.now();

  const [meRaw, mmmRaw, tensorRaw] = await Promise.all([
    getCollectionTopOfferLamports(slug).catch(() => null),
    fetchMmmTopBid(slug).catch(() => null),
    fetchTensorTopBid(slug).catch(() => null),
  ]);

  const meCollection = buildVenueSnapshot(
    'ME_COLLECTION',
    meRaw != null ? meRaw / 1e9 : null,
    observedAtMs,
    {},
    'medium', // capped at medium even when live — trait-conditionality unverifiable, see module doc
    meRaw == null ? ['ME collection offers endpoint returned no data (as of this audit, this endpoint returns HTTP 400 for every collection tested — see module doc)'] : [],
  );

  const mmm = buildVenueSnapshot(
    'MMM',
    mmmRaw?.amountLamports != null ? mmmRaw.amountLamports / 1e9 : null,
    observedAtMs,
    { poolAddress: mmmRaw?.poolAddress ?? null, owner: mmmRaw?.owner ?? null, funded: mmmRaw?.funded ?? null },
    'medium', // pool allowlist eligibility not verified — see module doc
    mmmRaw ? [] : [],
  );

  const tensor = buildVenueSnapshot(
    'TENSOR',
    tensorRaw != null ? tensorRaw / 1e9 : null,
    observedAtMs,
    {},
    'medium', // sellNowPrice basis (gross vs net) not independently confirmed — see module doc
    [],
  );

  const snapshot = buildCollectionOfferSnapshot(collectionKey, observedAtMs, meCollection, mmm, tensor);

  const priorState = stateByCollection.get(collectionKey) ?? initialOfferHistoryState();
  const { nextState, transition, confirmedJump } = stepOfferHistory(priorState, snapshot, opts.config, opts.hysteresis);
  setOfferHistoryState(collectionKey, nextState);

  return { snapshot, transition, confirmedJump };
}

// ─── Mispriced NFT compatibility (documentation only — no scorer built here) ─
//
// - Collection-level `best` (any venue) is CORROBORATION ONLY for a
//   Mispriced NFT signal — never proof a specific listed NFT could fill it.
// - MMM and ME_COLLECTION amounts may be trait/allowlist-restricted in ways
//   this module cannot see; Tensor's collection-wide stat carries the same
//   caveat structurally (a single aggregate number, no per-NFT check).
// - Funding: MMM's `funded` flag is ME's self-reported balance, not RPC-
//   verified — plausible corroboration, not proof. A future stage that
//   independently RPC-verifies a specific offer/pool balance (the
//   tools-retardio-offers.ts pattern, applied per-mint) may justifiably
//   assign HIGHER confidence than anything this module produces on its own.
// - Do not treat `confidence: 'high'` as availability today — every venue
//   snapshot here is capped at 'medium' until a future stage adds
//   trait/allowlist/RPC verification; this module's job is honest
//   collection-level history, not per-NFT certainty.
