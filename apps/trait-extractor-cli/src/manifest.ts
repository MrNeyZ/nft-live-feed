/**
 * trait-extractor-cli - persistent job manifest + per-value checkpoints
 * (Stage 5.3 section 5: local cache and resumability).
 *
 * Layout inside --output:
 *   job.json              manifest: config hash, status, target list,
 *                          which targets have a valid checkpoint.
 *   checkpoints/<hash>.json one settled ProcessValueResult per target. The
 *                          in-manifest/in-memory key is the EXACT string
 *                          `${traitType} ${traitValue}` - this must match
 *                          trait-extraction-core's own internal target key
 *                          (run-extraction.ts's `skipTargets`/
 *                          `resumedResults` are keyed the same way) so the
 *                          core can skip already-completed targets. The
 *                          on-disk filename is a sha256 of that key instead
 *                          of the raw string, since trait/value text isn't
 *                          guaranteed filesystem-safe.
 *
 * Every write (manifest AND checkpoint) goes to a `.tmp-<random>` sibling
 * file first, then an atomic rename over the real path - a kill -9 or
 * power loss mid-write can never leave a PARTIALLY WRITTEN file at the
 * real path; the real path is only ever a complete previous version or
 * the complete new version, never a half-written one.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ProcessValueResult } from 'trait-extraction-core';
import type { CliSelection } from './args';

/** Bumped whenever the on-disk checkpoint/manifest SHAPE changes in a way
 *  that makes old files unreadable by a newer CLI build - never silently
 *  reused; a mismatch forces a fresh run instead of misinterpreting
 *  stale data. Independent of the extraction ALGORITHM's own behavior
 *  (that's covered by the config hash below, since a different core
 *  package version changes results, not just the file shape). */
export const CACHE_FORMAT_VERSION = 1;

export interface ManifestConfig {
  collectionAddress: string;
  preset: string;
  selections: CliSelection[];
  coreVersion: string;
}

export interface JobManifest {
  cacheFormatVersion: number;
  jobId: string;
  configHash: string;
  config: ManifestConfig;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalTargets: number;
  completedTargetKeys: string[]; // traitValueDirKey-derived checkpoint keys already settled
}

function stableStringify(value: unknown): string {
  const seen = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(seen);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = seen((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(seen(value));
}

/** Deterministic job identity: identical collection+preset+selections+core
 *  version always produces the SAME id, so re-running the exact same
 *  command resumes; changing ANY of them produces a different id, so it
 *  can never accidentally resume into a mismatched prior run. */
export function computeConfigHash(config: ManifestConfig): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 24);
}

function manifestPath(outputDir: string): string {
  return path.join(outputDir, 'job.json');
}
function checkpointDir(outputDir: string): string {
  return path.join(outputDir, 'checkpoints');
}
/** The exact key trait-extraction-core uses internally for a target -
 *  MUST stay byte-identical to run-extraction.ts's `${target.traitType}
 *  ${target.traitValue}` so skipTargets/resumedResults line up. */
export function checkpointKeyFor(traitType: string, traitValue: string): string {
  return `${traitType} ${traitValue}`;
}
function checkpointFilename(key: string): string {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;
}
function checkpointPath(outputDir: string, key: string): string {
  return path.join(checkpointDir(outputDir), checkpointFilename(key));
}
/** Exposed for tests only (mirrors te-state-store.ts's jobWorkDir/
 *  traitExtractionTempRoot pattern) - lets a test corrupt/truncate a real
 *  checkpoint file on disk to exercise loadCheckpoint's rejection paths. */
export function checkpointFilePathForTests(outputDir: string, key: string): string {
  return checkpointPath(outputDir, key);
}

async function writeAtomic(destPath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = path.join(path.dirname(destPath), `.tmp-${crypto.randomBytes(6).toString('hex')}-${path.basename(destPath)}`);
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, destPath);
}

export async function initManifest(outputDir: string, config: ManifestConfig, totalTargets: number): Promise<JobManifest> {
  const configHash = computeConfigHash(config);
  const now = new Date().toISOString();
  const manifest: JobManifest = {
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    jobId: configHash,
    configHash,
    config,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    totalTargets,
    completedTargetKeys: [],
  };
  await fs.promises.mkdir(checkpointDir(outputDir), { recursive: true });
  await writeAtomic(manifestPath(outputDir), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Returns null (never throws) for: missing manifest, corrupt/unparsable
 *  JSON, or a cacheFormatVersion mismatch - all three mean "cannot safely
 *  resume from this directory", never "crash the CLI". */
export async function loadManifest(outputDir: string): Promise<JobManifest | null> {
  try {
    const raw = await fs.promises.readFile(manifestPath(outputDir), 'utf8');
    const parsed = JSON.parse(raw) as JobManifest;
    if (parsed.cacheFormatVersion !== CACHE_FORMAT_VERSION) return null;
    if (typeof parsed.configHash !== 'string' || !Array.isArray(parsed.completedTargetKeys)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveManifest(outputDir: string, manifest: JobManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await writeAtomic(manifestPath(outputDir), JSON.stringify(manifest, null, 2));
}

export async function markTargetCompleted(outputDir: string, manifest: JobManifest, key: string): Promise<void> {
  if (!manifest.completedTargetKeys.includes(key)) manifest.completedTargetKeys.push(key);
  await saveManifest(outputDir, manifest);
}

/** A resolved ProcessValueResult carries real Buffer fields (candidate/
 *  mask/preview PNG bytes) - plain JSON.stringify/parse turns a Buffer
 *  into a `{type:'Buffer',data:[...]}` plain object, which is NOT a Buffer
 *  (no `.length`/`.subarray`/etc), so a naive round-trip silently corrupts
 *  every resumed value's image data (sharp then fails with a confusing
 *  "Input file is missing" when the ZIP/contact-sheet step tries to read
 *  it). This replacer/reviver pair base64-encodes Buffers explicitly so a
 *  loaded checkpoint's images are byte-identical real Buffers again. */
/** `JSON.stringify` calls a value's own `.toJSON()` BEFORE handing it to
 *  the replacer - `Buffer.prototype.toJSON` already exists and returns
 *  `{type:'Buffer', data:[...]}`, so by the time this replacer runs, a
 *  real Buffer has ALREADY been turned into that plain-object shape; a
 *  naive `Buffer.isBuffer(value)` check here would never match. Detect
 *  the post-toJSON shape instead and re-encode it as base64. */
function checkpointReplacer(_key: string, value: unknown): unknown {
  if (
    value && typeof value === 'object' && !Array.isArray(value)
    && (value as { type?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)
  ) {
    return { __bufferBase64: Buffer.from((value as { data: number[] }).data).toString('base64') };
  }
  return value;
}
function checkpointReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__bufferBase64' in (value as Record<string, unknown>)) {
    return Buffer.from((value as { __bufferBase64: string }).__bufferBase64, 'base64');
  }
  return value;
}

/** A checkpoint file's own recorded key must match what we ask for - a
 *  defensive check against a corrupt/truncated file that happens to still
 *  parse as valid JSON (e.g. truncated mid-array-write leaving a
 *  syntactically-valid-but-wrong-content prefix is unlikely with atomic
 *  rename, but this catches disk corruption / manual tampering too). */
export async function loadCheckpoint(outputDir: string, key: string): Promise<ProcessValueResult | null> {
  try {
    const raw = await fs.promises.readFile(checkpointPath(outputDir, key), 'utf8');
    const parsed = JSON.parse(raw, checkpointReviver) as { checkpointKey?: string; result?: ProcessValueResult };
    if (parsed.checkpointKey !== key || !parsed.result) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

export async function saveCheckpoint(outputDir: string, key: string, result: ProcessValueResult): Promise<void> {
  await writeAtomic(checkpointPath(outputDir, key), JSON.stringify({ checkpointKey: key, result }, checkpointReplacer, 2));
}
