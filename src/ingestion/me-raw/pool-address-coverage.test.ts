/**
 * MMM pool sniper (2026-07-16) — poolAddress fail-closed coverage guard.
 *
 * `parser.ts` computes `poolAddress` with a single unconditional rule:
 *   match.poolAcctIdx !== null ? accs[match.poolAcctIdx] : null
 * (see parser.ts line ~418, `parseMmmSale`). So whether a given MMM
 * instruction variant's poolAddress can ever be non-null is entirely
 * determined by its `poolAcctIdx` in `MMM_SALE_INSTRUCTIONS` — no other
 * code path can override it. That makes this a config-level test rather
 * than a replay-test fixture: `coreFulfillBuyV2` has genuinely never been
 * observed in our own ingested sale_events history (confirmed via direct
 * DB query, 2026-07-16), so there is no real transaction to replay-test
 * against — this instead proves the exact mechanism that guarantees
 * `poolAddress: null` for it and every other unverified variant, without
 * needing one.
 *
 * Run: npx ts-node src/ingestion/me-raw/pool-address-coverage.test.ts
 */

import { MMM_SALE_INSTRUCTIONS } from './programs';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${label}`); pass++; }
  else { console.log(`❌ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

function ixByName(name: string) {
  const ix = MMM_SALE_INSTRUCTIONS.find((i) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not found in MMM_SALE_INSTRUCTIONS`);
  return ix;
}

function main() {
  // Unverified layout — poolAcctIdx must be null, guaranteeing poolAddress
  // stays null for every coreFulfillBuyV2 sale regardless of instruction
  // content (see this file's module doc comment for why this is sufficient).
  const coreFulfillBuyV2 = ixByName('coreFulfillBuyV2');
  check('coreFulfillBuyV2: poolAcctIdx is null (unverified variant, fails closed)', coreFulfillBuyV2.poolAcctIdx === null);
  check('coreFulfillBuyV2: direction is fulfillBuy (the sniper-relevant direction)', coreFulfillBuyV2.direction === 'fulfillBuy');
  // Buyer IS documented for this variant (pool owner wallet) even though
  // the pool account itself isn't verified — confirms poolAddress:null is
  // NOT for lack of buyer data, i.e. there's no shortcut to derive it from
  // buyer either.
  check('coreFulfillBuyV2: buyerAcctIdx is still populated (owner wallet known, pool account is not)', coreFulfillBuyV2.buyerAcctIdx === 1);

  // Other unverified MMM variants — same fail-closed guarantee.
  const solOcpFulfillBuy = ixByName('solOcpFulfillBuy');
  check('solOcpFulfillBuy: poolAcctIdx IS verified (4) — sanity check this one is NOT null', solOcpFulfillBuy.poolAcctIdx === 4);

  const solOcpFulfillSell = ixByName('solOcpFulfillSell');
  check('solOcpFulfillSell: poolAcctIdx is null (unverified variant, fails closed)', solOcpFulfillSell.poolAcctIdx === null);

  // Sanity check on the verified side — every verified fulfillBuy variant
  // (the direction the pool sniper watches) has poolAcctIdx=4, confirming
  // the sniper's target instructions are NOT the gap.
  const verifiedFulfillBuyVariants = ['solFulfillBuy', 'coreFulfillBuy', 'solOcpFulfillBuy', 'solExtFulfillBuy', 'solMip1FulfillBuy', 'cnftFulfillBuy'];
  for (const name of verifiedFulfillBuyVariants) {
    const ix = ixByName(name);
    check(`${name}: poolAcctIdx verified (non-null)`, ix.poolAcctIdx !== null, `got ${ix.poolAcctIdx}`);
    check(`${name}: buyerAcctIdx === 1 (pool owner wallet, not the pool account)`, ix.buyerAcctIdx === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
