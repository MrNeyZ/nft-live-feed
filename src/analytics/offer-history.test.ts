/**
 * Regression suite for offer-history.ts.
 *
 * Pure-function tests (transition + snapshot builders) need no network/DB.
 * State-machine tests exercise `stepOfferHistory` directly (pure) plus the
 * exported `setOfferHistoryState`/`getOfferHistoryState`/
 * `loadOfferHistoryStateFile` for the persistence-layer specific cases
 * (malformed file, eviction) — none of these make a real fetch, and the
 * debounced disk-save timer is `.unref()`'d, so this test process exits
 * (via `process.exit()` below) before it could ever actually write to the
 * real production state file.
 *
 * Run: npx ts-node src/analytics/offer-history.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildVenueSnapshot,
  buildCollectionOfferSnapshot,
  computeOfferTransition,
  stepOfferHistory,
  initialOfferHistoryState,
  loadOfferHistoryStateFile,
  setOfferHistoryState,
  getOfferHistoryState,
  MAX_COLLECTION_KEYS,
  DEFAULT_OFFER_HISTORY_CONFIG,
  DEFAULT_HYSTERESIS_CONFIG,
  type CollectionOfferSnapshot,
  type OfferHistoryState,
} from './offer-history';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

function snap(collectionKey: string, observedAtMs: number, bestAmountSol: number | null, bestVenue: 'ME_COLLECTION' | 'MMM' | 'TENSOR' = 'MMM'): CollectionOfferSnapshot {
  const v = bestAmountSol != null ? buildVenueSnapshot(bestVenue, bestAmountSol, observedAtMs) : null;
  const others = { meCollection: null, mmm: null, tensor: null };
  return buildCollectionOfferSnapshot(
    collectionKey,
    observedAtMs,
    bestVenue === 'ME_COLLECTION' ? v : others.meCollection,
    bestVenue === 'MMM' ? v : others.mmm,
    bestVenue === 'TENSOR' ? v : others.tensor,
  );
}

// ════════════════════════════════════════════════════════════════════════
// PURE TRANSITION TESTS
// ════════════════════════════════════════════════════════════════════════

// 1. null -> first offer
{
  const t = computeOfferTransition(null, snap('c1', 1000, 2));
  check('null->offer: kind first_offer', t.kind === 'first_offer');
  check('null->offer: previousBestSol null, currentBestSol 2', t.previousBestSol === null && t.currentBestSol === 2);
  check('null->offer: candidateJump false', t.candidateJump === false);
}

// 2. first offer -> unchanged
{
  const a = snap('c2', 1000, 2);
  const b = snap('c2', 2000, 2);
  const t = computeOfferTransition(a, b);
  check('offer->unchanged: kind unchanged', t.kind === 'unchanged');
  check('offer->unchanged: deltas zero-ish', t.absoluteDeltaSol === 0);
}

// 3. increase passes relative but fails absolute (tiny prior value)
{
  // prior 0.01, new 0.013 -> +30% relative (passes 15%), +0.003 SOL absolute (fails 0.05)
  const a = snap('c3', 1000, 0.01);
  const b = snap('c3', 2000, 0.013);
  const t = computeOfferTransition(a, b);
  check('passRelFailAbs: kind offer_increase', t.kind === 'offer_increase');
  check('passRelFailAbs: candidateJump false', t.candidateJump === false);
  check('passRelFailAbs: reasons mention absolute threshold', t.reasons.some(r => r.includes('absolute increase')));
}

// 4. increase passes absolute but fails relative (large prior value)
{
  // prior 10, new 10.08 -> +0.8% relative (fails 15%), +0.08 SOL absolute (passes 0.05)
  const a = snap('c4', 1000, 10);
  const b = snap('c4', 2000, 10.08);
  const t = computeOfferTransition(a, b);
  check('passAbsFailRel: kind offer_increase', t.kind === 'offer_increase');
  check('passAbsFailRel: candidateJump false', t.candidateJump === false);
  check('passAbsFailRel: reasons mention relative threshold', t.reasons.some(r => r.includes('relative increase')));
}

// 5. increase passes both
{
  const a = snap('c5', 1000, 1);
  const b = snap('c5', 2000, 1.2); // +20% rel, +0.2 SOL abs
  const t = computeOfferTransition(a, b);
  check('passBoth: kind offer_increase', t.kind === 'offer_increase');
  check('passBoth: candidateJump true', t.candidateJump === true);
  check('passBoth: absoluteDeltaSol ~0.2', Math.abs(t.absoluteDeltaSol! - 0.2) < 1e-9);
  check('passBoth: relativeDeltaPct ~0.2', Math.abs(t.relativeDeltaPct! - 0.2) < 1e-9);
}

// 6. decrease
{
  const a = snap('c6', 1000, 2);
  const b = snap('c6', 2000, 1.5);
  const t = computeOfferTransition(a, b);
  check('decrease: kind offer_decrease', t.kind === 'offer_decrease');
  check('decrease: candidateJump false', t.candidateJump === false);
  check('decrease: absoluteDeltaSol negative', t.absoluteDeltaSol! < 0);
}

// 7. removal
{
  const a = snap('c7', 1000, 2);
  const b = snap('c7', 2000, null);
  const t = computeOfferTransition(a, b);
  check('removal: kind offer_removed', t.kind === 'offer_removed');
  check('removal: currentBestSol null', t.currentBestSol === null);
}

// 8. equal within epsilon
{
  const a = snap('c8', 1000, 2);
  const b = snap('c8', 2000, 2 + 1e-9); // well under default epsilon 1e-6
  const t = computeOfferTransition(a, b);
  check('epsilon: kind unchanged', t.kind === 'unchanged');
}

// 9. best venue changes at same price
{
  const a = snap('c9', 1000, 2, 'MMM');
  const b = snap('c9', 2000, 2, 'TENSOR');
  const t = computeOfferTransition(a, b);
  check('venueChange: kind best_venue_changed', t.kind === 'best_venue_changed');
  check('venueChange: candidateJump false', t.candidateJump === false);
  check('venueChange: previousVenue MMM, currentVenue TENSOR', t.previousVenue === 'MMM' && t.currentVenue === 'TENSOR');
}

// 10. invalid/NaN/zero/negative values treated as unavailable
{
  check('invalid: zero amount -> null snapshot', buildVenueSnapshot('MMM', 0, 1000) === null);
  check('invalid: negative amount -> null snapshot', buildVenueSnapshot('MMM', -5, 1000) === null);
  check('invalid: NaN amount -> null snapshot', buildVenueSnapshot('MMM', NaN, 1000) === null);
  check('invalid: undefined amount -> null snapshot', buildVenueSnapshot('MMM', undefined, 1000) === null);
  const s = buildCollectionOfferSnapshot('c10', 1000, null, null, null);
  check('invalid: all-null venues -> best null', s.best === null);
}

// 11. relative delta from very small prior value
{
  const a = snap('c11', 1000, 0.0001);
  const b = snap('c11', 2000, 0.06); // +0.0599 SOL absolute (passes), huge relative %
  const t = computeOfferTransition(a, b);
  check('tinyPrior: relativeDeltaPct is finite (no Infinity/NaN)', Number.isFinite(t.relativeDeltaPct!));
  check('tinyPrior: candidateJump true (both thresholds genuinely pass)', t.candidateJump === true);
}

// ════════════════════════════════════════════════════════════════════════
// STATE MACHINE TESTS
// ════════════════════════════════════════════════════════════════════════

// 12. candidate confirmed after 2 observations
{
  let state = initialOfferHistoryState();
  const s1 = snap('sm12', 1000, 1);
  let r = stepOfferHistory(state, s1);
  state = r.nextState;
  check('confirm2: first_offer never confirms', r.confirmedJump === false);

  const s2 = snap('sm12', 2000, 1.2); // passes both thresholds — observation 1 of candidate
  r = stepOfferHistory(state, s2);
  state = r.nextState;
  check('confirm2: 1st qualifying increase does not confirm yet', r.confirmedJump === false && state.pendingCandidate?.confirmations === 1);

  const s3 = snap('sm12', 3000, 1.2); // same level again — observation 2
  r = stepOfferHistory(state, s3);
  check('confirm2: 2nd consecutive observation confirms', r.confirmedJump === true);
}

// 13. candidate reverts before confirmation
{
  let state = initialOfferHistoryState();
  state = stepOfferHistory(state, snap('sm13', 1000, 1)).nextState; // first_offer baseline
  let r = stepOfferHistory(state, snap('sm13', 2000, 1.2)); // candidate, confirmations=1
  state = r.nextState;
  check('revert: candidate pending after 1st observation', state.pendingCandidate?.confirmations === 1);
  r = stepOfferHistory(state, snap('sm13', 3000, 1.0)); // reverts back down
  check('revert: candidate discarded, not confirmed', r.confirmedJump === false && r.nextState.pendingCandidate === null);
}

// 14. confirmed jump does not refire every observation
{
  let state = initialOfferHistoryState();
  state = stepOfferHistory(state, snap('sm14', 1000, 1)).nextState;
  state = stepOfferHistory(state, snap('sm14', 2000, 1.2)).nextState;
  let r = stepOfferHistory(state, snap('sm14', 3000, 1.2));
  check('norefire: confirms once', r.confirmedJump === true);
  state = r.nextState;
  // Same level persists for several more observations — must not refire.
  for (let i = 0; i < 5; i++) {
    r = stepOfferHistory(state, snap('sm14', 4000 + i * 1000, 1.2));
    state = r.nextState;
    check(`norefire: observation ${i + 1} after confirmation does not refire`, r.confirmedJump === false);
  }
}

// 15. re-arm only after meaningful reset
{
  let state = initialOfferHistoryState();
  state = stepOfferHistory(state, snap('sm15', 1000, 1)).nextState;       // baseline 1
  state = stepOfferHistory(state, snap('sm15', 2000, 1.2)).nextState;     // candidate 1/2
  let r = stepOfferHistory(state, snap('sm15', 3000, 1.2));               // confirms (baseline for re-arm = 1)
  check('rearm: confirms', r.confirmedJump === true);
  state = r.nextState;
  check('rearm: disarmed after confirmation', state.armed === false);

  // Small dip, NOT a meaningful reset (still near 1.2, well above baseline 1 * 1.02)
  r = stepOfferHistory(state, snap('sm15', 4000, 1.15));
  state = r.nextState;
  check('rearm: still disarmed after a small dip', state.armed === false);
  // Even if it jumps again from here, must not confirm while disarmed.
  state = stepOfferHistory(state, snap('sm15', 5000, 1.4)).nextState;
  r = stepOfferHistory(state, snap('sm15', 6000, 1.4));
  check('rearm: no confirmation while still disarmed', r.confirmedJump === false);
  state = r.nextState;

  // Meaningful reset: drop back to baseline (1) or below.
  state = stepOfferHistory(state, snap('sm15', 7000, 1.0)).nextState;
  check('rearm: armed again after genuine reset to baseline', state.armed === true);

  // A fresh qualifying jump can now confirm again.
  state = stepOfferHistory(state, snap('sm15', 8000, 1.3)).nextState;
  r = stepOfferHistory(state, snap('sm15', 9000, 1.3));
  check('rearm: a new jump confirms after re-arm', r.confirmedJump === true);
}

// 16. venue rotation does not confirm jump
{
  let state = initialOfferHistoryState();
  state = stepOfferHistory(state, snap('sm16', 1000, 2, 'MMM')).nextState;
  let r = stepOfferHistory(state, snap('sm16', 2000, 2, 'TENSOR')); // same price, different venue
  check('venueRotation: transition is best_venue_changed', r.transition.kind === 'best_venue_changed');
  check('venueRotation: never confirms', r.confirmedJump === false);
  check('venueRotation: no pending candidate created', r.nextState.pendingCandidate === null);
}

// 17. process restart warm state does not emit false first_offer
// (Simulated: a state machine seeded with a non-null lastStableSnapshot,
// as if loaded from disk on boot, must not read the next real observation
// as first_offer just because THIS process never saw an earlier one.)
{
  const warmStartState: OfferHistoryState = {
    lastStableSnapshot: snap('sm17', 500, 3),
    pendingCandidate: null,
    armed: true,
    lastConfirmedJumpAtMs: null,
    preJumpBaselineSol: null,
  };
  const r = stepOfferHistory(warmStartState, snap('sm17', 1500, 3.05));
  check('warmStart: not first_offer despite this being the process\'s first observation', r.transition.kind !== 'first_offer');
}

// 18. malformed disk cache fails soft
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-history-test-'));
  const malformedFile = path.join(tmpDir, 'malformed.json');
  fs.writeFileSync(malformedFile, '{ this is not valid JSON !!!', 'utf8');
  const result = loadOfferHistoryStateFile(malformedFile);
  check('malformedDisk: fails soft, empty entries', result.entries.length === 0);
  check('malformedDisk: malformed flag set', result.malformed === true);

  const missingFile = path.join(tmpDir, 'does-not-exist.json');
  const result2 = loadOfferHistoryStateFile(missingFile);
  check('missingDisk: fails soft (first boot), malformed NOT set', result2.entries.length === 0 && result2.malformed === false);

  // Stale-pruning: one fresh, one stale entry.
  const now = Date.now();
  const goodFile = path.join(tmpDir, 'good.json');
  const freshState: OfferHistoryState = { lastStableSnapshot: snap('fresh', now, 1), pendingCandidate: null, armed: true, lastConfirmedJumpAtMs: null, preJumpBaselineSol: null };
  const staleState: OfferHistoryState = { lastStableSnapshot: snap('stale', now - 8 * 24 * 60 * 60 * 1000, 1), pendingCandidate: null, armed: true, lastConfirmedJumpAtMs: null, preJumpBaselineSol: null };
  fs.writeFileSync(goodFile, JSON.stringify([['fresh', freshState], ['stale', staleState]]), 'utf8');
  const result3 = loadOfferHistoryStateFile(goodFile, now);
  check('stalePruning: fresh entry kept, stale entry dropped', result3.entries.length === 1 && result3.entries[0][0] === 'fresh');
  check('stalePruning: skippedStale count is 1', result3.skippedStale === 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 19. max-key eviction works
{
  const prefix = `__TEST_EVICT_${Date.now()}_`;
  const blank: OfferHistoryState = initialOfferHistoryState();
  for (let i = 0; i < MAX_COLLECTION_KEYS + 5; i++) {
    setOfferHistoryState(`${prefix}${i}`, { ...blank, lastConfirmedJumpAtMs: i });
  }
  check('eviction: earliest keys evicted', getOfferHistoryState(`${prefix}0`) === null);
  check('eviction: most recent key retained', getOfferHistoryState(`${prefix}${MAX_COLLECTION_KEYS + 4}`) !== null);
}

// 20. input order / source object order does not affect result
{
  const a = buildVenueSnapshot('ME_COLLECTION', 1, 1000);
  const b = buildVenueSnapshot('MMM', 2, 1000);
  const c = buildVenueSnapshot('TENSOR', 1.5, 1000);
  const s1 = buildCollectionOfferSnapshot('order', 1000, a, b, c);
  // Same inputs, constructed via differently-ordered intermediate steps —
  // buildCollectionOfferSnapshot takes fixed named params (not an object a
  // caller could reorder), so this asserts the function itself is
  // order-independent regardless of which venue happens to be null/present.
  const s2 = buildCollectionOfferSnapshot('order', 1000, a, b, c);
  check('orderIndependence: identical result on repeated identical calls', JSON.stringify(s1) === JSON.stringify(s2));
  check('orderIndependence: best is MMM (highest amount) regardless of param position', s1.best?.venue === 'MMM');
}

// ════════════════════════════════════════════════════════════════════════
// STAGE 4.5 — normalized best-bid integration (usableForValueSignal gate)
// ════════════════════════════════════════════════════════════════════════

// 21. An underfunded/ineligible MMM quote (usableForValueSignal explicitly
// false) can never win `best`, even though its raw amount is far higher
// than every other venue — this is exactly the mad_lads/okay_bears failure
// mode Stage 4.5 fixes (57.67 SOL phantom MMM "bid" vs a real 8 SOL Tensor
// quote must select Tensor, not the phantom MMM number).
{
  const mmmPhantom = buildVenueSnapshot('MMM', 57.67, 1000, { usableForValueSignal: false, funding: 'insufficient', eligibility: 'collection_wide' });
  const tensorReal  = buildVenueSnapshot('TENSOR', 8, 1000, { usableForValueSignal: false, funding: 'reported', eligibility: 'unknown' });
  const s = buildCollectionOfferSnapshot('phantom1', 1000, null, mmmPhantom, tensorReal);
  check('phantomMmm: best is TENSOR, not the higher phantom MMM amount', s.best?.venue === 'TENSOR' && s.best?.amountSol === 8);
}

// 22. A genuinely funded + collection-wide MMM quote CAN win best, including
// over a lower Tensor number.
{
  const mmmFunded = buildVenueSnapshot('MMM', 5, 1000, { usableForValueSignal: true, funding: 'verified', eligibility: 'collection_wide' });
  const tensorLow  = buildVenueSnapshot('TENSOR', 3, 1000, { usableForValueSignal: false, funding: 'reported', eligibility: 'unknown' });
  const s = buildCollectionOfferSnapshot('funded1', 1000, null, mmmFunded, tensorLow);
  check('fundedMmm: best is MMM when usable and higher', s.best?.venue === 'MMM' && s.best?.amountSol === 5);
}

// 23. Tensor-only snapshot (no MMM liquidity at all) remains valid market
// context and can still be `best` — Tensor is never gated the way MMM is.
{
  const tensorOnly = buildVenueSnapshot('TENSOR', 2.5, 1000, { usableForValueSignal: false, funding: 'reported', eligibility: 'unknown' });
  const s = buildCollectionOfferSnapshot('tensorOnly', 1000, null, null, tensorOnly);
  check('tensorOnly: best is TENSOR', s.best?.venue === 'TENSOR' && s.best?.amountSol === 2.5);
}

// 24. Removal of a phantom (never-usable) MMM quote must not emit a false
// offer jump / offer_removed transition, because it never contributed to
// `best` in the first place — `best` doesn't change at all across the
// "removal".
{
  const mmmPhantom = buildVenueSnapshot('MMM', 57.67, 1000, { usableForValueSignal: false, funding: 'insufficient', eligibility: 'collection_wide' });
  const tensorReal  = buildVenueSnapshot('TENSOR', 8, 1000, { usableForValueSignal: false, funding: 'reported', eligibility: 'unknown' });
  const before = buildCollectionOfferSnapshot('phantomGone', 1000, null, mmmPhantom, tensorReal);

  const tensorReal2 = buildVenueSnapshot('TENSOR', 8, 2000, { usableForValueSignal: false, funding: 'reported', eligibility: 'unknown' });
  const after  = buildCollectionOfferSnapshot('phantomGone', 2000, null, null, tensorReal2); // MMM pool vanished entirely

  const t = computeOfferTransition(before, after);
  check('phantomRemoval: best unchanged (8 SOL both times)', before.best?.amountSol === 8 && after.best?.amountSol === 8);
  check('phantomRemoval: transition is NOT offer_removed', t.kind !== 'offer_removed');
  check('phantomRemoval: transition is unchanged', t.kind === 'unchanged');
}

// 25. Restart/disk-state round trip still works with the new optional
// venue-snapshot fields present (eligibility/funding/usableForValueSignal
// survive a JSON serialize/parse cycle same as any other field).
{
  const mmmFunded = buildVenueSnapshot('MMM', 5, 1000, { usableForValueSignal: true, funding: 'verified', eligibility: 'collection_wide', poolAddress: 'Pool123' });
  const snap25 = buildCollectionOfferSnapshot('restart25', 1000, null, mmmFunded, null);
  const state: OfferHistoryState = { lastStableSnapshot: snap25, pendingCandidate: null, armed: true, lastConfirmedJumpAtMs: null, preJumpBaselineSol: null };
  const roundTripped = JSON.parse(JSON.stringify(state)) as OfferHistoryState;
  check('restart: usableForValueSignal survives round trip', roundTripped.lastStableSnapshot?.venues.mmm?.usableForValueSignal === true);
  check('restart: eligibility survives round trip', roundTripped.lastStableSnapshot?.venues.mmm?.eligibility === 'collection_wide');
  const r = stepOfferHistory(state, buildCollectionOfferSnapshot('restart25', 2000, null, mmmFunded, null));
  check('restart: warm state step does not read as first_offer', r.transition.kind !== 'first_offer');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
