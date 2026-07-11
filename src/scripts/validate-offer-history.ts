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
  { slug: 'claynosaurz',       label: 'Blue chip, expected stable offers' },
  { slug: 'mad_lads',          label: 'Active collection, frequent bid movement expected' },
  { slug: 'wobots',            label: 'Low-floor collection' },
  { slug: 'trippin_ape_tribe', label: 'Collection with a real MMM top bid' },
  { slug: 'okay_bears',        label: 'Collection where Tensor may be best' },
  { slug: 'pegui',             label: 'Thin collection — may have no offers at all' },
];

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(4);
}

function printSnapshot(s: CollectionOfferSnapshot) {
  console.log(`  ME_COLLECTION: amount=${fmt(s.venues.meCollection?.amountSol)} conf=${s.venues.meCollection?.confidence ?? '—'} warnings=${s.venues.meCollection?.warnings.length ?? 0}`);
  console.log(`  MMM:           amount=${fmt(s.venues.mmm?.amountSol)} funded=${s.venues.mmm?.funded ?? '—'} pool=${s.venues.mmm?.poolAddress?.slice(0, 8) ?? '—'} conf=${s.venues.mmm?.confidence ?? '—'}`);
  console.log(`  TENSOR:        amount=${fmt(s.venues.tensor?.amountSol)} conf=${s.venues.tensor?.confidence ?? '—'}`);
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
