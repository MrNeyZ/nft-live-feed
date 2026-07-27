/**
 * Collection Analyzer Stage 4 — part planner + display-name offline tests.
 * Pure, no network.
 *
 * Run: npm run test:collection-analyzer-part-plan
 */
import assert from 'assert';
import { sortAssetsByMint, planBundleParts } from '../bundle-part-plan';
import { deriveCollectionDisplayName } from '../bundle-display-name';
import type { NormalizedAsset } from '../../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

function asset(mint: string, name: string | null = null): NormalizedAsset {
  return { mint, name, image: null, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: [] };
}

console.log('\nsortAssetsByMint');
check('sorts deterministically by mint regardless of input order', () => {
  const a = [asset('C'), asset('A'), asset('B')];
  const sorted = sortAssetsByMint(a);
  assert.deepStrictEqual(sorted.map((x) => x.mint), ['A', 'B', 'C']);
});
check('same input in different order re-sorts to the identical sequence', () => {
  const r1 = sortAssetsByMint([asset('Z'), asset('M'), asset('A')]).map((x) => x.mint);
  const r2 = sortAssetsByMint([asset('A'), asset('Z'), asset('M')]).map((x) => x.mint);
  assert.deepStrictEqual(r1, r2);
});

console.log('\nplanBundleParts');
check('single part when under both caps', () => {
  const assets = sortAssetsByMint(Array.from({ length: 10 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  const plan = planBundleParts(assets, 5000, 750 * 1024 * 1024, 400 * 1024);
  assert.strictEqual(plan.parts.length, 1);
  assert.strictEqual(plan.parts[0].assetCount, 10);
});
check('exactly at the per-part asset cap -> still one part', () => {
  const assets = sortAssetsByMint(Array.from({ length: 100 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  const plan = planBundleParts(assets, 100, 750 * 1024 * 1024, 400 * 1024);
  assert.strictEqual(plan.parts.length, 1);
});
check('one over the per-part asset cap -> two parts, contiguous boundary', () => {
  const assets = sortAssetsByMint(Array.from({ length: 101 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  const plan = planBundleParts(assets, 100, 750 * 1024 * 1024, 400 * 1024);
  assert.strictEqual(plan.parts.length, 2);
  assert.strictEqual(plan.parts[0].assetCount, 100);
  assert.strictEqual(plan.parts[1].assetCount, 1);
  assert.strictEqual(plan.parts[0].endIndex, plan.parts[1].startIndex);
  assert.strictEqual(plan.parts[0].lastMint, assets[99].mint);
  assert.strictEqual(plan.parts[1].firstMint, assets[100].mint);
});
check('byte estimate can produce SMALLER parts than the count cap (not asset-count-only)', () => {
  const assets = sortAssetsByMint(Array.from({ length: 100 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  // 100 assets * 10KB estimate = 1MB > a 250KB-per-part byte budget -> forces small parts.
  const plan = planBundleParts(assets, 5000, 250 * 1024, 10 * 1024);
  assert.ok(plan.parts.length > 1, 'byte budget alone should force multiple parts even though asset count is small');
  assert.ok(plan.parts.every((p) => p.assetCount <= 25)); // 250KB / 10KB = 25
});
check('part numbers are 1-based and sequential', () => {
  const assets = sortAssetsByMint(Array.from({ length: 250 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  const plan = planBundleParts(assets, 100, 750 * 1024 * 1024, 400 * 1024);
  assert.deepStrictEqual(plan.parts.map((p) => p.partNumber), [1, 2, 3]);
});
check('empty asset list -> zero parts, no crash', () => {
  const plan = planBundleParts([], 100, 750 * 1024 * 1024, 400 * 1024);
  assert.deepStrictEqual(plan.parts, []);
  assert.strictEqual(plan.totalAssets, 0);
});
check('replanning the identical sorted list yields identical boundaries (determinism)', () => {
  const assets = sortAssetsByMint(Array.from({ length: 337 }, (_, i) => asset(`M${String(i).padStart(3, '0')}`)));
  const plan1 = planBundleParts(assets, 100, 750 * 1024 * 1024, 400 * 1024);
  const plan2 = planBundleParts(assets, 100, 750 * 1024 * 1024, 400 * 1024);
  assert.deepStrictEqual(plan1, plan2);
});

console.log('\nderiveCollectionDisplayName');
check('trusted name (tier 1) wins when provided', () => {
  assert.strictEqual(deriveCollectionDisplayName('ADDR1111111111111111111111111111111111111', [], 'Froganas'), 'Froganas');
});
check('common name prefix (tier 2) derived from consistent asset names', () => {
  const assets = Array.from({ length: 20 }, (_, i) => asset(`M${i}`, `Frogana #${i}`));
  assert.strictEqual(deriveCollectionDisplayName('ADDR1111111111111111111111111111111111111', assets), 'Frogana');
});
check('inconsistent names (no reliable majority) fall back to the address', () => {
  // Ten genuinely distinct prefixes (not sharing a common stripped name) —
  // no single name clears the 60% consistency threshold.
  const assets = Array.from({ length: 10 }, (_, i) => asset(`M${i}`, `Totally Different Name ${String.fromCharCode(65 + i)}`));
  assert.strictEqual(deriveCollectionDisplayName('ADDR1111111111111111111111111111111111111', assets), 'ADDR1111111111111111111111111111111111111');
});
check('no names at all -> address fallback (tier 3), never throws', () => {
  const assets = Array.from({ length: 5 }, (_, i) => asset(`M${i}`, null));
  assert.strictEqual(deriveCollectionDisplayName('ADDR1111111111111111111111111111111111111', assets), 'ADDR1111111111111111111111111111111111111');
});
check('result is sanitized for filesystem use', () => {
  const name = deriveCollectionDisplayName('ADDR', [], '../../etc/passwd Collection');
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes('..'));
});
check('never blocks/throws on malformed input', () => {
  assert.doesNotThrow(() => deriveCollectionDisplayName('ADDR', [{ mint: 'M', name: undefined as unknown as string, image: null, jsonUri: null, collectionAddress: null, compressed: false, standard: 'legacy', attributes: [] }]));
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
