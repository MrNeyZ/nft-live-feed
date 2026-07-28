/**
 * trait-extractor-cli - unpacks the core's `trait-collection.zip` into the
 * CLI's browsable output layout (spec section 5's suggested tree):
 *   trait-collection/README.txt, eligibility.json, extraction-summary.json,
 *   unresolved-traits.json, generator-schema.json  -> reports/
 *   trait-collection/categories/...                -> traits/
 *   trait-collection/contact-sheets/...             -> contact-sheets/
 *
 * The ZIP itself is ALSO kept (as collection-traits.zip, copied by the
 * caller) so the output stays a single portable artifact too - this just
 * additionally saves the user from unzipping it to look around.
 */
import * as fs from 'fs';
import * as path from 'path';
import yauzl from 'yauzl';

const ROOT_PREFIX = 'trait-collection/';
const REPORT_FILES: ReadonlySet<string> = new Set([
  'README.txt', 'eligibility.json', 'extraction-summary.json', 'unresolved-traits.json', 'generator-schema.json',
]);

function mapEntryPath(zipEntryName: string): string | null {
  if (!zipEntryName.startsWith(ROOT_PREFIX)) return null;
  const rel = zipEntryName.slice(ROOT_PREFIX.length);
  if (REPORT_FILES.has(rel)) return path.join('reports', rel);
  if (rel.startsWith('categories/')) return path.join('traits', rel.slice('categories/'.length));
  if (rel.startsWith('contact-sheets/')) return path.join('contact-sheets', rel.slice('contact-sheets/'.length));
  return null;
}

export function extractZipToOutputDirs(zipPath: string, outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { reject(err ?? new Error('failed to open zip')); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
        const mapped = mapEntryPath(entry.fileName);
        if (!mapped) { zipfile.readEntry(); return; }
        const destPath = path.join(outputDir, mapped);
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) { zipfile.readEntry(); return; }
          fs.mkdir(path.dirname(destPath), { recursive: true }, () => {
            const out = fs.createWriteStream(destPath);
            stream.pipe(out);
            out.on('finish', () => zipfile.readEntry());
            out.on('error', () => zipfile.readEntry());
          });
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', (e) => reject(e));
    });
  });
}
