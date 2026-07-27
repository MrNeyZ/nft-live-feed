/**
 * Collection Analyzer Tool — offline test.
 *
 * ts-node + node:assert, NO network. Covers:
 *   - input parsing (address / Tensor URL / Magic Eden URL / invalid)
 *   - DAS item normalization (Core / pNFT / legacy / compressed, image/attr
 *     extraction, burnt exclusion)
 *   - pure analyze layer (trait category summary, warnings)
 *
 * Run: npm run test:collection-analyzer
 */
import assert from 'assert';
import { parseCollectionAnalyzerInput } from '../parse-input';
import { normalizeAsset, computeExactTotal } from '../fetch-preview';
import { buildCollectionAnalysis, buildTraitCategories } from '../analyze';
import type { NormalizedAsset } from '../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

const SAMPLE_COLLECTION = 'CoLLection111111111111111111111111111111';
const SAMPLE_MINT = 'MintAddr111111111111111111111111111111111';

// ── parse-input ──────────────────────────────────────────────────────────
console.log('\nInput parsing');
check('valid base58 address -> address', () => {
  const p = parseCollectionAnalyzerInput(SAMPLE_COLLECTION);
  assert.strictEqual(p.kind, 'address');
  assert.strictEqual((p as { address: string }).address, SAMPLE_COLLECTION);
});
check('tensor.trade/trade/<slug> -> tensor_url', () => {
  const p = parseCollectionAnalyzerInput('https://www.tensor.trade/trade/froganas');
  assert.strictEqual(p.kind, 'tensor_url');
  assert.strictEqual((p as { slug: string }).slug, 'froganas');
});
check('tensor.trade without www -> tensor_url', () => {
  const p = parseCollectionAnalyzerInput('https://tensor.trade/trade/froganas');
  assert.strictEqual(p.kind, 'tensor_url');
});
check('tensor url without protocol -> tensor_url', () => {
  const p = parseCollectionAnalyzerInput('tensor.trade/trade/froganas');
  assert.strictEqual(p.kind, 'tensor_url');
});
check('magiceden.io/marketplace/<slug> -> magiceden_url', () => {
  const p = parseCollectionAnalyzerInput('https://magiceden.io/marketplace/froganas');
  assert.strictEqual(p.kind, 'magiceden_url');
  assert.strictEqual((p as { slug: string }).slug, 'froganas');
});
check('magiceden.us/marketplace/<slug> -> magiceden_url', () => {
  const p = parseCollectionAnalyzerInput('https://magiceden.us/marketplace/froganas');
  assert.strictEqual(p.kind, 'magiceden_url');
});
check('unrelated URL -> invalid', () => {
  assert.strictEqual(parseCollectionAnalyzerInput('https://example.com/foo').kind, 'invalid');
});
check('tensor.trade item (not /trade/<slug>) -> invalid', () => {
  assert.strictEqual(parseCollectionAnalyzerInput('https://www.tensor.trade/item/abc123').kind, 'invalid');
});
check('empty string -> invalid', () => {
  assert.strictEqual(parseCollectionAnalyzerInput('').kind, 'invalid');
});
check('garbage text -> invalid', () => {
  assert.strictEqual(parseCollectionAnalyzerInput('not an address or url').kind, 'invalid');
});

// ── normalizeAsset ───────────────────────────────────────────────────────
console.log('\nAsset normalization');
check('MPL Core asset normalizes standard=core, compressed=false', () => {
  const a = normalizeAsset({
    id: SAMPLE_MINT,
    interface: 'MplCoreAsset',
    content: {
      metadata: { name: 'Froganas #1', attributes: [{ trait_type: 'Background', value: 'Blue' }] },
      links: { image: 'https://example.com/1.png' },
      json_uri: 'https://example.com/1.json',
    },
    grouping: [{ group_key: 'collection', group_value: SAMPLE_COLLECTION }],
  }, SAMPLE_COLLECTION);
  assert.strictEqual(a.mint, SAMPLE_MINT);
  assert.strictEqual(a.name, 'Froganas #1');
  assert.strictEqual(a.image, 'https://example.com/1.png');
  assert.strictEqual(a.jsonUri, 'https://example.com/1.json');
  assert.strictEqual(a.collectionAddress, SAMPLE_COLLECTION);
  assert.strictEqual(a.compressed, false);
  assert.strictEqual(a.standard, 'core');
  assert.deepStrictEqual(a.attributes, [{ trait_type: 'Background', value: 'Blue' }]);
});
check('ProgrammableNFT normalizes standard=pnft', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT, interface: 'ProgrammableNFT', content: {} }, SAMPLE_COLLECTION);
  assert.strictEqual(a.standard, 'pnft');
  assert.strictEqual(a.compressed, false);
});
check('V1_NFT / LEGACY_NFT normalize standard=legacy', () => {
  assert.strictEqual(normalizeAsset({ id: SAMPLE_MINT, interface: 'V1_NFT' }, SAMPLE_COLLECTION).standard, 'legacy');
  assert.strictEqual(normalizeAsset({ id: SAMPLE_MINT, interface: 'LEGACY_NFT' }, SAMPLE_COLLECTION).standard, 'legacy');
});
check('MplBubblegumV2 normalizes standard=compressed, compressed=true', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT, interface: 'MplBubblegumV2' }, SAMPLE_COLLECTION);
  assert.strictEqual(a.standard, 'compressed');
  assert.strictEqual(a.compressed, true);
});
check('compression.compressed=true overrides to compressed regardless of interface', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT, interface: 'V1_NFT', compression: { compressed: true } }, SAMPLE_COLLECTION);
  assert.strictEqual(a.compressed, true);
  assert.strictEqual(a.standard, 'compressed');
});
check('missing grouping falls back to the queried collection address', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT, interface: 'V1_NFT' }, SAMPLE_COLLECTION);
  assert.strictEqual(a.collectionAddress, SAMPLE_COLLECTION);
});
check('image falls back to files[0] when links.image absent', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT, content: { files: [{ cdn_uri: 'https://cdn.example.com/1.png' }] } }, SAMPLE_COLLECTION);
  assert.strictEqual(a.image, 'https://cdn.example.com/1.png');
});
check('no image anywhere -> null, not throw', () => {
  const a = normalizeAsset({ id: SAMPLE_MINT }, SAMPLE_COLLECTION);
  assert.strictEqual(a.image, null);
  assert.strictEqual(a.name, null);
  assert.deepStrictEqual(a.attributes, []);
});
check('attribute with non-string trait_type is skipped, not throw', () => {
  const a = normalizeAsset({
    id: SAMPLE_MINT,
    content: { metadata: { attributes: [{ trait_type: undefined, value: 'x' }, { trait_type: 'Eyes', value: 'Green' }] as unknown as Array<{ trait_type?: string; value?: unknown }> } },
  }, SAMPLE_COLLECTION);
  assert.deepStrictEqual(a.attributes, [{ trait_type: 'Eyes', value: 'Green' }]);
});

// ── computeExactTotal ────────────────────────────────────────────────────
// Verified against live Helius mainnet: `result.total` mirrors the
// requested page size, not the true collection size (limit=1 -> total=1,
// limit=50 -> total=50, even for a 5,000+ asset collection). Only a SHORT
// page (fewer raw items than the limit) proves there's no more to fetch.
console.log('\ncomputeExactTotal (DAS total-field trust boundary)');
check('short page (rawItemCount < limit) -> exact total from reportedTotal', () => {
  assert.strictEqual(computeExactTotal(7, 20, 7), 7);
});
check('short page with missing reportedTotal -> falls back to rawItemCount', () => {
  assert.strictEqual(computeExactTotal(7, 20, undefined), 7);
});
check('full page (rawItemCount === limit) -> null, never trusts reportedTotal', () => {
  assert.strictEqual(computeExactTotal(20, 20, 20), null);
});
check('full page even when reportedTotal claims a huge number -> still null', () => {
  assert.strictEqual(computeExactTotal(50, 50, 5000), null);
});
check('zero items, zero limit edge case -> not exact (0 >= 0)', () => {
  assert.strictEqual(computeExactTotal(0, 0, 0), null);
});

// ── buildTraitCategories / buildCollectionAnalysis ──────────────────────
console.log('\nTrait summary + analysis build');
const assets: NormalizedAsset[] = [
  { mint: 'A', name: 'A', image: null, jsonUri: null, collectionAddress: SAMPLE_COLLECTION, compressed: false, standard: 'core', attributes: [{ trait_type: 'Background', value: 'Blue' }, { trait_type: 'Eyes', value: 'Green' }] },
  { mint: 'B', name: 'B', image: null, jsonUri: null, collectionAddress: SAMPLE_COLLECTION, compressed: false, standard: 'core', attributes: [{ trait_type: 'Background', value: 'Blue' }, { trait_type: 'Eyes', value: 'Red' }] },
  { mint: 'C', name: 'C', image: null, jsonUri: null, collectionAddress: SAMPLE_COLLECTION, compressed: true, standard: 'compressed', attributes: [{ trait_type: 'Background', value: 'Red' }] },
];

check('trait categories sorted alpha, values sorted by count desc', () => {
  const cats = buildTraitCategories(assets);
  assert.strictEqual(cats.length, 2);
  assert.strictEqual(cats[0].traitType, 'Background');
  assert.strictEqual(cats[1].traitType, 'Eyes');
  assert.deepStrictEqual(cats[0].values, [{ value: 'Blue', count: 2 }, { value: 'Red', count: 1 }]);
  assert.strictEqual(cats[1].values.length, 2);
});
check('buildTraitCategories on empty assets returns []', () => {
  assert.deepStrictEqual(buildTraitCategories([]), []);
});

const NOW = '2026-01-01T00:00:00.000Z';
check('buildCollectionAnalysis passthrough + preview-only warning always present', () => {
  const a = buildCollectionAnalysis({
    inputKind: 'collection', inputValue: SAMPLE_COLLECTION, collectionAddress: SAMPLE_COLLECTION,
    totalAssets: 3, assets, nowIso: NOW,
  });
  assert.strictEqual(a.previewCount, 3);
  assert.strictEqual(a.totalAssets, 3);
  assert.strictEqual(a.updatedAt, NOW);
  assert.ok(a.warnings.some((w) => w.includes('Stage 1 preview only')));
});
check('null totalAssets with non-empty preview adds an exact-total-unavailable warning', () => {
  const a = buildCollectionAnalysis({
    inputKind: 'collection', inputValue: SAMPLE_COLLECTION, collectionAddress: SAMPLE_COLLECTION,
    totalAssets: null, assets, nowIso: NOW,
  });
  assert.ok(a.warnings.some((w) => w.includes('Exact total asset count unavailable')));
});
check('null totalAssets with empty preview does NOT add the exact-total warning (no-assets warning covers it)', () => {
  const a = buildCollectionAnalysis({
    inputKind: 'collection', inputValue: SAMPLE_COLLECTION, collectionAddress: SAMPLE_COLLECTION,
    totalAssets: null, assets: [], nowIso: NOW,
  });
  assert.ok(!a.warnings.some((w) => w.includes('Exact total asset count unavailable')));
});
check('empty assets adds a no-assets-found warning', () => {
  const a = buildCollectionAnalysis({
    inputKind: 'collection', inputValue: SAMPLE_COLLECTION, collectionAddress: SAMPLE_COLLECTION,
    totalAssets: 0, assets: [], nowIso: NOW,
  });
  assert.ok(a.warnings.some((w) => w.includes('No assets found')));
});
check('dasError surfaces as a warning, not thrown', () => {
  const a = buildCollectionAnalysis({
    inputKind: 'mint', inputValue: SAMPLE_MINT, collectionAddress: SAMPLE_COLLECTION,
    totalAssets: null, assets: [], dasError: 'DAS 500: boom', nowIso: NOW,
  });
  assert.ok(a.warnings.some((w) => w.includes('DAS error during fetch')));
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
