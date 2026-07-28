/**
 * Trait Extraction (Stage 5.1) - diversity-aware source selection tests.
 * Proves source sampling no longer just takes the lexically-first N
 * target-bearing assets (the Retardio Cousins pilot's root cause for most
 * non-"Mischievous" Eyebrows values contaminating on Shirt/Background).
 *
 * Run: npm run test:collection-analyzer-te-diversity
 */
import assert from 'assert';
import { buildCollectionIndex } from '../te-index';
import { selectDiverseSourceAssets } from '../te-diversity';
import type { NormalizedAsset } from '../asset-types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, attrs: Record<string, string>): NormalizedAsset {
  return { mint, name: mint, image: `https://img/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) };
}

console.log('\nselectDiverseSourceAssets');
check('lexically-first assets sharing ONE signature no longer crowd out the whole sample', () => {
  // 6 lexically-first assets ALL share the exact same (contaminating)
  // Background+Shirt combo; 2 lexically-later assets carry different,
  // otherwise-unseen Background/Shirt combos. The old "first N by mint"
  // sampler would pick only the 6 identical ones for a cap of 3-4;
  // diversity-aware selection must reach past them.
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 6; i++) assets.push(asset(`A${i}`, { Background: 'Blue', Shirt: 'Red', Eyebrows: 'Confused' }));
  assets.push(asset('Z1', { Background: 'Green', Shirt: 'Blue', Eyebrows: 'Confused' }));
  assets.push(asset('Z2', { Background: 'Orange', Shirt: 'Black', Eyebrows: 'Confused' }));
  const index = buildCollectionIndex(assets);
  const result = selectDiverseSourceAssets('Eyebrows', 'Confused', index, 3);
  const mints = result.sources.map((s) => s.mint);
  assert.ok(mints.includes('Z1') || mints.includes('Z2'), `expected diversity fill to reach a non-lexically-first signature, got ${mints.join(',')}`);
});
check('one representative per unique non-target signature is preferred over duplicates', () => {
  const assets: NormalizedAsset[] = [
    asset('A1', { Background: 'Blue', Eyebrows: 'Confused' }),
    asset('A2', { Background: 'Blue', Eyebrows: 'Confused' }), // same sig as A1
    asset('A3', { Background: 'Green', Eyebrows: 'Confused' }),
  ];
  const index = buildCollectionIndex(assets);
  const result = selectDiverseSourceAssets('Eyebrows', 'Confused', index, 2);
  const mints = result.sources.map((s) => s.mint).sort();
  assert.deepStrictEqual(mints, ['A1', 'A3'], 'should pick one rep from the Blue-signature bucket, then the Green one - not both Blue duplicates');
});
check('lexical mint order is the final deterministic tiebreak within a signature bucket', () => {
  const assets: NormalizedAsset[] = [
    asset('B_DUP', { Background: 'Blue', Eyebrows: 'Confused' }),
    asset('A_DUP', { Background: 'Blue', Eyebrows: 'Confused' }),
  ];
  const index = buildCollectionIndex(assets);
  const result = selectDiverseSourceAssets('Eyebrows', 'Confused', index, 1);
  assert.strictEqual(result.sources[0].mint, 'A_DUP');
});
check('deterministic across repeated calls / rebuilt indexes', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 20; i++) assets.push(asset(`M${i}`, { Background: `BG${i % 5}`, Shirt: `SH${i % 3}`, Eyebrows: 'Confused' }));
  const index1 = buildCollectionIndex(assets);
  const index2 = buildCollectionIndex([...assets].reverse());
  const r1 = selectDiverseSourceAssets('Eyebrows', 'Confused', index1, 6).sources.map((s) => s.mint);
  const r2 = selectDiverseSourceAssets('Eyebrows', 'Confused', index2, 6).sources.map((s) => s.mint);
  assert.deepStrictEqual(r1, r2);
});
check('no candidates for the target value -> empty result, never throws', () => {
  const assets: NormalizedAsset[] = [asset('A', { Eyebrows: 'Other' })];
  const index = buildCollectionIndex(assets);
  const result = selectDiverseSourceAssets('Eyebrows', 'Confused', index, 5);
  assert.deepStrictEqual(result.sources, []);
});
check('diagnostics report candidate pool size and unique-signature count', () => {
  const assets: NormalizedAsset[] = [
    asset('A1', { Background: 'Blue', Eyebrows: 'Confused' }),
    asset('A2', { Background: 'Blue', Eyebrows: 'Confused' }),
    asset('A3', { Background: 'Green', Eyebrows: 'Confused' }),
  ];
  const index = buildCollectionIndex(assets);
  const result = selectDiverseSourceAssets('Eyebrows', 'Confused', index, 5);
  assert.strictEqual(result.diagnostics.candidatePoolSize, 3);
  assert.strictEqual(result.diagnostics.uniqueNonTargetSignatures, 2);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
