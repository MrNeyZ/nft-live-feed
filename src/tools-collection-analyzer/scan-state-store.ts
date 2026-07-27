/**
 * Collection Analyzer — Stage 2 in-memory scan-state store.
 *
 * Plain Map, no Redis/Postgres/daemon — matches the project's existing
 * single-process architecture (see CLAUDE.md "Single-process SSE; no Redis
 * pub/sub"). One `ScanStateRecord` per scan, created when a scan starts and
 * swept `SCAN_STATE_TTL_MS` after it reaches a terminal state
 * (completed/error/cancelled). A scan that never finishes can't outlive the
 * process anyway (nothing persists across a restart), and client-disconnect
 * cancellation (see the SSE route) converts an "abandoned" scan straight to
 * `cancelled` immediately — so there is no separate "abandoned while
 * running" state to special-case.
 */
import crypto from 'crypto';
import type { CollectionAnalyzerInputKind } from './types';
import { SCAN_MAX_CONCURRENT, SCAN_STATE_TTL_MS } from './scan-limits';
import type { ScanErrorInfo, ScanProgressSnapshot, ScanResultSummary, ScanStateRecord, ScanStatus } from './scan-types';
import type { NormalizedAsset } from './types';

const scans = new Map<string, ScanStateRecord>();
let activeScanCount = 0;

export function activeScanSlots(): { active: number; max: number } {
  return { active: activeScanCount, max: SCAN_MAX_CONCURRENT };
}

/** Reserve a concurrency slot. Returns false (no slot reserved) when the
 *  process-wide cap is already reached — caller must reject the scan
 *  request without creating a ScanStateRecord. */
export function tryAcquireScanSlot(): boolean {
  if (activeScanCount >= SCAN_MAX_CONCURRENT) return false;
  activeScanCount++;
  return true;
}

/** Release a previously-acquired slot. Idempotent-safe to call at most once
 *  per acquired slot — callers release exactly once, when the scan reaches
 *  any terminal state. */
export function releaseScanSlot(): void {
  activeScanCount = Math.max(0, activeScanCount - 1);
}

export function createScan(collectionAddress: string, inputKind: CollectionAnalyzerInputKind, inputValue: string): ScanStateRecord {
  const scanId = crypto.randomUUID();
  const record: ScanStateRecord = {
    scanId,
    status: 'running',
    createdAt: Date.now(),
    terminalAt: null,
    collectionAddress,
    inputKind,
    inputValue,
    progress: {
      scanId, status: 'running', pagesFetched: 0, assetsDiscovered: 0,
      duplicatesSkipped: 0, retryState: null, elapsedMs: 0,
    },
    summary: null,
    assets: null,
    error: null,
    abortController: new AbortController(),
    ttlTimer: null,
  };
  scans.set(scanId, record);
  return record;
}

export function getScan(scanId: string): ScanStateRecord | undefined {
  return scans.get(scanId);
}

export function updateProgress(record: ScanStateRecord, tick: Partial<ScanProgressSnapshot>): void {
  record.progress = { ...record.progress, ...tick, scanId: record.scanId, status: record.status };
}

/** Transition a scan to a terminal state, release its concurrency slot, and
 *  schedule the TTL sweep. Idempotent — a second call on an already-terminal
 *  record is a no-op (guards against e.g. both the walker's completion path
 *  and a late client-disconnect handler both firing). */
export function finalizeScan(
  record: ScanStateRecord,
  status: Exclude<ScanStatus, 'running'>,
  opts: { summary?: ScanResultSummary; assets?: NormalizedAsset[]; error?: ScanErrorInfo },
): void {
  if (record.status !== 'running') return;
  record.status = status;
  record.terminalAt = Date.now();
  record.summary = opts.summary ?? null;
  record.assets = opts.assets ?? null;
  record.error = opts.error ?? null;
  record.progress = { ...record.progress, status, elapsedMs: record.terminalAt - record.createdAt };
  releaseScanSlot();
  scheduleTtlSweep(record);
}

function scheduleTtlSweep(record: ScanStateRecord): void {
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  const timer = setTimeout(() => { scans.delete(record.scanId); }, SCAN_STATE_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  record.ttlTimer = timer;
}

/** Test/ops helper — force-expire a scan immediately (used by tests to
 *  exercise the TTL-expiry access-denial path without waiting real time). */
export function expireScanNow(scanId: string): void {
  const record = scans.get(scanId);
  if (!record) return;
  if (record.ttlTimer) clearTimeout(record.ttlTimer);
  scans.delete(scanId);
}

export function scanCount(): number { return scans.size; }
