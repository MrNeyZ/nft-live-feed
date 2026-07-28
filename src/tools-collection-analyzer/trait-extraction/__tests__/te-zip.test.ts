/**
 * Trait Extraction - filename safety + ZIP structure tests.
 * Run: npm run test:collection-analyzer-te-zip
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yauzl from 'yauzl';
import { sanitizeTraitName, traitValueDirKey, shortHash } from '../te-filenames';
import { buildTraitZip, type TraitZipValueFiles } from '../te-zip';
import { extractZipEntryBySuffix } from '../te-zip-read';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

console.log('\nsanitizeTraitName / traitValueDirKey');
check('lowercases and hyphenates', () => assert.strictEqual(sanitizeTraitName('Laser Eyes'), 'laser-eyes'));
check('path traversal neutralized', () => assert.strictEqual(sanitizeTraitName('../../etc/passwd'), 'etcpasswd'));
check('empty/unsafe-only falls back to "value"', () => assert.strictEqual(sanitizeTraitName('!!!'), 'value'));
check('different raw values that sanitize identically get different hashes -> no collision', () => {
  const k1 = traitValueDirKey('Eyes', 'Laser!');
  const k2 = traitValueDirKey('Eyes', 'Laser?');
  assert.notStrictEqual(k1, k2);
  assert.ok(k1.startsWith('laser--'));
  assert.ok(k2.startsWith('laser--'));
});
check('same trait_type+value always hashes identically (deterministic)', () => {
  assert.strictEqual(shortHash('Eyes', 'Laser'), shortHash('Eyes', 'Laser'));
});
check('different trait_type with the same value produces a different dir key', () => {
  assert.notStrictEqual(traitValueDirKey('Eyes', 'Red'), traitValueDirKey('Hat', 'Red'));
});

function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { reject(err); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => { names.push(entry.fileName); zipfile.readEntry(); });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
    });
  });
}

async function main() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vl-te-zip-test-'));
  const png = Buffer.from([137, 80, 78, 71]); // fake PNG magic bytes - content doesn't matter for structure tests

  console.log('\nbuildTraitZip structure');

  await checkAsync('deterministic structure with all optional files present', async () => {
    const outPath = path.join(tmpDir, 'out1.zip');
    const values: TraitZipValueFiles[] = [
      { traitType: 'Eyes', outputDirKey: 'laser--abcd1234', candidate: png, candidateExpanded: png, changeMask: png, uncertaintyMask: png, preview: png, evidenceJson: '{}' },
      { traitType: 'Body', outputDirKey: 'green--efgh5678', candidate: png, candidateExpanded: null, changeMask: png, uncertaintyMask: null, preview: png, evidenceJson: '{}' },
    ];
    await buildTraitZip({
      readmeText: 'readme', eligibilityJson: '{}', extractionSummaryJson: '{}', unresolvedTraitsJson: '[]', generatorSchemaJson: '{}',
      values, contactSheets: [{ category: 'Eyes', png }, { category: 'Body', png }],
    }, outPath, new AbortController().signal);

    const entries = await listZipEntries(outPath);
    assert.ok(entries.includes('trait-collection/README.txt'));
    assert.ok(entries.includes('trait-collection/eligibility.json'));
    assert.ok(entries.includes('trait-collection/extraction-summary.json'));
    assert.ok(entries.includes('trait-collection/unresolved-traits.json'));
    assert.ok(entries.includes('trait-collection/generator-schema.json'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/candidate.png'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/candidate-expanded.png'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/change-mask.png'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/uncertainty-mask.png'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/preview.png'));
    assert.ok(entries.includes('trait-collection/categories/eyes/laser--abcd1234/evidence.json'));
    assert.ok(entries.includes('trait-collection/categories/body/green--efgh5678/candidate.png'));
    // Optional files that were null must NOT appear.
    assert.ok(!entries.includes('trait-collection/categories/body/green--efgh5678/candidate-expanded.png'));
    assert.ok(!entries.includes('trait-collection/categories/body/green--efgh5678/uncertainty-mask.png'));
    assert.ok(entries.includes('trait-collection/contact-sheets/eyes.png'));
    assert.ok(entries.includes('trait-collection/contact-sheets/body.png'));
  });

  await checkAsync('optional-only files are truly optional - a value with only candidate.png produces a minimal tree', async () => {
    const outPath = path.join(tmpDir, 'out2.zip');
    const values: TraitZipValueFiles[] = [
      { traitType: 'Hat', outputDirKey: 'cap--11112222', candidate: png, candidateExpanded: null, changeMask: null, uncertaintyMask: null, preview: null, evidenceJson: '{}' },
    ];
    await buildTraitZip({ readmeText: 'r', eligibilityJson: '{}', extractionSummaryJson: '{}', unresolvedTraitsJson: '[]', generatorSchemaJson: '{}', values, contactSheets: [] }, outPath, new AbortController().signal);
    const entries = await listZipEntries(outPath);
    const hatEntries = entries.filter((e) => e.startsWith('trait-collection/categories/hat/'));
    assert.deepStrictEqual(hatEntries.sort(), [
      'trait-collection/categories/hat/cap--11112222/candidate.png',
      'trait-collection/categories/hat/cap--11112222/evidence.json',
    ]);
  });

  await checkAsync('extractZipEntryBySuffix finds the right file without reading the whole archive', async () => {
    const outPath = path.join(tmpDir, 'out3.zip');
    const values: TraitZipValueFiles[] = [
      { traitType: 'Eyes', outputDirKey: 'laser--abcd1234', candidate: png, candidateExpanded: null, changeMask: null, uncertaintyMask: null, preview: png, evidenceJson: '{"x":1}' },
    ];
    await buildTraitZip({ readmeText: 'r', eligibilityJson: '{}', extractionSummaryJson: '{}', unresolvedTraitsJson: '[]', generatorSchemaJson: '{}', values, contactSheets: [{ category: 'Eyes', png }] }, outPath, new AbortController().signal);

    const preview = await extractZipEntryBySuffix(outPath, '/laser--abcd1234/preview.png');
    assert.ok(preview && preview.length > 0);
    const sheet = await extractZipEntryBySuffix(outPath, '/contact-sheets/eyes.png');
    assert.ok(sheet && sheet.length > 0);
    const missing = await extractZipEntryBySuffix(outPath, '/does-not-exist.png');
    assert.strictEqual(missing, null);
  });

  await checkAsync('category folder collision (two trait types sanitizing identically) gets a disambiguating suffix', async () => {
    const outPath = path.join(tmpDir, 'out4.zip');
    const values: TraitZipValueFiles[] = [
      { traitType: 'Eyes!', outputDirKey: 'a--11111111', candidate: png, candidateExpanded: null, changeMask: null, uncertaintyMask: null, preview: null, evidenceJson: '{}' },
      { traitType: 'Eyes?', outputDirKey: 'b--22222222', candidate: png, candidateExpanded: null, changeMask: null, uncertaintyMask: null, preview: null, evidenceJson: '{}' },
    ];
    await buildTraitZip({ readmeText: 'r', eligibilityJson: '{}', extractionSummaryJson: '{}', unresolvedTraitsJson: '[]', generatorSchemaJson: '{}', values, contactSheets: [] }, outPath, new AbortController().signal);
    const entries = await listZipEntries(outPath);
    const categoryDirs = new Set(entries.filter((e) => e.includes('/categories/')).map((e) => e.split('/')[2]));
    assert.strictEqual(categoryDirs.size, 2, 'both category folders must exist distinctly, not overwrite each other');
  });

  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
