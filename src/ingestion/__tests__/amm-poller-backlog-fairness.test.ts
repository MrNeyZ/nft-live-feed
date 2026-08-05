/**
 * Regression: MMM (and any high-volume target)'s backlog must not starve
 * under sustained traffic, while the cursor-safety guarantee from
 * `amm-poller-cursor-safety.test.ts` still holds.
 *
 * Root cause (2026-08-05 backlog-fairness audit, follow-up to the cursor-
 * safety fix in the same file): the FIRST version of the cursor-safety fix
 * gave every sweep's newest `BASE_SYNC_BUDGET` slots to fresh dispatch
 * unconditionally, and pushed the rest into a plain queue drained
 * separately with no priority relative to fresh. Under sustained high
 * volume (arrivals > budget every sweep — the everyday case for
 * `poll:mmm`), the backlog's OLDEST items never got scheduling priority.
 * Since the persisted cursor can only advance through a contiguous safe
 * run starting at the OLDEST pending item, this meant the cursor
 * effectively froze indefinitely under real traffic (confirmed live:
 * `poll:mmm`'s cursor advanced once then sat frozen for 2+ minutes while
 * sales kept landing) — loss-safe, but durability-weakening (an
 * ever-growing gap between the persisted cursor and real time is an
 * ever-growing crash-recovery blind spot).
 *
 * Fix: backlog draining is now integrated into each sweep's own
 * synchronous dispatch, with a GUARANTEED minimum reserve share for the
 * OLDEST backlog items, escalating toward the full per-sweep budget as
 * backlog depth/age cross thresholds (see `backlogReserveShare` /
 * `syncBudgetForSweep` in amm-poller.ts). A retryable failure gets
 * re-queued (age-preserving, not reset) for guaranteed retry instead of
 * silently relying on unrelated FIFO eviction.
 *
 * This test drives the REAL exported scheduling primitives
 * (`backlogFor`, `syncBudgetForSweep`, `backlogReserveShare`,
 * `requeueOldestFirst`, `rememberOutcome`, `safeAdvanceSigFromPage`) through
 * many simulated sweeps with a synthetic (network-free) ingest outcome
 * source, at a sustained arrival rate that exceeds the base per-sweep
 * budget — the exact regime that starved before this fix.
 *
 * Run: npm run test:amm-poller-backlog-fairness
 */
import { __testHooks } from '../amm-poller';
import { IngestOutcome } from '../ingest-outcome';

const {
  safeAdvanceSigFromPage, rememberOutcome, getRememberedOutcome,
  backlogFor, totalBacklogSize, requeueOldestFirst, backlogReserveShare, syncBudgetForSweep,
  clearBacklogForTest, baseSyncBudgetForTarget, signatureOutcomeMax,
} = __testHooks;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

const WINDOW_CAP = 40;   // mirrors PAGE_SIZE(20) x MAX_PAGES_BY_TARGET['poll:mmm'](2)

interface SimSig { signature: string; enqueuedAt: number; err: null; confirmationStatus: 'confirmed' }
type SimBacklogItem = { sig: string; enqueuedAt: number; ingest: never; target: string };
function simItem(sig: string, enqueuedAt: number, target: string): SimBacklogItem {
  return { sig, enqueuedAt, ingest: (async () => 'inserted') as never, target };
}

/** One simulated sweep against the REAL exported scheduling primitives for
 *  `target`. `arrivalCount` new signatures "arrive" (appended to the tail
 *  of `chain`, mirroring real chain ordering); `outcomeFor` decides the
 *  synthetic ingest result per signature — network-free, this occupies
 *  exactly the seam `target.ingest` fills in the real sweepTarget. */
function runSweep(
  target: string,
  chain: SimSig[],
  now: number,
  arrivalCount: number,
  outcomeFor: (sig: string) => IngestOutcome,
): { freshDispatched: number; backlogDispatched: number; backlogEnqueued: number; safeAdvancedTo: string | null } {
  const backlogQueue = backlogFor(target);

  for (let i = 0; i < arrivalCount; i++) {
    chain.push({ signature: `${target}-${chain.length}-${now}-${i}`, enqueuedAt: now, err: null, confirmationStatus: 'confirmed' });
  }

  const backlogDepthBefore = backlogQueue.length;
  const oldestAgeMsBefore  = backlogDepthBefore > 0 ? now - backlogQueue[0].enqueuedAt : 0;

  // The "page" this sweep would fetch: newest WINDOW_CAP of the unresolved
  // tail (everything from the last confirmed-safe point onward), newest-first.
  const unresolvedTail = chain.filter(s => getRememberedOutcome(s.signature) === undefined);
  const pageOldestFirst = unresolvedTail.slice(-WINDOW_CAP);
  const page = [...pageOldestFirst].reverse(); // newest-first, matches real `page` ordering

  const totalBudget   = syncBudgetForSweep(target, backlogDepthBefore, oldestAgeMsBefore, page.length);
  const reserveShare  = backlogReserveShare(backlogDepthBefore, oldestAgeMsBefore);
  const backlogBudget = Math.min(backlogDepthBefore, Math.round(totalBudget * reserveShare));
  const freshBudgetCap = Math.max(0, totalBudget - backlogBudget);

  const inBacklog = new Set(backlogQueue.map(b => b.sig));
  const newThisSweep = pageOldestFirst.filter(s => !inBacklog.has(s.signature)).reverse(); // newest-first

  const freshNow = newThisSweep.slice(0, freshBudgetCap);
  const freshOverflow = newThisSweep.slice(freshBudgetCap);
  for (let i = freshOverflow.length - 1; i >= 0; i--) {
    backlogQueue.push(simItem(freshOverflow[i].signature, now, target));
  }

  const backlogNow: SimBacklogItem[] = [];
  for (let i = 0; i < backlogBudget; i++) {
    const item = backlogQueue.shift();
    if (!item) break;
    backlogNow.push(item as SimBacklogItem);
  }

  const outcomes: (IngestOutcome | undefined)[] = new Array(page.length);
  const idxBySig = new Map<string, number>();
  for (let i = 0; i < page.length; i++) idxBySig.set(page[i].signature, i);
  for (const s of pageOldestFirst) {
    const remembered = getRememberedOutcome(s.signature);
    const idx = idxBySig.get(s.signature);
    if (idx !== undefined && remembered !== undefined) outcomes[idx] = remembered;
  }

  const dispatched: { sig: string; enqueuedAt: number }[] =
    [...backlogNow, ...freshNow.map(f => ({ sig: f.signature, enqueuedAt: now }))];
  for (const { sig, enqueuedAt } of dispatched) {
    const outcome = outcomeFor(sig);
    rememberOutcome(sig, outcome);
    const idx = idxBySig.get(sig);
    if (idx !== undefined) outcomes[idx] = outcome;
    if (outcome === 'retryable_error') {
      requeueOldestFirst(backlogQueue, simItem(sig, enqueuedAt, target));
    }
  }

  const safeAdvancedTo = safeAdvanceSigFromPage(page as never, outcomes);
  return {
    freshDispatched: freshNow.length,
    backlogDispatched: backlogNow.length,
    backlogEnqueued: freshOverflow.length,
    safeAdvancedTo,
  };
}

function main(): void {
  // ── 1. Sustained high traffic: arrivals exceed the base budget every sweep ──
  {
    const target = 'poll:sim-sustained';
    clearBacklogForTest(target);
    const base = baseSyncBudgetForTarget(target);
    const ARRIVAL_PER_SWEEP = 30; // mirrors the observed live poll:mmm burst (fetched=40, ~30 overflow)
    const SWEEPS = 40;
    const chain: SimSig[] = [];
    let now = Date.now();
    const depthHistory: number[] = [];
    const advanceHistory: (string | null)[] = [];
    let freshEverySweep = true;

    for (let s = 0; s < SWEEPS; s++) {
      now += 10_000; // 10s sweep cadence, matches AMM_POLLER_INTERVAL_MS
      const result = runSweep(target, chain, now, ARRIVAL_PER_SWEEP, () => 'inserted'); // all succeed — steady-state throughput test
      if (result.freshDispatched === 0) freshEverySweep = false;
      depthHistory.push(totalBacklogSize());
      advanceHistory.push(result.safeAdvancedTo);
    }

    check(
      '1a. fresh sales continue to be processed every sweep (low latency preserved)',
      freshEverySweep,
      `base_budget=${base}  all sweeps had freshDispatched > 0: ${freshEverySweep}`,
    );

    const advancedSweeps = advanceHistory.filter(a => a !== null).length;
    check(
      '1b. cursor advances repeatedly, not frozen after the first sweep',
      advancedSweeps >= SWEEPS * 0.5,
      `advanced on ${advancedSweeps}/${SWEEPS} sweeps`,
    );

    const firstHalfAvg  = depthHistory.slice(0, SWEEPS / 2).reduce((a, b) => a + b, 0) / (SWEEPS / 2);
    const secondHalfAvg = depthHistory.slice(SWEEPS / 2).reduce((a, b) => a + b, 0) / (SWEEPS / 2);
    check(
      '1c. backlog depth stabilizes/converges rather than growing unbounded (second-half avg <= first-half avg + one sweep of slack)',
      secondHalfAvg <= firstHalfAvg + ARRIVAL_PER_SWEEP,
      `firstHalfAvg=${firstHalfAvg.toFixed(1)} secondHalfAvg=${secondHalfAvg.toFixed(1)} depthHistory=[${depthHistory.join(',')}]`,
    );
  }

  // ── 2. No cursor crosses an unresolved gap, even under a persistent
  //      retryable-failure rate ──
  {
    const target = 'poll:sim-retry';
    clearBacklogForTest(target);
    const chain: SimSig[] = [];
    let now = Date.now();
    let counter = 0;
    const outcomeFor = (): IngestOutcome => {
      counter++;
      return counter % 5 === 0 ? 'retryable_error' : 'inserted'; // ~20% persistent failure rate
    };
    let lastAdvance: string | null = null;
    let advanceCount = 0;
    for (let s = 0; s < 30; s++) {
      now += 10_000;
      const r = runSweep(target, chain, now, 15, outcomeFor);
      if (r.safeAdvancedTo) { lastAdvance = r.safeAdvancedTo; advanceCount++; }
    }
    check('2a. cursor advanced at least once despite ~20% retryable failure rate', lastAdvance !== null, `lastAdvance=${lastAdvance}`);
    check('2b. cursor advanced on multiple sweeps (retries converge, not permanently stuck)', advanceCount >= 5, `advanceCount=${advanceCount}/30`);
  }

  // ── 3. requeueOldestFirst keeps the queue sorted oldest-first (by
  //      preserved age, not by requeue time) ──
  {
    const target = 'poll:sim-order';
    clearBacklogForTest(target);
    const q = backlogFor(target);
    const t0 = 1000;
    q.push(simItem('a', t0, target));
    q.push(simItem('b', t0 + 100, target));
    q.push(simItem('c', t0 + 200, target));
    // 'a' gets dispatched (shifted out, as the real reserve-dispatch loop
    // does) and fails — requeued preserving its ORIGINAL (oldest)
    // enqueuedAt. Must land back at the front, not the back, of the queue.
    const shiftedA = q.shift()!;
    requeueOldestFirst(q, shiftedA);
    check('3a. a retried item with the OLDEST original enqueuedAt returns to the FRONT of the queue', q[0].sig === 'a', `queue=[${q.map(i => i.sig).join(',')}]`);
    // A retry with a NEWER enqueuedAt than everything else lands at the back.
    requeueOldestFirst(q, simItem('d', t0 + 300, target));
    check('3b. a retry with the NEWEST enqueuedAt lands at the back', q[q.length - 1].sig === 'd', `queue=[${q.map(i => i.sig).join(',')}]`);
  }

  // ── 4. Bounded outcome-cache eviction cannot cause an UNSAFE advance ──
  {
    const probe = 'EvictionProbeSig1111111111111111111111111111111111111111';
    rememberOutcome(probe, 'inserted');
    check('4a. probe outcome is recorded before eviction pressure', getRememberedOutcome(probe) === 'inserted', 'sanity');
    for (let i = 0; i < signatureOutcomeMax + 500; i++) {
      rememberOutcome(`evict-filler-${i}`, 'inserted');
    }
    const stillThere = getRememberedOutcome(probe) !== undefined;
    // Whether or not THIS specific probe survived (FIFO order-dependent),
    // the invariant under test is the SAFETY property: if it WAS evicted,
    // a page walk treats it as unresolved (blocks), never as falsely safe.
    const outcomes: (IngestOutcome | undefined)[] = [getRememberedOutcome(probe)];
    const page = [{ signature: probe, err: null, confirmationStatus: 'confirmed' }];
    const safe = safeAdvanceSigFromPage(page as never, outcomes);
    if (stillThere) {
      check('4b. probe survived eviction pressure (not evicted this run) — still resolves safe', safe === probe, `safe=${safe}`);
    } else {
      check('4b. probe WAS evicted — walk correctly treats it as unresolved, NOT falsely safe', safe === null, `safe=${safe} (outcome after eviction=${getRememberedOutcome(probe)})`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
