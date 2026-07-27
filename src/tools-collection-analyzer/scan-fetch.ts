/**
 * Collection Analyzer — Stage 2 full-collection DAS pagination walker.
 *
 * Walks Helius DAS `getAssetsByGroup` (groupKey="collection") page by page,
 * deduplicating by mint/asset id across ALL pages (not just consecutive
 * ones). Read-only — no signing, no writes.
 *
 * Termination rules (checked in this order each iteration):
 *   1. safety cap reached (pages or assets) WITHOUT a short/empty page yet
 *      -> fatal `collection_too_large` (can't honestly claim completeness).
 *   2. overall wall-clock scan timeout exceeded -> fatal `scan_timeout`.
 *   3. cancellation (external AbortSignal fired) -> terminal `cancelled`.
 *   4. a page's raw item set is IDENTICAL to the immediately preceding
 *      page's (same ids, same order) -> stop gracefully as `completed`
 *      (provider pagination loop guard) with a warning, using what we have.
 *   5. page returned zero items -> stop, `completed`.
 *   6. page returned fewer items than requested (short page) -> stop,
 *      `completed` — this is genuinely the last page.
 *   7. otherwise continue to the next page.
 *
 * `result.total` is NEVER trusted (see Stage 1's fetch-preview.ts for the
 * empirical reason). The only trustworthy total is `uniqueAssets.size`
 * after a normal (non-error, non-cancelled) stop.
 */
import { normalizeAssetAttributesFull, type AttributeIssue } from './scan-normalize';
import type { NormalizedAsset, NormalizedAttribute } from './types';
import {
  SCAN_MAX_PAGES,
  SCAN_MAX_RETRIES_PER_PAGE,
  SCAN_PAGE_LIMIT,
  SCAN_PAGE_TIMEOUT_MS,
  SCAN_RETRY_BASE_MS,
  SCAN_RETRY_MAX_WAIT_MS,
  SCAN_TOTAL_TIMEOUT_MS,
} from './scan-limits';

interface DasScanItem {
  id?: string;
  interface?: string;
  content?: {
    metadata?: { name?: string; attributes?: unknown };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
    json_uri?: string;
  };
  compression?: { compressed?: boolean };
  grouping?: Array<{ group_key: string; group_value: string }>;
  burnt?: boolean;
}
interface DasGroupResponse {
  result?: { total?: number; items?: DasScanItem[] };
  error?: { code?: number; message?: string };
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

function extractImage(item: DasScanItem): string | null {
  const link = item.content?.links?.image;
  if (typeof link === 'string' && link.length > 0) return link;
  const file = item.content?.files?.[0];
  const fallback = file?.cdn_uri || file?.uri;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

function standardOf(item: DasScanItem, compressed: boolean): NormalizedAsset['standard'] {
  if (compressed) return 'compressed';
  const iface = item.interface ?? '';
  if (iface === 'MplCoreAsset') return 'core';
  if (iface === 'ProgrammableNFT') return 'pnft';
  if (iface === 'V1_NFT' || iface === 'LEGACY_NFT') return 'legacy';
  if (iface === 'MplBubblegumV2') return 'compressed';
  return 'unknown';
}

function normalizeScanAsset(item: DasScanItem, fallbackCollectionAddress: string): { asset: NormalizedAsset; issues: AttributeIssue[] } {
  const group = item.grouping?.find((g) => g.group_key === 'collection');
  const compressed = item.compression?.compressed === true || item.interface === 'MplBubblegumV2';
  const { attributes, issues } = normalizeAssetAttributesFull(item.content?.metadata?.attributes);
  const asset: NormalizedAsset = {
    mint: item.id ?? '',
    name: item.content?.metadata?.name ?? null,
    image: extractImage(item),
    jsonUri: item.content?.json_uri ?? null,
    collectionAddress: group?.group_value ?? fallbackCollectionAddress,
    compressed,
    standard: standardOf(item, compressed),
    attributes: attributes as NormalizedAttribute[],
  };
  return { asset, issues };
}

/** Tunable knobs, defaulted from `scan-limits.ts` but overridable per-call —
 *  exists purely so tests can run bounded, fast scans (small page/limit
 *  sizes, near-zero backoff) without touching real env-derived constants or
 *  waiting out real backoff timers. Production call sites never pass this. */
export interface ScanWalkOptions {
  pageLimit?: number;
  maxPages?: number;
  pageTimeoutMs?: number;
  maxRetriesPerPage?: number;
  retryBaseMs?: number;
  retryMaxWaitMs?: number;
  totalTimeoutMs?: number;
}

function backoffWaitMs(attempt: number, retryBaseMs: number, retryMaxWaitMs: number): number {
  const base = retryBaseMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * retryBaseMs;
  return Math.min(retryMaxWaitMs, Math.round(base + jitter));
}

/** Interruptible sleep — resolves early (and stays a normal resolve, not a
 *  rejection) when `signal` fires mid-wait, so a cancellation during a
 *  backoff pause stops promptly instead of finishing the wait first. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type PageFetchOutcome =
  | { ok: true; json: DasGroupResponse }
  | { ok: false; fatal: string }
  | { ok: false; cancelled: true };

async function fetchPageWithRetry(
  url: string,
  collectionAddress: string,
  page: number,
  externalSignal: AbortSignal,
  opts: Required<ScanWalkOptions>,
  onRetry: (attempt: number, waitMs: number, httpStatus: number | null) => void,
): Promise<PageFetchOutcome> {
  for (let attempt = 1; ; attempt++) {
    if (externalSignal.aborted) return { ok: false, cancelled: true };
    const timeoutSignal = AbortSignal.timeout(opts.pageTimeoutMs);
    const combinedSignal = AbortSignal.any([timeoutSignal, externalSignal]);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'collection-analyzer-scan',
          method: 'getAssetsByGroup',
          params: {
            groupKey: 'collection',
            groupValue: collectionAddress,
            page,
            limit: opts.pageLimit,
            displayOptions: { showCollectionMetadata: false, showFungible: false },
          },
        }),
        signal: combinedSignal,
      });

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt > opts.maxRetriesPerPage) return { ok: false, fatal: `http_${res.status}_retries_exhausted` };
        const waitMs = backoffWaitMs(attempt, opts.retryBaseMs, opts.retryMaxWaitMs);
        onRetry(attempt, waitMs, res.status);
        await interruptibleSleep(waitMs, externalSignal);
        if (externalSignal.aborted) return { ok: false, cancelled: true };
        continue;
      }
      if (!res.ok) return { ok: false, fatal: `http_${res.status}` };

      const json = (await res.json()) as DasGroupResponse;
      if (json.error) return { ok: false, fatal: `das_${json.error.code ?? '?'}` };
      return { ok: true, json };
    } catch (err) {
      if (externalSignal.aborted) return { ok: false, cancelled: true };
      if (attempt > opts.maxRetriesPerPage) return { ok: false, fatal: (err as Error).message || 'network_error_retries_exhausted' };
      const waitMs = backoffWaitMs(attempt, opts.retryBaseMs, opts.retryMaxWaitMs);
      onRetry(attempt, waitMs, null);
      await interruptibleSleep(waitMs, externalSignal);
      if (externalSignal.aborted) return { ok: false, cancelled: true };
    }
  }
}

export interface ScanWalkHooks {
  onProgress: (tick: {
    pagesFetched: number;
    assetsDiscovered: number;
    duplicatesSkipped: number;
    retryState: { page: number; attempt: number; waitMs: number; httpStatus: number | null } | null;
  }) => void;
}

export type ScanWalkResult =
  | {
      outcome: 'completed';
      assets: NormalizedAsset[];
      perAssetIssues: AttributeIssue[][];
      pagesFetched: number;
      duplicatesSkipped: number;
      warnings: string[];
    }
  | { outcome: 'cancelled'; pagesFetched: number; assetsScanned: number }
  | { outcome: 'error'; code: 'collection_too_large' | 'scan_timeout' | 'rpc_error'; message: string; pagesFetched: number; assetsScanned: number };

/** Walks the full collection. `externalSignal` fires on cancellation
 *  (client disconnect). Never throws — every failure path returns a typed
 *  `ScanWalkResult`. `overrides` is test-only (see ScanWalkOptions); real
 *  callers omit it and get the production constants from scan-limits.ts. */
export async function walkFullCollection(
  collectionAddress: string,
  externalSignal: AbortSignal,
  hooks: ScanWalkHooks,
  overrides?: ScanWalkOptions,
): Promise<ScanWalkResult> {
  const opts: Required<ScanWalkOptions> = {
    pageLimit: overrides?.pageLimit ?? SCAN_PAGE_LIMIT,
    maxPages: overrides?.maxPages ?? SCAN_MAX_PAGES,
    pageTimeoutMs: overrides?.pageTimeoutMs ?? SCAN_PAGE_TIMEOUT_MS,
    maxRetriesPerPage: overrides?.maxRetriesPerPage ?? SCAN_MAX_RETRIES_PER_PAGE,
    retryBaseMs: overrides?.retryBaseMs ?? SCAN_RETRY_BASE_MS,
    retryMaxWaitMs: overrides?.retryMaxWaitMs ?? SCAN_RETRY_MAX_WAIT_MS,
    totalTimeoutMs: overrides?.totalTimeoutMs ?? SCAN_TOTAL_TIMEOUT_MS,
  };
  const startedAt = Date.now();
  const url = rpcUrl();

  const uniqueAssets = new Map<string, NormalizedAsset>();
  const perAssetIssues = new Map<string, AttributeIssue[]>();
  let duplicatesSkipped = 0;
  let pagesFetched = 0;
  let prevPageIds: string[] | null = null;
  const warnings: string[] = [];

  for (let page = 1; page <= opts.maxPages; page++) {
    if (externalSignal.aborted) {
      return { outcome: 'cancelled', pagesFetched, assetsScanned: uniqueAssets.size };
    }
    if (Date.now() - startedAt > opts.totalTimeoutMs) {
      return {
        outcome: 'error', code: 'scan_timeout',
        message: `Scan exceeded the ${Math.round(opts.totalTimeoutMs / 1000)}s time budget.`,
        pagesFetched, assetsScanned: uniqueAssets.size,
      };
    }

    const result = await fetchPageWithRetry(url, collectionAddress, page, externalSignal, opts, (attempt, waitMs, httpStatus) => {
      hooks.onProgress({
        pagesFetched, assetsDiscovered: uniqueAssets.size, duplicatesSkipped,
        retryState: { page, attempt, waitMs, httpStatus },
      });
    });

    if (!result.ok) {
      if ('cancelled' in result) {
        return { outcome: 'cancelled', pagesFetched, assetsScanned: uniqueAssets.size };
      }
      return {
        outcome: 'error', code: 'rpc_error',
        message: `Provider request failed (${result.fatal}).`,
        pagesFetched, assetsScanned: uniqueAssets.size,
      };
    }

    pagesFetched++;
    const rawItems = result.json.result?.items ?? [];
    const liveItems = rawItems.filter((it) => it.burnt !== true);

    // Repeated-page guard: identical id sequence to the immediately
    // preceding page means the provider is looping (not advancing state).
    const idsThisPage = rawItems.map((it) => it.id ?? '');
    if (prevPageIds && idsThisPage.length > 0 && idsThisPage.length === prevPageIds.length
        && idsThisPage.every((id, i) => id === prevPageIds![i])) {
      warnings.push(`Page ${page} repeated the previous page's assets identically — stopped pagination early (provider pagination loop guard).`);
      hooks.onProgress({ pagesFetched, assetsDiscovered: uniqueAssets.size, duplicatesSkipped, retryState: null });
      break;
    }
    prevPageIds = idsThisPage;

    for (const item of liveItems) {
      const mint = item.id;
      if (!mint) continue;
      if (uniqueAssets.has(mint)) { duplicatesSkipped++; continue; }
      const { asset, issues } = normalizeScanAsset(item, collectionAddress);
      uniqueAssets.set(mint, asset);
      perAssetIssues.set(mint, issues);
    }

    hooks.onProgress({ pagesFetched, assetsDiscovered: uniqueAssets.size, duplicatesSkipped, retryState: null });

    // Safety cap: reached the page ceiling with a FULL page still coming
    // back — collection is definitively larger than we can honestly claim
    // completeness for.
    if (rawItems.length >= opts.pageLimit && page === opts.maxPages) {
      return {
        outcome: 'error', code: 'collection_too_large',
        message: `Collection has more than ${opts.maxPages * opts.pageLimit} indexed assets (the configured scan cap) — full scan aborted.`,
        pagesFetched, assetsScanned: uniqueAssets.size,
      };
    }

    if (rawItems.length === 0 || rawItems.length < opts.pageLimit) {
      // Zero or short page — genuinely done.
      break;
    }
  }

  return {
    outcome: 'completed',
    assets: [...uniqueAssets.values()],
    perAssetIssues: [...uniqueAssets.keys()].map((mint) => perAssetIssues.get(mint) ?? []),
    pagesFetched,
    duplicatesSkipped,
    warnings,
  };
}
