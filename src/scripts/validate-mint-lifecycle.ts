/**
 * One-off live validation of getMintLifecycle() against real mints, using
 * the project's existing DB + (for the "fresh mint that listed quickly"
 * case) listings-store.ts snapshot machinery — no new fetch path.
 *
 * Run: npx ts-node src/scripts/validate-mint-lifecycle.ts
 */
import 'dotenv/config';
import { getPool, closePool } from '../db/client';
import { getMintLifecycle, classifyFlipSpeed } from '../analytics/mint-lifecycle';
import { ensureFresh, getByCollection } from '../server/listings-store';

const FIXTURES: Array<{ mint: string; label: string }> = [
  { mint: 'BPeHPfCGJZGkvd8YE6vt1oZt3EbrnXueeJTN8hqCiWGQ', label: 'pNFT (sale_events.nft_type=pnft, matched mint_events row)' },
  { mint: 'DiDC6teZjBgmskSCuWbfexUEqx8XTaxASezq9PpFhtdB', label: 'Core NFT (mpl_core, matched mint_events row)' },
  { mint: '5iBA8qGFKXZWnxrvvLmwLew1XztZLAdNBWLpoZHAuU8Q', label: 'Legacy NFT (sale_events.nft_type=legacy)' },
  { mint: '9V3G9aWLL9MuPo8e5xUt6CUGgTHLVQZo8sYVH15esEQg', label: 'Tensor cNFT takeBid (real asset ID, already-fixed party-identity path)' },
  { mint: '4V5vtxZUyPWtUGm27K2emryFncRdK4wd7KzxFeXa2TfR', label: 'Fresh Core mint, no secondary activity yet' },
];

function fmt(ms: number | null): string {
  return ms === null ? '—' : `${ms} (${new Date(ms).toISOString()})`;
}
function fmtDur(ms: number | null): string {
  return ms === null ? '—' : `${ms}ms (${(ms / 60_000).toFixed(1)}min)`;
}

async function report(mint: string, label: string) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${mint}  (${label})`);
  console.log('='.repeat(72));
  const lc = await getMintLifecycle(mint);
  if (!lc) {
    console.log('  getMintLifecycle() -> null (no mint_events anchor for this mint — identifiers did NOT match cleanly, or this mint predates the 7-day mint_events retention window).');
    return;
  }
  console.log(`mintedAtMs:            ${fmt(lc.mintedAtMs)}`);
  console.log(`firstListedAtMs:       ${fmt(lc.firstListedAtMs)}  (quality: ${lc.listingTimeQuality})`);
  console.log(`firstSoldAtMs:         ${fmt(lc.firstSoldAtMs)}`);
  console.log(`mintToFirstListingMs:  ${fmtDur(lc.mintToFirstListingMs)}`);
  console.log(`mintToFirstSaleMs:     ${fmtDur(lc.mintToFirstSaleMs)}  -> flip: ${classifyFlipSpeed(lc.mintToFirstSaleMs) ?? '—'}`);
  console.log(`listingToFirstSaleMs:  ${fmtDur(lc.listingToFirstSaleMs)}`);
  console.log(`nftType:               ${lc.nftType ?? '—'}`);
  console.log(`collectionAddress:     ${lc.collectionAddress ?? '—'}`);
  console.log(`warnings:              ${lc.warnings.length === 0 ? 'none' : ''}`);
  for (const w of lc.warnings) console.log(`  - ${w}`);
  console.log('  Identifiers matched cleanly: YES (mint_events row found and correlated).');
}

async function findFreshListedMint(): Promise<void> {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Live probe: "fresh mint that listed quickly" (micros, an actively-minting collection)`);
  console.log('='.repeat(72));
  try {
    await ensureFresh('micros', 0);
    const rows = getByCollection('micros');
    console.log(`  fetched ${rows.length} live listings for slug=micros`);
    const pool = getPool();
    // Any of these currently-listed mints that ALSO has a recent mint_events
    // row gives a genuine, real "minted then listed" example.
    const mints = rows.map(r => r.mint).filter(Boolean);
    if (mints.length === 0) { console.log('  no live listings found right now — skipping.'); return; }
    const { rows: minted } = await pool.query<{ mint_address: string }>(
      `SELECT mint_address FROM mint_events WHERE mint_address = ANY($1) ORDER BY block_time DESC LIMIT 1`,
      [mints],
    );
    if (minted.length === 0) {
      console.log('  none of the currently-listed "micros" mints have a matching recent mint_events row — skipping (collection may have stopped minting, or listings are older than the mint_events retention window).');
      return;
    }
    await report(minted[0].mint_address, 'Freshly minted + currently listed (micros, live)');
  } catch (err) {
    console.log('  ERROR:', (err as Error)?.message ?? err);
  }
}

async function main() {
  for (const { mint, label } of FIXTURES) {
    await report(mint, label);
  }
  await findFreshListedMint();
  await closePool();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('FATAL', err);
  try { await closePool(); } catch { /* best effort */ }
  process.exit(1);
});
