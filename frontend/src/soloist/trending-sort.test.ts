// Standalone (no test framework — the frontend has none) verification of the
// canonical Trending Collections row order shared by /dashboard and /multi's
// DashboardCollectionsPanel. Compile + run:
//   npx tsc src/soloist/trending-sort.ts src/soloist/trending-sort.test.ts \
//     --outDir /tmp/ts-sort --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck && node /tmp/ts-sort/trending-sort.test.js
//
// Covers the /multi parity fix: the unsorted-column default used to always
// order by Volume there, diverging from /dashboard's "most recent sale
// first" default for the live-overlay ranges (5m/10m/1h/6h).
import assert from 'assert';
import { compareTrendingRows, sortValueFor, numCmp, type TrendingSortableRow, type SortKey } from './trending-sort';

function row(slug: string, overrides: Partial<TrendingSortableRow> = {}): TrendingSortableRow {
  return {
    name: slug, slug,
    floorSol: 1, volumeSol: 1, salesCount: 1,
    listedCount: null, totalSupply: null,
    bid: null, live: null,
    ...overrides,
  };
}

let failures = 0;
function check(label: string, cond: boolean) {
  if (!cond) { failures++; console.log(`FAIL  ${label}`); }
  else console.log(`PASS  ${label}`);
}

// ── liveActive default sort: most-recent-sale first ─────────────────────────
{
  const a = row('alpha', { volumeSol: 10, live: { latestTs: 1000 } });
  const b = row('bravo', { volumeSol: 50, live: { latestTs: 2000 } });
  const sorted = [a, b].sort((x, y) => compareTrendingRows(x, y, { sortCol: null, sortDir: 'desc', liveActive: true }));
  // bravo has the more recent sale (2000 > 1000) despite lower volume —
  // liveActive default must rank by latestTs, not volume.
  check('liveActive default ranks by latestTs desc, not volume', sorted[0].slug === 'bravo');
}

// ── liveActive=false default sort: Volume desc (1d/7d/30d ranges) ──────────
{
  const a = row('alpha', { volumeSol: 10, live: { latestTs: 2000 } });
  const b = row('bravo', { volumeSol: 50, live: { latestTs: 1000 } });
  const sorted = [a, b].sort((x, y) => compareTrendingRows(x, y, { sortCol: null, sortDir: 'desc', liveActive: false }));
  check('liveActive=false default ranks by volume desc', sorted[0].slug === 'bravo');
}

// ── explicit column sort still wins over the default branch ────────────────
{
  const a = row('alpha', { salesCount: 5, live: { latestTs: 2000 } });
  const b = row('bravo', { salesCount: 50, live: { latestTs: 1000 } });
  const sorted = [a, b].sort((x, y) => compareTrendingRows(x, y, { sortCol: 'sales', sortDir: 'asc', liveActive: true }));
  check('explicit sortCol overrides liveActive default', sorted[0].slug === 'alpha');
}

// ── tie-break: equal primary key falls back to latestTs, then name ─────────
{
  const a = row('zzz', { volumeSol: 10, live: { latestTs: 500 } });
  const b = row('aaa', { volumeSol: 10, live: { latestTs: 1500 } });
  const sorted = [a, b].sort((x, y) => compareTrendingRows(x, y, { sortCol: null, sortDir: 'desc', liveActive: false }));
  check('tie on primary key falls back to latestTs desc', sorted[0].slug === 'aaa');
}
{
  const a = row('zzz', { volumeSol: 10, live: null });
  const b = row('aaa', { volumeSol: 10, live: null });
  const sorted = [a, b].sort((x, y) => compareTrendingRows(x, y, { sortCol: null, sortDir: 'desc', liveActive: false }));
  check('tie on primary key and latestTs falls back to name asc', sorted[0].slug === 'aaa');
}

// ── sortValueFor / numCmp sanity (used internally by compareTrendingRows) ──
{
  check('sortValueFor floor prefers bid over base', sortValueFor(row('x', { floorSol: 1, bid: { floorSol: 2, meBidSol: null, tnsrBidSol: null, listedCount: null, totalSupply: null } }), 'floor' as SortKey) === 2);
  check('numCmp treats NaN as 0', numCmp(NaN, 1) === -1);
}

assert.strictEqual(failures, 0, `${failures} trending-sort case(s) failed`);
console.log('\nAll trending-sort cases passed.');
