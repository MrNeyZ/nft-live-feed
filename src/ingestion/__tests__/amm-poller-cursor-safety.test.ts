/**
 * Regression: amm-poller.ts persisted cursor must only advance through a
 * signature once its ingestion reached a TERMINAL SAFE outcome — never
 * merely because work was dispatched.
 *
 * Root cause (2026-08-05 /feed audit): `sweepTarget` used to fire
 * `target.ingest(sig)` fire-and-forget, then unconditionally advance the
 * persisted `poller_state` cursor to `page[0].signature` in the SAME tick
 * — with zero dependency on whether any ingest call had resolved. A crash
 * or a genuine retryable failure (RPC timeout, DB error) in that window
 * meant the cursor had already moved past a signature nobody durably
 * processed, and amm-poller (the gap-healer / backstop over the live WS
 * listener) never revisits a signature once its cursor has passed it.
 *
 * Fix: `target.ingest` now returns an explicit `IngestOutcome`
 * ('inserted' | 'duplicate' | 'confirmed_irrelevant' | 'retryable_error').
 * The fresh-path dispatch loop AWAITS these (bounded concurrency), and
 * `safeAdvanceSigFromPage` computes how far the cursor may safely advance:
 * `page` is newest-first (index 0 = newest — provable from its own usage,
 * see the function's doc comment), so "advance through the contiguous
 * completed prefix" in timeline terms means walking from the OLDEST entry
 * (highest index) toward the newest (index 0), stopping at the first
 * outcome that is either unresolved (still in flight / never dispatched
 * this sweep) or `retryable_error`.
 *
 * This test exercises `safeAdvanceSigFromPage` directly — the pure
 * algorithm — with synthetic pages, which is both the fastest and the
 * most precise way to verify cursor-safety logic without mocking the DB
 * (`poller_state`) or RPC layers the rest of `sweepTarget` depends on.
 *
 * Run: npm run test:amm-poller-cursor-safety
 */
import { __testHooks, SigInfo } from '../amm-poller';
import { IngestOutcome } from '../ingest-outcome';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

// Builds a synthetic newest-first page: sig0 is newest, sigN-1 is oldest —
// matches getSignaturesForAddress's real ordering (see amm-poller.ts's
// own fetchSinceCursor / page[0]-as-`until` usage).
function page(n: number): SigInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    signature: `sig${i}`, err: null, confirmationStatus: 'confirmed',
  }));
}

async function main(): Promise<void> {
  const { safeAdvanceSigFromPage, rememberOutcome, getRememberedOutcome, signatureOutcomeCacheSize, runBounded } = __testHooks;

  // ── 1. All terminal-safe → full advance to the newest (page[0]) ────────
  {
    const p = page(3); // sig0 (newest) .. sig2 (oldest)
    const outcomes: (IngestOutcome | undefined)[] = ['inserted', 'duplicate', 'confirmed_irrelevant'];
    const safe = safeAdvanceSigFromPage(p, outcomes);
    check('1. fully-safe batch advances to the newest signature (page[0])', safe === 'sig0', `safe=${safe}`);
  }

  // ── 2. Cursor stops at the first retryable failure in a mixed batch ────
  // sig2 (oldest) safe, sig1 (middle) retryable, sig0 (newest) safe.
  // Walking oldest→newest: sig2 ok → candidate=sig2; sig1 retryable → STOP.
  // sig0 must NOT be reachable even though it individually succeeded —
  // it's newer than the still-unresolved sig1, so the cursor (a single
  // "everything newer than X is done" value) cannot skip past sig1.
  {
    const p = page(3);
    const outcomes: (IngestOutcome | undefined)[] = ['inserted', 'retryable_error', 'confirmed_irrelevant'];
    const safe = safeAdvanceSigFromPage(p, outcomes);
    check(
      '2. cursor stops at the first retryable failure (oldest→newest), even though a NEWER item in the same batch already succeeded',
      safe === 'sig2',
      `safe=${safe} (expected sig2 — sig1 retryable blocks sig0 from ever being reachable this sweep)`,
    );
  }

  // ── 3. Cursor not advanced past a dispatched-but-unfinished ingestion ──
  // sig1 (middle) is `undefined` — dispatched but not yet resolved (or
  // never dispatched this sweep, e.g. a backlog item). Same "stop at the
  // gap" behaviour as a retryable error — unresolved is NOT terminal-safe.
  {
    const p = page(3);
    const outcomes: (IngestOutcome | undefined)[] = ['inserted', undefined, 'inserted'];
    const safe = safeAdvanceSigFromPage(p, outcomes);
    check(
      '3. an unresolved (undefined) outcome blocks the cursor exactly like a retryable failure',
      safe === 'sig2',
      `safe=${safe}`,
    );
  }

  // ── 4. Nothing safe at all → null (cursor must not move this sweep) ────
  {
    const p = page(3);
    const outcomes: (IngestOutcome | undefined)[] = ['inserted', 'inserted', 'retryable_error'];
    const safe = safeAdvanceSigFromPage(p, outcomes);
    check(
      '4. oldest entry itself unresolved/retryable → null, cursor stays exactly where it was',
      safe === null,
      `safe=${safe}`,
    );
  }

  // ── 5. Restart/replay after a failure cannot lose the signature ────────
  // Simulates: sweep 1 sees [sig0 ok, sig1 RETRYABLE] → cursor doesn't
  // advance past sig1 (per check #2/#4 logic) → "restart" happens → sweep
  // 2 re-fetches the SAME window (since `until` never moved past sig1) →
  // sig1 is present again and gets a real chance to resolve. This is the
  // structural guarantee: as long as safeAdvanceSigFromPage never returns
  // a signature that skips over an unresolved/retryable one, a crash or a
  // transient failure can only ever DELAY the cursor, never skip data.
  {
    const p = page(2); // sig0 newest, sig1 oldest
    const sweep1Outcomes: (IngestOutcome | undefined)[] = ['inserted', 'retryable_error'];
    const sweep1Safe = safeAdvanceSigFromPage(p, sweep1Outcomes);
    check('5a. sweep 1: retryable oldest entry → no advance at all', sweep1Safe === null, `safe=${sweep1Safe}`);
    // "Restart" — cursor unchanged, sig1 is refetched and now succeeds.
    const sweep2Outcomes: (IngestOutcome | undefined)[] = ['inserted', 'inserted'];
    const sweep2Safe = safeAdvanceSigFromPage(p, sweep2Outcomes);
    check('5b. sweep 2 (after "restart"): sig1 now resolved → full advance, signature not lost', sweep2Safe === 'sig0', `safe=${sweep2Safe}`);
  }

  // ── 6. Empty page → null (no crash, nothing to advance) ────────────────
  {
    const safe = safeAdvanceSigFromPage([], []);
    check('6. empty page returns null, not a crash', safe === null, `safe=${safe}`);
  }

  // ── 7. Cross-sweep outcome memory: bounded FIFO, remembers real outcomes ──
  {
    const sig = 'MemoryProbeSig1111111111111111111111111111111111111111111';
    check('7a. unremembered sig has no cached outcome', getRememberedOutcome(sig) === undefined, `outcome=${getRememberedOutcome(sig)}`);
    rememberOutcome(sig, 'confirmed_irrelevant');
    check('7b. remembered outcome is retrievable', getRememberedOutcome(sig) === 'confirmed_irrelevant', `outcome=${getRememberedOutcome(sig)}`);
    const sizeBefore = signatureOutcomeCacheSize();
    check('7c. cache size is a small bounded number, not unbounded', sizeBefore > 0 && sizeBefore < 1_000_000, `size=${sizeBefore}`);
  }

  // ── 8. runBounded — bounded concurrency, all items processed ───────────
  {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    let maxConcurrent = 0, current = 0;
    await runBounded(items, 4, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise<void>((r) => setTimeout(r, 1));
      seen.push(n);
      current--;
    });
    check('8a. runBounded processes every item exactly once', seen.length === items.length && new Set(seen).size === items.length, `seen=${seen.length}`);
    check('8b. runBounded respects the concurrency cap', maxConcurrent <= 4, `maxConcurrent=${maxConcurrent}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
