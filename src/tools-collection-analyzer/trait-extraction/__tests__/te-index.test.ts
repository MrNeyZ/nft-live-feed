/**
 * Trait Extraction (Stage 5.1) - full-collection index tests.
 * Proves the old COMPARISON_POOL_CAP=2000 lexical-prefix blind spot is
 * gone: an exact comparison partner sitting anywhere in a large
 * collection - including well past position 2000, or at the very last
 * asset - is always found via indexed lookup, never a full N^2 scan.
 *
 * Run: npm run test:collection-analyzer-te-index
 */
import assert from 'assert';
import {
  buildCollectionIndex, exactCandidatesFor, shortlistNearCandidates, buildSignatureExcluding,
} from '../te-index';
import type { NormalizedAsset } from '../../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, attrs: Record<string, string>): NormalizedAsset {
  return { mint, name: mint, image: `https://img/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) };
}

/** Builds a large synthetic collection where the ONLY exact Level-0 match
 *  for the source sits at a specific lexical position - everything else
 *  (fillers) has a unique, non-matching non-target signature. */
function buildLargeCollectionWithMatchAt(totalFillers: number, matchMint: string): NormalizedAsset[] {
  const assets: NormalizedAsset[] = [asset('AAA_SRC', { Category1: 'X', Category2: 'Y', Target: 'Alpha' })];
  for (let i = 0; i < totalFillers; i++) {
    const id = String(i).padStart(5, '0');
    assets.push(asset(`F${id}`, { Category1: `X${id}`, Category2: `Y${id}`, Target: 'Beta' }));
  }
  assets.push(asset(matchMint, { Category1: 'X', Category2: 'Y', Target: 'Beta' }));
  return assets;
}

console.log('\nbuildCollectionIndex - full-collection reach (no lexical-prefix cap)');
check('exact pair located well AFTER the old 2000-asset cap', () => {
  const assets = buildLargeCollectionWithMatchAt(2500, 'ZZZ_MATCH_AFTER_2000');
  const index = buildCollectionIndex(assets);
  const excludedIdx = index.excludedSignatureIndexFor('Target');
  const found = exactCandidatesFor(excludedIdx, 'AAA_SRC');
  assert.deepStrictEqual(found, ['ZZZ_MATCH_AFTER_2000']);
});
check('exact pair located at the VERY LAST asset in the collection', () => {
  const assets = buildLargeCollectionWithMatchAt(3000, 'ZZZ_LAST_ASSET');
  const index = buildCollectionIndex(assets);
  assert.strictEqual(index.sortedMints[index.sortedMints.length - 1], 'ZZZ_LAST_ASSET');
  const excludedIdx = index.excludedSignatureIndexFor('Target');
  const found = exactCandidatesFor(excludedIdx, 'AAA_SRC');
  assert.deepStrictEqual(found, ['ZZZ_LAST_ASSET']);
});
check('assetsSearchable/totalAssets reflects the FULL collection, not a prefix', () => {
  const assets = buildLargeCollectionWithMatchAt(4000, 'ZZZ_MATCH');
  const index = buildCollectionIndex(assets);
  assert.strictEqual(index.totalAssets, 4002);
});

console.log('\nexcludedSignatureIndexFor - caching + correctness');
check('caches per traitType - same reference on second call', () => {
  const assets = buildLargeCollectionWithMatchAt(50, 'MATCH');
  const index = buildCollectionIndex(assets);
  const a = index.excludedSignatureIndexFor('Target');
  const b = index.excludedSignatureIndexFor('Target');
  assert.strictEqual(a, b);
});
check('two assets with identical non-target signature land in the same bucket regardless of position', () => {
  const assets: NormalizedAsset[] = [
    asset('S1', { A: '1', B: '2', Target: 'Alpha' }),
    asset('S2', { A: '1', B: '2', Target: 'Beta' }),
    asset('S3', { A: '9', B: '9', Target: 'Gamma' }),
  ];
  const index = buildCollectionIndex(assets);
  const idx = index.excludedSignatureIndexFor('Target');
  assert.deepStrictEqual(exactCandidatesFor(idx, 'S1'), ['S2']);
  assert.deepStrictEqual(exactCandidatesFor(idx, 'S2'), ['S1']);
  assert.deepStrictEqual(exactCandidatesFor(idx, 'S3'), []);
});

console.log('\nshortlistNearCandidates - indexed Level 1/2 discovery (no full scan)');
check('finds a Level-1 near-match (one non-target category differs) via posting-list intersection', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Body: 'Green', Hat: 'Cap', Target: 'Alpha' }),
    asset('NEAR', { Body: 'Blue', Hat: 'Cap', Target: 'Beta' }), // Body differs -> Level 1
    asset('FAR', { Body: 'Red', Hat: 'Helmet', Target: 'Beta' }), // both differ -> not in maxRelax=1 shortlist
  ];
  const index = buildCollectionIndex(assets);
  const srcEntries = buildSignatureExcluding(assets[0], 'Target').entries;
  const shortlist = shortlistNearCandidates(index, srcEntries, 'SRC', { maxRelax: 1, maxCandidates: 100 });
  assert.ok(shortlist.candidates.includes('NEAR'));
  assert.ok(!shortlist.candidates.includes('FAR'));
});
check('finds a Level-2 near-match only when maxRelax=2', () => {
  const assets: NormalizedAsset[] = [
    asset('SRC', { Body: 'Green', Hat: 'Cap', Shirt: 'Red', Target: 'Alpha' }),
    asset('FAR', { Body: 'Blue', Hat: 'Helmet', Shirt: 'Red', Target: 'Beta' }), // Body+Hat differ
  ];
  const index = buildCollectionIndex(assets);
  const srcEntries = buildSignatureExcluding(assets[0], 'Target').entries;
  const level1 = shortlistNearCandidates(index, srcEntries, 'SRC', { maxRelax: 1, maxCandidates: 100 });
  assert.ok(!level1.candidates.includes('FAR'), 'not reachable at maxRelax=1');
  const level2 = shortlistNearCandidates(index, srcEntries, 'SRC', { maxRelax: 2, maxCandidates: 100 });
  assert.ok(level2.candidates.includes('FAR'), 'reachable at maxRelax=2');
});
check('near-candidate shortlist cost scales with posting-list size, not total collection size (no O(N^2))', () => {
  // 6000 assets, but the source's own categories are RARE (small posting
  // lists) - postingEntriesScanned must stay far below N (proves indexed
  // lookup, not "for every source, scan every asset").
  // Two non-target categories -> minMatch stays above 0 for maxRelax=1,
  // so this exercises the indexed posting-list path (not the low-
  // cardinality full-scan fallback, which only triggers when a source has
  // so few non-target categories that even 0 shared ones would qualify).
  const assets: NormalizedAsset[] = [asset('SRC', { RareCat: 'RareVal', OtherCat: 'X', Target: 'Alpha' })];
  for (let i = 0; i < 5999; i++) assets.push(asset(`M${String(i).padStart(5, '0')}`, { RareCat: `Other${i % 50}`, OtherCat: `Y${i % 50}`, Target: 'Beta' }));
  const index = buildCollectionIndex(assets);
  const srcEntries = buildSignatureExcluding(assets[0], 'Target').entries;
  const shortlist = shortlistNearCandidates(index, srcEntries, 'SRC', { maxRelax: 1, maxCandidates: 500 });
  assert.ok(shortlist.postingEntriesScanned < 200, `expected a small posting scan for a rare value, got ${shortlist.postingEntriesScanned}`);
});
check('deterministic: rebuilding the index and re-running the search from a shuffled asset order gives identical results', () => {
  const assets = buildLargeCollectionWithMatchAt(200, 'MATCH_X');
  const shuffled = [...assets].reverse();
  const idx1 = buildCollectionIndex(assets);
  const idx2 = buildCollectionIndex(shuffled);
  const found1 = exactCandidatesFor(idx1.excludedSignatureIndexFor('Target'), 'AAA_SRC');
  const found2 = exactCandidatesFor(idx2.excludedSignatureIndexFor('Target'), 'AAA_SRC');
  assert.deepStrictEqual(found1, found2);
});

check('low-cardinality fallback (single non-target category) samples the FULL range when truncating, never a lexical prefix', () => {
  // Source has only ONE non-target category -> minMatch computes to 0 for
  // maxRelax=1, so shortlistNearCandidates falls back to a bounded full-
  // collection scan (see te-index.ts doc comment). That scan must still
  // reach the END of a large collection when capped, not just its start.
  const assets: NormalizedAsset[] = [asset('SRC', { Body: 'Green', Target: 'Alpha' })];
  for (let i = 0; i < 2000; i++) assets.push(asset(`F${String(i).padStart(5, '0')}`, { Body: `Other${i}`, Target: 'Beta' }));
  const index = buildCollectionIndex(assets);
  const srcEntries = buildSignatureExcluding(assets[0], 'Target').entries;
  const shortlist = shortlistNearCandidates(index, srcEntries, 'SRC', { maxRelax: 1, maxCandidates: 100 });
  const lastFillerMint = `F${String(1999).padStart(5, '0')}`;
  assert.ok(shortlist.candidates.includes(lastFillerMint), 'a capped full-range sample must still reach the last asset, not just the first 100 lexically');
});

console.log('\nperformance guard - full index build stays well under a full N^2 comparison budget');
check('building an index over a large, many-category collection is fast (structural regression guard, not a strict SLA)', () => {
  const assets: NormalizedAsset[] = [];
  const categories = ['Background', 'Body', 'Shirt', 'Hat', 'Eyes', 'Mouth', 'Eyebrows', 'Accessory', 'Necklace', 'Earring', 'Skin', 'Weapon', 'Aura', 'Rank'];
  for (let i = 0; i < 6000; i++) {
    const attrs: Record<string, string> = {};
    for (const cat of categories) attrs[cat] = `${cat}Val${i % 12}`;
    assets.push(asset(`C${String(i).padStart(5, '0')}`, attrs));
  }
  const t0 = Date.now();
  const index = buildCollectionIndex(assets);
  index.excludedSignatureIndexFor('Eyebrows');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `index build took ${elapsed}ms - expected well under a naive O(N^2) budget`);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
