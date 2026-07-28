/**
 * Trait Extraction - reads a single entry out of an already-completed
 * trait-collection ZIP (for the previews / contact-sheet routes). Only
 * the central directory is listed (cheap); the matched entry alone is
 * decompressed - never the whole archive.
 */
import yauzl from 'yauzl';

/** Finds the first entry whose path ends with `suffix` and returns its
 *  decompressed bytes, or null if no entry matches / the archive can't be
 *  opened. Never throws. */
export function extractZipEntryBySuffix(zipPath: string, suffix: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { resolve(null); return; }
      let settled = false;
      const finish = (v: Buffer | null) => { if (settled) return; settled = true; resolve(v); try { zipfile.close(); } catch { /* ignore */ } };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (!entry.fileName.endsWith(suffix)) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) { finish(null); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => finish(Buffer.concat(chunks)));
          stream.on('error', () => finish(null));
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.on('error', () => finish(null));
    });
  });
}
