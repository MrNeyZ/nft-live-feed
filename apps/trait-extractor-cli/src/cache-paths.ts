/**
 * trait-extractor-cli - global cache root layout (Stage 5.4 section 2).
 *
 * Stage 5.3's `LocalImageCache` lived under `--output/cache/`, i.e.
 * effectively per-job: two runs against the SAME collection into two
 * different `--output` dirs (or a fresh collection that happens to share
 * an image URL - e.g. a shared launchpad placeholder) never reused a
 * single downloaded byte. This module owns the single shared location
 * instead:
 *
 *   <cacheRoot>/
 *     images/<sha256(url)>.bin / .meta.json   (LocalImageCache's own shape,
 *                                               unchanged - only the ROOT
 *                                               moved, not the scheme)
 *     scans/<collectionAddress>.json          (metadata-cache.ts)
 *
 * Default root is `~/.trait-extractor-cli/cache` (via `os.homedir()`, not
 * XDG - a single fixed dot-folder name behaves identically on Linux/macOS/
 * Windows, which matters given the Windows-packaging goal in the spec's
 * deliverables). `--cache-dir`/config/env can override it.
 *
 * No automatic migration of Stage 5.3 `--output/cache/` directories - a
 * deliberate, documented known limitation (see docs). Upgrading re-downloads
 * images once into the new location; every existing corruption/permanent-
 * failure safeguard in local-image-cache.ts still applies to that re-fetch.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function defaultCacheRoot(): string {
  return path.join(os.homedir(), '.trait-extractor-cli', 'cache');
}

export function imagesDir(cacheRoot: string): string { return path.join(cacheRoot, 'images'); }
export function scansDir(cacheRoot: string): string { return path.join(cacheRoot, 'scans'); }

export async function ensureCacheDirs(cacheRoot: string): Promise<void> {
  await fs.promises.mkdir(imagesDir(cacheRoot), { recursive: true });
  await fs.promises.mkdir(scansDir(cacheRoot), { recursive: true });
}

export interface CacheStats {
  cacheRoot: string;
  imagesCount: number;
  imagesBytes: number;
  scansCount: number;
  scansBytes: number;
}

/** `countSuffix` names the file that represents ONE logical cache entry
 *  (images/: `.bin`, one per distinct cached URL; scans/: `.json`, one per
 *  collection) - every file's bytes still count toward the total, but only
 *  that suffix increments `count`, so "images" in the stats means
 *  "distinct cached URLs," not "files on disk" (each URL is really two
 *  files: `.bin` + `.meta.json`). */
async function dirStats(dir: string, countSuffix: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { count: 0, bytes: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
    if (!stat) continue;
    bytes += stat.size;
    if (entry.name.endsWith(countSuffix)) count++;
  }
  return { count, bytes };
}

/** Cache statistics (spec section 2's "cache statistics" requirement) -
 *  read-only, no side effects, safe to call from `--dry-run`/`--estimate`
 *  or a plain `--cache-stats`-style inspection without touching anything. */
export async function computeCacheStats(cacheRoot: string): Promise<CacheStats> {
  const images = await dirStats(imagesDir(cacheRoot), '.bin');
  const scans = await dirStats(scansDir(cacheRoot), '.json');
  return {
    cacheRoot,
    imagesCount: images.count,
    imagesBytes: images.bytes,
    scansCount: scans.count,
    scansBytes: scans.bytes,
  };
}

export async function clearCache(cacheRoot: string): Promise<void> {
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
}

/** Age/size-bounded automatic cleanup (spec section 2's "automatic cache
 *  cleanup"), run opportunistically after a successful job - never during
 *  an active job's own downloads. Scan entries are pruned purely by age
 *  (DAS data changes, so unbounded staleness is a silent-correctness
 *  footgun, not just a disk-usage one). Image entries are LRU-evicted by
 *  `.meta.json` mtime, and ONLY once total bytes exceed `maxImageBytes` -
 *  a cache under budget is left alone entirely. */
export async function cleanupCache(cacheRoot: string, opts: { scanMaxAgeMs: number; maxImageBytes: number }): Promise<{ scansPruned: number; imagesEvicted: number }> {
  let scansPruned = 0;
  let imagesEvicted = 0;
  const now = Date.now();

  const sDir = scansDir(cacheRoot);
  const scanEntries = await fs.promises.readdir(sDir).catch(() => [] as string[]);
  for (const name of scanEntries) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(sDir, name);
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat) continue;
    if (now - stat.mtimeMs > opts.scanMaxAgeMs) {
      await fs.promises.unlink(p).catch(() => {});
      scansPruned++;
    }
  }

  const iDir = imagesDir(cacheRoot);
  const imageEntries = await fs.promises.readdir(iDir).catch(() => [] as string[]);
  const metaFiles: { key: string; mtimeMs: number; totalBytes: number }[] = [];
  for (const name of imageEntries) {
    if (!name.endsWith('.meta.json')) continue;
    const key = name.slice(0, -'.meta.json'.length);
    const metaPath = path.join(iDir, name);
    const binPath = path.join(iDir, `${key}.bin`);
    const [metaStat, binStat] = await Promise.all([
      fs.promises.stat(metaPath).catch(() => null),
      fs.promises.stat(binPath).catch(() => null),
    ]);
    if (!metaStat) continue;
    metaFiles.push({ key, mtimeMs: metaStat.mtimeMs, totalBytes: metaStat.size + (binStat?.size ?? 0) });
  }
  let totalBytes = metaFiles.reduce((sum, m) => sum + m.totalBytes, 0);
  if (totalBytes > opts.maxImageBytes) {
    metaFiles.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const m of metaFiles) {
      if (totalBytes <= opts.maxImageBytes) break;
      await fs.promises.unlink(path.join(iDir, `${m.key}.meta.json`)).catch(() => {});
      await fs.promises.unlink(path.join(iDir, `${m.key}.bin`)).catch(() => {});
      totalBytes -= m.totalBytes;
      imagesEvicted++;
    }
  }
  return { scansPruned, imagesEvicted };
}
