/**
 * Regression suite for Stage 4.5 (normalized-collection-bid.ts) + the
 * collection-bids.ts funding fix it depends on.
 *
 * Pure-function only — no network/RPC calls. `classifyFunding` and
 * `classifyMmmEligibility`/`buildNormalizedMmmBid`/`buildNormalizedTensorBid`
 * are all synchronous and side-effect free, so every case from the Jul 2026
 * discovery audit (mad_lads, okay_bears, trippin_ape_tribe) is reproduced
 * here as literal lamport figures, not live fetches.
 *
 * Run: npx ts-node src/analytics/normalized-collection-bid.test.ts
 */

import { classifyFunding, type MmmBidCandidate } from '../server/collection-bids';
import {
  classifyMmmEligibility,
  buildNormalizedMmmBid,
  buildNormalizedTensorBid,
  pickBestCollectionBids,
} from './normalized-collection-bid';
import type { Allowlist } from '../server/tools-mmm-pools';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const SOL = 1e9;
function candidate(spotSol: number, bpaSol: number, poolAddress = 'PoolAddr111'): MmmBidCandidate {
  const spotPriceLamports = Math.round(spotSol * SOL);
  const buysidePaymentAmountLamports = Math.round(bpaSol * SOL);
  return {
    spotPriceLamports,
    buysidePaymentAmountLamports,
    poolAddress,
    owner: 'Owner1111',
    funding: classifyFunding(buysidePaymentAmountLamports, spotPriceLamports),
  };
}

// ════════════════════════════════════════════════════════════════════════
// classifyFunding — real broken examples from the Jul 2026 audit
// ════════════════════════════════════════════════════════════════════════

{
  // mad_lads: spotPrice 57.67 SOL, funding 2.30 SOL
  const f = classifyFunding(2.302789582 * SOL, 57.670126845 * SOL);
  check('mad_lads: funding = insufficient', f === 'insufficient');
}
{
  // okay_bears: spotPrice 6.00 SOL, funding 0.067 SOL
  const f = classifyFunding(0.067357142 * SOL, 6 * SOL);
  check('okay_bears: funding = insufficient', f === 'insufficient');
}
{
  // trippin_ape_tribe: spotPrice 0.207 SOL, funding 4.31 SOL — genuinely funded
  const f = classifyFunding(4.305097079 * SOL, 0.206825297 * SOL);
  check('trippin_ape_tribe: funding = verified', f === 'verified');
}
check('classifyFunding: missing spot -> unknown', classifyFunding(5 * SOL, undefined) === 'unknown');
check('classifyFunding: missing bpa -> unknown', classifyFunding(undefined, 5 * SOL) === 'unknown');
check('classifyFunding: NaN bpa -> unknown', classifyFunding(NaN, 5 * SOL) === 'unknown');
check('classifyFunding: zero spot -> unknown', classifyFunding(1 * SOL, 0) === 'unknown');
check('classifyFunding: bpa exactly equal to spot -> verified', classifyFunding(1 * SOL, 1 * SOL) === 'verified');
check('classifyFunding: bpa exactly zero, spot positive -> insufficient', classifyFunding(0, 1 * SOL) === 'insufficient');

// ════════════════════════════════════════════════════════════════════════
// classifyMmmEligibility
// ════════════════════════════════════════════════════════════════════════

check('eligibility: no allowlist entries -> collection_wide', classifyMmmEligibility([]) === 'collection_wide');
check('eligibility: FVCA -> collection_wide', classifyMmmEligibility([{ type: 'FVCA', pubkey: 'x' }]) === 'collection_wide');
check('eligibility: MCC -> collection_wide', classifyMmmEligibility([{ type: 'MCC', pubkey: 'x' }]) === 'collection_wide');
check('eligibility: core_collection -> collection_wide', classifyMmmEligibility([{ type: 'core_collection', pubkey: 'x' }]) === 'collection_wide');
check('eligibility: any -> collection_wide', classifyMmmEligibility([{ type: 'any', pubkey: 'x' }]) === 'collection_wide');
check('eligibility: mint -> exact_mint', classifyMmmEligibility([{ type: 'mint', pubkey: 'x' }]) === 'exact_mint');
check('eligibility: unrecognized numeric type -> unknown (fail closed)', classifyMmmEligibility([{ type: '7', pubkey: 'x' }] as Allowlist[]) === 'unknown');

// ════════════════════════════════════════════════════════════════════════
// buildNormalizedMmmBid
// ════════════════════════════════════════════════════════════════════════

{
  // mad_lads: 57.67 SOL spot / 2.30 SOL funding
  const c = candidate(57.670126845, 2.302789582);
  const bid = buildNormalizedMmmBid(c, 'collection_wide');
  check('mad_lads bid: funding insufficient', bid.funding === 'insufficient');
  check('mad_lads bid: not executable', bid.executableForCollection === false);
  check('mad_lads bid: not usable for VALUE', bid.usableForValueSignal === false);
  check('mad_lads bid: warning mentions escrow shortfall', bid.warnings.some(w => w.includes('below its own')));
}
{
  // okay_bears: 6 SOL spot / 0.067 SOL funding
  const c = candidate(6, 0.067357142);
  const bid = buildNormalizedMmmBid(c, 'collection_wide');
  check('okay_bears bid: funding insufficient', bid.funding === 'insufficient');
  check('okay_bears bid: not executable', bid.executableForCollection === false);
  check('okay_bears bid: not usable for VALUE', bid.usableForValueSignal === false);
}
{
  // trippin_ape_tribe: 0.207 SOL spot / 4.31 SOL funding — genuinely funded, collection-wide
  const c = candidate(0.206825297, 4.305097079);
  const bid = buildNormalizedMmmBid(c, 'collection_wide');
  check('trippin_ape_tribe bid: funding verified', bid.funding === 'verified');
  check('trippin_ape_tribe bid: eligibility collection_wide', bid.eligibility === 'collection_wide');
  check('trippin_ape_tribe bid: usable for VALUE', bid.usableForValueSignal === true);
  check('trippin_ape_tribe bid: executable', bid.executableForCollection === true);
  check('trippin_ape_tribe bid: grossAmountSol ~0.2068', Math.abs(bid.grossAmountSol - 0.206825297) < 1e-6);
}
{
  // Exact-mint allowlist, even if fully funded — never usable for collection-wide VALUE
  const c = candidate(1, 5);
  const bid = buildNormalizedMmmBid(c, 'exact_mint');
  check('exact_mint: funding verified (fully funded)', bid.funding === 'verified');
  check('exact_mint: NOT usable for collection-wide VALUE', bid.usableForValueSignal === false);
  check('exact_mint: warning present', bid.warnings.some(w => w.includes('exact mint')));
}
{
  // Unknown/unparseable decoder result — fail closed even if funding looks fine
  const c = candidate(1, 5);
  const bid = buildNormalizedMmmBid(c, 'unknown');
  check('unknown eligibility: fails closed, not usable', bid.usableForValueSignal === false);
  check('unknown eligibility: warning present', bid.warnings.some(w => w.includes('could not be decoded')));
}

// ════════════════════════════════════════════════════════════════════════
// buildNormalizedTensorBid
// ════════════════════════════════════════════════════════════════════════

{
  // mad_lads live Tensor stats: gross 8.0010 SOL, net 7.5049 SOL
  const bid = buildNormalizedTensorBid(8.0010 * SOL, 7.5049 * SOL);
  check('tensor: parsed', bid !== null);
  check('tensor: gross ~8.0010', Math.abs(bid!.grossAmountSol - 8.0010) < 1e-4);
  check('tensor: net ~7.5049 (lower than gross)', bid!.netAmountSol != null && Math.abs(bid!.netAmountSol - 7.5049) < 1e-4);
  check('tensor: net < gross (fees reduce seller proceeds)', bid!.netAmountSol! < bid!.grossAmountSol);
  check('tensor: eligibility unknown', bid!.eligibility === 'unknown');
  check('tensor: funding reported', bid!.funding === 'reported');
  check('tensor: never usable for VALUE', bid!.usableForValueSignal === false);
  check('tensor: never executableForCollection', bid!.executableForCollection === false);
}
{
  // No net figure present — still valid, netAmountSol null
  const bid = buildNormalizedTensorBid(3 * SOL, null);
  check('tensor no-net: still parses', bid !== null && bid.grossAmountSol === 3);
  check('tensor no-net: netAmountSol null', bid!.netAmountSol === null);
}
{
  // No positive gross amount at all -> null (nothing to report)
  check('tensor: null gross -> null bid', buildNormalizedTensorBid(null, null) === null);
  check('tensor: zero gross -> null bid', buildNormalizedTensorBid(0, null) === null);
  check('tensor: negative gross -> null bid', buildNormalizedTensorBid(-5, null) === null);
}

// ════════════════════════════════════════════════════════════════════════
// pickBestCollectionBids — explicit bestContextBid vs bestUsableForValueBid
// ════════════════════════════════════════════════════════════════════════

{
  // mad_lads-shaped: phantom MMM (57.67 SOL, insufficient) far outranks a
  // real Tensor quote (8 SOL). Context still surfaces the phantom (for
  // display); the VALUE pick must skip it entirely.
  const mmmPhantom = buildNormalizedMmmBid(candidate(57.670126845, 2.302789582), 'collection_wide');
  const tensorReal = buildNormalizedTensorBid(8.0010 * SOL, 7.5049 * SOL)!;
  const { bestContextBid, bestUsableForValueBid } = pickBestCollectionBids([mmmPhantom, tensorReal]);
  check('bestContextBid: phantom MMM wins on raw amount', bestContextBid?.venue === 'MMM');
  check('bestUsableForValueBid: null (MMM phantom excluded, Tensor never usable)', bestUsableForValueBid === null);
}
{
  // trippin_ape_tribe-shaped: genuinely funded, collection-wide MMM bid IS
  // usable and wins both picks even against a lower Tensor number.
  const mmmFunded = buildNormalizedMmmBid(candidate(0.206825297, 4.305097079), 'collection_wide');
  const tensorLow = buildNormalizedTensorBid(0.1 * SOL, null)!;
  const { bestContextBid, bestUsableForValueBid } = pickBestCollectionBids([mmmFunded, tensorLow]);
  check('bestContextBid: funded MMM wins (higher amount)', bestContextBid?.venue === 'MMM');
  check('bestUsableForValueBid: funded MMM wins (only usable candidate)', bestUsableForValueBid?.venue === 'MMM');
}
{
  // No venues at all -> both null, no throw.
  const { bestContextBid, bestUsableForValueBid } = pickBestCollectionBids([null, null]);
  check('pickBestCollectionBids: empty input -> both null', bestContextBid === null && bestUsableForValueBid === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
