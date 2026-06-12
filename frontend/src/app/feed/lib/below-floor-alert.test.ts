// Standalone (no test framework — the frontend has none) verification of the
// below-floor alert decision. Compile + run:
//   npx tsc src/app/feed/lib/below-floor-alert.ts src/app/feed/lib/below-floor-alert.test.ts \
//     --outDir /tmp/bfa --module commonjs --target es2020 && node /tmp/bfa/below-floor-alert.test.js
import assert from 'assert';
import { shouldPlayBelowFloorAlert } from './below-floor-alert';

// Each case: [floorSol, saleSol, expectedAlert, label]
const CASES: Array<[number | null, number, boolean, string]> = [
  [0.01,  0.004, false, 'tiny floor 0.01 → suppressed'],
  [0.02,  0.004, false, 'floor == 0.02 boundary → suppressed'],
  [0.021, 0.004, true,  'floor 0.021 just above gate, -81% → alert'],
  [0.1,   0.004, true,  'floor 0.1, tiny sale 0.004 (-96%) → alert (price not gated)'],
  // AMM/pool case: real ME floor 0.1 is passed (NOT the polluted ~0.005
  // derived floor). 0.004 vs 0.1 = -96% → alert.
  [0.1,   0.004, true,  'AMM-polluted scenario uses real ME floor 0.1 → alert'],
  // Guard rows.
  [null,  0.004, false, 'floor missing → suppressed'],
  [0.1,   0.061, false, 'floor 0.1, sale 0.061 (-39%, above -40%) → no alert'],
  // Threshold = -40% verification cases.
  [0.05,  0.029, true,  'floor 0.05, sale -42% → alert'],
  [0.05,  0.0305,false, 'floor 0.05, sale -39% → no alert'],
  [0.009, 0.0009,false, 'floor 0.009, sale -90% → still no alert (tiny floor)'],
];

let failures = 0;
for (const [floor, sale, expected, label] of CASES) {
  const got = shouldPlayBelowFloorAlert(floor, sale);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  floor=${floor} sale=${sale} → ${got} (want ${expected})  ${label}`);
}
assert.strictEqual(failures, 0, `${failures} below-floor-alert case(s) failed`);
console.log('\nAll below-floor-alert cases passed.');
