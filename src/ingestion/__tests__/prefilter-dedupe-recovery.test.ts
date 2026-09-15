/**
 * Regression: Tensor / Orbis / ME v2 WS log-prefilter skips must not
 * poison the shared cross-pipeline fetch dedup (`recentByScope` /
 * `wasRecentlyFetched` in me-raw/ingest.ts).
 *
 * Root cause (2026-08-05 /feed audit): the three prefilter-skip blocks in
 * listener.ts (Tensor `hasTensorSaleInstruction`, Orbis
 * `hasOrbisSaleInstruction`, ME v2 `shouldSkipMeV2Logs`) called
 * `markSigFetched(sig)` on a mere log-name GUESS, not a real fetch. That
 * poisoned the 3-min dedup TTL even though no `getTransaction` was ever
 * attempted — permanently blocking the poller's/listener's own recovery
 * pass for that exact signature if the guess was wrong (truncated logs,
 * an unrecognized ix variant, a sale ix only visible as an inner CPI).
 * The MMM sales_only skip block already avoided this (see its "IMPORTANT:
 * do NOT markSigFetched" comment) — the fix makes Tensor/Orbis/ME v2
 * consistent with it: they now only call `markSeen` (listener-local,
 * harmless) and leave `markSigFetched` to the AUTHORITATIVE call sites
 * inside me-raw / tensor-raw / orbis-raw ingest.ts (a real fetch/insert
 * decision).
 *
 * This test verifies both halves of the fix:
 *   1. Statically: the three listener.ts skip blocks no longer contain a
 *      `markSigFetched(` call (source-level regression guard — cheap and
 *      exact, since the whole bug was "a call site that shouldn't be
 *      there").
 *   2. Behaviourally: exercises the real dedup primitives
 *      (`markSigFetched` / `wasRecentlyFetched`) from me-raw/ingest.ts to
 *      prove the underlying contract — a signature nobody has called
 *      `markSigFetched` on is NOT dedup-blocked, i.e. "a later
 *      listener/poller recovery path can still fetch and ingest it".
 *
 * Run: npm run test:prefilter-dedupe-recovery
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { markSigFetched, wasRecentlyFetched } from '../me-raw/ingest';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

function main(): void {
  // ── 1. Static regression guard on listener.ts ──────────────────────────
  const listenerSrc = readFileSync(join(__dirname, '../listener.ts'), 'utf8');

  const blocks: { label: string; anchor: string }[] = [
    { label: 'Tensor',  anchor: 'TENSOR_PREFILTER_TARGETS.has(target.name) && !hasTensorSaleInstruction(value.logs)' },
    { label: 'Orbis',   anchor: 'ORBIS_PREFILTER_TARGETS.has(target.name) && !hasOrbisSaleInstruction(value.logs)' },
    { label: 'ME v2',   anchor: "target.name === 'me_v2' && shouldSkipMeV2Logs(value.logs)" },
  ];

  for (const { label, anchor } of blocks) {
    const anchorIdx = listenerSrc.indexOf(anchor);
    check(`1. ${label} prefilter block exists in listener.ts`, anchorIdx !== -1, `anchor found at index ${anchorIdx}`);
    if (anchorIdx === -1) continue;
    // Slice from the anchor to the next `return;` (the block's own exit) —
    // that's the exact skip-branch body the fix touched.
    const bodyEnd = listenerSrc.indexOf('return;', anchorIdx);
    const body = listenerSrc.slice(anchorIdx, bodyEnd);
    check(
      `1. ${label} skip block does NOT call markSigFetched`,
      !body.includes('markSigFetched('),
      body.includes('markSigFetched(') ? 'FOUND — dedupe-poisoning regression' : 'absent, as expected',
    );
    check(
      `1. ${label} skip block still calls markSeen (listener-local, harmless)`,
      body.includes('markSeen('),
      body.includes('markSeen(') ? 'present' : 'MISSING — listener poll loop would re-dispatch',
    );
  }

  // Sanity: the MMM sales_only block (the reference pattern) also has no
  // markSigFetched — confirms the anchor-slicing approach above is sound
  // by cross-checking against the known-good block.
  const mmmAnchor = "target.name === 'mmm' && shouldSkipMmmLogsSalesOnly(value.logs)";
  const mmmIdx = listenerSrc.indexOf(mmmAnchor);
  check('1. MMM reference block found', mmmIdx !== -1, `index=${mmmIdx}`);
  if (mmmIdx !== -1) {
    const mmmBody = listenerSrc.slice(mmmIdx, listenerSrc.indexOf('return;', mmmIdx));
    check('1. MMM reference block also has no markSigFetched (sanity check)', !mmmBody.includes('markSigFetched('), 'confirmed');
  }

  // Authoritative call sites must still exist — this fix removes the
  // PREMATURE calls, not the mechanism itself.
  const tensorSrc = readFileSync(join(__dirname, '../tensor-raw/ingest.ts'), 'utf8');
  const orbisSrc  = readFileSync(join(__dirname, '../orbis-raw/ingest.ts'), 'utf8');
  const meSrc     = readFileSync(join(__dirname, '../me-raw/ingest.ts'), 'utf8');
  check('1. tensor-raw/ingest.ts still marks fetched on a real decision', tensorSrc.includes('markSigFetched('), 'authoritative call site present');
  check('1. orbis-raw/ingest.ts still marks fetched on a real decision', orbisSrc.includes('markSigFetched('), 'authoritative call site present');
  check('1. me-raw/ingest.ts still marks fetched on a real decision', meSrc.includes('markSigFetched(sig, \'sale\')'), 'authoritative call site present');

  // ── 2. Behavioural: the dedup primitive itself ──────────────────────────
  const untouchedSig = 'PrefilterSkipNoMarkTestSig11111111111111111111111111111111';
  check(
    '2. a signature nobody marked is NOT dedup-blocked (recovery path stays open)',
    wasRecentlyFetched(untouchedSig, 'sale') === false,
    `wasRecentlyFetched=${wasRecentlyFetched(untouchedSig, 'sale')}`,
  );

  const markedSig = 'PrefilterAuthoritativeMarkTestSig1111111111111111111111111';
  markSigFetched(markedSig, 'sale');
  check(
    '2. markSigFetched (authoritative call) DOES set the dedup TTL',
    wasRecentlyFetched(markedSig, 'sale') === true,
    `wasRecentlyFetched=${wasRecentlyFetched(markedSig, 'sale')}`,
  );

  // Scope isolation: a 'sale' mark must not leak into 'mint' scope dedupe.
  check(
    "2. a 'sale' mark does not block the same sig in 'mint' scope",
    wasRecentlyFetched(markedSig, 'mint') === false,
    `wasRecentlyFetched(mint)=${wasRecentlyFetched(markedSig, 'mint')}`,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
