/**
 * Collection Analyzer Tool — read API.
 *
 * Stage 1 (unchanged contract):
 *   GET /api/tools/collection-analyzer/analyze?input=<address|mint|url>&limit=<n>
 * Read-only preview: resolves input down to an on-chain collection address,
 * then fetches ONE small Helius DAS `getAssetsByGroup` page (default 20,
 * capped at 50 assets). No wallet, no signing, no full-collection walk.
 *
 * Stage 2 (additive — bounded full-collection scan):
 *   GET  /api/tools/collection-analyzer/scan-stream?input=<...>            (SSE)
 *   GET  /api/tools/collection-analyzer/scan/:scanId/status                (poll fallback)
 *   GET  /api/tools/collection-analyzer/scan/:scanId/assets?offset=&limit= (paginated)
 *   GET  /api/tools/collection-analyzer/scan/:scanId/export/<file>         (downloads)
 * Walks the FULL collection via bounded, retried, cancellable DAS pagination
 * (see `tools-collection-analyzer/scan-fetch.ts` for termination rules and
 * `scan-limits.ts` for every safety cap). Still strictly read-only: no
 * wallet, no signing, no DB writes, no persistent job queue. Scan state
 * lives in an in-memory Map with a TTL sweep (`scan-state-store.ts`) — same
 * "single process, no Redis" architecture as the rest of the project.
 *
 * Marketplace URLs are resolved via the same sampled-listing approach the
 * Holder Count tool uses (`tools-holders/resolve-slug.ts`) — a public ME API
 * call maps slug -> a representative mint -> on-chain collection via DAS.
 * Marketplace HTML is never scraped.
 *
 * Stage 3 (additive — collection bundle downloads):
 *   POST /api/tools/collection-analyzer/scans/:scanId/bundles
 *   GET  /api/tools/collection-analyzer/bundles/:jobId/stream    (SSE, subscriber-only)
 *   GET  /api/tools/collection-analyzer/bundles/:jobId           (status)
 *   POST /api/tools/collection-analyzer/bundles/:jobId/cancel
 *   GET  /api/tools/collection-analyzer/bundles/:jobId/download
 * Generates a ZIP of images + metadata + analysis exports from an already-
 * completed Stage 2 scan — never re-scans. See
 * `tools-collection-analyzer/bundle/` for the SSRF-safe downloader, ZIP
 * builder, and in-memory job registry (same "single process, no Redis"
 * architecture, own TTL, own temp-dir lifecycle under os.tmpdir()).
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { buildCollectionAnalysis } from '../tools-collection-analyzer/analyze';
import {
  fetchCollectionPreview,
  DEFAULT_PREVIEW_LIMIT,
  MAX_PREVIEW_LIMIT,
} from '../tools-collection-analyzer/fetch-preview';
import { resolveInputToCollectionAddress } from '../tools-collection-analyzer/resolve-input';
import { executeScan } from '../tools-collection-analyzer/scan-run';
import {
  activeScanSlots,
  createScan,
  getScan,
  tryAcquireScanSlot,
} from '../tools-collection-analyzer/scan-state-store';
import { buildAssetsCsv } from '../tools-collection-analyzer/scan-csv';
import { SCAN_ASSETS_PAGE_DEFAULT, SCAN_ASSETS_PAGE_MAX } from '../tools-collection-analyzer/scan-limits';
import type { ScanStatusResponse } from '../tools-collection-analyzer/scan-types';
import * as fs from 'fs';
import * as path from 'path';
import { executeBundleJob } from '../tools-collection-analyzer/bundle/bundle-run';
import {
  activeJobSlots,
  bundleTempRoot,
  checkDiskSpace,
  createBundleJob,
  finalizeBundleJob,
  getBundleJob,
  publishBundleProgress,
  subscribeToBundleProgress,
  sweepOrphanedBundleTempDirs,
  tryAcquireJobSlot,
} from '../tools-collection-analyzer/bundle/bundle-state-store';
import { DEFAULT_BUNDLE_OPTIONS, isEmptySelection } from '../tools-collection-analyzer/bundle/bundle-types';
import type { BundleJobRecord, BundleOptions, BundlePartStatusWire, BundleStatusResponse } from '../tools-collection-analyzer/bundle/bundle-types';
import {
  BUNDLE_ESTIMATED_BYTES_PER_ASSET,
  BUNDLE_MAX_JOB_DOWNLOAD_BYTES,
  BUNDLE_MAX_TOTAL_ASSETS,
} from '../tools-collection-analyzer/bundle/bundle-limits';
import { buildTraitCollectionEligibility, TE_MAX_SELECTED_CATEGORIES, TE_MAX_SELECTED_VALUES, extractZipEntryBySuffix, sanitizeTraitName } from 'trait-extraction-core';
import { executeTraitExtractionJob } from '../tools-collection-analyzer/trait-extraction/te-run';
import {
  activeJobSlots as teActiveJobSlots,
  checkDiskSpace as teCheckDiskSpace,
  createTraitExtractionJob,
  finalizeTraitExtractionJob,
  getTraitExtractionJob,
  publishTraitExtractionProgress,
  subscribeToTraitExtractionProgress,
  sweepOrphanedTraitExtractionTempDirs,
  traitExtractionTempRoot,
  tryAcquireJobSlot as teTryAcquireJobSlot,
} from '../tools-collection-analyzer/trait-extraction/te-state-store';
import type {
  ExtractionPreset, TraitExtractionConfig, TraitExtractionSelection,
} from 'trait-extraction-core';
import type { TraitExtractionJobRecord, TraitExtractionStatusResponse } from '../tools-collection-analyzer/trait-extraction/te-server-types';

// Orphaned per-job temp directories from a prior process crash have no
// surviving in-memory record — the only place that can ever clean them up
// is a startup sweep. Fire-and-forget; never blocks router construction.
void sweepOrphanedBundleTempDirs();
void sweepOrphanedTraitExtractionTempDirs();

function scanStatusResponse(record: ReturnType<typeof getScan>): ScanStatusResponse | null {
  if (!record) return null;
  return {
    scanId: record.scanId,
    status: record.status,
    progress: record.progress,
    summary: record.summary ?? undefined,
    error: record.error ?? undefined,
  };
}

export function createCollectionAnalyzerRouter(): Router {
  const router = Router();
  // Multi-network-call route (slug/mint resolve + DAS preview) — same budget
  // class as the Holder Count tool.
  const previewLimit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/collection-analyzer' });
  // Full scans are far heavier (up to SCAN_MAX_PAGES sequential Helius
  // calls) — a much tighter per-IP budget on top of the process-wide
  // concurrency cap.
  const scanStartLimit = rateLimit({ limit: 3, windowMs: 5 * 60_000, label: 'tools/collection-analyzer-scan' });

  // ── Stage 1: preview ───────────────────────────────────────────────────
  router.get('/tools/collection-analyzer/analyze', previewLimit, async (req: Request, res: Response) => {
    const input = String(req.query.input ?? '').trim();
    if (!input) {
      return res.status(400).json({ ok: false, error: 'missing_input' });
    }

    const rawLimit = Number(req.query.limit);
    const previewLimitN = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PREVIEW_LIMIT) : DEFAULT_PREVIEW_LIMIT;

    const resolved = await resolveInputToCollectionAddress(input);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ ok: false, error: resolved.error });
    }
    const { inputKind, collectionAddress, extraWarnings } = resolved;

    try {
      const preview = await fetchCollectionPreview(collectionAddress, previewLimitN);
      const analysis = buildCollectionAnalysis({
        inputKind,
        inputValue: input,
        collectionAddress,
        totalAssets: preview.totalAssets,
        assets: preview.assets,
        dasError: preview.dasError,
        extraWarnings,
        nowIso: new Date().toISOString(),
      });
      return res.json({ ok: true, analysis });
    } catch (err) {
      console.error('[tools/collection-analyzer] preview fetch error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  // ── Stage 2: full-collection scan (SSE) ────────────────────────────────
  // GET /api/tools/collection-analyzer/scan-stream?input=<address|mint|url>
  router.get('/tools/collection-analyzer/scan-stream', scanStartLimit, async (req: Request, res: Response) => {
    const input = String(req.query.input ?? '').trim();
    if (!input) {
      return res.status(400).json({ ok: false, error: 'missing_input' });
    }

    const resolved = await resolveInputToCollectionAddress(input);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ ok: false, error: resolved.error });
    }

    // Concurrency cap checked BEFORE flushHeaders so an over-cap caller gets
    // a clean 429 JSON body instead of a 200-then-stuck SSE stream (mirrors
    // the SSE connection-cap check in server/sse.ts).
    if (!tryAcquireScanSlot()) {
      const { active, max } = activeScanSlots();
      console.warn(`[tools/collection-analyzer] scan rejected reason=capacity active=${active}/${max}`);
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ ok: false, error: 'scan_capacity' });
    }

    const record = createScan(resolved.collectionAddress, resolved.inputKind, input);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emit = (payload: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
      catch { /* client disconnected */ }
    };

    emit({ type: 'progress', scanId: record.scanId, status: 'running', pagesFetched: 0, assetsDiscovered: 0, duplicatesSkipped: 0, elapsedMs: 0 });

    // Client disconnect (tab closed, EventSource.close() called, network
    // drop) -> abort the in-flight walker promptly. This is the ONLY
    // cancellation trigger (see scan-fetch.ts's termination-rule doc) —
    // matches the project's existing SSE cleanup idiom (server/sse.ts).
    let cleaned = false;
    const onClientGone = () => {
      if (cleaned) return;
      cleaned = true;
      record.abortController.abort();
    };
    req.on('close', onClientGone);
    req.on('error', onClientGone);
    req.on('aborted', onClientGone);

    try {
      await executeScan(record, (progress) => {
        if (progress.status === 'running') {
          emit({ type: 'progress', ...progress });
          return;
        }
        if (progress.status === 'completed') {
          emit({ type: 'result', scanId: record.scanId, summary: record.summary });
        } else if (progress.status === 'cancelled') {
          emit({ type: 'cancelled', scanId: record.scanId, error: record.error });
        } else {
          emit({ type: 'error', scanId: record.scanId, error: record.error });
        }
        try { res.end(); } catch { /* already closed */ }
      });
    } finally {
      req.off('close', onClientGone);
      req.off('error', onClientGone);
      req.off('aborted', onClientGone);
    }
  });

  // ── Stage 2: status poll fallback ──────────────────────────────────────
  router.get('/tools/collection-analyzer/scan/:scanId/status', (req: Request, res: Response) => {
    const record = getScan(req.params.scanId);
    const status = scanStatusResponse(record);
    if (!status) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    return res.json({ ok: true, ...status });
  });

  // ── Stage 2: paginated assets over a completed scan ────────────────────
  router.get('/tools/collection-analyzer/scan/:scanId/assets', (req: Request, res: Response) => {
    const record = getScan(req.params.scanId);
    if (!record) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    if (record.status !== 'completed' || !record.assets) {
      return res.status(409).json({ ok: false, error: 'scan_not_completed', status: record.status });
    }
    const rawOffset = Number(req.query.offset);
    const rawLimit = Number(req.query.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), SCAN_ASSETS_PAGE_MAX) : SCAN_ASSETS_PAGE_DEFAULT;
    const page = record.assets.slice(offset, offset + limit);
    return res.json({
      ok: true,
      total: record.assets.length,
      offset,
      limit,
      assets: page,
    });
  });

  // ── Stage 2: exports ────────────────────────────────────────────────────
  // GET /api/tools/collection-analyzer/scan/:scanId/export/<file>
  // <file> ∈ collection-summary.json | assets.json | assets.csv | trait-counts.json
  // Only available for a completed scan; inherits the scan's TTL (once the
  // in-memory record is swept, exports 404 the same as /status).
  router.get('/tools/collection-analyzer/scan/:scanId/export/:file', (req: Request, res: Response) => {
    const record = getScan(req.params.scanId);
    if (!record) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    if (record.status !== 'completed' || !record.assets || !record.summary) {
      return res.status(409).json({ ok: false, error: 'scan_not_completed', status: record.status });
    }

    const file = req.params.file;
    switch (file) {
      case 'collection-summary.json': {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="collection-summary.json"');
        return res.send(JSON.stringify(record.summary, null, 2));
      }
      case 'assets.json': {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="assets.json"');
        return res.send(JSON.stringify(record.assets, null, 2));
      }
      case 'assets.csv': {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
        return res.send(buildAssetsCsv(record.assets));
      }
      case 'trait-counts.json': {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="trait-counts.json"');
        return res.send(JSON.stringify(record.summary.traitCategories, null, 2));
      }
      default:
        return res.status(404).json({ ok: false, error: 'unknown_export_file' });
    }
  });

  // ── Stage 3: bundle generation ──────────────────────────────────────────
  // POST /api/tools/collection-analyzer/scans/:scanId/bundles
  // GET  /api/tools/collection-analyzer/bundles/:jobId/stream   (SSE, subscriber-only)
  // GET  /api/tools/collection-analyzer/bundles/:jobId          (status)
  // POST /api/tools/collection-analyzer/bundles/:jobId/cancel
  // GET  /api/tools/collection-analyzer/bundles/:jobId/download
  //
  // A bundle job runs DETACHED from the request that created it — unlike
  // Stage 2's scan-stream (which IS the scan), here POST just kicks the job
  // off and returns a jobId immediately; the job keeps running even if every
  // SSE subscriber disconnects (explicit Stage 3 requirement — the user may
  // navigate away and come back). Only the dedicated /cancel endpoint stops
  // it. See tools-collection-analyzer/bundle/bundle-run.ts for the pipeline
  // and bundle-state-store.ts for the job registry + TTL + temp-dir lifecycle.
  const bundleCreateLimit = rateLimit({ limit: 5, windowMs: 10 * 60_000, label: 'tools/collection-analyzer-bundle-create' });

  function bundleStatusResponse(record: BundleJobRecord): BundleStatusResponse {
    const parts: BundlePartStatusWire[] = record.parts.map((p) => ({
      partNumber: p.partNumber,
      status: p.status,
      assetCount: p.range.assetCount,
      firstMint: p.range.firstMint,
      lastMint: p.range.lastMint,
      successfulImages: p.successfulImages,
      failedImages: p.failedImages,
      successfulOriginalMetadata: p.successfulOriginalMetadata,
      failedOriginalMetadata: p.failedOriginalMetadata,
      bytesDownloaded: p.bytesDownloaded,
      archiveBytesWritten: p.archiveBytesWritten,
      sha256: p.sha256,
      filename: p.zipFilename,
      downloadAvailable: p.status === 'completed' && !!p.zipPath,
      error: p.error ?? undefined,
    }));
    return {
      jobId: record.jobId,
      scanId: record.scanId,
      status: record.status,
      options: record.options,
      progress: record.progress,
      failures: record.failures,
      error: record.error ?? undefined,
      collectionDisplayName: record.collectionDisplayName,
      totalParts: record.totalParts,
      currentPartNumber: record.currentPartNumber,
      parts,
      manifestStatus: record.manifestStatus,
      manifestAvailable: record.manifestStatus === 'completed' && !!record.manifestPath,
    };
  }

  /** Shared path-traversal guard: `absPath` must resolve to somewhere
   *  strictly inside this job's own temp directory. Every file-serving
   *  route below (single-part legacy download, per-part download,
   *  manifest download) uses this — none of them ever accept a
   *  client-supplied filesystem path. */
  function isWithinJobDir(jobId: string, absPath: string): boolean {
    const expectedDir = path.resolve(bundleTempRoot(), jobId);
    return path.resolve(absPath).startsWith(expectedDir + path.sep);
  }

  function streamFileDownload(res: Response, jobId: string, absPath: string, contentType: string, downloadFilename: string): void {
    if (!isWithinJobDir(jobId, absPath)) {
      console.error('[tools/collection-analyzer] refusing to serve a path outside its job directory', jobId);
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    let size: number;
    try {
      size = fs.statSync(absPath).size;
    } catch {
      res.status(404).json({ ok: false, error: 'bundle_file_missing' });
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Length', String(size));
    const stream = fs.createReadStream(absPath);
    stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
    stream.pipe(res);
  }

  router.post('/tools/collection-analyzer/scans/:scanId/bundles', bundleCreateLimit, async (req: Request, res: Response) => {
    const scan = getScan(req.params.scanId);
    if (!scan) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    if (scan.status !== 'completed' || !scan.assets || !scan.summary) {
      return res.status(409).json({ ok: false, error: 'scan_not_completed', status: scan.status });
    }

    const rawOptions = (req.body && typeof req.body === 'object' ? (req.body as { options?: unknown }).options : undefined) as
      | Partial<Record<keyof BundleOptions, unknown>>
      | undefined;
    const options: BundleOptions = { ...DEFAULT_BUNDLE_OPTIONS };
    if (rawOptions && typeof rawOptions === 'object') {
      for (const key of Object.keys(DEFAULT_BUNDLE_OPTIONS) as Array<keyof BundleOptions>) {
        if (key in rawOptions) options[key] = Boolean(rawOptions[key]);
      }
    }

    if (isEmptySelection(options)) {
      return res.status(400).json({ ok: false, error: 'empty_selection' });
    }
    // Stage 4: collections beyond the per-part cap are automatically split
    // into multiple parts (see bundle-part-plan.ts) — only collections
    // beyond the TOTAL job cap are rejected outright.
    if (scan.assets.length > BUNDLE_MAX_TOTAL_ASSETS) {
      return res.status(413).json({ ok: false, error: 'collection_too_large', maxAssetCount: BUNDLE_MAX_TOTAL_ASSETS });
    }

    const needsNetwork = options.images || options.originalMetadata;
    const estimatedBytes = needsNetwork ? scan.assets.length * BUNDLE_ESTIMATED_BYTES_PER_ASSET : 0;
    if (estimatedBytes > BUNDLE_MAX_JOB_DOWNLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: 'collection_too_large' });
    }

    const diskCheck = await checkDiskSpace(estimatedBytes);
    if (!diskCheck.ok) {
      return res.status(507).json({ ok: false, error: 'insufficient_disk_space' });
    }

    if (!tryAcquireJobSlot()) {
      const { active, max } = activeJobSlots();
      console.warn(`[tools/collection-analyzer] bundle rejected reason=capacity active=${active}/${max}`);
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ ok: false, error: 'bundle_capacity' });
    }

    const record = createBundleJob(scan.scanId, options, scan.assets.length);
    const assets = scan.assets;
    const summary = scan.summary;
    // Fire-and-forget — the job MUST outlive this request/response cycle.
    // The outer catch is a last-resort safety net; executeBundleJob already
    // finalizes on every internal error path (see its own doc comment).
    void executeBundleJob({
      record, assets, summary,
      onProgress: (p) => publishBundleProgress(record.jobId, p),
    }).catch((err) => {
      console.error('[tools/collection-analyzer] bundle job crashed outside executeBundleJob', err);
      finalizeBundleJob(record, 'failed', { error: { code: 'archive_creation_failed', message: 'Unexpected internal error.' } });
      publishBundleProgress(record.jobId, record.progress);
    });

    return res.status(202).json({ ok: true, jobId: record.jobId, status: record.status });
  });

  router.get('/tools/collection-analyzer/bundles/:jobId/stream', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emit = (payload: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
      catch { /* client disconnected */ }
    };
    const frameType = (status: string): string =>
      status === 'completed' ? 'result' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'error' : 'progress';
    const sendTick = (p: BundleJobRecord['progress']) => {
      emit({ type: frameType(p.status), ...p, failures: record.failures, error: record.error ?? undefined });
    };

    // Replay current state immediately — a client attaching mid-job (or
    // reconnecting after navigating away) must see where things stand
    // without waiting for the next tick.
    sendTick(record.progress);

    const isTerminal = record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired';
    if (isTerminal) { res.end(); return; }

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* client gone */ }
    }, 20_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const unsubscribe = subscribeToBundleProgress(record.jobId, (p) => {
      sendTick(p);
      if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
        try { res.end(); } catch { /* already closed */ }
      }
    });

    // IMPORTANT: disconnecting here does NOT cancel the job (explicit Stage
    // 3 requirement) — it only detaches THIS subscriber. The job keeps
    // running; reconnect or poll GET .../:jobId to see where it ended up.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    req.on('aborted', cleanup);
  });

  router.get('/tools/collection-analyzer/bundles/:jobId', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });
    return res.json({ ok: true, ...bundleStatusResponse(record) });
  });

  router.post('/tools/collection-analyzer/bundles/:jobId/cancel', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });
    if (record.status !== 'queued' && record.status !== 'downloading' && record.status !== 'archiving') {
      return res.status(409).json({ ok: false, error: 'bundle_not_cancellable', status: record.status });
    }
    record.abortController.abort();
    return res.status(202).json({ ok: true, status: record.status });
  });

  // Legacy single-part download — unchanged behavior for a single-part job.
  // For a MULTI-part job this returns a structured explanation instead of
  // arbitrarily picking one part's archive (spec-required — never silently
  // return "a" ZIP when there are several).
  router.get('/tools/collection-analyzer/bundles/:jobId/download', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });
    if (record.totalParts > 1) {
      return res.status(409).json({
        ok: false,
        error: 'multipart_bundle',
        message: 'This bundle has multiple parts — download each part individually or fetch the manifest.',
        totalParts: record.totalParts,
        partsUrl: `/api/tools/collection-analyzer/bundles/${record.jobId}/parts/:partNumber/download`,
        manifestUrl: `/api/tools/collection-analyzer/bundles/${record.jobId}/manifest`,
      });
    }
    if (record.status !== 'completed' || !record.zipPath) {
      return res.status(409).json({ ok: false, error: 'bundle_not_completed', status: record.status });
    }
    const filename = record.parts[0]?.zipFilename ?? `collection-bundle-${record.jobId.slice(0, 8)}.zip`;
    streamFileDownload(res, record.jobId, record.zipPath, 'application/zip', filename);
  });

  // Stage 4: individual part download.
  router.get('/tools/collection-analyzer/bundles/:jobId/parts/:partNumber/download', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });

    const partNumber = Number(req.params.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > record.parts.length) {
      return res.status(400).json({ ok: false, error: 'invalid_part_number' });
    }
    const part = record.parts[partNumber - 1];
    if (part.status !== 'completed' || !part.zipPath) {
      return res.status(409).json({ ok: false, error: 'part_not_completed', status: part.status });
    }
    streamFileDownload(res, record.jobId, part.zipPath, 'application/zip', part.zipFilename ?? `part-${partNumber}.zip`);
  });

  // Stage 4: top-level manifest download.
  router.get('/tools/collection-analyzer/bundles/:jobId/manifest', (req: Request, res: Response) => {
    const record = getBundleJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'bundle_not_found' });
    if (record.manifestStatus !== 'completed' || !record.manifestPath) {
      return res.status(409).json({ ok: false, error: 'manifest_not_available', status: record.manifestStatus });
    }
    streamFileDownload(res, record.jobId, record.manifestPath, 'application/json', `${record.collectionDisplayName}-manifest.json`);
  });

  // ── Trait Extraction ("Download Trait Collection") ─────────────────────
  // POST /api/tools/collection-analyzer/scans/:scanId/trait-extractions/eligibility
  // POST /api/tools/collection-analyzer/scans/:scanId/trait-extractions
  // GET  /api/tools/collection-analyzer/trait-extractions/:jobId/stream    (SSE, subscriber-only)
  // GET  /api/tools/collection-analyzer/trait-extractions/:jobId          (status)
  // POST /api/tools/collection-analyzer/trait-extractions/:jobId/cancel
  // GET  /api/tools/collection-analyzer/trait-extractions/:jobId/download
  // GET  /api/tools/collection-analyzer/trait-extractions/:jobId/previews
  // GET  /api/tools/collection-analyzer/trait-extractions/:jobId/contact-sheets/:category
  //
  // Same detached-job architecture as bundles: SSE is subscriber-only,
  // disconnecting never cancels, REST status is the durable fallback. See
  // tools-collection-analyzer/trait-extraction/te-run.ts for the pixel
  // pipeline and te-state-store.ts for the job registry.
  const teEligibilityLimit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/collection-analyzer-te-eligibility' });
  const teCreateLimit = rateLimit({ limit: 5, windowMs: 10 * 60_000, label: 'tools/collection-analyzer-te-create' });

  function isWithinTraitExtractionJobDir(jobId: string, absPath: string): boolean {
    const expectedDir = path.resolve(traitExtractionTempRoot(), jobId);
    return path.resolve(absPath).startsWith(expectedDir + path.sep);
  }

  function traitExtractionStatusResponse(record: TraitExtractionJobRecord): TraitExtractionStatusResponse {
    return {
      jobId: record.jobId,
      scanId: record.scanId,
      status: record.status,
      config: record.config,
      progress: record.progress,
      evidenceSummary: record.evidence.map((e) => ({ traitType: e.traitType, traitValue: e.traitValue, status: e.confidence.status, score: e.confidence.score, outputDirKey: e.outputDirKey, searchDiagnostics: e.searchDiagnostics })),
      unresolvedValues: record.unresolvedValues,
      error: record.error ?? undefined,
      collectionDisplayName: record.collectionDisplayName,
      downloadAvailable: record.status === 'completed' && !!record.zipPath,
    };
  }

  router.post('/tools/collection-analyzer/scans/:scanId/trait-extractions/eligibility', teEligibilityLimit, (req: Request, res: Response) => {
    const scan = getScan(req.params.scanId);
    if (!scan) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    if (scan.status !== 'completed' || !scan.assets) {
      return res.status(409).json({ ok: false, error: 'scan_not_completed', status: scan.status });
    }
    const eligibility = buildTraitCollectionEligibility(scan.assets);
    return res.json({ ok: true, eligibility });
  });

  router.post('/tools/collection-analyzer/scans/:scanId/trait-extractions', teCreateLimit, async (req: Request, res: Response) => {
    const scan = getScan(req.params.scanId);
    if (!scan) return res.status(404).json({ ok: false, error: 'scan_not_found' });
    if (scan.status !== 'completed' || !scan.assets || !scan.summary) {
      return res.status(409).json({ ok: false, error: 'scan_not_completed', status: scan.status });
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { selections?: unknown; preset?: unknown; allowUnsuitable?: unknown };
    const preset: ExtractionPreset = body.preset === 'fast' || body.preset === 'thorough' ? body.preset : 'balanced';

    const rawSelections = Array.isArray(body.selections) ? body.selections : [];
    const selections: TraitExtractionSelection[] = [];
    for (const raw of rawSelections) {
      if (!raw || typeof raw !== 'object') continue;
      const traitType = (raw as { traitType?: unknown }).traitType;
      if (typeof traitType !== 'string' || traitType.length === 0) continue;
      const rawValues = (raw as { values?: unknown }).values;
      const values = Array.isArray(rawValues) ? rawValues.filter((v): v is string => typeof v === 'string').slice(0, TE_MAX_SELECTED_VALUES) : undefined;
      selections.push({ traitType, values });
    }
    const dedupedSelections = selections.slice(0, TE_MAX_SELECTED_CATEGORIES);

    if (dedupedSelections.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_selection' });
    }
    const totalSelectedValues = dedupedSelections.reduce((s, sel) => s + (sel.values?.length ?? TE_MAX_SELECTED_VALUES), 0);
    if (totalSelectedValues > TE_MAX_SELECTED_VALUES) {
      return res.status(413).json({ ok: false, error: 'selection_too_large', maxValues: TE_MAX_SELECTED_VALUES });
    }

    const eligibility = buildTraitCollectionEligibility(scan.assets);
    const allowUnsuitable = body.allowUnsuitable === true;
    if (eligibility.classification === 'unsuitable' && !allowUnsuitable) {
      return res.status(409).json({ ok: false, error: 'ineligible', classification: eligibility.classification, reasons: eligibility.reasons });
    }

    const estimatedBytes = totalSelectedValues * 8 * 1024 * 1024; // conservative per-value estimate
    const diskCheck = await teCheckDiskSpace(estimatedBytes);
    if (!diskCheck.ok) {
      return res.status(507).json({ ok: false, error: 'insufficient_disk_space' });
    }
    if (!teTryAcquireJobSlot()) {
      const { active, max } = teActiveJobSlots();
      console.warn(`[tools/collection-analyzer] trait-extraction rejected reason=capacity active=${active}/${max}`);
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ ok: false, error: 'te_capacity' });
    }

    const config: TraitExtractionConfig = { scanId: scan.scanId, selections: dedupedSelections, preset };
    const record = createTraitExtractionJob(config, 0);
    const assets = scan.assets;
    const summary = scan.summary;
    void executeTraitExtractionJob({
      record, assets, summary,
      onProgress: (p) => publishTraitExtractionProgress(record.jobId, p),
    }).catch((err) => {
      console.error('[tools/collection-analyzer] trait-extraction job crashed outside executeTraitExtractionJob', err);
      finalizeTraitExtractionJob(record, 'failed', { error: { code: 'archive_creation_failed', message: 'Unexpected internal error.' } });
      publishTraitExtractionProgress(record.jobId, record.progress);
    });

    return res.status(202).json({ ok: true, jobId: record.jobId, status: record.status });
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId/stream', (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'te_not_found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emit = (payload: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
      catch { /* client disconnected */ }
    };
    const frameType = (status: string): string =>
      status === 'completed' ? 'result' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'error' : 'progress';
    const sendTick = (p: TraitExtractionJobRecord['progress']) => {
      emit({ type: frameType(p.status), ...p, evidenceSummary: traitExtractionStatusResponse(record).evidenceSummary, error: record.error ?? undefined });
    };

    sendTick(record.progress);
    const isTerminal = ['completed', 'failed', 'cancelled', 'expired'].includes(record.status);
    if (isTerminal) { res.end(); return; }

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* client gone */ }
    }, 20_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const unsubscribe = subscribeToTraitExtractionProgress(record.jobId, (p) => {
      sendTick(p);
      if (['completed', 'failed', 'cancelled'].includes(p.status)) {
        try { res.end(); } catch { /* already closed */ }
      }
    });

    // Disconnecting does NOT cancel the job - same contract as bundles.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    req.on('aborted', cleanup);
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId', (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'te_not_found' });
    return res.json({ ok: true, ...traitExtractionStatusResponse(record) });
  });

  router.post('/tools/collection-analyzer/trait-extractions/:jobId/cancel', (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'te_not_found' });
    if (!['queued', 'downloading', 'processing', 'archiving'].includes(record.status)) {
      return res.status(409).json({ ok: false, error: 'te_not_cancellable', status: record.status });
    }
    record.abortController.abort();
    return res.status(202).json({ ok: true, status: record.status });
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId/download', (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'te_not_found' });
    if (record.status !== 'completed' || !record.zipPath) {
      return res.status(409).json({ ok: false, error: 'te_not_completed', status: record.status });
    }
    if (!isWithinTraitExtractionJobDir(record.jobId, record.zipPath)) {
      console.error('[tools/collection-analyzer] refusing to serve a trait-extraction zip outside its job directory', record.jobId);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
    let size: number;
    try { size = fs.statSync(record.zipPath).size; } catch { return res.status(404).json({ ok: false, error: 'te_file_missing' }); }
    const filename = `${record.collectionDisplayName || 'trait-collection'}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(size));
    const stream = fs.createReadStream(record.zipPath);
    stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
    stream.pipe(res);
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId/previews', (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record) return res.status(404).json({ ok: false, error: 'te_not_found' });
    if (record.status !== 'completed') {
      return res.status(409).json({ ok: false, error: 'te_not_completed', status: record.status });
    }
    const rawOffset = Number(req.query.offset);
    const rawLimit = Number(req.query.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 24;
    const page = record.evidence.slice(offset, offset + limit).map((e) => ({
      traitType: e.traitType,
      traitValue: e.traitValue,
      occurrenceCount: e.occurrenceCount,
      confidence: e.confidence,
      candidateBoundingBox: e.candidateBoundingBox,
      hasPreview: !!e.outputFiles.preview,
      previewUrl: e.outputFiles.preview ? `/api/tools/collection-analyzer/trait-extractions/${record.jobId}/values/${e.outputDirKey}/preview.png` : null,
    }));
    return res.json({ ok: true, total: record.evidence.length, offset, limit, values: page });
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId/values/:outputDirKey/preview.png', async (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record || record.status !== 'completed' || !record.zipPath) return res.status(404).json({ ok: false, error: 'te_not_found' });
    // outputDirKey is generated server-side (sanitized value + hash) - still
    // validated against a conservative charset before ever touching the
    // filesystem/zip reader, defense in depth against path traversal.
    if (!/^[a-z0-9._-]{1,80}$/.test(req.params.outputDirKey)) return res.status(400).json({ ok: false, error: 'invalid_output_key' });
    const buffer = await extractZipEntryBySuffix(record.zipPath, `/${req.params.outputDirKey}/preview.png`);
    if (!buffer) return res.status(404).json({ ok: false, error: 'preview_not_found' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  });

  router.get('/tools/collection-analyzer/trait-extractions/:jobId/contact-sheets/:category', async (req: Request, res: Response) => {
    const record = getTraitExtractionJob(req.params.jobId);
    if (!record || record.status !== 'completed' || !record.zipPath) return res.status(404).json({ ok: false, error: 'te_not_found' });
    const safeCategory = sanitizeTraitName(req.params.category);
    const buffer = await extractZipEntryBySuffix(record.zipPath, `/contact-sheets/${safeCategory}.png`);
    if (!buffer) return res.status(404).json({ ok: false, error: 'contact_sheet_not_found' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  });

  return router;
}
