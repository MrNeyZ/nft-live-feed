/**
 * Offline test for Stage 1 collection storage (collections-store.ts) plus
 * the new TraitAsset.collectionId field in store.ts — no network, no
 * Anthropic call, no Express layer. Runs entirely inside a scratch temp
 * directory (via process.chdir, before either module is first imported)
 * so it never reads or writes real data/pixel-forge files.
 * Run: `npx ts-node src/pixel-agent/__tests__/collections-store.test.ts`.
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-forge-collections-test-'));
const realCwd = process.cwd();
process.chdir(scratchDir);

async function main() {
  // Imported dynamically, AFTER chdir: both modules compute their storage
  // directory from process.cwd() once, at import time, so this ordering
  // is what keeps every read/write inside the scratch dir.
  const {
    createCollection, getCollection, updateCollection, listCollections, deleteCollection, normalizeCollection,
  } = await import('../collections-store');
  const { normalizeTraitAsset } = await import('../store');

  // ── create / get ─────────────────────────────────────────────────────
  const a = await createCollection({ name: 'SMB Animal', presetId: 'smb-animal' });
  assert.ok(a.id.startsWith('smb-animal-'), `expected slug-shaped id, got ${a.id}`);
  assert.strictEqual(a.presetId, 'smb-animal');
  assert.strictEqual(a.paletteOverride, null);
  assert.ok(a.createdAt > 0 && a.updatedAt === a.createdAt);

  const fetched = await getCollection(a.id);
  assert.deepStrictEqual(fetched, a);

  const b = await createCollection({ name: 'Second Test', presetId: 'smb-animal', paletteOverride: ['#111111'] });
  assert.notStrictEqual(a.id, b.id);

  // ── list ───────────────────────────────────────────────────────────
  const listed = await listCollections();
  assert.strictEqual(listed.length, 2);
  assert.ok(listed.some((c) => c.id === a.id) && listed.some((c) => c.id === b.id));

  // ── update ─────────────────────────────────────────────────────────
  const updated = await updateCollection(a.id, { name: 'SMB Animal Renamed', paletteOverride: ['#abcabc'] });
  assert.strictEqual(updated.id, a.id);
  assert.strictEqual(updated.name, 'SMB Animal Renamed');
  assert.deepStrictEqual(updated.paletteOverride, ['#abcabc']);
  assert.strictEqual(updated.presetId, 'smb-animal'); // untouched by the patch
  assert.ok(updated.updatedAt >= a.updatedAt);

  // ── missing collection → null, never throws ─────────────────────────
  assert.strictEqual(await getCollection('does-not-exist'), null);
  await assert.rejects(() => updateCollection('does-not-exist', { name: 'x' }), /collection_not_found/);

  // ── malformed / incomplete collection JSON is skipped, not a crash ───
  const collectionsDir = path.join(scratchDir, 'data', 'pixel-forge', 'collections');
  fs.writeFileSync(path.join(collectionsDir, 'corrupt.json'), '{ this is not valid json');
  fs.writeFileSync(path.join(collectionsDir, 'missing-fields.json'), JSON.stringify({ paletteOverride: ['#fff'] }));
  const listedAfterCorruption = await listCollections();
  assert.strictEqual(listedAfterCorruption.length, 2, 'corrupt/incomplete files must not appear or crash listCollections');
  assert.strictEqual(await getCollection('corrupt'), null);
  assert.strictEqual(await getCollection('missing-fields'), null);

  // ── normalizeCollection direct checks ─────────────────────────────────
  assert.strictEqual(normalizeCollection(null, 'x'), null);
  assert.strictEqual(normalizeCollection({ name: '', presetId: 'smb-animal' }, 'x'), null);
  assert.strictEqual(normalizeCollection({ name: 'ok' }, 'x'), null); // missing presetId
  const okNorm = normalizeCollection({ name: 'ok', presetId: 'smb-animal' }, 'x');
  assert.ok(okNorm && okNorm.id === 'x' && okNorm.createdAt === 0 && okNorm.paletteOverride === null);

  // ── delete ────────────────────────────────────────────────────────
  assert.strictEqual(await deleteCollection(b.id), true);
  assert.strictEqual(await getCollection(b.id), null);
  assert.strictEqual(await deleteCollection(b.id), false); // already gone, not an error

  // ── legacy trait (pre-collectionId shape) normalizes collectionId null ─
  const legacyRaw = {
    size: 2, pixels: [0, 0, 0, 0], palette: ['transparent', '#000000'],
    // no collectionId, no collectionPresetId — simulates a trait file
    // written before either field existed.
  };
  const legacyTrait = normalizeTraitAsset(legacyRaw, 'legacy-id');
  assert.ok(legacyTrait);
  assert.strictEqual(legacyTrait.collectionId, null);
  assert.strictEqual(legacyTrait.collectionPresetId, null);

  // ── a trait that DOES carry a real collectionId round-trips it ───────
  const withCollection = normalizeTraitAsset({ ...legacyRaw, collectionId: a.id }, 'new-id');
  assert.ok(withCollection);
  assert.strictEqual(withCollection.collectionId, a.id);

  console.log('collections-store.test.ts: all assertions passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(realCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
