/**
 * Offline, deterministic regression suite for computeCrossMarketGap().
 * No network, no DB, no RPC — pure fixtures only.
 *
 * Run: npx ts-node src/analytics/cross-market.test.ts
 */

import { computeCrossMarketGap } from './cross-market';
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

// ── 1. Empty listings ────────────────────────────────────────────────────
{
  const r = computeCrossMarketGap([]);
  check('empty: all floors null', r.meDirectFloorSol === null && r.mmmExecutableFloorSol === null && r.tensorDirectFloorSol === null && r.executableFloorAnySol === null);
  check('empty: no opportunities', r.opportunities.length === 0);
  check('empty: confidence low', r.confidence === 'low');
  check('empty: warns no valid listings', r.warnings.some(w => w.includes('no valid listings')));
}

// ── 2. Only ME listings ──────────────────────────────────────────────────
{
  const r = computeCrossMarketGap([mk('a', 1), mk('b', 2)]);
  check('onlyMe: meDirectFloorSol 1', r.meDirectFloorSol === 1);
  check('onlyMe: tensorDirectFloorSol null', r.tensorDirectFloorSol === null);
  check('onlyMe: no opportunities (no Tensor reference to beat, no Tensor rows to compare vs ME)', r.opportunities.length === 0);
  check('onlyMe: warns no Tensor direct listings', r.warnings.some(w => w.includes('no Tensor direct listings')));
}

// ── 3. Only Tensor listings ───────────────────────────────────────────────
{
  const r = computeCrossMarketGap([mk('a', 1, { source: 'TENSOR' }), mk('b', 2, { source: 'TENSOR' })]);
  check('onlyTensor: tensorDirectFloorSol 1', r.tensorDirectFloorSol === 1);
  check('onlyTensor: meDirectFloorSol null', r.meDirectFloorSol === null);
  check('onlyTensor: no opportunities (no ME reference floor)', r.opportunities.length === 0);
  check('onlyTensor: warns no ME direct listings', r.warnings.some(w => w.includes('no ME direct listings')));
}

// ── 4. ME ask below Tensor floor ─────────────────────────────────────────
{
  const r = computeCrossMarketGap([mk('cheap', 1, { source: 'ME' }), mk('t', 2, { source: 'TENSOR' })]);
  check('meBelowTensor: one opportunity', r.opportunities.length === 1);
  const op = r.opportunities[0];
  check('meBelowTensor: listingSource ME, referenceSource TENSOR', op.listingSource === 'ME' && op.referenceSource === 'TENSOR');
  check('meBelowTensor: gapSol 1, gapPct 0.5', op.gapSol === 1 && Math.abs(op.gapPct - 0.5) < 1e-9);
}

// ── 5. Tensor ask below ME floor ─────────────────────────────────────────
{
  const r = computeCrossMarketGap([mk('cheap', 1, { source: 'TENSOR' }), mk('m', 2, { source: 'ME' })]);
  check('tensorBelowMe: one opportunity', r.opportunities.length === 1);
  const op = r.opportunities[0];
  check('tensorBelowMe: listingSource TENSOR, referenceSource ME', op.listingSource === 'TENSOR' && op.referenceSource === 'ME');
  check('tensorBelowMe: gapSol 1, gapPct 0.5', op.gapSol === 1 && Math.abs(op.gapPct - 0.5) < 1e-9);
}

// ── 6. MMM pool ask below Tensor floor ───────────────────────────────────
{
  const r = computeCrossMarketGap([mk('pool1', 0.5, { source: 'MMM', type: 'pool' }), mk('t', 2, { source: 'TENSOR' })]);
  check('mmmBelowTensor: mmmExecutableFloorSol 0.5', r.mmmExecutableFloorSol === 0.5);
  check('mmmBelowTensor: one opportunity from MMM', r.opportunities.length === 1 && r.opportunities[0].listingSource === 'MMM' && r.opportunities[0].listingType === 'pool');
}

// ── 7. Same mint duplicated across ME/MMM — cheapest wins ────────────────
{
  const r = computeCrossMarketGap([
    mk('dup', 3, { source: 'ME' }),
    mk('dup', 2, { source: 'MMM', type: 'pool' }),
    mk('t', 10, { source: 'TENSOR' }),
  ]);
  check('dupMeMmm: uniqueMintCount 2 (dup collapsed + tensor)', r.uniqueMintCount === 2);
  check('dupMeMmm: cheaper MMM row wins the dedup', r.perMintFloors.find(p => p.mint === 'dup')?.priceSol === 2);
  check('dupMeMmm: exactly one opportunity for "dup" (not two)', r.opportunities.filter(o => o.mint === 'dup').length === 1);
  check('dupMeMmm: winning opportunity uses the MMM (cheaper) price', r.opportunities.find(o => o.mint === 'dup')?.listingPriceSol === 2);
  check('dupMeMmm: warns about collapsed duplicate', r.warnings.some(w => w.includes('duplicate row')));
}

// ── 8. Same mint duplicated across ME/Tensor ─────────────────────────────
{
  const r = computeCrossMarketGap([
    mk('dup', 5, { source: 'ME' }),
    mk('dup', 1, { source: 'TENSOR' }),
    mk('m2', 3, { source: 'ME' }),
  ]);
  check('dupMeTensor: uniqueMintCount 2', r.uniqueMintCount === 2);
  check('dupMeTensor: Tensor (cheaper) wins the dedup for "dup"', r.perMintFloors.find(p => p.mint === 'dup')?.source === 'TENSOR');
  // meDirectFloorSol must still reflect ME's OWN cheapest ask (3, from m2) —
  // not silently hidden by Tensor winning the cross-source dedup for 'dup'.
  check('dupMeTensor: meDirectFloorSol still 3 (ME\'s own floor, independent of dedup)', r.meDirectFloorSol === 3);
  // 'dup' (Tensor @ 1) is now compared against ME's direct floor (3) → opportunity.
  check('dupMeTensor: "dup" surfaces as a Tensor-vs-ME opportunity', r.opportunities.some(o => o.mint === 'dup' && o.referenceSource === 'ME'));
}

// ── 9. Equal prices produce zero gap, not an opportunity ─────────────────
{
  const r = computeCrossMarketGap([mk('a', 5, { source: 'ME' }), mk('b', 5, { source: 'TENSOR' })]);
  check('equalPrices: no opportunities emitted', r.opportunities.length === 0, `got ${JSON.stringify(r.opportunities)}`);
}

// ── 10. Invalid / zero / negative / NaN rows excluded ────────────────────
{
  const listings = [
    mk('good', 1, { source: 'ME' }),
    mk('zero', 0, { source: 'ME' }),
    mk('neg', -1, { source: 'TENSOR' }),
    mk('nan', NaN, { source: 'TENSOR' }),
    { ...mk('noMint', 2, { source: 'ME' }), mint: '' },
  ];
  const r = computeCrossMarketGap(listings);
  check('invalid: only the good row survives', r.rawListingCount === 1 && r.uniqueMintCount === 1);
  check('invalid: warns about excluded prices', r.warnings.some(w => w.includes('invalid (non-positive/NaN) price')));
  check('invalid: warns about missing mint identity', r.warnings.some(w => w.includes('missing mint identity')));
}

// ── 11. Input order does not affect output ───────────────────────────────
{
  const listings = [
    mk('a', 3, { source: 'ME' }), mk('b', 1, { source: 'TENSOR' }),
    mk('c', 2, { source: 'ME' }), mk('d', 4, { source: 'TENSOR' }),
    mk('pool', 1.5, { source: 'MMM', type: 'pool' }),
  ];
  const shuffled = [listings[4], listings[1], listings[3], listings[0], listings[2]];
  const r1 = computeCrossMarketGap(listings);
  const r2 = computeCrossMarketGap(shuffled);
  check('order: identical result regardless of input order', JSON.stringify(r1) === JSON.stringify(r2));
}

// ── 12. Function does not mutate input ───────────────────────────────────
{
  const raw = [mk('z', 5, { source: 'ME' }), mk('a', 1, { source: 'TENSOR' }), mk('m', 3, { source: 'ME' })];
  const frozen = raw.map(l => Object.freeze({ ...l }));
  Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  let threw = false;
  try { computeCrossMarketGap(frozen); } catch { threw = true; }
  check('mutate: did not throw on frozen input', !threw);
  check('mutate: frozen input unchanged after call', JSON.stringify(frozen) === before);

  const rawCopy = [mk('z', 5, { source: 'ME' }), mk('a', 1, { source: 'TENSOR' }), mk('m', 3, { source: 'ME' })];
  const orderBefore = rawCopy.map(l => l.mint).join(',');
  computeCrossMarketGap(rawCopy);
  check('mutate: caller array order unchanged (no in-place sort)', rawCopy.map(l => l.mint).join(',') === orderBefore);
}

// ── 13. Missing reference floor ───────────────────────────────────────────
// (covered structurally by #2 and #3 above — re-asserted here explicitly
// against the "do not silently compare against a missing floor" rule.)
{
  const r = computeCrossMarketGap([mk('poolOnly', 1, { source: 'MMM', type: 'pool' })]);
  check('missingRef: mmmExecutableFloorSol set, but no ME/Tensor floor to compare against', r.mmmExecutableFloorSol === 1);
  check('missingRef: no opportunities (neither reference floor exists)', r.opportunities.length === 0);
  check('missingRef: warns about BOTH missing reference floors', r.warnings.some(w => w.includes('no ME direct listings')) && r.warnings.some(w => w.includes('no Tensor direct listings')));
}

// ── 14. Thin one-listing market ───────────────────────────────────────────
{
  const r = computeCrossMarketGap([mk('solo', 2, { source: 'ME' })]);
  check('thin: meDirectFloorSol 2', r.meDirectFloorSol === 2);
  check('thin: confidence low (uniqueMintCount < 2)', r.confidence === 'low');
  check('thin: warns fewer than 2 unique mints', r.warnings.some(w => w.includes('fewer than 2 unique mints')));
}

// ── 15. Multiple opportunities sorted by strongest gap ───────────────────
{
  const r = computeCrossMarketGap([
    mk('small', 9, { source: 'ME' }),     // 10% below tensor(10)
    mk('big',   4, { source: 'ME' }),     // 60% below tensor(10)
    mk('mid',   7, { source: 'ME' }),     // 30% below tensor(10)
    mk('t', 10, { source: 'TENSOR' }),
  ]);
  check('sorted: 3 opportunities', r.opportunities.length === 3);
  check('sorted: strongest gap (big, 60%) first', r.opportunities[0].mint === 'big');
  check('sorted: then mid (30%)', r.opportunities[1].mint === 'mid');
  check('sorted: then small (10%) last', r.opportunities[2].mint === 'small');
  check('sorted: gapPct strictly descending', r.opportunities[0].gapPct > r.opportunities[1].gapPct && r.opportunities[1].gapPct > r.opportunities[2].gapPct);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
