/**
 * Trait Extraction - in-memory job registry. Mirrors
 * bundle/bundle-state-store.ts exactly (plain Map, TTL sweep, concurrency
 * gate, per-job temp dir under os.tmpdir(), progress pub/sub for
 * subscriber-only SSE) - independent module, own temp root, so cleanup of
 * one mode never touches the other's files.
 */
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TE_MAX_CONCURRENT_JOBS, TE_MIN_FREE_DISK_BYTES, TE_STATE_TTL_MS, TE_TEMP_DIR_MAX_AGE_MS } from 'trait-extraction-core';
import type { TraitExtractionConfig, TraitExtractionErrorInfo, TraitExtractionJobStatus, TraitExtractionProgressSnapshot, TraitValueEvidence } from 'trait-extraction-core';
import type { TraitExtractionJobRecord } from './te-server-types';

const jobs = new Map<string, TraitExtractionJobRecord>();
let activeJobCount = 0;

export function traitExtractionTempRoot(): string {
  return path.join(os.tmpdir(), 'vl-trait-extractions');
}
export function jobWorkDir(jobId: string): string {
  return path.join(traitExtractionTempRoot(), jobId);
}

export function activeJobSlots(): { active: number; max: number } {
  return { active: activeJobCount, max: TE_MAX_CONCURRENT_JOBS };
}
export function tryAcquireJobSlot(): boolean {
  if (activeJobCount >= TE_MAX_CONCURRENT_JOBS) return false;
  activeJobCount++;
  return true;
}
export function releaseJobSlot(): void {
  activeJobCount = Math.max(0, activeJobCount - 1);
}

export async function checkDiskSpace(estimatedNeededBytes: number): Promise<{ ok: boolean; availableBytes: number | null }> {
  try {
    const stat = await fs.promises.statfs(os.tmpdir());
    const availableBytes = stat.bavail * stat.bsize;
    return { ok: availableBytes >= estimatedNeededBytes + TE_MIN_FREE_DISK_BYTES, availableBytes };
  } catch {
    return { ok: true, availableBytes: null };
  }
}

export function createTraitExtractionJob(config: TraitExtractionConfig, totalValues: number): TraitExtractionJobRecord {
  const jobId = crypto.randomUUID();
  const progress: TraitExtractionProgressSnapshot = {
    jobId, scanId: config.scanId, status: 'queued', phase: 'queued',
    currentCategory: null, currentTraitValue: null,
    totalValues, processedValues: 0,
    uniqueImagesDownloaded: 0, comparisonsEvaluated: 0,
    resolvedHigh: 0, resolvedMedium: 0, resolvedLow: 0, resolvedUnresolved: 0, resolvedVisuallyIdentical: 0,
    failedImageCount: 0, bytesDownloaded: 0, elapsedMs: 0,
  };
  const record: TraitExtractionJobRecord = {
    jobId, scanId: config.scanId, status: 'queued', config,
    createdAt: Date.now(), terminalAt: null,
    progress, evidence: [], unresolvedValues: [], error: null,
    workDir: jobWorkDir(jobId), zipPath: null, collectionDisplayName: '',
    abortController: new AbortController(), ttlTimer: null,
  };
  jobs.set(jobId, record);
  return record;
}

export function getTraitExtractionJob(jobId: string): TraitExtractionJobRecord | undefined {
  return jobs.get(jobId);
}

export function updateTraitExtractionProgress(record: TraitExtractionJobRecord, tick: Partial<TraitExtractionProgressSnapshot>): void {
  record.progress = { ...record.progress, ...tick, jobId: record.jobId, scanId: record.scanId, status: record.status };
}

export function finalizeTraitExtractionJob(
  record: TraitExtractionJobRecord,
  status: Exclude<TraitExtractionJobStatus, 'queued' | 'downloading' | 'processing' | 'archiving'>,
  opts: { zipPath?: string; error?: TraitExtractionErrorInfo; evidence?: TraitValueEvidence[] },
): void {
  if (!['queued', 'downloading', 'processing', 'archiving'].includes(record.status)) return;
  record.status = status;
  record.terminalAt = Date.now();
  record.zipPath = opts.zipPath ?? null;
  record.error = opts.error ?? null;
  if (opts.evidence) record.evidence = opts.evidence;
  record.progress = { ...record.progress, status, phase: status, elapsedMs: record.terminalAt - record.createdAt };
  releaseJobSlot();
  scheduleTtlSweep(record);
}

function scheduleTtlSweep(record: TraitExtractionJobRecord): void {
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  const timer = setTimeout(() => { void removeJobWorkDir(record.jobId); jobs.delete(record.jobId); }, TE_STATE_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  record.ttlTimer = timer;
}

export async function removeJobWorkDir(jobId: string): Promise<void> {
  try { await fs.promises.rm(jobWorkDir(jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

export async function expireTraitExtractionJobNow(jobId: string): Promise<void> {
  const record = jobs.get(jobId);
  if (!record) return;
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  await removeJobWorkDir(jobId);
  jobs.delete(jobId);
}

export function traitExtractionJobCount(): number { return jobs.size; }

export async function sweepOrphanedTraitExtractionTempDirs(): Promise<void> {
  const root = traitExtractionTempRoot();
  let entries: string[];
  try { entries = await fs.promises.readdir(root); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(root, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (now - stat.mtimeMs > TE_TEMP_DIR_MAX_AGE_MS) await fs.promises.rm(full, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

// ── Per-job progress pub/sub (SSE is subscriber-only, mirrors bundle) ────
type ProgressListener = (p: TraitExtractionProgressSnapshot) => void;
const progressListeners = new Map<string, Set<ProgressListener>>();

export function subscribeToTraitExtractionProgress(jobId: string, cb: ProgressListener): () => void {
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
export function publishTraitExtractionProgress(jobId: string, p: TraitExtractionProgressSnapshot): void {
  const set = progressListeners.get(jobId);
  if (!set) return;
  for (const cb of set) cb(p);
}
