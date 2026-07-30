/**
 * Collection Analyzer Tool — read-only DAS preview fetch.
 *
 * Single Helius DAS `getAssetsByGroup` (groupKey="collection") page — the
 * ONLY network call in the preview path. Strictly read-only: no signing, no
 * writes, no full-collection walk (that's explicitly out of scope for Stage
 * 1 — see docs). `result.total` is NOT the collection's full indexed size on
 * this provider (verified empirically — it mirrors the requested page size);
 * an exact total is only surfaced when the page came back short. See
 * `computeExactTotal` below.
 */
import type { NormalizedAsset, NormalizedAttribute } from './types';

/** Default / max preview size. Deliberately small — this is a preview, not
 *  an export. */
export const DEFAULT_PREVIEW_LIMIT = 20;
export const MAX_PREVIEW_LIMIT = 50;

const FETCH_TIMEOUT_MS = 10_000;

interface DasAttribute { trait_type?: string; value?: unknown }
interface DasGroupItem {
  id?: string;
  interface?: string;
  content?: {
    metadata?: { name?: string; attributes?: DasAttribute[] };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
    json_uri?: string;
  };
  compression?: { compressed?: boolean };
  grouping?: Array<{ group_key: string; group_value: string }>;
  burnt?: boolean;
}
interface DasGroupResponse {
  result?: { total?: number; items?: DasGroupItem[] };
  error?: { code?: number; message?: string };
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

function extractImage(item: DasGroupItem): string | null {
  const link = item.content?.links?.image;
  if (typeof link === 'string' && link.length > 0) return link;
  const file = item.content?.files?.[0];
  const fallback = file?.cdn_uri || file?.uri;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

function extractAttributes(item: DasGroupItem): NormalizedAttribute[] {
  const attrs = item.content?.metadata?.attributes;
  if (!Array.isArray(attrs)) return [];
  const out: NormalizedAttribute[] = [];
  for (const a of attrs) {
    if (typeof a?.trait_type !== 'string' || a.trait_type.length === 0) continue;
    if (a.value == null) continue;
    out.push({ trait_type: a.trait_type, value: String(a.value) });
  }
  return out;
}

function standardOf(item: DasGroupItem, compressed: boolean): NormalizedAsset['standard'] {
  if (compressed) return 'compressed';
  const iface = item.interface ?? '';
  if (iface === 'MplCoreAsset') return 'core';
  if (iface === 'ProgrammableNFT') return 'pnft';
  if (iface === 'V1_NFT' || iface === 'LEGACY_NFT') return 'legacy';
  if (iface === 'MplBubblegumV2') return 'compressed';
  return 'unknown';
}

export function normalizeAsset(item: DasGroupItem, fallbackCollectionAddress: string): NormalizedAsset {
  const group = item.grouping?.find((g) => g.group_key === 'collection');
  const compressed = item.compression?.compressed === true || item.interface === 'MplBubblegumV2';
  return {
    mint: item.id ?? '',
    name: item.content?.metadata?.name ?? null,
    image: extractImage(item),
    jsonUri: item.content?.json_uri ?? null,
    collectionAddress: group?.group_value ?? fallbackCollectionAddress,
    compressed,
    standard: standardOf(item, compressed),
    attributes: extractAttributes(item),
  };
}

export interface CollectionPreviewFetch {
  /** Exact indexed asset count for the collection, or null when unknown.
   *  See `computeExactTotal` — never guessed, never inflated. */
  totalAssets: number | null;
  assets: NormalizedAsset[];
  /** Non-null when the DAS call failed — caller turns this into a warning
   *  or a 502, never surfaces the raw message to the client verbatim. */
  dasError: string | null;
}

/**
 * Whether DAS `result.total` can be trusted as the collection's EXACT asset
 * count. Verified against live Helius mainnet responses: `total` mirrors the
 * number of items in the CURRENT page (bounded by the requested `limit`),
 * not the full indexed collection size — e.g. `limit=1` on a 5,000-asset
 * collection returns `total: 1`. This directly answers the Stage 1 research
 * question ("does getAssetsByGroup return an exact total?") — no, not
 * reliably, at least not on this provider/plan.
 *
 * The one case where it IS trustworthy: the page came back SHORT (fewer raw
 * items than requested) — that means DAS has no more pages, so `total`
 * (== the raw item count) is genuinely the whole group. A full page tells us
 * nothing beyond "at least this many assets exist" — never claimed as exact.
 *
 * Pure/exported so this contract is unit-testable without a network call.
 */
export function computeExactTotal(rawItemCount: number, limit: number, reportedTotal: number | undefined): number | null {
  if (rawItemCount >= limit) return null; // full page — can't confirm there's no more
  return typeof reportedTotal === 'number' && reportedTotal >= 0 ? reportedTotal : rawItemCount;
}

/** Fetch one preview page of a collection's assets. Never throws on
 *  transport/RPC errors — captured into `dasError` (missing API key still
 *  throws, matching the Holder Count tool's contract, since that's a
 *  server misconfiguration, not a caller-facing failure). */
export async function fetchCollectionPreview(
  collectionAddress: string,
  limit: number = DEFAULT_PREVIEW_LIMIT,
): Promise<CollectionPreviewFetch> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_PREVIEW_LIMIT));
  const url = rpcUrl();

  let json: DasGroupResponse;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'collection-analyzer-preview',
        method: 'getAssetsByGroup',
        params: {
          groupKey: 'collection',
          groupValue: collectionAddress,
          page: 1,
          limit: boundedLimit,
          displayOptions: { showCollectionMetadata: false, showFungible: false },
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { totalAssets: null, assets: [], dasError: `DAS HTTP ${res.status}` };
    json = (await res.json()) as DasGroupResponse;
  } catch (err) {
    return { totalAssets: null, assets: [], dasError: (err as Error).message || 'fetch_error' };
  }
  if (json.error) {
    return { totalAssets: null, assets: [], dasError: `DAS ${json.error.code ?? '?'}: ${json.error.message ?? 'error'}` };
  }

  const rawItems = json.result?.items ?? [];
  const assets = rawItems.filter((it) => it.burnt !== true).map((it) => normalizeAsset(it, collectionAddress));

  return {
    totalAssets: computeExactTotal(rawItems.length, boundedLimit, json.result?.total),
    assets,
    dasError: null,
  };
}
