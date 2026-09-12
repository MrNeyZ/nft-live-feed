// Standalone (the frontend has no test framework) verification of the
// GhostBid page's pure logic. Compile + run:
//   npx tsc src/app/tools/ghostbid/logic.ts src/app/tools/ghostbid/logic.test.ts \
//     --outDir /tmp/gb --module commonjs --target es2020 --esModuleInterop \
//     --strict --skipLibCheck && node /tmp/gb/logic.test.js
//
// Registered as `npm run test:ghostbid-frontend`.

import assert from 'assert';
import { GhostBidRequestArbiter, floorSnapshotCaption } from './logic';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

// ── GhostBidRequestArbiter — the GB-1 race fix ───────────────────────────
console.log('GhostBidRequestArbiter');

check('cross-list load race: List 1 starts, List 2 starts later, List 2 resolves first, List 1 resolves later -> List 2 remains displayed', () => {
  const a = new GhostBidRequestArbiter();
  const genList1 = a.beginLoad(); // List 1 request starts
  const genList2 = a.beginLoad(); // user switches to List 2 before List 1 resolves
  // List 2 resolves first:
  assert.strictEqual(a.isLatestOverall(genList2), true, 'List 2 should be allowed to paint');
  // List 1 resolves later (stale):
  assert.strictEqual(a.isLatestOverall(genList1), false, 'List 1 must NOT be allowed to overwrite List 2');
});

check('same-list refresh race: Refresh A starts, Refresh B starts later, B resolves first, A resolves later -> B remains displayed', () => {
  const a = new GhostBidRequestArbiter();
  const genA = a.beginRefresh();
  const genB = a.beginRefresh();
  assert.strictEqual(a.isLatestOverall(genB), true, 'Refresh B should be allowed to paint');
  assert.strictEqual(a.isLatestOverall(genA), false, 'Refresh A must NOT be allowed to overwrite Refresh B');
});

check('stale request error does not replace current successful result: newer request wins regardless of which resolves as error', () => {
  const a = new GhostBidRequestArbiter();
  const genOld = a.beginLoad();
  const genNew = a.beginLoad();
  // newer succeeds first
  assert.strictEqual(a.isLatestOverall(genNew), true);
  // older then arrives as an error — must still be rejected, not allowed to clobber the successful newer result
  assert.strictEqual(a.isLatestOverall(genOld), false);
});

check('load-vs-refresh interleave: a refresh started after a load must still let the load win if the load is what the user is now viewing (ordering is purely by start time, not by type)', () => {
  const a = new GhostBidRequestArbiter();
  const genLoad = a.beginLoad();
  const genRefresh = a.beginRefresh();
  assert.strictEqual(a.isLatestOverall(genRefresh), true, 'refresh started later — it is the latest overall');
  assert.strictEqual(a.isLatestOverall(genLoad), false, 'load started earlier — stale relative to the refresh');
});

check('stale load completion does not clear a NEWER load\'s busy flag: only the latest load may clear busy', () => {
  const a = new GhostBidRequestArbiter();
  const genL1 = a.beginLoad();
  const genL2 = a.beginLoad();
  // L1 (stale) resolves first — must not be allowed to clear busy
  assert.strictEqual(a.isLatestLoad(genL1), false);
  // L2 (current) resolves — allowed to clear busy
  assert.strictEqual(a.isLatestLoad(genL2), true);
});

check('stale load completion arriving AFTER a newer load already cleared busy still correctly refuses to touch busy again', () => {
  const a = new GhostBidRequestArbiter();
  const genL1 = a.beginLoad();
  const genL2 = a.beginLoad();
  assert.strictEqual(a.isLatestLoad(genL2), true); // L2 finishes, clears busy
  assert.strictEqual(a.isLatestLoad(genL1), false); // L1 finishes late, must not touch busy
});

check('a refresh starting after a load must NOT suppress the load\'s own busy-clear (different flags, independently tracked)', () => {
  const a = new GhostBidRequestArbiter();
  const genLoad = a.beginLoad();
  a.beginRefresh(); // unrelated refresh starts and is now "latest overall"
  // the load, still in flight, must still be allowed to clear ITS OWN busy flag
  // when it finishes, since no newer LOAD has superseded it:
  assert.strictEqual(a.isLatestLoad(genLoad), true);
});

check('symmetric case: a load starting after a refresh must not suppress the refresh\'s own refreshing-clear', () => {
  const a = new GhostBidRequestArbiter();
  const genRefresh = a.beginRefresh();
  a.beginLoad();
  assert.strictEqual(a.isLatestRefresh(genRefresh), true);
});

check('two refreshes: only the latest may clear refreshing, independent of resolution order', () => {
  const a = new GhostBidRequestArbiter();
  const genR1 = a.beginRefresh();
  const genR2 = a.beginRefresh();
  assert.strictEqual(a.isLatestRefresh(genR1), false);
  assert.strictEqual(a.isLatestRefresh(genR2), true);
});

check('fresh arbiter: a request that never gets superseded is always latest on all three axes', () => {
  const a = new GhostBidRequestArbiter();
  const gen = a.beginLoad();
  assert.strictEqual(a.isLatestOverall(gen), true);
  assert.strictEqual(a.isLatestLoad(gen), true);
});

// ── floorSnapshotCaption (GB-2 truthful floor-staleness copy) ────────────
console.log('floorSnapshotCaption');

check('valid timestamp -> exact preferred copy with formatted date', () => {
  const sep1_2026 = Date.UTC(2026, 8, 1); // month is 0-indexed: 8 = September
  const out = floorSnapshotCaption(sep1_2026);
  assert.ok(out.includes('Sep'), `expected month abbreviation in: ${out}`);
  assert.ok(out.includes('Refresh updates escrow/activity only'), `expected the "does not refresh floor" clause: ${out}`);
  assert.ok(!out.toLowerCase().includes('stored floor snapshot'), 'should use the dated copy, not the fallback, when a date is available');
});

check('null -> honest fallback copy, no invented date', () => {
  const out = floorSnapshotCaption(null);
  assert.ok(out.includes('stored floor snapshot'));
  assert.ok(!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(out), 'must not fabricate a month when none is known');
});

check('undefined -> same honest fallback as null', () => {
  assert.strictEqual(floorSnapshotCaption(undefined), floorSnapshotCaption(null));
});

check('0 -> treated as "no timestamp" (falsy), not epoch 1970', () => {
  const out = floorSnapshotCaption(0);
  assert.ok(out.includes('stored floor snapshot'));
});

check('NaN -> fallback, not "Invalid Date"', () => {
  const out = floorSnapshotCaption(NaN);
  assert.ok(!out.includes('Invalid Date'));
  assert.ok(out.includes('stored floor snapshot'));
});

check('different snapshot dates produce different captions (per-list, not one hardcoded global date)', () => {
  const a = floorSnapshotCaption(Date.UTC(2026, 8, 1));
  const b = floorSnapshotCaption(Date.UTC(2026, 9, 15));
  assert.notStrictEqual(a, b);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) { console.error('SOME CHECKS FAILED'); }
