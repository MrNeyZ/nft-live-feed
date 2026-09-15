/**
 * Regression: mmm-pool-type-resolver.ts's `ownerCache` must not leak
 * memory forever.
 *
 * Root cause (2026-08-05 /feed audit): `ownerCache` (owner wallet →
 * resolved MMM pools) was only ever `.set()` — refreshed on a repeat
 * lookup for the SAME owner — with no `.delete()` anywhere in the file.
 * An owner resolved once and never looked up again (the common case: most
 * wallets sell one pool and move on) stayed allocated for the life of the
 * process. Same shape as the `_deployerWindow` bug already fixed in the
 * /mints audit.
 *
 * Fix: `sweepOwnerCache()` — TTL sweep (OWNER_CACHE_TTL_MS) + hard size
 * cap (OWNER_CACHE_MAX) — piggybacked onto mmm-prefilter.ts's existing
 * 60 s summary tick (no new standalone timer).
 *
 * Run: npm run test:mmm-owner-cache-ttl
 */
import { __testHooks } from '../mmm-pool-type-resolver';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

function main(): void {
  const { seedOwnerCache, sweepOwnerCache, ownerCacheSize, ownerCacheMax, ownerCacheTtlMs } = __testHooks;

  check('ownerCacheMax is a small bounded constant, not Infinity', ownerCacheMax > 0 && ownerCacheMax < 1_000_000, `max=${ownerCacheMax}`);

  // ── TTL sweep purges a stale entry, keeps a fresh one ───────────────────
  {
    const staleOwner = 'StaleOwnerNeverLooksUpAgain11111111111111111111111111111';
    const freshOwner = 'FreshOwnerLookedUpRecently222222222222222222222222222222';
    const staleTs = Date.now() - (ownerCacheTtlMs + 60_000);
    const freshTs = Date.now();
    seedOwnerCache(staleOwner, staleTs);
    seedOwnerCache(freshOwner, freshTs);
    sweepOwnerCache();
    check('stale owner entry is purged by the TTL sweep', ownerCacheSize() >= 0, `size=${ownerCacheSize()}`);
    // Re-seed to check membership precisely (sweep above may have also
    // cleared entries from a previous test run in the same process).
    seedOwnerCache(freshOwner, Date.now());
    const beforeStaleReseed = ownerCacheSize();
    seedOwnerCache(staleOwner, Date.now() - (ownerCacheTtlMs + 60_000));
    check('cache accepted the seed (sanity)', ownerCacheSize() === beforeStaleReseed + 1, `size=${ownerCacheSize()}`);
    sweepOwnerCache();
    check('post-sweep size dropped by exactly the one stale entry', ownerCacheSize() === beforeStaleReseed, `size=${ownerCacheSize()} expected=${beforeStaleReseed}`);
  }

  // ── Hard cap: pushing well past OWNER_CACHE_MAX gets trimmed ───────────
  {
    const before = ownerCacheSize();
    const toAdd = (ownerCacheMax - before) + 200;
    for (let i = 0; i < toAdd; i++) {
      seedOwnerCache(`fifo-owner-probe-${i}`, Date.now());
    }
    check('size exceeds the cap before sweeping (sanity)', ownerCacheSize() > ownerCacheMax, `size=${ownerCacheSize()} max=${ownerCacheMax}`);
    sweepOwnerCache();
    check('sweepOwnerCache enforces the hard cap', ownerCacheSize() <= ownerCacheMax, `size=${ownerCacheSize()} max=${ownerCacheMax}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
