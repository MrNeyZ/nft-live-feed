/**
 * Helius Digital Asset Standard (DAS) getAsset call.
 * Docs: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api
 */

export interface NftMetadata {
  nftName: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  /** On-chain collection group address from DAS grouping (group_key === 'collection'). */
  collectionAddress: string | null;
  /** Magic Eden verified collection slug (e.g. "froganas"). Null when unknown. */
  meCollectionSlug: string | null;
}

// Minimal shape of the Helius DAS getAsset response we care about.
// Extended with `interface`, `token_info`, and `content.metadata.token_standard`
// so the mints pipeline can authoritatively classify NFT-vs-fungible
// before surfacing a row on /mints.
interface DasAsset {
  interface?: string;
  content?: {
    metadata?: { name?: string; token_standard?: string };
    links?: { image?: string };
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
    collection_metadata?: { name?: string };
  }>;
  token_info?: {
    decimals?: number;
    supply?: number;
  };
}

interface DasResponse {
  result?: DasAsset;
  error?: { code: number; message: string };
}

export async function getAsset(mintAddress: string): Promise<NftMetadata> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');

  const res = await fetch(
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'enrich',
        method: 'getAsset',
        params: { id: mintAddress },
      }),
      signal: AbortSignal.timeout(8_000),
    }
  );

  if (!res.ok) {
    throw new Error(`DAS getAsset HTTP ${res.status}`);
  }

  const json = (await res.json()) as DasResponse;
  if (json.error) {
    throw new Error(`DAS getAsset error ${json.error.code}: ${json.error.message}`);
  }

  const asset = json.result;
  const collection = asset?.grouping?.find((g) => g.group_key === 'collection');

  return {
    nftName: asset?.content?.metadata?.name ?? null,
    imageUrl: asset?.content?.links?.image ?? null,
    collectionName: collection?.collection_metadata?.name ?? null,
    collectionAddress: collection?.group_value ?? null,
    meCollectionSlug: null,  // populated separately in enrich.ts via ME public API
  };
}

// ── NFT classifier (used by the mints pipeline) ────────────────────────────
//
// `getAsset` above returns metadata even for fungible tokens — sales path
// uses it that way. The mints pipeline however must reject fungibles
// outright; this helper packages the DAS classification rules and runs
// them alongside the metadata fetch so we make exactly one DAS call per
// group. Returns both the verdict (`ok / reason / kind`) and the
// metadata so the enricher can use them in a single round-trip.

export type NftKind = 'core' | 'pnft' | 'legacy';
export interface NftVerdict {
  ok:      boolean;
  kind?:   NftKind;
  reason?: string;
}
export interface AssetVerifyResult {
  verdict: NftVerdict;
  meta:    NftMetadata;
}

function classifyDasAsset(asset: DasAsset | undefined): NftVerdict {
  if (!asset) return { ok: false, reason: 'no_asset' };
  const iface         = asset.interface ?? '';
  const tokenStandard = asset.content?.metadata?.token_standard ?? '';
  const decimals      = asset.token_info?.decimals;
  const fSupply       = asset.token_info?.supply;

  // ── Hard rejects ──
  if (iface === 'FungibleToken' || iface === 'FungibleAsset') {
    return { ok: false, reason: `interface=${iface}` };
  }
  if (tokenStandard === 'Fungible' || tokenStandard === 'FungibleAsset') {
    return { ok: false, reason: `tokenStandard=${tokenStandard}` };
  }
  if (typeof decimals === 'number' && decimals > 0) {
    return { ok: false, reason: `decimals=${decimals}` };
  }
  if (typeof fSupply === 'number' && fSupply > 1) {
    return { ok: false, reason: `supply=${fSupply}` };
  }

  // ── Accepts ──
  if (iface === 'MplCoreAsset')                      return { ok: true, kind: 'core' };
  if (iface === 'ProgrammableNFT')                   return { ok: true, kind: 'pnft' };
  if (iface === 'V1_NFT')                            return { ok: true, kind: 'legacy' };
  if (tokenStandard === 'NonFungible')               return { ok: true, kind: 'legacy' };
  if (tokenStandard === 'ProgrammableNonFungible')   return { ok: true, kind: 'pnft' };

  // ── Permissive fallback ──
  // Unknown interface but NFT-shaped (decimals 0, supply ≤ 1) — accept
  // as legacy. Conservative: rejects anything ambiguous beyond this.
  if ((decimals === 0 || decimals === undefined)
      && (fSupply == null || fSupply <= 1)) {
    return { ok: true, kind: 'legacy' };
  }
  return { ok: false, reason: `unknown_interface=${iface || '—'}` };
}

export async function verifyAndFetchAsset(mintAddress: string): Promise<AssetVerifyResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return {
      verdict: { ok: false, reason: 'no_api_key' },
      meta: { nftName: null, imageUrl: null, collectionName: null, collectionAddress: null, meCollectionSlug: null },
    };
  }
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'mint-verify',
          method: 'getAsset',
          params: { id: mintAddress },
        }),
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) {
      return {
        verdict: { ok: false, reason: `http_${res.status}` },
        meta: { nftName: null, imageUrl: null, collectionName: null, collectionAddress: null, meCollectionSlug: null },
      };
    }
    const json = (await res.json()) as DasResponse;
    if (json.error) {
      return {
        verdict: { ok: false, reason: `das_${json.error.code}` },
        meta: { nftName: null, imageUrl: null, collectionName: null, collectionAddress: null, meCollectionSlug: null },
      };
    }
    const asset      = json.result;
    const collection = asset?.grouping?.find((g) => g.group_key === 'collection');
    const meta: NftMetadata = {
      nftName:           asset?.content?.metadata?.name        ?? null,
      imageUrl:          asset?.content?.links?.image           ?? null,
      collectionName:    collection?.collection_metadata?.name  ?? null,
      collectionAddress: collection?.group_value                ?? null,
      meCollectionSlug:  null,
    };
    return { verdict: classifyDasAsset(asset), meta };
  } catch {
    return {
      verdict: { ok: false, reason: 'fetch_error' },
      meta: { nftName: null, imageUrl: null, collectionName: null, collectionAddress: null, meCollectionSlug: null },
    };
  }
}

// ── Wallet-collection holdings count (for /feed seller badge) ─────────────
//
// `searchAssets` with both ownerAddress + grouping=[collection,<addr>] returns
// a paginated list AND a `total` field. The default tokenType filter on
// some Helius DAS deployments excludes MPL Core / pNFT — we explicitly set
// `tokenType: 'all'` so the count covers every NFT shape. When searchAssets
// returns 0 we fall back to a paginated `getAssetsByOwner` scan that walks
// the seller's wallet and counts grouping matches client-side; that path
// has the highest fidelity (it's exactly what the explorer UIs render) at
// the cost of more bytes on the wire.
interface DasSearchResponse {
  result?: { total?: number; items?: unknown[] };
  error?:  { code: number; message: string };
}
interface DasOwnerScanItem {
  grouping?: Array<{ group_key: string; group_value: string }>;
}
interface DasOwnerScanResponse {
  result?: { total?: number; items?: DasOwnerScanItem[] };
  error?:  { code: number; message: string };
}

export type OwnerCollectionCountMethod = 'searchAssets' | 'getAssetsByOwner' | 'failed';
export interface OwnerCollectionCountVerbose {
  count:  number | null;
  method: OwnerCollectionCountMethod;
  /** Total assets seen during the fallback scan, useful for sanity
   *  ratio checks ("seller has 1200 assets, only 1 matched collection
   *  → DAS grouping mismatch"). */
  scanned?: number;
}

async function searchAssetsTotal(owner: string, collection: string): Promise<number | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'seller-count-search',
          method: 'searchAssets',
          params: {
            ownerAddress: owner,
            grouping:     ['collection', collection],
            tokenType:    'all',     // include MPL Core / pNFT / legacy
            page:         1,
            limit:        1,
            burnt:        false,
          },
        }),
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as DasSearchResponse;
    if (json.error) return null;
    const total = json.result?.total;
    return typeof total === 'number' && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

/** Fallback: walk getAssetsByOwner pages and count items whose
 *  grouping carries `{ group_key: 'collection', group_value: <addr> }`.
 *  Caps at 5 pages × 1000 items = 5 000 owned assets which covers
 *  every realistic seller wallet; whales beyond that get an
 *  underestimate but the badge still renders for them since they're
 *  trivially above the 3-NFT threshold. */
async function ownerScanForCollectionCount(
  owner: string,
  collection: string,
): Promise<{ count: number | null; scanned: number }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { count: null, scanned: 0 };
  const MAX_PAGES = 5;
  const PAGE_LIMIT = 1000;
  let count   = 0;
  let scanned = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'seller-count-scan',
            method: 'getAssetsByOwner',
            params: {
              ownerAddress: owner,
              page,
              limit: PAGE_LIMIT,
              displayOptions: { showCollectionMetadata: false },
            },
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return { count: null, scanned };
      const json = (await res.json()) as DasOwnerScanResponse;
      if (json.error) return { count: null, scanned };
      const items = json.result?.items ?? [];
      if (items.length === 0) break;
      for (const it of items) {
        scanned++;
        const groups = it.grouping ?? [];
        for (const g of groups) {
          if (g.group_key === 'collection' && g.group_value === collection) {
            count++;
            break;
          }
        }
      }
      if (items.length < PAGE_LIMIT) break;
    }
    return { count, scanned };
  } catch {
    return { count: null, scanned };
  }
}

/** Verbose variant — fast searchAssets path only. Never runs the
 *  expensive `getAssetsByOwner` fallback; that's exposed separately
 *  via `getOwnerCollectionDeepCount` and only invoked on demand by
 *  the active-dumper exact-count path. */
export async function getOwnerCollectionCountVerbose(
  owner: string,
  collectionAddress: string,
): Promise<OwnerCollectionCountVerbose> {
  const search = await searchAssetsTotal(owner, collectionAddress);
  return { count: search, method: search == null ? 'failed' : 'searchAssets' };
}

/** Deep scan — paginated `getAssetsByOwner` walk (up to 5 pages × 1000
 *  items = 5 000 owned assets) counting grouping matches client-side.
 *  Heavy, so caller should gate (cache + queue + active-dumper trigger).
 *  Returns `{count, scanned}` or `{count: null}` on failure. */
export async function getOwnerCollectionDeepCount(
  owner: string,
  collectionAddress: string,
): Promise<{ count: number | null; scanned: number }> {
  return ownerScanForCollectionCount(owner, collectionAddress);
}

/** Backward-compatible wrapper for callers that only want the count. */
export async function getOwnerCollectionCount(
  owner: string,
  collectionAddress: string,
): Promise<number | null> {
  const r = await getOwnerCollectionCountVerbose(owner, collectionAddress);
  return r.count;
}
