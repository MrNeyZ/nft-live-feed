/**
 * Helius Digital Asset Standard (DAS) getAsset call.
 * Docs: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api
 */

import { TtlCache } from './cache';
import { incGetAsset, incSearchAssets, incGetAssetsByOwner, type GetAssetSource } from '../helius-credit-metrics';

export interface NftMetadata {
  nftName: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  /** On-chain collection group address from DAS grouping (group_key === 'collection'). */
  collectionAddress: string | null;
  /** Magic Eden verified collection slug (e.g. "froganas"). Null when unknown. */
  meCollectionSlug: string | null;
  /** Off-chain metadata URI from DAS `content.json_uri`. Surfaced so the
   *  enrichment layer can fetch it directly when DAS resolved no image
   *  (`content.links`/`files` empty) — common for freshly-minted MPL Core
   *  assets. Optional; absent on the empty/error metadata objects. */
  jsonUri?: string | null;
  /** On-chain VERIFIED creator addresses (DAS `creators[].address` where
   *  `verified === true`). A creator flag is verified only if that creator
   *  signed the metadata, so it is a spoof-proof, stable cross-drop identity
   *  — unlike the per-drop collection address / update authority. Surfaced so
   *  the blacklist can match issuers (e.g. DRiP) that mint every drop under a
   *  fresh collection address with no name/slug. Optional; absent on the
   *  empty/error metadata objects. */
  verifiedCreators?: string[] | null;
  /** True when DAS metadata carries an attribute whose `trait_type`/`key` is
   *  exactly "Artist". Narrow DRiP signal: DRiP per-drop cNFTs tag every asset
   *  with an "Artist" trait. Value is intentionally ignored. Optional; absent
   *  on the empty/error metadata objects. */
  hasArtistAttribute?: boolean;
}

// Minimal shape of the Helius DAS getAsset response we care about.
// Extended with `interface`, `token_info`, and `content.metadata.token_standard`
// so the mints pipeline can authoritatively classify NFT-vs-fungible
// before surfacing a row on /mints.
interface DasAsset {
  interface?: string;
  content?: {
    metadata?: {
      name?: string;
      token_standard?: string;
      attributes?: Array<{ trait_type?: string; key?: string; value?: unknown }>;
    };
    links?: { image?: string; animation_url?: string };
    files?: Array<{ uri?: string; cdn_uri?: string; mime?: string }>;
    json_uri?: string;
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
    collection_metadata?: { name?: string };
  }>;
  creators?: Array<{ address?: string; verified?: boolean; share?: number }>;
  token_info?: {
    decimals?: number;
    supply?: number;
  };
  ownership?: {
    owner?: string;
  };
}

/** Verified-creator addresses from a DAS asset. Only `verified === true`
 *  creators are returned — an unverified creator entry can be set to any
 *  address by the minter, so matching on it would be spoofable. */
function extractVerifiedCreators(asset: DasAsset | undefined): string[] {
  return (asset?.creators ?? [])
    .filter((c) => c.verified === true && typeof c.address === 'string' && c.address.length > 0)
    .map((c) => c.address as string);
}

/** True iff DAS metadata has an attribute whose `trait_type` or `key` is
 *  exactly "Artist" (case-sensitive). Value is not inspected. */
function extractHasArtistAttribute(asset: DasAsset | undefined): boolean {
  const attrs = asset?.content?.metadata?.attributes;
  if (!Array.isArray(attrs)) return false;
  return attrs.some((a) => a?.trait_type === 'Artist' || a?.key === 'Artist');
}

interface DasResponse {
  result?: DasAsset;
  error?: { code: number; message: string };
}

// ── Shared DAS asset cache ──────────────────────────────────────────────────
//
// All getAsset wrappers in this file route through fetchAsset so that:
//   1. Concurrent callers for the same address share a single in-flight request.
//   2. Repeat callers within 4h (sale_enrich + seller_collection_count race,
//      mint_enricher_verify + collection_confirm retries, etc.) get a cache hit.
//
// Two TTLs: successful DAS responses are immutable-ish NFT metadata (4h);
// null/failures are retried sooner in case the asset indexes (60s).

const ASSET_HIT_TTL_MS  = 4 * 60 * 60 * 1_000; // 4h
const ASSET_MISS_TTL_MS = 60_000;               // 60s

const assetHitCache  = new TtlCache<string, DasAsset>(ASSET_HIT_TTL_MS,  60_000);
const assetMissCache = new TtlCache<string, true>(ASSET_MISS_TTL_MS, 60_000);
const assetInflight  = new Map<string, Promise<DasAsset | null>>();

type FetchSource = 'network' | 'hit_cache' | 'miss_cache' | 'inflight';

/** Internal: cache → inflight dedup → network. Returns the raw asset plus
 *  the source so callers can increment credit metrics only on real RPCs. */
async function fetchAssetWithSource(
  address: string,
): Promise<{ asset: DasAsset | null; source: FetchSource }> {
  const hit = assetHitCache.get(address);
  if (hit !== undefined) return { asset: hit, source: 'hit_cache' };
  if (assetMissCache.has(address)) return { asset: null, source: 'miss_cache' };

  const existing = assetInflight.get(address);
  if (existing) {
    const asset = await existing;
    return { asset, source: 'inflight' };
  }

  const promise = (async (): Promise<DasAsset | null> => {
    try {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) { assetMissCache.set(address, true); return null; }

      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0',
          id:      'fetch-asset',
          method:  'getAsset',
          params:  { id: address },
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) { assetMissCache.set(address, true); return null; }

      const json = (await res.json()) as DasResponse;
      if (json.error || !json.result) { assetMissCache.set(address, true); return null; }

      assetHitCache.set(address, json.result);
      return json.result;
    } catch {
      assetMissCache.set(address, true);
      return null;
    } finally {
      assetInflight.delete(address);
    }
  })();

  assetInflight.set(address, promise);
  const asset = await promise;
  return { asset, source: 'network' };
}

/** Backward-compatible wrapper — returns asset only. */
export async function fetchAsset(address: string): Promise<DasAsset | null> {
  const { asset } = await fetchAssetWithSource(address);
  return asset;
}

// Resolve the NFT's still-image URL from a DAS getAsset result.
//
// Normal path: return `content.links.image` unchanged (png/jpeg/webp, animated
// gif that wsrv can static-frame, the Flork mypinata/ipfs gateway rewrite that
// /thumb applies downstream — all flow through here untouched).
//
// Video-only fallback: some NFTs are pure video assets — `links.image` ===
// `links.animation_url` === a `video/mp4` file, with NO separate still image
// anywhere in DAS or off-chain metadata (verified: Colony Planet, mint
// 4qfSRV5HjiqDDF6hXieMxBZ8udT2SbgxVaQuCsUFzaqL). Our /thumb backend (wsrv)
// can't decode video/mp4, so those render blank. Magic Eden's imgproxy CDN
// transcodes the first frame to a static JPEG, and the rest of the pipeline
// (/thumb -> wsrv output=png) renders that unchanged. We detect this case
// purely from fields already in the getAsset response (no extra DAS call, no
// ME token API) and substitute the ME img-cdn static-frame URL.
//
// Exact host/template verified against the asset above:
//   img-cdn.magiceden.dev/rs:fill:400:400:0:0/plain/<encoded-url>
// Do NOT use img.magiceden.dev (does not resolve) or rs:fit (returned 500).
function extractImageUrl(asset: DasAsset | undefined): string | null {
  const links        = asset?.content?.links;
  const stillImage   = links?.image ?? null;
  const animationUrl = links?.animation_url ?? null;
  const files        = asset?.content?.files ?? [];

  // Classify "video" strictly from DAS files[].mime — never guess from a bare
  // URL. A non-video asset short-circuits to the unchanged still-image path.
  const videoFile = files.find(
    (f) => typeof f.mime === 'string' && f.mime.startsWith('video/'),
  );
  if (videoFile) {
    const videoUrl =
      (typeof videoFile.uri === 'string' && videoFile.uri) ||
      animationUrl ||
      stillImage ||
      null;

    // A "separate still" is a links.image that points somewhere OTHER than the
    // video (a real poster frame); keep that untouched. Only when there is no
    // distinct still (image absent, or image === the video / === animation_url)
    // do we route through the ME static-frame transcode.
    const hasSeparateStill =
      !!stillImage && stillImage !== videoUrl && stillImage !== animationUrl;

    if (videoUrl && !hasSeparateStill) {
      return `https://img-cdn.magiceden.dev/rs:fill:400:400:0:0/plain/${encodeURIComponent(videoUrl)}`;
    }
  }

  return stillImage;
}

export async function getAsset(mintAddress: string, reason?: GetAssetSource): Promise<NftMetadata> {
  if (!process.env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY not set');

  const { asset, source } = await fetchAssetWithSource(mintAddress);
  if (reason && source === 'network') incGetAsset(reason);
  if (!asset) throw new Error('DAS getAsset failed');

  const collection = asset.grouping?.find((g) => g.group_key === 'collection');
  return {
    nftName:           asset.content?.metadata?.name         ?? null,
    imageUrl:          extractImageUrl(asset),
    collectionName:    collection?.collection_metadata?.name  ?? null,
    collectionAddress: collection?.group_value                ?? null,
    meCollectionSlug:  null,
    jsonUri:           asset.content?.json_uri                ?? null,
    verifiedCreators:  extractVerifiedCreators(asset),
    hasArtistAttribute: extractHasArtistAttribute(asset),
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

export async function verifyAndFetchAsset(mintAddress: string, reason?: GetAssetSource): Promise<AssetVerifyResult> {
  const EMPTY_META: NftMetadata = {
    nftName: null, imageUrl: null, collectionName: null,
    collectionAddress: null, meCollectionSlug: null,
  };
  if (!process.env.HELIUS_API_KEY) {
    return { verdict: { ok: false, reason: 'no_api_key' }, meta: EMPTY_META };
  }
  const { asset, source } = await fetchAssetWithSource(mintAddress);
  if (reason && source === 'network') incGetAsset(reason);
  if (!asset) {
    return { verdict: { ok: false, reason: 'fetch_error' }, meta: EMPTY_META };
  }
  const collection = asset.grouping?.find((g) => g.group_key === 'collection');
  const meta: NftMetadata = {
    nftName:           asset.content?.metadata?.name        ?? null,
    imageUrl:          extractImageUrl(asset),
    collectionName:    collection?.collection_metadata?.name ?? null,
    collectionAddress: collection?.group_value               ?? null,
    meCollectionSlug:  null,
    jsonUri:           asset.content?.json_uri               ?? null,
  };
  return { verdict: classifyDasAsset(asset), meta };
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
    incSearchAssets('seller_count_fast');
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
      incGetAssetsByOwner('seller_count_deep');
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

/** Collection asset owner — calls DAS `getAsset(collectionAddress)`
 *  and reads `ownership.owner`. For MPL Core collections this is the
 *  deployer wallet (e.g. `7MmgSY…cwdoPx` for fixture
 *  `He9QbMYH…NQRF1`); we use it as a final-tier fallback for the LMNFT
 *  explore-by-deployer link when:
 *    - `getLmnftInfoByMint` (featured-set scraper) misses, AND
 *    - `getLmnftStateForCollection` (on-chain LMNFT state decoder) misses.
 *  Returns null on RPC failure or when DAS hasn't indexed the
 *  collection asset yet (very fresh launches). Cheap single call,
 *  fire-and-forget by callers. */
/** Resolve the collection-level image URL via DAS getAsset on the
 *  collection address. Used as last-resort fallback for /feed cards
 *  whose per-NFT image never resolved through the standard enrichment
 *  chain (DAS asset image null + on-chain Metaplex null + Tensor +
 *  ME all empty). The collection image is a strictly-better signal
 *  than the abbr/color placeholder. Returns null on any failure /
 *  missing field. Cheap single RPC; callers should throttle. */
export async function getCollectionImage(collectionAddress: string, reason?: GetAssetSource): Promise<string | null> {
  const { asset, source } = await fetchAssetWithSource(collectionAddress);
  if (reason && source === 'network') incGetAsset(reason);
  if (!asset) return null;
  const link  = asset.content?.links?.image;
  const file  = asset.content?.files?.[0]?.cdn_uri ?? asset.content?.files?.[0]?.uri;
  const image = link || file || null;
  return typeof image === 'string' && image.length > 0 ? image : null;
}

export async function getCollectionOwner(collectionAddress: string, reason?: GetAssetSource): Promise<string | null> {
  const { asset, source } = await fetchAssetWithSource(collectionAddress);
  if (reason && source === 'network') incGetAsset(reason);
  if (!asset) return null;
  const owner = asset.ownership?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/** Collection-wide minted count — `searchAssets` filtered by
 *  `grouping=[collection, <addr>]` only (no owner). Returns the
 *  total number of assets DAS has indexed for the collection, which
 *  is a faithful proxy for "how many minted so far" on a launchpad
 *  drop. Distinct from supply (the planned cap) and from
 *  `observedMints` (what our session has personally seen).
 *
 *  Returns null on RPC failure / non-numeric `total`. */
export async function getCollectionMintedCount(collectionAddress: string): Promise<number | null> {
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
          id: 'collection-minted-count',
          method: 'searchAssets',
          params: {
            // NB: do NOT pass `tokenType` here. Helius DAS validates
            // `tokenType` only in conjunction with `ownerAddress` —
            // sending it with grouping-only filters returns
            // `-32000 Validation Error: Must provide owner_address when
            // using token_type field`, the result is null, and the
            // MINTED column shows "—" forever. Without `tokenType`
            // DAS defaults to NFTs+pNFTs+Core, which is exactly the
            // set we want for a launchpad mint count.
            grouping:  ['collection', collectionAddress],
            page:      1,
            limit:     1,
            burnt:     false,
          },
        }),
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!res.ok) {
      console.log(`[mints/minted-count] collection=${collectionAddress} http=${res.status} result=null`);
      return null;
    }
    const json = (await res.json()) as DasSearchResponse;
    if (json.error) {
      console.log(`[mints/minted-count] collection=${collectionAddress} dasErr=${json.error.code}:${json.error.message} result=null`);
      return null;
    }
    incSearchAssets('minted_count');
    const total = json.result?.total;
    const out = typeof total === 'number' && total >= 0 ? total : null;
    console.log(`[mints/minted-count] collection=${collectionAddress} total=${total} result=${out}`);
    return out;
  } catch (e) {
    console.log(`[mints/minted-count] collection=${collectionAddress} err=${(e as Error)?.message ?? 'unknown'} result=null`);
    return null;
  }
}
