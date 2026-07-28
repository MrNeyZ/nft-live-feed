/**
 * trait-extractor-cli - shared atomic file write.
 *
 * Extracted from manifest.ts/local-image-cache.ts (Stage 5.3), which each
 * had a byte-identical copy of this helper. Writes to a `.tmp-<random>`
 * sibling then renames over the real path, so a kill -9 or power loss
 * mid-write can never leave a partially-written file at the real path.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export async function writeAtomic(destPath: string, content: Buffer | string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = path.join(path.dirname(destPath), `.tmp-${crypto.randomBytes(6).toString('hex')}-${path.basename(destPath)}`);
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, destPath);
}

export async function readJsonQuiet<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.promises.readFile(p, 'utf8')) as T; } catch { return null; }
}

export async function unlinkQuiet(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort */ }
}
