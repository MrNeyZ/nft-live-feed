/**
 * Offer History / Diffing — pure snapshot model + pure transition/hysteresis
 * core + a thin I/O wrapper that reuses existing venue fetchers.
 *
 * ── Stage 4.5 update (Jul 2026) ─────────────────────────────────────────────
 *
 * ME_COLLECTION is RETIRED, not merely low-confidence. `GET /v2/collections/
 * {slug}/offers` returns HTTP 400 for every collection tested, routed through
 * ME's real API gateway (Kong request id + live rate-limit headers present —
 * a real deprecation, not a network hiccup), and no working replacement
 * exists (confirmed via ME's own docs/help articles — see the Jul 2026
 * discovery audit). `enrich.ts`'s `getCollectionTopOfferLamports` — the only
 * caller of that dead endpoint — has been deleted; this module no longer
 * calls it at all. `venues.meCollection` stays in the snapshot shape (wire/
 * disk-state compatibility — every historical snapshot already has it as
 * null, since the endpoint has been silently failing all along) but is now
 * ALWAYS null, permanently, unless a future stage proves a real replacement.
 *
 * MMM and TENSOR are now sourced from `src/analytics/normalized-collection-
 * bid.ts`'s `NormalizedCollectionBid` model instead of raw collection-bids.ts
 * fetchers directly:
 *   - MMM: `fetchMmmTopBid`'s old `buysidePaymentAmount > 0` check accepted
 *     pools that could not pay their own quoted price (mad_lads 57.67 SOL
 *     quote / 2.30 SOL escrow; okay_bears 6.00 SOL / 0.067 SOL) — fixed in
 *     collection-bids.ts (`classifyFunding`). Additionally, pool allowlist
 *     eligibility (collection-wide vs exact-mint-restricted) is now checked
 *     on-chain (one cached read per candidate pool). A snapshot's `mmm`
 *     venue may still report an underfunded/ineligible quote as market
 *     context (`usableForValueSignal: false`) — see `buildCollectionOfferSnapshot`'s
 *     `best`-selection gate below, which excludes such quotes from ever
 *     winning `best` (and therefore from ever driving an Offer Jump).
 *   - TENSOR: `sellNowPrice` confirmed GROSS (a separate `sellNowPriceNetFees`
 *     net figure exists) — normalized-collection-bid.ts exposes both; this
 *     module prefers net for the displayed `amountSol` when present. Tensor
 *     remains collection-wide-by-construction with no per-NFT/trait signal,
 *     so `eligibility` is always 'unknown' and it can never set
 *     `usableForValueSignal`. Per the hardening spec, Tensor MAY still win
 *     `best` (market-context corroboration) — only MMM is gated on
 *     usability, since MMM's absurd-bid failure mode is the one this stage
 *     fixes.
 *
 * ── Hard rule shared with floor-depth.ts / cross-market.ts ─────────────────
 * None of these venues prove a SPECIFIC NFT can fill the reported amount —
 * every value here is collection-level corroboration, never per-NFT proof.
 * See the doc comment on `observeCollectionOffers` and the Mispriced-NFT
 * compatibility notes at the bottom of this file.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  getNormalizedMmmBid,
  getNormalizedTensorBid,
  type BidEligibility,
  type BidFunding,
} from './normalized-collection-bid';

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
  /** @deprecated true iff `funding === 'verified'` — kept for back-compat,
   *  prefer `funding`/`eligibility`/`usableForValueSignal`. */
  funded?:      boolean | null;

  /** Stage 4.5 normalized-bid fields — optional so existing pure-builder
   *  tests that never set them keep passing unchanged (undefined is treated
   *  as "not asserted", never as "usable"). */
  eligibility?:           BidEligibility;
  funding?:               BidFunding;
  usableForValueSignal?:  boolean;
  grossAmountSol?:        number | null;
  netAmountSol?:          number | null;

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
  extra: Partial<Pick<VenueOfferSnapshot,
    'offerId' | 'poolAddress' | 'owner' | 'expiresAtMs' | 'funded'
    | 'eligibility' | 'funding' | 'usableForValueSignal' | 'grossAmountSol' | 'netAmountSol'
  >> = {},
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
    // Stage 4.5: an MMM quote explicitly marked NOT usable (underfunded,
    // exact-mint-restricted, or unparseable allowlist) can never win `best`
    // — that's exactly the mad_lads/okay_bears absurd-bid failure mode this
    // stage fixes. Strict `=== false` (not `!== true`) so callers/tests that
    // never set `usableForValueSignal` (e.g. raw buildVenueSnapshot calls in
    // offer-history.test.ts) keep their pre-Stage-4.5 behavior unchanged.
    // Tensor is deliberately NOT gated the same way — it may still win as
    // market-context corroboration (see module doc).
    if (v.venue === 'MMM' && v.usableForValueSignal === false) continue;
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

  const [mmmBid, tensorBid] = await Promise.all([
    getNormalizedMmmBid(slug).catch(() => null),
    getNormalizedTensorBid(slug).catch(() => null),
  ]);

  // ME_COLLECTION is permanently retired — see module doc. Never fetched;
  // always null. Kept as an explicit venue slot (not removed from the
  // shape) purely for wire/disk-state compatibility with historical
  // snapshots, which already have this as null in every case on record.
  const meCollection: VenueOfferSnapshot | null = null;

  const mmm = buildVenueSnapshot(
    'MMM',
    mmmBid?.grossAmountSol ?? null,
    observedAtMs,
    {
      poolAddress: mmmBid?.poolAddress ?? null,
      owner:       mmmBid?.owner ?? null,
      funded:      mmmBid ? mmmBid.funding === 'verified' : null,
      eligibility: mmmBid?.eligibility,
      funding:     mmmBid?.funding,
      usableForValueSignal: mmmBid?.usableForValueSignal,
      grossAmountSol: mmmBid?.grossAmountSol ?? null,
      netAmountSol:   mmmBid?.netAmountSol ?? null,
    },
    mmmBid?.usableForValueSignal ? 'medium' : 'low', // never 'high' — see module doc
    mmmBid?.warnings ?? [],
  );

  // Tensor's displayed amountSol prefers the net-of-fees figure when present
  // (closer to what a seller would actually receive) — falls back to gross.
  const tensorAmountSol = tensorBid?.netAmountSol ?? tensorBid?.grossAmountSol ?? null;
  const tensor = buildVenueSnapshot(
    'TENSOR',
    tensorAmountSol,
    observedAtMs,
    {
      eligibility: tensorBid?.eligibility,
      funding:     tensorBid?.funding,
      usableForValueSignal: tensorBid?.usableForValueSignal,
      grossAmountSol: tensorBid?.grossAmountSol ?? null,
      netAmountSol:   tensorBid?.netAmountSol ?? null,
    },
    'medium',
    tensorBid?.warnings ?? [],
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
// - Stage 4.5 hard gate: a future scorer must check `usableForValueSignal`
//   on the MMM venue snapshot (or re-derive it from `eligibility`/`funding`)
//   before treating an MMM quote as anything more than context — only
//   `eligibility: 'collection_wide'` AND `funding: 'verified'` may
//   contribute to VALUE. Tensor's `usableForValueSignal` is always false —
//   it may corroborate, never independently trigger VALUE (no per-NFT/trait
//   executability signal exists at its endpoint). ME_COLLECTION no longer
//   exists as a venue in practice (permanently retired, see module doc).
// - Do not treat `confidence: 'high'` as availability today — every venue
//   snapshot here is capped at 'medium' (or 'low' for a non-usable MMM
//   quote); this module's job is honest collection-level history, not
//   per-NFT certainty.
