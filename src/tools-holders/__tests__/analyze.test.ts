/**
 * Holder Count Tool — offline test.
 *
 * ts-node + node:assert, NO network. Feeds a mocked Helius DAS
 * `getAssetsByGroup` response (fixtures/sample-collection.json) through the same
 * owner-extraction the fetch layer uses, then asserts the pure
 * `buildHoldersAnalysis` output: distinct-holder count, top holders, the four
 * distribution buckets, and the warning channels (ownerless / empty / truncated).
 *
 * Run: npm run test:holders-tool
 */
import assert from 'assert';
import { buildHoldersAnalysis } from '../analyze';
import type { CollectionOwnerScan } from '../types';
import sampleFixture from './fixtures/sample-collection.json';

const NOW = '2026-01-01T00:00:00.000Z';

interface DasItem { ownership?: { owner?: string | null } }
/** Mirror of fetch-assets owner extraction — exercised here without network. */
function scanFromDasItems(items: DasItem[]): CollectionOwnerScan {
  const owners: string[] = [];
  let missingOwnerCount = 0;
  for (const it of items) {
    const owner = it.ownership?.owner;
    if (typeof owner === 'string' && owner.length > 0) owners.push(owner);
    else missingOwnerCount++;
  }
  return { owners, missingOwnerCount, totalAssets: items.length, truncated: false, dasError: null };
}

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

// ── Case 1: realistic mocked collection (all 4 buckets + one ownerless) ──────
const items = (sampleFixture as { result: { items: DasItem[] } }).result.items;
const a = buildHoldersAnalysis({ ...scanFromDasItems(items), collectionAddress: 'TestCollection1111111111111111111111111111', inputType: 'collection', inputValue: 'TestCollection1111111111111111111111111111', nowIso: NOW });

console.log('\nCase 1 — mocked collection (22 assets, 1 ownerless)');
check('totalAssets = 22',          () => assert.strictEqual(a.totalAssets, 22));
check('uniqueHolders = 5',         () => assert.strictEqual(a.uniqueHolders, 5));
check('updatedAt is injected now', () => assert.strictEqual(a.updatedAt, NOW));
check('inputType = collection',    () => assert.strictEqual(a.inputType, 'collection'));
check('resolvedCollectionAddress passthrough', () => assert.strictEqual(a.resolvedCollectionAddress, 'TestCollection1111111111111111111111111111'));
check('collectionAddress alias == resolved',    () => assert.strictEqual(a.collectionAddress, a.resolvedCollectionAddress));
check('top holder = WHALE x11',    () => { assert.strictEqual(a.topHolders[0].wallet, 'WHALEwa11111111111111111111111111111111111'); assert.strictEqual(a.topHolders[0].count, 11); });
check('top holder percent = 50',   () => assert.strictEqual(a.topHolders[0].percent, 50)); // 11 / 22
check('topHolders sorted desc',    () => { for (let i = 1; i < a.topHolders.length; i++) assert.ok(a.topHolders[i - 1].count >= a.topHolders[i].count); });
check('dist holders1 = 2',         () => assert.strictEqual(a.holderDistribution.holders1, 2));
check('dist holders2to5 = 1',      () => assert.strictEqual(a.holderDistribution.holders2to5, 1));
check('dist holders6to10 = 1',     () => assert.strictEqual(a.holderDistribution.holders6to10, 1));
check('dist holders11plus = 1',    () => assert.strictEqual(a.holderDistribution.holders11plus, 1));
check('dist buckets sum = uniqueHolders', () => {
  const d = a.holderDistribution;
  assert.strictEqual(d.holders1 + d.holders2to5 + d.holders6to10 + d.holders11plus, a.uniqueHolders);
});
check('warns about 1 ownerless asset', () => assert.ok(a.warnings.some(w => /1 asset\(s\) had no ownership\.owner/.test(w))));
check('no false truncation/error warning', () => assert.ok(!a.warnings.some(w => /lower bound|DAS error/.test(w))));

// ── Case 2: empty collection (wrong address / not a verified group) ──────────
const empty = buildHoldersAnalysis({ owners: [], missingOwnerCount: 0, totalAssets: 0, truncated: false, dasError: null, collectionAddress: 'Empty11111111111111111111111111111111111111', inputType: 'collection', inputValue: 'Empty11111111111111111111111111111111111111', nowIso: NOW });
console.log('\nCase 2 — empty collection');
check('totalAssets = 0',        () => assert.strictEqual(empty.totalAssets, 0));
check('uniqueHolders = 0',      () => assert.strictEqual(empty.uniqueHolders, 0));
check('top holders empty',      () => assert.strictEqual(empty.topHolders.length, 0));
check('warns "No assets found"',() => assert.ok(empty.warnings.some(w => /No assets found/.test(w))));

// ── Case 3: truncated scan + DAS error surface as warnings ───────────────────
const trunc = buildHoldersAnalysis({ owners: ['A'.repeat(43)], missingOwnerCount: 0, totalAssets: 1, truncated: true, dasError: 'DAS 429: rate', collectionAddress: 'Trunc111111111111111111111111111111111111111', inputType: 'slug', inputValue: 'somecollection', extraWarnings: ['Slug "somecollection" resolved to collection Trunc111… via a sample Magic Eden listing — verify the address if it looks wrong.'], nowIso: NOW });
console.log('\nCase 3 — slug input + truncated + DAS error');
check('inputType = slug',      () => assert.strictEqual(trunc.inputType, 'slug'));
check('inputValue passthrough',() => assert.strictEqual(trunc.inputValue, 'somecollection'));
check('slug-resolve note first',() => assert.ok(/resolved to collection/.test(trunc.warnings[0])));
check('warns lower bound',  () => assert.ok(trunc.warnings.some(w => /lower bound/.test(w))));
check('warns DAS error',    () => assert.ok(trunc.warnings.some(w => /DAS error/.test(w))));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
