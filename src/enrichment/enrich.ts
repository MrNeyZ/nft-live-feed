import { SaleEvent } from '../models/sale-event';
import { getAsset, NftMetadata } from './helius-das';
import { incGetAsset } from '../helius-credit-metrics';
import { getMetaplexOnchainMetadata, fetchMetaFromJsonUri } from './metaplex-onchain';
import { fetchFallbackMetadata } from './fallback-metadata';
import { TtlCache } from './cache';
import { SLUG_BLACKLIST } from '../db/blacklist';
import { getDerivedFloorLamports, slugForMint, nameForMint } from '../server/listings-store';
import { getMeStats } from './me-stats';
import { getPool } from '../db/client';
import { meCooldownActive, setMeCooldown } from '../me-api-cooldown';
import { primeCollectionCache } from './seller-collection-count';

const FAILURE_TTL_MS = 60 * 1000;       // 60 seconds — retry quickly after a transient DAS error
const FLOOR_TTL_MS   = 2 * 60 * 1000;  // 2 minutes — floor prices change frequently
const FLOOR_MISS_TTL_MS = 90 * 1000; // 90s — backoff after a floor lookup miss (was 5 min, reduced so transient 429s recover faster)
const OFFER_TTL_MS   = 90 * 1000;       // 90 seconds — offers change faster than floor

// 60s backoff after a complete enrichment failure (DAS + all fallbacks exhausted).
// Prevents re-running the full fallback chain (Metaplex onchain, Tensor, ME) within
// the retry window. The shared fetchAsset cache in helius-das.ts already handles DAS
// success caching, failure caching, and inflight dedup — this covers only the case
// where the fallback chain itself found nothing.
const failureCache = new TtlCache<string, true>(FAILURE_TTL_MS, 60_000);
/** Keyed by ME collection slug → floor price in lamports. Active sweep
 *  on a 60 s cadence — slugs we've populated but never re-read should
 *  not pin memory. Lazy expiry inside `get()` still applies for fast
 *  reads. */
const floorCache   = new TtlCache<string, number>(FLOOR_TTL_MS, 60_000);
/** Keyed by slug → marker that recent ME+Tensor floor lookups both failed.
 *  Prevents per-event refresh storms for slugs with no resolvable floor. */
const floorMissCache = new TtlCache<string, true>(FLOOR_MISS_TTL_MS, 60_000);
/** Slugs with an in-flight background floor refresh — dedup so concurrent
 *  events don't fan out into duplicate ME/Tensor calls. */
const floorRefreshInFlight = new Set<string>();
/** Keyed by ME collection slug → top offer price in lamports. */
const offerCache   = new TtlCache<string, number>(OFFER_TTL_MS, 60_000);

// ── Tensor collection slug cache ─────────────────────────────────────────────
// Keyed by ME collection slug (the filter input) → Tensor slugDisplay.
// Tensor collection slugs are stable so a long TTL is fine.
const TENSOR_SLUG_TTL_MS = 60 * 60 * 1000; // 1 hour
const tensorSlugCache     = new TtlCache<string, string>(TENSOR_SLUG_TTL_MS, 5 * 60_000);
const tensorSlugMissCache = new TtlCache<string, true>(10 * 60_000, 60_000);

/** Resolve the Tensor-native collection slug (slugDisplay) via find_collection.
 *  Uses ME slug or collection address as the filter key. Requires TENSOR_API_KEY.
 *  Returns null when the key is absent, the collection isn't on Tensor, or on
 *  any network error. Never throws. */
async function resolveTensorCollectionSlug(
  meSlug: string | null | undefined,
  collectionAddress: string | null | undefined,
): Promise<string | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  const filter = meSlug || collectionAddress;
  if (!filter) return null;

  const cached = tensorSlugCache.get(filter);
  if (cached !== undefined) return cached;
  if (tensorSlugMissCache.get(filter)) return null;

  try {
    const res = await fetch(
      `https://api.mainnet.tensordev.io/api/v1/collections/find_collection?filter=${encodeURIComponent(filter)}`,
      { headers: { 'x-tensor-api-key': key }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) { tensorSlugMissCache.set(filter, true); return null; }
    const j = await res.json() as { slugDisplay?: string };
    const slug = typeof j.slugDisplay === 'string' && j.slugDisplay ? j.slugDisplay : null;
    if (slug) {
      tensorSlugCache.set(filter, slug);
      // Also cache under the tensor slug itself for potential future lookups.
      tensorSlugCache.set(slug, slug);
    } else {
      tensorSlugMissCache.set(filter, true);
    }
    return slug;
  } catch {
    tensorSlugMissCache.set(filter, true);
    return null;
  }
}

// ── collection_address → ME slug recovery ────────────────────────────────────
// A burst of same-collection sales can transiently null ONE NFT's per-mint
// getMeTokenData lookup (ME rate-limit / timeout) while its siblings resolved
// fine. Since floorDelta is slug-only, that one row loses its floor chip even
// though the collection's slug is already known. This recovers the slug from
// the EXACT collection_address (positive cache → most-recent sale_events row).
// Never guesses by name or mint.
const COLL_SLUG_TTL_MS      = 30 * 60 * 1000; // 30 min — a collection's slug is stable
const COLL_SLUG_MISS_TTL_MS = 2 * 60 * 1000;  // 2 min — don't re-hit the DB for slug-less collections
const collSlugCache     = new TtlCache<string, { slug: string; collectionName: string | null }>(COLL_SLUG_TTL_MS, 5 * 60_000);
const collSlugMissCache = new TtlCache<string, true>(COLL_SLUG_MISS_TTL_MS, 60_000);

// ── mint_address → ME slug recovery (third tier) ─────────────────────────────
// Last-resort recovery for the case both prior tiers miss AND collection_address
// is empty (e.g. a legacy mint whose DAS grouping is absent): a transient
// getMeTokenData miss then has nothing to fall back on. Recover the slug from a
// prior sale_events row for the EXACT same mint. Same shapes/TTLs as the
// collection tier. Exact mint match only — never by name or collection.
const MINT_SLUG_TTL_MS      = 30 * 60 * 1000; // 30 min — a mint's slug is stable
const MINT_SLUG_MISS_TTL_MS = 2 * 60 * 1000;  // 2 min — don't re-hit the DB for slug-less mints
const mintSlugCache     = new TtlCache<string, { slug: string; collectionName: string | null }>(MINT_SLUG_TTL_MS, 5 * 60_000);
const mintSlugMissCache = new TtlCache<string, true>(MINT_SLUG_MISS_TTL_MS, 60_000);

interface MeTokenData {
  slug:           string | null;
  collectionName: string | null;
  nftName:        string | null;
  imageUrl:       string | null;
}

/**
 * Fetches the Magic Eden token record for a mint.
 * Returns slug, human-readable collectionName, nftName, and imageUrl (all may be null).
 * Uses the public ME v2 tokens API — no key required.
 * Never throws.
 */
// Optional ME API key — keyless calls hit Cloudflare's per-IP limiter
// (HTTP 429 / "error code: 1015"), which silently nulled the slug and thus
// the floor-delta chip (floor lookup is slug-only). Sending a key removes
// that limit; behaviour is unchanged (keyless) when neither var is set.
const ME_API_KEY = process.env.ME_API_KEY ?? process.env.MAGIC_EDEN_API_KEY ?? '';
const ME_TOKEN_HEADERS: Record<string, string> = ME_API_KEY
  ? { Authorization: `Bearer ${ME_API_KEY}` }
  : {};

export async function getMeTokenData(mint: string): Promise<MeTokenData> {
  const EMPTY: MeTokenData = { slug: null, collectionName: null, nftName: null, imageUrl: null };
  // Skip immediately if the process-wide ME cooldown is active (set by any ME
  // caller — rare feed, retardio scanner — hitting 429 on the shared IP quota).
  if (meCooldownActive()) return EMPTY;
  // Two attempts max: a single short-backoff retry recovers the slug after a
  // transient rate-limit (429 / CF 1015 / 403) or timeout under feed load.
  // Terminal client errors (404 unknown mint, 400/401) are NOT retried.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status = 0;
    let reason = 'unknown';
    try {
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/tokens/${mint}`,
        { headers: ME_TOKEN_HEADERS, signal: AbortSignal.timeout(4000) },
      );
      status = res.status;
      if (res.ok) {
        // ME v2 tokens shape (verified against live response):
        //   { collection: "<slug>", collectionName: "<Human Name>", name: "<NFT Name>", image, ... }
        const json = await res.json() as {
          collection?:     string;
          collectionName?: string;
          name?:           string;
          image?:          string;
        };
        return {
          slug:           json.collection     ?? null,
          collectionName: json.collectionName ?? null,
          nftName:        json.name           ?? null,
          imageUrl:       json.image          ?? null,
        };
      }
      reason = `http_${status}`;
      if (status === 429) {
        setMeCooldown(60_000);
        console.warn(`[enrich] ME 429 — process-wide cooldown set (60s)`);
        return EMPTY;
      }
      // Terminal client errors (404 unknown mint, 400/401) are not retried.
      const retryable = status === 403 || status === 408 || status >= 500;
      if (!retryable) {
        console.warn(`[enrich] ME slug resolve failed mint=${mint.slice(0, 8)} status=${status} reason=${reason} attempts=${attempt}`);
        return EMPTY;
      }
    } catch (e) {
      reason = (e instanceof Error && e.name === 'TimeoutError') ? 'timeout' : 'fetch_error';
      // network/timeout is transient → allowed to retry
    }
    if (attempt === 2) {
      // Single quiet line per mint only on FINAL failure — never on success
      // or on the first (retried) attempt, so logs don't flood under load.
      console.warn(`[enrich] ME slug resolve failed mint=${mint.slice(0, 8)} status=${status} reason=${reason} attempts=${attempt}`);
      return EMPTY;
    }
    // Short backoff (500–1000 ms) before the single retry.
    await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
  }
  return EMPTY; // unreachable (loop always returns by attempt 2) — satisfies tsc
}

/**
 * Recovers a collection's ME slug from a known collection_address, used only
 * when the per-mint getMeTokenData lookup returned null (transient burst miss).
 * Source order: in-memory positive cache → most-recent sale_events row with a
 * non-empty me_collection_slug for the SAME collection_address. Exact-address
 * match only — never by name or mint. Returns null when nothing is known.
 * Never throws.
 */
async function recoverSlugByCollection(
  collectionAddress: string,
): Promise<{ slug: string; collectionName: string | null } | null> {
  const cached = collSlugCache.get(collectionAddress);
  if (cached) return cached;
  if (collSlugMissCache.has(collectionAddress)) return null;
  try {
    const { rows } = await getPool().query<{ me_collection_slug: string; collection_name: string | null }>(
      `select me_collection_slug, collection_name
         from sale_events
        where collection_address = $1
          and me_collection_slug is not null
          and me_collection_slug <> ''
        order by block_time desc
        limit 1`,
      [collectionAddress],
    );
    const row = rows[0];
    if (row?.me_collection_slug) {
      const resolved = { slug: row.me_collection_slug, collectionName: row.collection_name ?? null };
      collSlugCache.set(collectionAddress, resolved);
      return resolved;
    }
  } catch (err) {
    // DB error → do NOT negative-cache; allow a later event to retry.
    console.warn(`[enrich] collection-slug DB recovery failed collection=${collectionAddress.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
  collSlugMissCache.set(collectionAddress, true);
  return null;
}

/**
 * Third-tier recovery: a mint's ME slug from a prior sale_events row for the
 * EXACT same mint_address. Used only when getMeTokenData returned null AND the
 * collection_address tier couldn't help (typically because collection_address
 * is empty). Source order: in-memory positive cache → most-recent sale_events
 * row with a non-empty me_collection_slug for the SAME mint. Exact-mint match
 * only — never by name or collection. Returns null when nothing is known.
 * Never throws.
 */
async function recoverSlugByMint(
  mint: string,
): Promise<{ slug: string; collectionName: string | null } | null> {
  const cached = mintSlugCache.get(mint);
  if (cached) return cached;
  if (mintSlugMissCache.has(mint)) return null;
  try {
    const { rows } = await getPool().query<{ me_collection_slug: string; collection_name: string | null }>(
      `select me_collection_slug, collection_name
         from sale_events
        where mint_address = $1
          and me_collection_slug is not null
          and me_collection_slug <> ''
        order by block_time desc
        limit 1`,
      [mint],
    );
    const row = rows[0];
    if (row?.me_collection_slug) {
      const resolved = { slug: row.me_collection_slug, collectionName: row.collection_name ?? null };
      mintSlugCache.set(mint, resolved);
      return resolved;
    }
  } catch (err) {
    // DB error → do NOT negative-cache; allow a later event to retry.
    console.warn(`[enrich] mint-slug DB recovery failed mint=${mint.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
  mintSlugMissCache.set(mint, true);
  return null;
}

/**
 * Fetches NFT name and image from Tensor's public mint API.
 * Returns null values on any failure; never throws.
 */
export async function getTensorMetadata(
  mint: string,
): Promise<Pick<NftMetadata, 'nftName' | 'imageUrl'>> {
  try {
    const res = await fetch(
      `https://api.tensor.so/api/v1/mint?mints=${mint}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return { nftName: null, imageUrl: null };
    const json = await res.json() as Array<{ name?: string; imageUri?: string }>;
    const item = Array.isArray(json) ? json[0] : null;
    if (!item) return { nftName: null, imageUrl: null };
    return {
      nftName:  item.name     ?? null,
      imageUrl: item.imageUri ?? null,
    };
  } catch {
    return { nftName: null, imageUrl: null };
  }
}

/**
 * Fetches the current floor price (in lamports) for a ME collection.
 * Uses the public ME v2 collections stats API — no key required.
 * Result is cached for FLOOR_TTL_MS (2 minutes).
 * Returns null on any failure; never throws.
 */
/** Synchronous, fetch-free floor lookup. Used by the /latest snapshot
 *  endpoint to retro-attach `floor_delta` to events on REST replies —
 *  the SSE `meta` channel delivers floor updates for live events but
 *  the REST snapshot has no way to carry them otherwise.
 *
 *  Source order:
 *    1. listings-store derived floor (min observed listing priceSol)
 *       — always present for actively-traded collections, no network.
 *    2. legacy ME-API floor cache — kept as a safety net for the
 *       brief window after boot before snapshots populate, and for
 *       slugs that don't have indexed listings yet.
 *  Cache miss on both → null → frontend hides the chip. */
export function peekCachedFloorLamports(slug: string | null | undefined): number | null {
  if (!slug) return null;
  const derived = getDerivedFloorLamports(slug);
  if (derived != null) return derived;
  if (!floorCache.has(slug)) return null;
  return floorCache.get(slug) ?? null;
}

async function fetchMeFloorLamports(slug: string): Promise<number | null> {
  const json = await getMeStats(slug);
  if (!json) return null;
  return typeof json.floorPrice === 'number' && json.floorPrice > 0
    ? json.floorPrice
    : null;
}

/** Tensor floor fallback. Uses `buyNowPrice` (lowest listing) from the
 *  authenticated `tensordev.io` collections endpoint. Returns null when
 *  TENSOR_API_KEY is unset or the slug isn't on Tensor. */
async function fetchTensorFloorLamports(slug: string): Promise<number | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.mainnet.tensordev.io/api/v1/collections?slug=${encodeURIComponent(slug)}`,
      {
        headers: { 'x-tensor-api-key': key },
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!res.ok) return null;
    const json = await res.json() as { stats?: { buyNowPrice?: string } };
    const raw = json?.stats?.buyNowPrice;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget background floor refresh. Tries ME first (public),
 *  Tensor second (key-gated). Populates `floorCache` on success so the
 *  NEXT event for this slug carries floorDelta. Logs `[floor-miss]` on
 *  total failure so coverage gaps are visible. Deduped via in-flight Set
 *  + miss TTL so we never fan out per-event. */
/**
 * Awaitable floor warm — same source order + caches/dedup as kickFloorRefresh,
 * but resolves once the floorCache is populated (or confirmed missing). Used by
 * the /latest snapshot so a reload can stamp floor_delta on first render instead
 * of waiting for live sales to warm the cache. Reuses getMeStats' own 12s cache
 * + in-flight dedup, so concurrent callers for one slug do one ME request.
 */
export async function warmFloorCache(slug: string | null | undefined): Promise<void> {
  if (!slug) return;
  if (getDerivedFloorLamports(slug) != null) return;  // listings-store covers it
  if (floorCache.has(slug)) return;
  if (floorMissCache.has(slug)) return;
  const me = await fetchMeFloorLamports(slug);
  if (me != null) { floorCache.set(slug, me); return; }
  const tnsr = await fetchTensorFloorLamports(slug);
  if (tnsr != null) { floorCache.set(slug, tnsr); return; }
  if (!meCooldownActive()) floorMissCache.set(slug, true);
}

function kickFloorRefresh(slug: string): void {
  if (floorCache.has(slug)) return;
  if (floorMissCache.has(slug)) return;
  if (floorRefreshInFlight.has(slug)) return;
  floorRefreshInFlight.add(slug);
  (async () => {
    try {
      const me = await fetchMeFloorLamports(slug);
      if (me != null) { floorCache.set(slug, me); return; }
      const tnsr = await fetchTensorFloorLamports(slug);
      if (tnsr != null) { floorCache.set(slug, tnsr); return; }
      // Only record a genuine miss. When ME cooldown was active the null is a
      // rate-limit artefact, not a "no floor" signal — caching it blocks the
      // next retry for 90 s even after the cooldown lifts.
      if (!meCooldownActive()) {
        floorMissCache.set(slug, true);
        console.log(`[floor-miss] collection=${slug} source=ME/Tensor`);
      }
    } finally {
      floorRefreshInFlight.delete(slug);
    }
  })().catch(() => { floorRefreshInFlight.delete(slug); });
}

/**
 * Fetches the highest active collection offer price (in lamports) for a ME collection.
 * Uses the public ME v2 collections/offers API — no key required.
 * The offers endpoint returns prices in SOL; converted to lamports for consistency.
 * Cached for OFFER_TTL_MS (90 seconds). Returns null on any failure; never throws.
 */
async function getCollectionTopOfferLamports(slug: string): Promise<number | null> {
  if (offerCache.has(slug)) return offerCache.get(slug)!;
  if (meCooldownActive()) return null;
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/offers?limit=20`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.status === 429) { setMeCooldown(60_000); return null; }
    if (!res.ok) return null;
    const json = await res.json() as Array<{ price?: number }>;
    if (!Array.isArray(json) || json.length === 0) return null;
    const prices = json.map((o) => (typeof o.price === 'number' ? o.price : 0)).filter((p) => p > 0);
    if (prices.length === 0) return null;
    const topSol = Math.max(...prices);
    // ME offers endpoint prices are in SOL (not lamports)
    const topLamports = Math.round(topSol * 1e9);
    offerCache.set(slug, topLamports);
    return topLamports;
  } catch {
    return null;
  }
}

/**
 * Enriches a SaleEvent with NFT metadata from Helius DAS, plus floor-price delta.
 *
 * Never throws. If enrichment fails for any reason the original event is
 * returned unchanged — ingestion must not be blocked by metadata lookup.
 */
// ─── Concurrency limiter ──────────────────────────────────────────────────────
//
// Enrich makes 4-5 HTTP calls per event (DAS, slug, floor, offer) and one
// DB UPDATE when it finishes. Under load without a cap, calls pile up and
// burst-complete together, overwhelming the pg Pool.
//
// MAX_CONCURRENT: enrich HTTP calls actually running.
// MAX_QUEUED:     bounded wait queue — arrivals beyond this are dropped.
//                 Small on purpose: a large queue is the stall→burst pattern.
const MAX_CONCURRENT = 8;
const MAX_QUEUED     = 12;

let   activeEnriches  = 0;
let   queuedEnriches  = 0;
let   skippedEnriches = 0;   // dropped because queue was full
const enrichQueue: Array<() => void> = [];

setInterval(() => {
  console.log(`[enrich] active=${activeEnriches}  queue=${queuedEnriches}  skipped=${skippedEnriches}`);
}, 10_000).unref();

export function activeEnrichCount():  number { return activeEnriches; }
export function queuedEnrichCount():  number { return queuedEnriches; }
export function skippedEnrichCount(): number { return skippedEnriches; }

function acquireEnrichSlot(): Promise<boolean> {
  if (activeEnriches < MAX_CONCURRENT) {
    activeEnriches++;
    return Promise.resolve(true);
  }
  if (queuedEnriches >= MAX_QUEUED) {
    // Queue full — drop to prevent stall→burst pattern.
    skippedEnriches++;
    return Promise.resolve(false);
  }
  queuedEnriches++;
  return new Promise<boolean>((resolve) => {
    enrichQueue.push(() => {
      queuedEnriches--;
      activeEnriches++;
      resolve(true);
    });
  });
}

function releaseEnrichSlot(): void {
  activeEnriches--;              // always release first — keeps the counter accurate
  const next = enrichQueue.shift();
  if (next) next();              // next() does activeEnriches++ to re-acquire the slot
}

// ─── In-flight dedup ─────────────────────────────────────────────────────────
//
// Two concurrent enriches for the same mint would fire duplicate HTTP calls.
// The second waits for the first and reuses the result.
const inFlightEnriches = new Map<string, Promise<SaleEvent>>();

export async function enrich(event: SaleEvent): Promise<SaleEvent> {
  // Tensor cNFT sales have their asset ID derived at parse time from the
  // Bubblegum `transfer` inner CPI (tensor-raw/price.ts:extractCnftAssetId).
  // If that failed, mintAddress stays '' and the empty-mint short-circuit
  // below skips all downstream metadata lookups.
  const mint = event.mintAddress;

  // If the same mint is already being enriched, reuse that promise.
  // Skip dedup when mint is still empty — each unresolved event is unique.
  const inflight = mint ? inFlightEnriches.get(mint) : undefined;
  if (inflight) {
    // Merge the in-flight result onto this event's identity fields.
    const resolved = await inflight;
    return {
      ...event,
      nftName:           resolved.nftName,
      imageUrl:          resolved.imageUrl,
      collectionName:    resolved.collectionName,
      collectionAddress: resolved.collectionAddress,
      meCollectionSlug:  resolved.meCollectionSlug,
      // floor/offer are sale-specific — recompute below rather than reuse
    };
  }

  const granted = await acquireEnrichSlot();
  if (!granted) {
    return event;  // dropped — counted in skippedEnriches, visible in 10s log
  }

  const promise = _enrich(event).finally(() => {
    releaseEnrichSlot();
    if (mint) inFlightEnriches.delete(mint);
  });
  if (mint) inFlightEnriches.set(mint, promise);
  return promise;
}

async function _enrich(event: SaleEvent): Promise<SaleEvent> {
  const mint = event.mintAddress;
  let metadata: NftMetadata | null = null;

  // Skip caches for empty mint — cache keyed by '' would conflate unrelated
  // unresolved cNFT events (different signatures, different assets).
  // Empty mint here means resolveCnftAssetId failed up-front; all downstream
  // HTTP lookups would return nothing, so short-circuit.
  if (!mint) {
    return applyMetadata(event, null);
  }
  if (!failureCache.has(mint)) {
    // ── Primary: Helius DAS ──────────────────────────────────────────────────
    try {
      incGetAsset('sale_enrich');
      metadata = await getAsset(mint);
      if (metadata) primeCollectionCache(mint, metadata.collectionAddress ?? null);
    } catch (err) {
      console.warn(`[enrich] DAS failed for ${mint.slice(0, 8)}...: ${(err as Error).message}`);
    }

    // ── On-chain Metaplex metadata (all types) ─────────────────────────────
    // Triggered when DAS is absent or returns a partial result (name/image null).
    // Works for legacy / pNFT; silently returns {} for Core / cNFT (no PDA).
    if (!metadata?.nftName || !metadata?.imageUrl) {
      const onchain = await getMetaplexOnchainMetadata(mint);
      if (onchain.nftName || onchain.imageUrl) {
        metadata = {
          nftName:           onchain.nftName  ?? metadata?.nftName  ?? null,
          imageUrl:          onchain.imageUrl ?? metadata?.imageUrl ?? null,
          collectionName:    metadata?.collectionName    ?? null,
          collectionAddress: metadata?.collectionAddress ?? null,
          meCollectionSlug:  metadata?.meCollectionSlug  ?? null,
          jsonUri:           metadata?.jsonUri ?? null,
          verifiedCreators:  metadata?.verifiedCreators ?? null,
          hasArtistAttribute: metadata?.hasArtistAttribute ?? false,
        };
      }
    }

    // ── Off-chain JSON via DAS json_uri (covers MPL Core) ─────────────────────
    // DAS occasionally returns a json_uri but empty content.links/files —
    // common for freshly-minted MPL Core assets (no Token-Metadata PDA, so the
    // on-chain fallback above silently no-ops). Fetch the json_uri ONCE and
    // pull the image straight from the off-chain JSON. Gated on imageUrl still
    // null, so it never runs when DAS already gave us an image.
    if (metadata && !metadata.imageUrl && metadata.jsonUri) {
      const offImg = (await fetchMetaFromJsonUri(metadata.jsonUri, mint)).image;
      if (offImg) metadata = { ...metadata, imageUrl: offImg };
    }

    // ── Slug resolution: LOCAL-FIRST, Magic Eden only on miss ────────────────
    // getMeTokenData(/v2/tokens/{mint}) was the dominant ME 429 source: ~1 call
    // per sale, mint-keyed so same-collection bursts never coalesce. Resolve the
    // slug from in-process / DB sources first and hit ME only when those miss
    // (or when DAS still left name/image null — ME is also the name/image
    // backstop). Exact mint / exact collection_address only; never by name,
    // never fuzzy, never an unrelated slug.
    let meCollectionSlug: string | null = null;
    let meCollectionName: string | null = null;
    const collAddr = metadata?.collectionAddress ?? event.collectionAddress ?? null;

    // 1) exact mint — listings-store in-memory reverse index (preloaded at boot
    //    + kept live via onMetaUpdate), else a prior sale_events row (cache→DB).
    const lsSlug = slugForMint(mint);
    if (lsSlug) {
      meCollectionSlug = lsSlug;
      meCollectionName = nameForMint(mint);
      if (Math.random() < 0.02) console.log(`[enrich] local slug hit source=mint-index mint=${mint.slice(0, 8)} slug=${lsSlug}`);
    } else {
      const byMint = await recoverSlugByMint(mint);
      if (byMint) {
        meCollectionSlug = byMint.slug;
        meCollectionName = byMint.collectionName;
        console.log(`[enrich] local slug hit source=mint mint=${mint.slice(0, 8)} slug=${byMint.slug}`);
      }
    }

    // 2) exact collection_address — in-memory cache → DB.
    if (!meCollectionSlug && collAddr) {
      const byColl = await recoverSlugByCollection(collAddr);
      if (byColl) {
        meCollectionSlug = byColl.slug;
        meCollectionName = byColl.collectionName;
        console.log(`[enrich] local slug hit source=collection collection=${collAddr.slice(0, 8)} slug=${byColl.slug} mint=${mint.slice(0, 8)}`);
      }
    }

    // 3) Magic Eden token endpoint — only when the slug is still unknown OR DAS
    //    left name/image null (ME is also our name/image backstop). Keeps the
    //    existing 2-attempt retry inside getMeTokenData.
    let meData: MeTokenData = { slug: null, collectionName: null, nftName: null, imageUrl: null };
    const needMeForMeta = !metadata?.nftName || !metadata?.imageUrl;
    if (!meCollectionSlug || needMeForMeta) {
      meData = await getMeTokenData(mint);
      if (!meCollectionSlug && meData.slug) {
        meCollectionSlug = meData.slug;
        // 4) Seed local caches so the rest of a same-collection burst skips ME.
        mintSlugCache.set(mint, { slug: meData.slug, collectionName: meData.collectionName });
        if (collAddr) collSlugCache.set(collAddr, { slug: meData.slug, collectionName: meData.collectionName });
        if (Math.random() < 0.05) console.log(`[enrich] ME token fetch used mint=${mint.slice(0, 8)} slug=${meData.slug}`);
      }
    }
    // collectionName backstop — ME top-level name when DAS/local had none.
    meCollectionName = meCollectionName ?? meData.collectionName;
    if (metadata) {
      // ME's top-level `collectionName` is the human-readable collection name
      // (DAS almost always omits this for Core / pNFT). Backfill when DAS's
      // `grouping[*].collection_metadata.name` came up null.
      metadata = {
        ...metadata,
        meCollectionSlug,
        collectionName: metadata.collectionName ?? meCollectionName ?? null,
      };
    }

    // ── Tensor → Magic Eden name/image fallback (all NFT types) ─────────────
    // Triggered when primary sources (DAS + on-chain) leave name or image null.
    // Tensor is tried first; ME fills whatever Tensor couldn't.
    if (!metadata?.nftName || !metadata?.imageUrl) {
      const tensor = await getTensorMetadata(mint);
      const tName  = tensor.nftName  || null;
      const tImage = tensor.imageUrl || null;
      if (tName || tImage) {
        console.log(`[enrich] Tensor fallback ok  ${mint.slice(0, 8)}...`);
      }

      // ME: prefer already-fetched meData fields over another round-trip.
      const meName  = meData.nftName  || null;
      const meImage = meData.imageUrl || null;
      if ((meName || meImage) && (!tName || !tImage)) {
        console.log(`[enrich] ME fallback ok  ${mint.slice(0, 8)}...`);
      }

      const mergedName  = metadata?.nftName  || tName  || meName  || null;
      const mergedImage = metadata?.imageUrl || tImage || meImage || null;

      if (mergedName !== (metadata?.nftName ?? null) || mergedImage !== (metadata?.imageUrl ?? null)) {
        metadata = {
          nftName:           mergedName,
          imageUrl:          mergedImage,
          collectionName:    metadata?.collectionName    ?? meCollectionName ?? null,
          collectionAddress: metadata?.collectionAddress ?? null,
          meCollectionSlug:  meCollectionSlug,
          verifiedCreators:  metadata?.verifiedCreators ?? null,
          hasArtistAttribute: metadata?.hasArtistAttribute ?? false,
        };
      }
    }

    // ── Solscan / SolanaFM fallback (Core only) ────────────────────────────
    if (event.nftType === 'core' && (!metadata?.nftName || !metadata?.imageUrl)) {
      metadata = await coreEnrichFallback(mint, metadata);
      metadata = { ...metadata, meCollectionSlug: metadata.meCollectionSlug ?? meCollectionSlug };
    }
    // Cache only complete results (have BOTH name and image). Caching a
    // partial — e.g. DAS returned a name but no image because indexing
    // hasn't finished for a freshly-minted asset — would lock that
    // partial in for the 7 min successCache TTL, defeating both the new
    // background image-retry path and any subsequent same-mint sale's
    // fallback chain. failureCache (60 s) handles total misses; partials
    // simply re-enrich on the next sale until one source surfaces an
    // image, after which the result becomes cacheable.
    if (metadata === null) {
      failureCache.set(mint, true);     // total failure — retry in 60s
    }
  }

  const enriched = applyMetadata(event, metadata);
  const slug = enriched.meCollectionSlug;

  // ── Floor-price delta + offer delta ──────────────────────────────────────
  // Skip for blacklisted collections — no point calling their APIs.
  // Both computed per-event (depend on sale price); prices cached by slug.
  // Run in parallel — neither blocks the other.
  if (slug && SLUG_BLACKLIST.has(slug)) {
    return { ...enriched, floorDelta: null, offerDelta: null };
  }

  const isTensor = enriched.marketplace === 'tensor' || enriched.marketplace === 'tensor_amm';
  const [floorDelta, offerDelta, tensorCollectionSlug] = await Promise.all([
    computeFloorDelta(slug, event.priceLamports),
    computeOfferDelta(slug, event.priceLamports),
    isTensor ? resolveTensorCollectionSlug(slug, enriched.collectionAddress) : Promise.resolve(null),
  ]);

  return { ...enriched, floorDelta, offerDelta, tensorCollectionSlug };
}

/**
 * Derived floor from the in-process listings store: minimum priceSol
 * across the slug's known active listings. Always synchronous, never
 * fetches anything — no ME / Helius / RPC traffic. May be slightly
 * stale (bounded by the listings store's own snapshot cadence) but
 * is virtually always present for any actively-traded collection.
 *
 * Falls back to the legacy ME-API floor cache only when the listings
 * store has nothing for this slug — preserves coverage during the
 * brief window after process boot before snapshots populate. The ME
 * cache itself is only filled by the legacy code path; in steady
 * state both lookups should agree closely.
 */
async function computeFloorDelta(
  slug: string | null | undefined,
  priceLamports: bigint,
): Promise<number | null> {
  if (!slug) return null;
  // Source order:
  //   1. listings-store derived floor — min non-pool listing for the
  //      slug. Pool entries are excluded because their priceSol is a
  //      curve quote that can shift between back-to-back events,
  //      giving inconsistent % vs. floor for sales seconds apart.
  //   2. legacy ME-API floor cache — slower / less fresh but stable.
  const derived = getDerivedFloorLamports(slug);
  const cachedMe = floorCache.get(slug) ?? null;
  const floorLamports = derived ?? cachedMe ?? null;
  const floorSource: 'listings_store' | 'me_api' | 'none' =
    derived != null ? 'listings_store' :
    cachedMe != null ? 'me_api' :
    'none';
  if (floorLamports == null || floorLamports <= 0) {
    // Background populate so the next event for this slug carries a delta.
    // Never blocks — the current event ships without a floor chip.
    kickFloorRefresh(slug);
    return null;
  }
  if (Number(priceLamports) <= 0) return null;
  const pct = (Number(priceLamports) - floorLamports) / floorLamports;
  // [floor-debug] sampled to 5 % so a hot collection doesn't flood,
  // but every floor delta a row reports can be cross-checked against
  // the price + floor used + source. Helps the operator catch the
  // "two same-collection sales with different %" case quickly.
  if (Math.random() < 0.05) {
    console.log(
      `[floor-debug] collection=${slug} ` +
      `price=${(Number(priceLamports) / 1e9).toFixed(6)} ` +
      `floor=${(floorLamports / 1e9).toFixed(6)} ` +
      `pct=${(pct * 100).toFixed(2)}% floorSource=${floorSource}`,
    );
  }
  return pct;
}

/**
 * Returns absolute SOL difference: salePrice − topOffer (both in SOL).
 * Positive = sale above best offer. Negative = sale below best offer.
 */
async function computeOfferDelta(
  slug: string | null | undefined,
  priceLamports: bigint,
): Promise<number | null> {
  if (!slug) return null;
  const topOfferLamports = await getCollectionTopOfferLamports(slug);
  if (topOfferLamports == null) return null;
  return (Number(priceLamports) - topOfferLamports) / 1e9;  // absolute SOL diff
}

function applyMetadata(event: SaleEvent, metadata: NftMetadata | null): SaleEvent {
  return {
    ...event,
    // DAS collection address overrides the parser-set value (raw parsers default to null).
    collectionAddress: metadata?.collectionAddress ?? event.collectionAddress,
    nftName:           metadata?.nftName            ?? null,
    imageUrl:          metadata?.imageUrl           ?? null,
    collectionName:    metadata?.collectionName     ?? null,
    magicEdenUrl:      `https://magiceden.io/item-details/${event.mintAddress}`,
    meCollectionSlug:  metadata?.meCollectionSlug   ?? null,
    verifiedCreators:  metadata?.verifiedCreators   ?? null,
    hasArtistAttribute: metadata?.hasArtistAttribute ?? false,
  };
}

/**
 * Secondary enrichment path for Core assets where DAS is absent or partial.
 *
 * Delegates to fetchFallbackMetadata (Solscan → SolanaFM), then guarantees
 * a non-empty name so the UI never shows "Unnamed NFT".
 *
 * Never throws.
 */
async function coreEnrichFallback(mint: string, das: NftMetadata | null): Promise<NftMetadata> {
  const result = await fetchFallbackMetadata(mint, das);

  // Guarantee a non-empty name as last resort.
  // Short mint snippet is unique, recognisable, and copy-pasteable.
  return {
    ...result,
    nftName: result.nftName ?? `NFT ${mint.slice(0, 4)}…${mint.slice(-4)}`,
  };
}
