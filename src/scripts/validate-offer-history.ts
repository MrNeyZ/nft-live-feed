/**
 * Live validation of observeCollectionOffers() against real collections.
 * Reuses existing fetchers (collection-bids.ts, enrich.ts) — no new
 * polling loop, no new cache. Observes each collection TWICE (a few
 * seconds apart) to show a real transition, and reports whether a
 * candidate jump would confirm (it won't unless a real jump happens
 * live — no jump is fabricated).
 *
 * Run: npx ts-node src/scripts/validate-offer-history.ts
 */
import 'dotenv/config';
import { observeCollectionOffers, type CollectionOfferSnapshot } from '../analytics/offer-history';

const COLLECTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'mad_lads',          label: 'Stage 4.5 fixture: MMM top pool underfunded (57.67/2.30 SOL) — must NOT be usable' },
  { slug: 'okay_bears',        label: 'Stage 4.5 fixture: MMM top pool underfunded (6.00/0.067 SOL) — must NOT be usable' },
  { slug: 'trippin_ape_tribe', label: 'Stage 4.5 fixture: MMM top pool genuinely funded (0.207/4.31 SOL) — should be usable' },
  { slug: 'wobots',            label: 'Low-floor collection, genuinely funded MMM pool' },
  { slug: 'claynosaurz',       label: 'No MMM buy-side liquidity at all — clean null case' },
];

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(4);
}

function printSnapshot(s: CollectionOfferSnapshot) {
  console.log(`  ME_COLLECTION: retired (permanently null — see module doc)`);
  const m = s.venues.mmm;
  console.log(`  MMM:           gross=${fmt(m?.grossAmountSol)} eligibility=${m?.eligibility ?? '—'} funding=${m?.funding ?? '—'} usableForValueSignal=${m?.usableForValueSignal ?? '—'} pool=${m?.poolAddress?.slice(0, 8) ?? '—'} conf=${m?.confidence ?? '—'}`);
  if (m?.warnings.length) for (const w of m.warnings) console.log(`      ! ${w}`);
  const t = s.venues.tensor;
  console.log(`  TENSOR:        gross=${fmt(t?.grossAmountSol)} net=${fmt(t?.netAmountSol)} eligibility=${t?.eligibility ?? '—'} funding=${t?.funding ?? '—'} usableForValueSignal=${t?.usableForValueSignal ?? '—'} conf=${t?.confidence ?? '—'}`);
  console.log(`  BEST:          ${s.best ? `${s.best.venue} @ ${fmt(s.best.amountSol)} SOL` : '— (no offers on any venue)'}`);
}

async function main() {
  for (const { slug, label } of COLLECTIONS) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`${slug}  (${label})`);
    console.log('='.repeat(72));
    try {
      console.log('-- observation 1 --');
      const r1 = await observeCollectionOffers(slug, slug);
      printSnapshot(r1.snapshot);
      console.log(`  transition: ${r1.transition.kind}  candidateJump=${r1.transition.candidateJump}  confirmedJump=${r1.confirmedJump}`);

      await new Promise((res) => setTimeout(res, 3_000));

      console.log('-- observation 2 (~3s later) --');
      const r2 = await observeCollectionOffers(slug, slug);
      printSnapshot(r2.snapshot);
      console.log(`  transition: ${r2.transition.kind}  candidateJump=${r2.transition.candidateJump}  confirmedJump=${r2.confirmedJump}`);
      for (const reason of r2.transition.reasons) console.log(`    - ${reason}`);

      if (r2.confirmedJump) {
        console.log('  >> CANDIDATE JUMP CONFIRMED on this real observation.');
      } else if (r2.transition.candidateJump) {
        console.log('  >> Candidate jump detected but not yet confirmed (needs another matching observation).');
      } else {
        console.log('  >> No jump candidate on this pair of observations (this is the expected/common case).');
      }
    } catch (err) {
      console.error(`  ERROR validating ${slug}:`, (err as Error)?.message ?? err);
    }
  }
  process.exit(0);
}

main();
