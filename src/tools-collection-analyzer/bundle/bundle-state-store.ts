/**
 * Collection Analyzer - Stage 3 in-memory bundle-job registry.
 *
 * Mirrors Stage 2's `scan-state-store.ts` architecture (plain Map, TTL
 * sweep, concurrency gate - no Redis/Postgres/daemon). Additionally owns
 * the per-job temp directory lifecycle under a dedicated OS temp
 * subdirectory (never inside the repo, never a client-supplied path) and a
 * startup sweep for orphaned directories left behind by a prior process
 * crash mid-job.
 */
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUNDLE_MAX_CONCURRENT_JOBS,
  BUNDLE_MAX_TEMP_DISK_BYTES,
  BUNDLE_MIN_FREE_DISK_BYTES,
  BUNDLE_STATE_TTL_MS,
  BUNDLE_TEMP_DIR_MAX_AGE_MS,
} from './bundle-limits';
import type { BundleErrorInfo, BundleJobRecord, BundleJobStatus, BundleOptions, BundleProgressSnapshot, FailedDownloadEntry } from './bundle-types';

const jobs = new Map<string, BundleJobRecord>();
let activeJobCount = 0;
let totalActiveDiskBytes = 0;

/** Dedicated app temp root - NOT inside the repo. Unpredictable per-job
 *  subdirectories live under this. */
export function bundleTempRoot(): string {
  return path.join(os.tmpdir(), 'vl-collection-bundles');
}

export function jobWorkDir(jobId: string): string {
  return path.join(bundleTempRoot(), jobId);
}

export function activeJobSlots(): { active: number; max: number } {
  return { active: activeJobCount, max: BUNDLE_MAX_CONCURRENT_JOBS };
}

export function tryAcquireJobSlot(): boolean {
  if (activeJobCount >= BUNDLE_MAX_CONCURRENT_JOBS) return false;
  activeJobCount++;
  return true;
}

export function releaseJobSlot(): void {
  activeJobCount = Math.max(0, activeJobCount - 1);
}

export function trackDiskBytes(delta: number): void {
  totalActiveDiskBytes = Math.max(0, totalActiveDiskBytes + delta);
}

export function currentTrackedDiskBytes(): number {
  return totalActiveDiskBytes;
}

export function wouldExceedTempDiskBudget(additionalBytes: number): boolean {
  return totalActiveDiskBytes + additionalBytes > BUNDLE_MAX_TEMP_DISK_BYTES;
}

/** Checks free space on the temp filesystem. Never throws - a statfs
 *  failure is treated as "unknown", which callers should treat
 *  conservatively (this is a best-effort check, not the only guard -
 *  BUNDLE_MAX_TOTAL_DOWNLOAD_BYTES and BUNDLE_MAX_TEMP_DISK_BYTES are hard
 *  caps regardless of what statfs reports). */
export async function checkDiskSpace(estimatedNeededBytes: number): Promise<{ ok: boolean; availableBytes: number | null }> {
  try {
    const stat = await fs.promises.statfs(os.tmpdir());
    const availableBytes = stat.bavail * stat.bsize;
    const ok = availableBytes >= estimatedNeededBytes + BUNDLE_MIN_FREE_DISK_BYTES;
    return { ok, availableBytes };
  } catch {
    return { ok: true, availableBytes: null };
  }
}

export function createBundleJob(scanId: string, options: BundleOptions, totalAssets: number): BundleJobRecord {
  const jobId = crypto.randomUUID();
  const progress: BundleProgressSnapshot = {
    jobId, scanId, status: 'queued', phase: 'queued',
    totalAssets, processedAssets: 0,
    successfulImages: 0, failedImages: 0,
    successfulOriginalMetadata: 0, failedOriginalMetadata: 0,
    bytesDownloaded: 0, archiveBytesWritten: null,
    elapsedMs: 0, totalParts: 1, currentPartNumber: 1,
  };
  const record: BundleJobRecord = {
    jobId, scanId, status: 'queued', options,
    createdAt: Date.now(), terminalAt: null,
    progress, failures: [], error: null,
    workDir: jobWorkDir(jobId), zipPath: null,
    collectionDisplayName: '', totalParts: 1, currentPartNumber: 1, parts: [],
    manifestStatus: 'pending', manifestPath: null,
    abortController: new AbortController(), ttlTimer: null,
  };
  jobs.set(jobId, record);
  return record;
}

export function getBundleJob(jobId: string): BundleJobRecord | undefined {
  return jobs.get(jobId);
}

export function updateBundleProgress(record: BundleJobRecord, tick: Partial<BundleProgressSnapshot>): void {
  record.progress = { ...record.progress, ...tick, jobId: record.jobId, scanId: record.scanId, status: record.status };
}

export function addFailure(record: BundleJobRecord, failure: FailedDownloadEntry): void {
  record.failures.push(failure);
}

/** Idempotent - a second call on an already-terminal record is a no-op. */
export function finalizeBundleJob(
  record: BundleJobRecord,
  status: Exclude<BundleJobStatus, 'queued' | 'downloading' | 'archiving'>,
  opts: { zipPath?: string; error?: BundleErrorInfo },
): void {
  if (record.status === status || !['queued', 'downloading', 'archiving'].includes(record.status)) return;
  record.status = status;
  record.terminalAt = Date.now();
  record.zipPath = opts.zipPath ?? null;
  record.error = opts.error ?? null;
  record.progress = { ...record.progress, status, phase: status, elapsedMs: record.terminalAt - record.createdAt };
  releaseJobSlot();
  trackDiskBytes(-record.progress.bytesDownloaded);
  scheduleJobTtlSweep(record);
}

function scheduleJobTtlSweep(record: BundleJobRecord): void {
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  const timer = setTimeout(() => {
    void removeJobWorkDir(record.jobId);
    jobs.delete(record.jobId);
  }, BUNDLE_STATE_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  record.ttlTimer = timer;
}

export async function removeJobWorkDir(jobId: string): Promise<void> {
  try { await fs.promises.rm(jobWorkDir(jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Test/ops helper - force-expire a job immediately (deletes its temp dir
 *  too), used by tests to exercise the TTL-expiry access-denial path
 *  without waiting real time. */
export async function expireBundleJobNow(jobId: string): Promise<void> {
  const record = jobs.get(jobId);
  if (!record) return;
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  await removeJobWorkDir(jobId);
  jobs.delete(jobId);
}

export function bundleJobCount(): number { return jobs.size; }

// ── Per-job progress pub/sub ─────────────────────────────────────────────
//
// A bundle job runs detached from any specific HTTP request (it must keep
// running if the SSE client disconnects - see the Stage 3 spec's explicit
// "do not auto-cancel on disconnect" requirement). The SSE route below is
// purely a SUBSCRIBER: it registers a listener, replays the job's CURRENT
// progress immediately (so a reconnect resumes mid-job), and forwards every
// further tick until the job reaches a terminal state or the client goes
// away. Multiple simultaneous subscribers (e.g. two tabs) are supported.
type ProgressListener = (p: BundleProgressSnapshot) => void;
const progressListeners = new Map<string, Set<ProgressListener>>();

export function subscribeToBundleProgress(jobId: string, cb: ProgressListener): () => void {
  let set = progressListeners.get(jobId);
  if (!set) { set = new Set(); progressListeners.set(jobId, set); }
  set.add(cb);
  return () => {
    const s = progressListeners.get(jobId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) progressListeners.delete(jobId);
  };
}

export function publishBundleProgress(jobId: string, p: BundleProgressSnapshot): void {
  const set = progressListeners.get(jobId);
  if (!set) return;
  for (const cb of set) cb(p);
}

/** Sweeps orphaned per-job temp directories older than
 *  BUNDLE_TEMP_DIR_MAX_AGE_MS - covers directories left behind by a prior
 *  process crash mid-job (no in-memory record survives a restart, so this
 *  is the only cleanup path for those). Called once at server startup. */
export async function sweepOrphanedBundleTempDirs(): Promise<void> {
  const root = bundleTempRoot();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return; // root doesn't exist yet - nothing to sweep
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(root, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (now - stat.mtimeMs > BUNDLE_TEMP_DIR_MAX_AGE_MS) {
        await fs.promises.rm(full, { recursive: true, force: true });
      }
    } catch { /* best-effort - skip entries we can't stat/remove */ }
  }
}
