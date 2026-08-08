// Standalone (no test framework — the frontend has none) verification of
// formatSol's precision — the canonical Floor/Volume/Bid formatter shared by
// /dashboard and /multi's DashboardCollectionsPanel. Compile + run:
//   npx tsc src/soloist/mock-data.ts src/soloist/format-sol-parity.test.ts \
//     --outDir /tmp/fsp --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck && node /tmp/fsp/format-sol-parity.test.js
//
// Covers the /multi parity fix: DashboardCollectionsPanel used to format
// Floor/Volume/Bid via formatFeedPrice (Live Feed's 3-decimal cap) instead
// of formatSol, so the exact same backend number rendered with different
// precision depending on which page you were on. This locks the values that
// previously diverged (the [0.001, 0.01) band) to formatSol's actual output,
// so a future accidental re-introduction of a second formatter in either
// page is caught by comparing against these fixed expectations rather than
// against a hardcoded competing implementation.
import assert from 'assert';
import { formatSol } from './mock-data';

const CASES: Array<[number, string]> = [
  // The reported regression case: formatFeedPrice gave '0.003', formatSol
  // (canonical, /dashboard) gives '0.0034'.
  [0.0034, '0.0034'],
  [0.0009, '0.0009'],
  [0.01,   '0.01'],
  [0.1,    '0.1'],
  [1.5,    '1.5'],
  [12.34,  '12.3'],
  [100.6,  '101'],
  [1500,   '1.5K'],
];

let failures = 0;
for (const [input, expected] of CASES) {
  const got = formatSol(input);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  formatSol(${input}) → '${got}' (want '${expected}')`);
}
assert.strictEqual(failures, 0, `${failures} formatSol parity case(s) failed`);
console.log('\nAll formatSol parity cases passed.');
