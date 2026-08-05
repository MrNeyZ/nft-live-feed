/**
 * Regression coverage for the /mints resource-lifecycle audit
 * (2026-08-05): four bugs where an optimization/dedup gate either
 * permanently blocked correct future data or leaked memory forever.
 *
 *   1. `collection-confirm.ts` retry exhaustion used to call
 *      `evictMintGroup()` — the SAME sticky non-NFT blacklist the
 *      enricher uses for a CONFIRMED fungible verdict — for what is
 *      actually just "DAS didn't index within 5 min", a transient
 *      outcome. That permanently silenced every future mint from the
 *      collection. Fixed: exhaustion now only drops the one retry
 *      entry; no eviction, no blacklist, re-enqueue still works.
 *   2. `enricher.ts`'s `verifiedMints` Set had a comment claiming
 *      indirect bounding that the code never actually performed —
 *      unbounded growth. Fixed: real FIFO cap.
 *   3. `blacklist.ts`'s `_deployerWindow` only pruned a deployer's
 *      stale stamps when that SAME deployer minted again — a one-shot
 *      deployer's entry lived forever. Fixed: periodic sweep.
 *   4. `collection-confirm.ts`'s `resolvedCountByKey` /
 *      `sharedImageConfirmedByKey` / `imageUseCount` were the same
 *      lazy-expiry shape as #3. Fixed: eager sweep piggybacked on the
 *      existing once-a-minute metrics tick.
 *
 * Pure in-memory state manipulation via each module's `__testHooks` —
 * no network calls, no real timers (retry delays run up to 5 min).
 *
 * Run: npx ts-node src/mints/__tests__/collection-confirm-lifecycle.test.ts
 */
import { __testHooks as ccHooks, scheduleCollectionConfirmation } from '../collection-confirm';
import { __testHooks as enricherHooks } from '../enricher';
import { __testHooks as blacklistHooks } from '../blacklist';
import { __testHooks as accHooks, evictMintGroup } from '../accumulator';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

function main(): void {
  // ── 1a. Exhausted retries do NOT create a permanent non-NFT eviction ──
  {
    const groupingKey = 'test-group-exhaust-1';
    const mintAddress = 'TestMintExhaust1111111111111111111111111';
    accHooks.reset();
    ccHooks.triggerExhaustion(groupingKey, mintAddress, 'parserColl1', 'sigExhaust1');

    check(
      '1a. exhaustion does not add groupingKey to evictedNonNft',
      accHooks.isEvictedNonNft(groupingKey) === false,
      `isEvictedNonNft(${groupingKey})=${accHooks.isEvictedNonNft(groupingKey)}`,
    );
    check(
      '1a. exhaustion removes the entry from the retry queue',
      ccHooks.hasPending(mintAddress) === false,
      `hasPending=${ccHooks.hasPending(mintAddress)}`,
    );
  }

  // ── 1b. Mint can be re-enqueued after timeout (no residual block) ──
  {
    const groupingKey = 'test-group-exhaust-2';
    const mintAddress = 'TestMintExhaust2222222222222222222222222';
    const before = ccHooks.pendingSize();
    ccHooks.triggerExhaustion(groupingKey, mintAddress, 'parserColl2', 'sigExhaust2');
    check(
      '1b. pending queue net-neutral after exhaustion (entry added then dropped)',
      ccHooks.pendingSize() === before,
      `before=${before} after=${ccHooks.pendingSize()}`,
    );
    // Re-enqueue for the SAME mintAddress+groupingKey — must not be
    // blocked by anything the exhausted attempt left behind. A real
    // 15s/60s setTimeout gets scheduled here; we only assert the entry
    // made it into `pending`, we don't wait for the timer to fire.
    scheduleCollectionConfirmation(groupingKey, mintAddress, 'parserColl2', 'sigExhaust2b');
    check(
      '1b. re-enqueue after exhaustion succeeds (mint accepted into retry queue again)',
      ccHooks.hasPending(mintAddress) === true,
      `hasPending=${ccHooks.hasPending(mintAddress)}`,
    );
  }

  // ── 4 (still in scope of #1). Confirmed DAS non-NFT verdict STILL evicts ──
  {
    const groupingKey = 'test-group-confirmed-fungible';
    accHooks.reset();
    check(
      'confirmed fungible reasons still classify as CONFIRMED (would evict)',
      enricherHooks.isConfirmedFungibleVerdict('interface=FungibleToken') === true &&
      enricherHooks.isConfirmedFungibleVerdict('decimals=6') === true,
      'interface=/decimals= reasons → confirmed',
    );
    check(
      'transient DAS reasons still classify as NOT confirmed (would NOT evict)',
      enricherHooks.isConfirmedFungibleVerdict('no_asset') === false &&
      enricherHooks.isConfirmedFungibleVerdict('http_429') === false,
      'no_asset/http_429 reasons → transient',
    );
    // enricher.ts's own eviction call site is untouched by this change —
    // verify evictMintGroup (the mechanism it still calls on a confirmed
    // verdict) really does sticky-blacklist the groupingKey.
    evictMintGroup(groupingKey);
    check(
      'evictMintGroup still sticky-blacklists on a real confirmed verdict',
      accHooks.isEvictedNonNft(groupingKey) === true,
      `isEvictedNonNft(${groupingKey})=${accHooks.isEvictedNonNft(groupingKey)}`,
    );
  }

  // ── 2. verifiedMints (enricher.ts) — real bounded FIFO ──
  {
    const max = enricherHooks.verifiedMintsMax;
    check(
      '2. verifiedMintsMax is a small bounded constant, not Infinity',
      max > 0 && max < 10_000_000,
      `verifiedMintsMax=${max}`,
    );

    const oldestProbe = 'ProbeMintOldestShouldGetEvicted111111111111';
    enricherHooks.rememberVerified(oldestProbe);
    const startSize = enricherHooks.verifiedMintsSize();

    // Push strictly past the cap (relative to current size) so the FIFO
    // trim actually engages — not just "added fewer than max" (which
    // would pass trivially without ever exercising the eviction branch).
    const toAdd = (max - startSize) + 500;
    for (let i = 0; i < toAdd; i++) {
      enricherHooks.rememberVerified(`fifo-probe-mint-${i}`);
    }

    check(
      '2. verifiedMints never exceeds its configured cap after crossing it',
      enricherHooks.verifiedMintsSize() <= max,
      `size=${enricherHooks.verifiedMintsSize()} max=${max} (added ${toAdd} on top of ${startSize})`,
    );
    check(
      '2. the OLDEST entry was evicted once the cap was exceeded (real FIFO, not a no-op)',
      enricherHooks.hasVerified(oldestProbe) === false,
      `hasVerified(oldestProbe)=${enricherHooks.hasVerified(oldestProbe)}`,
    );
    check(
      '2. a RECENT entry survives (FIFO evicts oldest-first, not random/newest)',
      enricherHooks.hasVerified(`fifo-probe-mint-${toAdd - 1}`) === true,
      `hasVerified(newest)=${enricherHooks.hasVerified(`fifo-probe-mint-${toAdd - 1}`)}`,
    );
  }

  // ── 3. _deployerWindow (blacklist.ts) — sweeps stale deployers ──
  {
    const deployer = 'TestDeployerNeverMintsAgain1111111111111111';
    const staleTs = Date.now() - 20 * 60_000; // 20 min ago, well past BULK_WINDOW_MS (10 min)
    blacklistHooks.seedDeployerStamp(deployer, 'someCollectionKey', staleTs);
    check(
      '3. seeded stale deployer entry is present before sweep',
      blacklistHooks.hasDeployerWindowEntry(deployer) === true,
      `hasDeployerWindowEntry(${deployer}) before sweep`,
    );
    blacklistHooks.runDeployerWindowSweep();
    check(
      '3. stale (never-returned) deployer entry is purged by the sweep',
      blacklistHooks.hasDeployerWindowEntry(deployer) === false,
      `hasDeployerWindowEntry(${deployer}) after sweep`,
    );
  }

  // ── 3b. A deployer with a FRESH stamp survives the sweep ──
  {
    const deployer = 'TestDeployerActiveRightNow222222222222222222';
    blacklistHooks.seedDeployerStamp(deployer, 'someCollectionKey', Date.now());
    blacklistHooks.runDeployerWindowSweep();
    check(
      '3b. fresh deployer entry survives the sweep (not over-pruned)',
      blacklistHooks.hasDeployerWindowEntry(deployer) === true,
      `hasDeployerWindowEntry(${deployer}) after sweep`,
    );
  }

  // ── 4. resolvedCountByKey / sharedImageConfirmedByKey / imageUseCount TTL ──
  {
    const key = 'test-group-ttl-stale';
    const staleTs = Date.now() - (ccHooks.resolvedWindowMs + 60_000);
    ccHooks.seedResolvedCount(key, 3, staleTs);
    ccHooks.seedSharedImageConfirmed(key, staleTs);
    ccHooks.seedImageUse('test-collection-ttl-stale', 'https://example.com/a.png', 'mintX', staleTs);

    check(
      '4. seeded stale entries present before sweep',
      ccHooks.resolvedCountByKeySize() > 0 && ccHooks.sharedImageConfirmedSize() > 0 && ccHooks.imageUseCountSize() > 0,
      `resolved=${ccHooks.resolvedCountByKeySize()} shared=${ccHooks.sharedImageConfirmedSize()} images=${ccHooks.imageUseCountSize()}`,
    );

    const beforeResolved = ccHooks.resolvedCountByKeySize();
    const beforeShared    = ccHooks.sharedImageConfirmedSize();
    const beforeImages    = ccHooks.imageUseCountSize();
    ccHooks.runSweep();

    check(
      '4. eager sweep purges stale resolvedCountByKey entries',
      ccHooks.resolvedCountByKeySize() < beforeResolved,
      `before=${beforeResolved} after=${ccHooks.resolvedCountByKeySize()}`,
    );
    check(
      '4. eager sweep purges stale sharedImageConfirmedByKey entries',
      ccHooks.sharedImageConfirmedSize() < beforeShared,
      `before=${beforeShared} after=${ccHooks.sharedImageConfirmedSize()}`,
    );
    check(
      '4. eager sweep purges stale imageUseCount entries',
      ccHooks.imageUseCountSize() < beforeImages,
      `before=${beforeImages} after=${ccHooks.imageUseCountSize()}`,
    );
  }

  // ── 4b. Fresh entries survive the sweep (not over-pruned) ──
  {
    const key = 'test-group-ttl-fresh';
    const now = Date.now();
    ccHooks.seedResolvedCount(key, 1, now);
    ccHooks.seedSharedImageConfirmed(key, now);
    ccHooks.seedImageUse('test-collection-ttl-fresh', 'https://example.com/b.png', 'mintY', now);
    ccHooks.runSweep();
    check(
      '4b. fresh entries are not purged by the sweep',
      ccHooks.resolvedCountByKeySize() > 0 && ccHooks.sharedImageConfirmedSize() > 0 && ccHooks.imageUseCountSize() > 0,
      `resolved=${ccHooks.resolvedCountByKeySize()} shared=${ccHooks.sharedImageConfirmedSize()} images=${ccHooks.imageUseCountSize()}`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
