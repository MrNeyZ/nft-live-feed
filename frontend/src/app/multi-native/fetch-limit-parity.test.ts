// Standalone (no test framework — the frontend has none) guard against
// /multi's trending-collections candidate set silently drifting from
// /dashboard's again. Compile + run from the `frontend/` directory (paths
// below are resolved against process.cwd(), NOT __dirname — __dirname
// points into the tsc --outDir scratch tree, not the real source tree):
//   npx tsc src/app/multi-native/fetch-limit-parity.test.ts \
//     --outDir /tmp/flp --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck --lib es2020 && node /tmp/flp/fetch-limit-parity.test.js
//
// Covers the /multi parity fix: DashboardCollectionsPanel.tsx fetched only
// the top 60 trending collections vs. /dashboard's 100, so sorting by a
// secondary column ranked over a different, smaller candidate set on each
// page. FETCH_LIMIT isn't exported (it's a page-local fetch-URL constant,
// not shared behavior worth a runtime import), so this reads both source
// files as text and compares the literal constant — a source-level guard
// rather than a unit test, same category as an eslint rule.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

function extractFetchLimit(srcRelPath: string): number {
  const src = readFileSync(join(process.cwd(), srcRelPath), 'utf8');
  const m = src.match(/const FETCH_LIMIT = (\d+);/);
  if (!m) throw new Error(`FETCH_LIMIT constant not found in ${srcRelPath}`);
  return Number(m[1]);
}

const dashboardLimit = extractFetchLimit('src/app/dashboard/page.tsx');
const multiLimit = extractFetchLimit('src/app/multi-native/DashboardCollectionsPanel.tsx');

console.log(`dashboard/page.tsx FETCH_LIMIT = ${dashboardLimit}`);
console.log(`DashboardCollectionsPanel.tsx FETCH_LIMIT = ${multiLimit}`);
assert.strictEqual(multiLimit, dashboardLimit, 'multi/dashboard FETCH_LIMIT drifted apart again');
console.log('\nFETCH_LIMIT parity holds.');
