/**
 * Manual fixture-runner for the targeted-mode launchpad detector.
 *
 *   npm run debug:mints:launchpads
 *
 * Fetches the two reference txs supplied with the targeted-mode spec
 * (LaunchMyNFT + vvv.so), runs `detectLaunchpadMint` against each, and
 * prints the extracted fields. Exits non-zero if either fixture fails
 * to match — handy for catching regressions when launchpad signatures
 * change shape on chain.
 *
 * Uses Helius via the existing `fetchRawTx` so all auth / rate limiting
 * paths are exercised the same way the live ingestion does.
 */
import 'dotenv/config';
import { fetchRawTx } from '../ingestion/me-raw/ingest';
import { detectLaunchpadMint } from '../ingestion/mint-raw/launchpad-detector';

interface Fixture { label: string; sig: string; expect: 'LaunchMyNFT' | 'VVV'; }

const FIXTURES: Fixture[] = [
  {
    label: 'LaunchMyNFT',
    sig:   '3qjW71UQFuq9X65Fk4bKVmGyPs6XVGc8rtHF1UiqzBJ7AfQ9ZA1RVX1PpKYFGJfG93vwcCcuTR5edV2zXNtDDUeQ',
    expect:'LaunchMyNFT',
  },
  {
    label: 'vvv.so',
    sig:   '4nvMBRxq7L7eY7spzMWggj1QjenbcZ5uUMEKb49Fy8vCMRUvSKc62gWtdxWRz7EEQtKFyrgPC72EfG2FvCjCxv4Q',
    expect:'VVV',
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const f of FIXTURES) {
    console.log(`\n— ${f.label} —`);
    console.log(`  sig:    ${f.sig}`);
    const tx = await fetchRawTx(f.sig, false, 'low');
    if (!tx) { console.log('  result: FETCH_FAILED'); failed++; continue; }
    const hit = detectLaunchpadMint(tx);
    if (!hit) {
      console.log('  result: NO_MATCH (detector returned null)');
      failed++;
      continue;
    }
    console.log(`  source: ${hit.source}`);
    console.log(`  mint:   ${hit.mintAddress}`);
    console.log(`  buyer:  ${hit.minter ?? '—'}`);
    console.log(`  coll:   ${hit.collectionAddress ?? '—'}`);
    console.log(`  needle: ${hit.matchedNeedle ?? '—'}`);
    if (hit.source !== f.expect) {
      console.log(`  result: MISMATCH (expected ${f.expect})`);
      failed++;
    } else {
      console.log('  result: OK');
    }
  }
  console.log(failed === 0 ? '\nALL FIXTURES OK' : `\n${failed} FIXTURE(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
