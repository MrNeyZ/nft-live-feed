/**
 * One-off live validation of computeFloorDepth() against 5 real collections,
 * using the project's EXISTING listings-store.ts snapshot machinery
 * (ensureFresh + getByCollection) — no new fetch path, no new cache.
 *
 * Also compares the computed floor against getDerivedFloorLamports() and
 * explains any mismatch (that function is deliberately ME-non-pool-only —
 * see its own doc comment in listings-store.ts).
 *
 * Run: npx ts-node src/scripts/validate-floor-depth.ts
 */
import 'dotenv/config';
import { ensureFresh, getByCollection, getDerivedFloorLamports } from '../server/listings-store';
import { computeFloorDepth } from '../analytics/floor-depth';

const COLLECTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'claynosaurz',        label: 'High-volume'                 },
  { slug: 'pegui',              label: 'Thin-floor (few listings)'   },
  { slug: 'wobots',             label: 'Low-price'                   },
  { slug: 'trippin_ape_tribe',  label: 'MMM pool asks present'       },
  { slug: 'okay_bears',         label: 'Cross-market (ME + Tensor)'  },
];

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(4);
}

async function main() {
  for (const { slug, label } of COLLECTIONS) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${slug}  (${label})`);
    console.log('='.repeat(70));
    try {
      await ensureFresh(slug, 0); // force a fresh snapshot, ignore TTL
      const listings = getByCollection(slug);
      const r = computeFloorDepth(listings);
      const derivedLamports = getDerivedFloorLamports(slug);
      const derivedSol = derivedLamports === null ? null : derivedLamports / 1e9;

      console.log(`floorSol:            ${fmt(r.floorSol)}`);
      console.log(`secondListingSol:     ${fmt(r.secondListingSol)}`);
      console.log(`spreadPct:            ${r.spreadPct === null ? '—' : (r.spreadPct * 100).toFixed(2) + '%'}`);
      console.log(`listingCount:         ${r.listingCount}`);
      console.log(`uniqueMintCount:      ${r.uniqueMintCount}`);
      console.log(`confidence:           ${r.confidence}`);
      console.log(`depth:`);
      for (const k of ['within1Pct', 'within2Pct', 'within5Pct', 'within10Pct'] as const) {
        console.log(`  ${k.padEnd(12)} count=${r.depth[k].count.toString().padStart(3)}  costSol=${fmt(r.depth[k].costSol)}`);
      }
      console.log(`moveFloor:`);
      for (const k of ['toPlus1Pct', 'toPlus2Pct', 'toPlus5Pct', 'toPlus10Pct'] as const) {
        console.log(`  ${k.padEnd(12)} listingsToBuy=${r.moveFloor[k].listingsToBuy.toString().padStart(3)}  costSol=${fmt(r.moveFloor[k].costSol)}`);
      }
      console.log(`sourceBreakdown:      ME=${r.sourceBreakdown.magicEden} Tensor=${r.sourceBreakdown.tensor} MMMPool=${r.sourceBreakdown.mmmPool} TensorPool=${r.sourceBreakdown.tensorPool} Other=${r.sourceBreakdown.other}`);
      console.log(`warnings:             ${r.warnings.length === 0 ? 'none' : ''}`);
      for (const w of r.warnings) console.log(`  - ${w}`);

      console.log(`\ngetDerivedFloorLamports() = ${fmt(derivedSol)} SOL`);
      if (r.floorSol === null || derivedSol === null) {
        console.log(`  -> one side is null (no ME non-pool listings resolvable) — not comparable.`);
      } else if (Math.abs(r.floorSol - derivedSol) < 1e-9) {
        console.log(`  -> MATCH. Cheapest overall ask is itself an ME non-pool listing.`);
      } else if (r.floorSol < derivedSol) {
        console.log(`  -> MISMATCH: floor-depth floor is LOWER. getDerivedFloorLamports() ` +
          `deliberately excludes MMM/AMM pool rows and non-ME sources (see its own comment: ` +
          `"Skip MMM/AMM pool entries ... ME-only"), so a cheaper pool or Tensor ask is invisible to it.`);
      } else {
        console.log(`  -> MISMATCH: floor-depth floor is HIGHER — unexpected (floor-depth's cheapest-` +
          `overall should never exceed an ME-only subset's minimum). Investigate.`);
      }
    } catch (err) {
      console.error(`  ERROR validating ${slug}:`, (err as Error)?.message ?? err);
    }
  }
  process.exit(0);
}

main();
