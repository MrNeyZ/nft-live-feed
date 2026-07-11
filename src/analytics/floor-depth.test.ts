/**
 * Offline, deterministic regression suite for computeFloorDepth().
 * No network, no DB, no RPC — pure fixtures only.
 *
 * Run: npx ts-node src/analytics/floor-depth.test.ts
 */

import assert from 'assert';
import { computeFloorDepth, type FloorDepthResult } from './floor-depth';
import type { Listing, ListingSource, ListingType } from '../server/listings-store';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

let seq = 0;
function mk(
  mint: string,
  priceSol: number,
  opts: { source?: ListingSource; type?: ListingType; seller?: string } = {},
): Listing {
  seq++;
  const source = opts.source ?? 'ME';
  const type   = opts.type   ?? 'listing';
  const seller = opts.seller ?? `seller${seq}`;
  return {
    id:           `${source}:${type === 'pool' ? `pool${seq}:` : ''}${mint}:${seller}`,
    mint,
    priceSol,
    source,
    type,
    seller,
    slug:         'test_collection',
    auctionHouse: source === 'MMM' ? '' : 'AH1',
    tokenAta:     '',
    rank:         null,
    listedAt:     null,
    nftName:      null,
    imageUrl:     null,
  };
}

// ── 1. Empty listing set ────────────────────────────────────────────────────
{
  const r = computeFloorDepth([]);
  check('empty: floorSol null', r.floorSol === null);
  check('empty: secondListingSol null', r.secondListingSol === null);
  check('empty: spreadPct null', r.spreadPct === null);
  check('empty: listingCount 0', r.listingCount === 0);
  check('empty: uniqueMintCount 0', r.uniqueMintCount === 0);
  check('empty: confidence low', r.confidence === 'low');
  check('empty: warns no valid listings', r.warnings.some(w => w.includes('no valid listings')));
  check('empty: depth bands all zero', r.depth.within10Pct.count === 0 && r.depth.within10Pct.costSol === 0);
  check('empty: moveFloor bands all zero', r.moveFloor.toPlus10Pct.listingsToBuy === 0);
}

// ── 2. One listing only ─────────────────────────────────────────────────────
{
  const r = computeFloorDepth([mk('mintA', 2.5)]);
  check('one: floorSol = 2.5', r.floorSol === 2.5);
  check('one: secondListingSol null', r.secondListingSol === null);
  check('one: spreadPct null', r.spreadPct === null);
  check('one: uniqueMintCount 1', r.uniqueMintCount === 1);
  check('one: confidence low', r.confidence === 'low');
  check('one: within10Pct count 1 costSol 2.5',
    r.depth.within10Pct.count === 1 && r.depth.within10Pct.costSol === 2.5);
  check('one: moveFloor toPlus5Pct exhausted (buy the only ask, still no surviving ask above)',
    r.moveFloor.toPlus5Pct.listingsToBuy === 1 && r.moveFloor.toPlus5Pct.costSol === 2.5);
  check('one: warns fewer than 2 unique mints', r.warnings.some(w => w.includes('fewer than 2 unique mints')));
}

// ── 3. Multiple listings at exactly the same floor ──────────────────────────
{
  const r = computeFloorDepth([mk('a', 1), mk('b', 1), mk('c', 1)]);
  check('tiedFloor: floorSol 1', r.floorSol === 1);
  check('tiedFloor: secondListingSol 1 (tied)', r.secondListingSol === 1);
  check('tiedFloor: spreadPct 0', r.spreadPct === 0);
  check('tiedFloor: within1Pct includes all 3', r.depth.within1Pct.count === 3);
  check('tiedFloor: confidence not high (only 3 unique mints)', r.confidence !== 'high');
}

// ── 4. Exact +1% / +2% / +5% / +10% boundaries ──────────────────────────────
{
  const listings = [
    mk('floor',  100),
    mk('at1',    101),      // exactly +1%
    mk('at2',    102),      // exactly +2%
    mk('at5',    105),      // exactly +5%
    mk('at10',   110),      // exactly +10%
    mk('beyond', 110.01),   // just past +10%
  ];
  const r = computeFloorDepth(listings);
  check('boundary: within1Pct includes floor+at1 (2)', r.depth.within1Pct.count === 2, `got ${r.depth.within1Pct.count}`);
  check('boundary: within2Pct includes floor+at1+at2 (3)', r.depth.within2Pct.count === 3, `got ${r.depth.within2Pct.count}`);
  check('boundary: within5Pct includes floor..at5 (4)', r.depth.within5Pct.count === 4, `got ${r.depth.within5Pct.count}`);
  check('boundary: within10Pct includes floor..at10 (5), excludes beyond', r.depth.within10Pct.count === 5, `got ${r.depth.within10Pct.count}`);
  // moveFloor.toPlus10Pct: every ask up through "at10" (exactly +10%, inclusive)
  // must be bought before the surviving ask ("beyond") is genuinely above +10%.
  check('boundary: moveFloor.toPlus10Pct buys 5 (through the exact-boundary ask)',
    r.moveFloor.toPlus10Pct.listingsToBuy === 5, `got ${r.moveFloor.toPlus10Pct.listingsToBuy}`);
  check('boundary: moveFloor.toPlus1Pct buys 2 (floor + the exact +1% ask)',
    r.moveFloor.toPlus1Pct.listingsToBuy === 2, `got ${r.moveFloor.toPlus1Pct.listingsToBuy}`);
  check('boundary: no exhaustion warning for toPlus10Pct (a surviving ask exists)',
    !r.warnings.some(w => w.includes('toPlus10Pct exhausted')));
}

// ── 5. Duplicate mint on ME and Tensor — cheapest executable listing wins ───
{
  const listings = [
    mk('dup', 3.0, { source: 'ME' }),
    mk('dup', 2.4, { source: 'TENSOR' }),
    mk('other', 5.0, { source: 'ME' }),
  ];
  const r = computeFloorDepth(listings);
  check('dup: listingCount 3 (raw)', r.listingCount === 3);
  check('dup: uniqueMintCount 2 (deduped)', r.uniqueMintCount === 2);
  check('dup: floorSol is the cheaper Tensor price (2.4)', r.floorSol === 2.4, `got ${r.floorSol}`);
  check('dup: sourceBreakdown counts BOTH raw rows', r.sourceBreakdown.magicEden === 2 && r.sourceBreakdown.tensor === 1);
  check('dup: warns about the collapsed duplicate', r.warnings.some(w => w.includes('duplicate row')));
}

// ── 6. Invalid / zero / negative / NaN prices ───────────────────────────────
{
  const listings = [
    mk('good', 1.5),
    mk('zero', 0),
    mk('neg', -1),
    mk('nan', NaN),
    { ...mk('noMint', 2), mint: '' },
  ];
  const r = computeFloorDepth(listings);
  check('invalid: only the good row survives', r.listingCount === 1 && r.uniqueMintCount === 1);
  check('invalid: floorSol 1.5', r.floorSol === 1.5);
  check('invalid: warns about excluded prices', r.warnings.some(w => w.includes('invalid (non-positive/NaN) price')));
  check('invalid: warns about missing mint identity', r.warnings.some(w => w.includes('missing mint identity')));
}

// ── 7. Stale/expired listing exclusion ──────────────────────────────────────
// `Listing` has no isStale/expiresAt/status field — staleness is enforced
// upstream in listings-store.ts before a row ever reaches this module (see
// module doc comment). This test documents that contract: a plain, valid
// row has no way to be flagged stale at this layer, so it is included.
{
  const r = computeFloorDepth([mk('live', 1)]);
  check('stale: Listing type has no staleness field to exclude on (documented contract)',
    !('isStale' in (r as unknown as Record<string, unknown>)) && r.uniqueMintCount === 1);
}

// ── 8. Pool asks mixed with normal asks ─────────────────────────────────────
{
  const listings = [
    mk('me1', 2.0, { source: 'ME', type: 'listing' }),
    mk('pool1', 1.8, { source: 'MMM', type: 'pool' }),
    mk('pool2', 1.9, { source: 'MMM', type: 'pool' }),
    mk('tensor1', 2.5, { source: 'TENSOR', type: 'listing' }),
  ];
  const r = computeFloorDepth(listings);
  check('pools: floorSol is the cheapest pool ask (1.8)', r.floorSol === 1.8);
  check('pools: sourceBreakdown.mmmPool 2', r.sourceBreakdown.mmmPool === 2);
  check('pools: sourceBreakdown.magicEden 1, tensor 1', r.sourceBreakdown.magicEden === 1 && r.sourceBreakdown.tensor === 1);
  check('pools: warns about pool-hosted asks', r.warnings.some(w => w.includes('pool-hosted asks included')));
  check('pools: tensorPool always 0 today', r.sourceBreakdown.tensorPool === 0);
}

// ── 9. A single thin floor followed by a large gap ──────────────────────────
{
  const r = computeFloorDepth([mk('floor', 1), mk('gap', 50)]);
  check('thinFloor: spreadPct is huge', r.spreadPct !== null && r.spreadPct! > 40);
  check('thinFloor: within10Pct only the floor itself', r.depth.within10Pct.count === 1);
  check('thinFloor: moveFloor.toPlus10Pct finds the gap ask beyond threshold',
    r.moveFloor.toPlus10Pct.listingsToBuy === 1 && !r.warnings.some(w => w.includes('toPlus10Pct exhausted')));
}

// ── 10. Dense floor with many asks inside +2% ───────────────────────────────
{
  const listings: Listing[] = [];
  for (let i = 0; i < 20; i++) listings.push(mk(`mint${i}`, 1 + i * 0.001)); // 1.000 .. 1.019, all within 2%
  listings.push(mk('farOut', 5)); // well beyond every band, so moveFloor always finds a surviving ask
  const r = computeFloorDepth(listings);
  check('dense: floorSol 1', r.floorSol === 1);
  check('dense: within2Pct includes all 20 tight asks (not farOut)', r.depth.within2Pct.count === 20, `got ${r.depth.within2Pct.count}`);
  check('dense: confidence high (>=5 unique mints, no exhaustion)', r.confidence === 'high');
}

// ── 11. Cost and listingsToBuy calculations ─────────────────────────────────
{
  const listings = [mk('a', 1), mk('b', 1.02), mk('c', 1.04), mk('d', 2)];
  const r = computeFloorDepth(listings);
  // within5Pct threshold = 1.05 → a(1), b(1.02), c(1.04) qualify; d(2) doesn't.
  check('cost: within5Pct count 3', r.depth.within5Pct.count === 3, `got ${r.depth.within5Pct.count}`);
  check('cost: within5Pct costSol = 1+1.02+1.04 = 3.06',
    Math.abs(r.depth.within5Pct.costSol - 3.06) < 1e-9, `got ${r.depth.within5Pct.costSol}`);
  // moveFloor.toPlus5Pct: must buy a, b, c (all <=1.05) before reaching d (2, > 1.05).
  check('cost: moveFloor.toPlus5Pct listingsToBuy 3, costSol 3.06',
    r.moveFloor.toPlus5Pct.listingsToBuy === 3 && Math.abs(r.moveFloor.toPlus5Pct.costSol - 3.06) < 1e-9);
}

// ── 12. Input order does not affect output ──────────────────────────────────
{
  const listings = [
    mk('a', 3), mk('b', 1), mk('c', 2), mk('d', 4, { source: 'TENSOR' }),
    mk('pool', 1.5, { source: 'MMM', type: 'pool' }),
  ];
  const shuffled = [listings[4], listings[1], listings[3], listings[0], listings[2]];
  const r1 = computeFloorDepth(listings);
  const r2 = computeFloorDepth(shuffled);
  check('order: identical result regardless of input order', JSON.stringify(r1) === JSON.stringify(r2));
}

// ── 13. Function does not mutate input ──────────────────────────────────────
{
  const raw = [mk('z', 5), mk('a', 1), mk('m', 3)];
  const frozen = raw.map(l => Object.freeze({ ...l }));
  Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  let threw = false;
  try {
    computeFloorDepth(frozen);
  } catch {
    threw = true;
  }
  check('mutate: computeFloorDepth did not throw on frozen input', !threw);
  check('mutate: frozen input unchanged after call', JSON.stringify(frozen) === before);
  // Extra: confirm the ORIGINAL (unfrozen) array's element order is untouched
  // (i.e. no in-place .sort() on the caller's array).
  const rawCopy = [mk('z', 5), mk('a', 1), mk('m', 3)];
  const orderBefore = rawCopy.map(l => l.mint).join(',');
  computeFloorDepth(rawCopy);
  const orderAfter = rawCopy.map(l => l.mint).join(',');
  check('mutate: caller array order unchanged (no in-place sort)', orderBefore === orderAfter);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// Re-exported so a validation script can import the same fixture builder.
export { mk };
export type { FloorDepthResult };
