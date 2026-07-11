/**
 * Regression suite for mint-lifecycle.ts.
 *
 * Two sections:
 *   1. PURE — deriveMintLifecycle() / classifyFlipSpeed(), synthetic
 *      scalars only, no network/DB.
 *   2. I/O — the dedup/LEAST()-upsert behavior genuinely lives in SQL
 *      (MIN() across duplicate mint_events/sale_events rows, the
 *      ON CONFLICT ... LEAST() upsert), so those specific cases are
 *      exercised against the real DB with uniquely-prefixed, self-cleaning
 *      fixture rows — never against real production mints.
 *
 * Run: npx ts-node src/analytics/mint-lifecycle.test.ts
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/client';
import {
  deriveMintLifecycle,
  classifyFlipSpeed,
  getMintLifecycle,
  getMintLifecycleBatch,
  recordFirstListedAtObservation,
} from './mint-lifecycle';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — pure derivation (no DB)
// ════════════════════════════════════════════════════════════════════════

// 1. Mint only, no listing/sale
{
  const r = deriveMintLifecycle({ mintAddress: 'm1', mintedAtMs: 1000 });
  check('mintOnly: firstListedAtMs null', r.firstListedAtMs === null);
  check('mintOnly: firstSoldAtMs null', r.firstSoldAtMs === null);
  check('mintOnly: all durations null', r.mintToFirstListingMs === null && r.mintToFirstSaleMs === null && r.listingToFirstSaleMs === null);
  check('mintOnly: listingTimeQuality unknown', r.listingTimeQuality === 'unknown');
  check('mintOnly: no warnings', r.warnings.length === 0);
}

// 2. Listing only (no sale)
{
  const r = deriveMintLifecycle({ mintAddress: 'm2', mintedAtMs: 1000, firstListedAtMs: 5000, firstListedQuality: 'exact' });
  check('listingOnly: mintToFirstListingMs 4000', r.mintToFirstListingMs === 4000);
  check('listingOnly: mintToFirstSaleMs null', r.mintToFirstSaleMs === null);
  check('listingOnly: listingToFirstSaleMs null', r.listingToFirstSaleMs === null);
  check('listingOnly: quality exact', r.listingTimeQuality === 'exact');
}

// 3. Sale only (no listing)
{
  const r = deriveMintLifecycle({ mintAddress: 'm3', mintedAtMs: 1000, firstSoldAtMs: 9000 });
  check('saleOnly: mintToFirstSaleMs 8000', r.mintToFirstSaleMs === 8000);
  check('saleOnly: mintToFirstListingMs null', r.mintToFirstListingMs === null);
  check('saleOnly: listingToFirstSaleMs null', r.listingToFirstSaleMs === null);
}

// 4. Listing then sale
{
  const r = deriveMintLifecycle({ mintAddress: 'm4', mintedAtMs: 1000, firstListedAtMs: 5000, firstListedQuality: 'exact', firstSoldAtMs: 9000 });
  check('listThenSale: mintToFirstListingMs 4000', r.mintToFirstListingMs === 4000);
  check('listThenSale: mintToFirstSaleMs 8000', r.mintToFirstSaleMs === 8000);
  check('listThenSale: listingToFirstSaleMs 4000', r.listingToFirstSaleMs === 4000);
}

// 5. Sale BEFORE listing timestamp → warning + null listingToFirstSaleMs
{
  const r = deriveMintLifecycle({ mintAddress: 'm5', mintedAtMs: 1000, firstListedAtMs: 9000, firstListedQuality: 'exact', firstSoldAtMs: 5000 });
  check('saleBeforeListing: listingToFirstSaleMs null', r.listingToFirstSaleMs === null);
  check('saleBeforeListing: mintToFirstSaleMs still valid (4000)', r.mintToFirstSaleMs === 4000);
  check('saleBeforeListing: warns about sale-before-listing', r.warnings.some(w => w.includes('sale-before-listing')));
}

// 6. Negative mint→listing (listedAt before mintedAt)
{
  const r = deriveMintLifecycle({ mintAddress: 'm6', mintedAtMs: 9000, firstListedAtMs: 1000, firstListedQuality: 'exact' });
  check('negListing: mintToFirstListingMs null (not clamped to 0)', r.mintToFirstListingMs === null);
  check('negListing: warns', r.warnings.some(w => w.includes('firstListedAtMs is earlier than mintedAtMs')));
}

// 7. Negative mint→sale (soldAt before mintedAt)
{
  const r = deriveMintLifecycle({ mintAddress: 'm7', mintedAtMs: 9000, firstSoldAtMs: 1000 });
  check('negSale: mintToFirstSaleMs null (not clamped to 0)', r.mintToFirstSaleMs === null);
  check('negSale: warns', r.warnings.some(w => w.includes('firstSoldAtMs is earlier than mintedAtMs')));
}

// 11. Exact vs approximate listing timestamp quality
{
  const exact = deriveMintLifecycle({ mintAddress: 'm11a', mintedAtMs: 0, firstListedAtMs: 100, firstListedQuality: 'exact' });
  const approx = deriveMintLifecycle({ mintAddress: 'm11b', mintedAtMs: 0, firstListedAtMs: 100, firstListedQuality: 'approximate' });
  const unknownQuality = deriveMintLifecycle({ mintAddress: 'm11c', mintedAtMs: 0, firstListedAtMs: 100 });
  check('quality: exact preserved', exact.listingTimeQuality === 'exact');
  check('quality: approximate preserved', approx.listingTimeQuality === 'approximate');
  check('quality: defaults to unknown when unspecified but a timestamp exists', unknownQuality.listingTimeQuality === 'unknown');
}

// 12. All flip-speed boundaries
{
  check('flip: null duration -> null label', classifyFlipSpeed(null) === null);
  check('flip: 5min exactly -> instant', classifyFlipSpeed(5 * MIN) === 'instant');
  check('flip: 5min+1ms -> fast', classifyFlipSpeed(5 * MIN + 1) === 'fast');
  check('flip: 30min exactly -> fast', classifyFlipSpeed(30 * MIN) === 'fast');
  check('flip: 30min+1ms -> normal', classifyFlipSpeed(30 * MIN + 1) === 'normal');
  check('flip: 4h exactly -> normal', classifyFlipSpeed(4 * HOUR) === 'normal');
  check('flip: 4h+1ms -> slow', classifyFlipSpeed(4 * HOUR + 1) === 'slow');
  check('flip: 0ms -> instant', classifyFlipSpeed(0) === 'instant');
  check('flip: negative duration -> null (defensive, should never occur upstream)', classifyFlipSpeed(-5) === null);
}

// 13. Empty/invalid mint address (pure function doesn't validate mint shape
// itself — that's an I/O-layer fail-closed concern, tested in section 2 —
// but confirm the pure function still derives correctly around whatever
// mintAddress string it's given, since it trusts its caller for that field).
{
  const r = deriveMintLifecycle({ mintAddress: '', mintedAtMs: 1000 });
  check('emptyMintPure: still derives (I/O layer is where fail-closed happens)', r.mintAddress === '' && r.mintedAtMs === 1000);
}

// 14. Function does not mutate input
{
  const input = { mintAddress: 'm14', mintedAtMs: 1000, firstListedAtMs: 2000, firstListedQuality: 'exact' as const, firstSoldAtMs: 3000 };
  const before = JSON.stringify(input);
  deriveMintLifecycle(input);
  check('mutate: input object unchanged after call', JSON.stringify(input) === before);
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — I/O-backed tests (real DB, self-cleaning fixture rows)
// ════════════════════════════════════════════════════════════════════════

const TEST_PREFIX = `TESTLC_${Date.now()}_`;
const testMints: string[] = [];
function nextTestMint(label: string): string {
  const m = `${TEST_PREFIX}${label}`;
  testMints.push(m);
  return m;
}

async function insertMintEvent(mint: string, blockTimeMs: number | null, opts: { sigSuffix?: string; programSource?: string; collectionAddress?: string } = {}): Promise<void> {
  const pool = getPool();
  const sig = `${TEST_PREFIX}sig_${mint}_${opts.sigSuffix ?? 'a'}`;
  await pool.query(
    `INSERT INTO mint_events (signature, mint_address, grouping_key, grouping_kind, source_label, program_source, mint_type, block_time, collection_address)
     VALUES ($1, $2, 'test', 'mint', 'test', $3, 'paid', to_timestamp($4::double precision / 1000.0), $5)
     ON CONFLICT (signature, mint_address) DO NOTHING`,
    [sig, mint, opts.programSource ?? 'mpl_token_metadata', blockTimeMs, opts.collectionAddress ?? null],
  );
}

async function insertSaleEvent(mint: string, blockTimeMs: number, sigSuffix: string): Promise<void> {
  const pool = getPool();
  const sig = `${TEST_PREFIX}sale_${mint}_${sigSuffix}`;
  await pool.query(
    `INSERT INTO sale_events (signature, block_time, marketplace, nft_type, mint_address, seller, buyer, price_lamports, price_sol)
     VALUES ($1, to_timestamp($2::double precision / 1000.0), 'test', 'legacy', $3, 'sellerX', 'buyerX', 1000000000, 1)
     ON CONFLICT (signature) DO NOTHING`,
    [sig, blockTimeMs, mint],
  );
}

async function cleanupFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM mint_events WHERE mint_address = ANY($1)`, [testMints]);
  await pool.query(`DELETE FROM sale_events WHERE mint_address = ANY($1)`, [testMints]);
  await pool.query(`DELETE FROM mint_first_listed WHERE mint_address = ANY($1)`, [testMints]);
}

async function runIoTests(): Promise<void> {
  // 8. Duplicate mint rows → earliest mint wins (MIN across rows, prefer block_time)
  {
    const mint = nextTestMint('dupmint');
    await insertMintEvent(mint, 5000, { sigSuffix: 'later' });
    await insertMintEvent(mint, 2000, { sigSuffix: 'earlier' });
    const lc = await getMintLifecycle(mint);
    check('dupMint: earliest mint wins (2000)', lc?.mintedAtMs === 2000, `got ${lc?.mintedAtMs}`);
  }

  // 9. Duplicate sale rows / multiple sales → earliest sale wins
  {
    const mint = nextTestMint('dupsale');
    await insertMintEvent(mint, 1000);
    await insertSaleEvent(mint, 9000, 'later');
    await insertSaleEvent(mint, 4000, 'earlier');
    const lc = await getMintLifecycle(mint);
    check('dupSale: earliest sale wins (4000)', lc?.firstSoldAtMs === 4000, `got ${lc?.firstSoldAtMs}`);
  }

  // 10. Repeated listing observations → earliest listing remains
  {
    const mint = nextTestMint('repeatlisting');
    await insertMintEvent(mint, 1000);
    await recordFirstListedAtObservation(mint, 5000, 'exact');
    await recordFirstListedAtObservation(mint, 2000, 'approximate'); // earlier, different quality
    await recordFirstListedAtObservation(mint, 8000, 'exact');       // later — must NOT move it later
    const lc = await getMintLifecycle(mint);
    check('repeatListing: earliest timestamp retained (2000)', lc?.firstListedAtMs === 2000, `got ${lc?.firstListedAtMs}`);
    check('repeatListing: quality follows the WINNING (earliest) timestamp (approximate)', lc?.listingTimeQuality === 'approximate', `got ${lc?.listingTimeQuality}`);
  }

  // 13 (I/O half). Empty/invalid mint address fails closed
  {
    const r1 = await getMintLifecycle('');
    const r2 = await getMintLifecycle('   ');
    check('emptyMintIO: getMintLifecycle("") returns null (fails closed)', r1 === null);
    check('emptyMintIO: getMintLifecycle("   ") returns null (fails closed)', r2 === null);
    const batch = await getMintLifecycleBatch(['', '   ']);
    check('emptyMintIO: getMintLifecycleBatch with only invalid mints returns empty map', batch.size === 0);
  }

  // No mint_events row at all -> fails closed to null (never falls back to
  // collection_address or any other cross-mint approximation).
  {
    const r = await getMintLifecycle(`${TEST_PREFIX}nonexistent`);
    check('noMintAnchor: unknown mint returns null (no mint_events row to anchor to)', r === null);
  }

  // 15. Batch result order stability
  {
    const mA = nextTestMint('batchA');
    const mB = nextTestMint('batchB');
    const mC = nextTestMint('batchC');
    await insertMintEvent(mA, 1000);
    await insertMintEvent(mB, 2000);
    await insertMintEvent(mC, 3000);
    const inputOrder = [mC, mA, mB, mC, mA]; // deliberately shuffled + duplicated
    const batch = await getMintLifecycleBatch(inputOrder);
    const keys = Array.from(batch.keys());
    check('batchOrder: result key order follows first-seen input order', keys.join(',') === [mC, mA, mB].join(','), `got ${keys.join(',')}`);
    check('batchOrder: all three resolved correctly', batch.get(mA)?.mintedAtMs === 1000 && batch.get(mB)?.mintedAtMs === 2000 && batch.get(mC)?.mintedAtMs === 3000);
  }

  // cNFT identifier guard: a sale row keyed by a merkle-tree-shaped
  // "mint_address" (simulating ME-standalone-cNFT / MMM cnftFulfillBuy)
  // must NOT be picked up by a DIFFERENT mint's lifecycle lookup just
  // because they share a collection_address. Confirms no collection_address
  // fallback exists anywhere in the query path.
  {
    const treeLikeId = nextTestMint('treeplaceholder');
    const realCnftMint = nextTestMint('realcnftasset');
    await insertMintEvent(realCnftMint, 1000, { programSource: 'bubblegum', collectionAddress: treeLikeId });
    // Simulate an ME-standalone-cNFT sale that (per the audited behavior)
    // stores the merkle tree as mint_address — NOT this NFT's real asset id.
    await insertSaleEvent(treeLikeId, 5000, 'a');
    const lc = await getMintLifecycle(realCnftMint);
    check('cnftGuard: real cNFT asset lifecycle has NO sale (tree-keyed sale correctly invisible to it)', lc?.firstSoldAtMs == null, `got ${lc?.firstSoldAtMs}`);
    check('cnftGuard: mintedAt still resolves independently', lc?.mintedAtMs === 1000);
    check('cnftGuard: nftType correctly sourced from program_source (bubblegum)', lc?.nftType === 'bubblegum', `got ${lc?.nftType}`);
  }
}

async function main() {
  try {
    await runIoTests();
  } finally {
    await cleanupFixtures();
    await closePool();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL', err);
  try { await cleanupFixtures(); await closePool(); } catch { /* best effort */ }
  process.exit(1);
});
