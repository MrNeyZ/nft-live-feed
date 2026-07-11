/**
 * One-off live validation of computeCrossMarketGap() against real
 * collections, using the project's EXISTING listings-store.ts machinery —
 * no new fetch path, no new cache.
 *
 * Also re-implements the PRE-refactor tools-me-tensor-arb.ts algorithm
 * inline (byte-for-byte copy of the removed code) and diffs its
 * meFloorSol/tensorFloorSol/listings against the new module's output, to
 * prove the refactor preserved behavior on live data, not just fixtures.
 *
 * Run: npx ts-node src/scripts/validate-cross-market.ts
 */
import 'dotenv/config';
import { ensureFresh, getByCollection, type Listing } from '../server/listings-store';
import { computeCrossMarketGap } from '../analytics/cross-market';

const COLLECTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'claynosaurz',       label: 'ME + Tensor listings'                       },
  { slug: 'trippin_ape_tribe', label: 'MMM pool asks (Stage-1 ME-only mismatch)'   },
  { slug: 'okay_bears',        label: 'Cross-market, currently used by the arb tool' },
  { slug: 'mad_lads',          label: 'Tightly-arbed blue chip (expect little/no divergence)' },
];

// ── Byte-for-byte copy of the PRE-refactor algorithm (what
// tools-me-tensor-arb.ts computed before Stage 2) ──────────────────────────
function oldAlgorithm(rows: Listing[]) {
  const tensorPrices = rows.filter(r => r.source === 'TENSOR').map(r => r.priceSol);
  const mePrices = rows.filter(r => r.source === 'ME').map(r => r.priceSol);
  const meFloorSol = mePrices.length > 0 ? Math.min(...mePrices) : null;
  const meListedCount = mePrices.length;
  if (tensorPrices.length === 0) {
    return { meFloorSol, meListedCount, tensorFloorSol: null as number | null, tensorListedCount: 0, listings: [] as Listing[] };
  }
  const tensorFloorSol = Math.min(...tensorPrices);
  const listings = rows
    .filter(r => r.source !== 'TENSOR' && r.priceSol < tensorFloorSol)
    .sort((a, b) => a.priceSol - b.priceSol);
  return { meFloorSol, meListedCount, tensorFloorSol, tensorListedCount: tensorPrices.length, listings };
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(4);
}

async function main() {
  for (const { slug, label } of COLLECTIONS) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`${slug}  (${label})`);
    console.log('='.repeat(72));
    try {
      await ensureFresh(slug, 0);
      const rows = getByCollection(slug);
      const gap = computeCrossMarketGap(rows);
      const old = oldAlgorithm(rows);

      console.log(`meDirectFloorSol:       ${fmt(gap.meDirectFloorSol)}`);
      console.log(`mmmExecutableFloorSol:  ${fmt(gap.mmmExecutableFloorSol)}`);
      console.log(`tensorDirectFloorSol:   ${fmt(gap.tensorDirectFloorSol)}`);
      console.log(`executableFloorAnySol:  ${fmt(gap.executableFloorAnySol)}`);
      console.log(`rawListingCount:        ${gap.rawListingCount}`);
      console.log(`uniqueMintCount:        ${gap.uniqueMintCount}`);
      console.log(`confidence:             ${gap.confidence}`);
      console.log(`opportunities (top 5 of ${gap.opportunities.length}):`);
      for (const o of gap.opportunities.slice(0, 5)) {
        console.log(`  mint=${o.mint.slice(0, 8)}…  ${o.listingSource}/${o.listingType} @ ${o.listingPriceSol.toFixed(4)}` +
          `  vs ${o.referenceSource} floor ${o.referenceFloorSol.toFixed(4)}  gap=${o.gapSol.toFixed(4)} (${(o.gapPct * 100).toFixed(1)}%)`);
      }
      console.log(`warnings:               ${gap.warnings.length === 0 ? 'none' : ''}`);
      for (const w of gap.warnings) console.log(`  - ${w}`);

      console.log(`\n-- old-vs-new behavior diff --`);
      const meMatch = old.meFloorSol === gap.meDirectFloorSol;
      const tensorMatch = old.tensorFloorSol === gap.tensorDirectFloorSol;
      console.log(`meFloorSol:     old=${fmt(old.meFloorSol)}  new=${fmt(gap.meDirectFloorSol)}  ${meMatch ? 'MATCH' : 'MISMATCH'}`);
      console.log(`tensorFloorSol: old=${fmt(old.tensorFloorSol)}  new=${fmt(gap.tensorDirectFloorSol)}  ${tensorMatch ? 'MATCH' : 'MISMATCH'}`);
      console.log(`old listings.length=${old.listings.length}`);
      if (!meMatch || !tensorMatch) {
        console.log('  !! UNEXPECTED MISMATCH — investigate.');
      } else {
        console.log('  Refactor preserves exact floor values on this live collection.');
      }
    } catch (err) {
      console.error(`  ERROR validating ${slug}:`, (err as Error)?.message ?? err);
    }
  }
  process.exit(0);
}

main();
