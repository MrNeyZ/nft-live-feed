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

  return router;
}
