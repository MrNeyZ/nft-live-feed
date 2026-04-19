import { SaleEvent } from '../models/sale-event';
import { getAsset, NftMetadata } from './helius-das';
import { getMetaplexOnchainMetadata } from './metaplex-onchain';
import { fetchFallbackMetadata } from './fallback-metadata';
import { TtlCache } from './cache';
import { SLUG_BLACKLIST } from '../db/blacklist';

const SUCCESS_TTL_MS = 7 * 60 * 1000;  // 7 minutes — stable NFT metadata rarely changes
const FAILURE_TTL_MS = 60 * 1000;       // 60 seconds — retry quickly after a transient DAS error
const FLOOR_TTL_MS   = 2 * 60 * 1000;  // 2 minutes — floor prices change frequently
const OFFER_TTL_MS   = 90 * 1000;       // 90 seconds — offers change faster than floor

const successCache = new TtlCache<string, NftMetadata>(SUCCESS_TTL_MS);
const failureCache = new TtlCache<string, true>(FAILURE_TTL_MS);
/** Keyed by ME collection slug → floor price in lamports. */
const floorCache   = new TtlCache<string, number>(FLOOR_TTL_MS);
/** Keyed by ME collection slug → top offer price in lamports. */
const offerCache   = new TtlCache<string, number>(OFFER_TTL_MS);

interface MeTokenData {
  slug:      string | null;
  nftName:   string | null;
  imageUrl:  string | null;
}

/**
 * Fetches the Magic Eden token record for a mint.
 * Returns slug, nftName, and imageUrl (all may be null).
 * Uses the public ME v2 tokens API — no key required.
 * Never throws.
 */
async function getMeTokenData(mint: string): Promise<MeTokenData> {
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/tokens/${mint}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return { slug: null, nftName: null, imageUrl: null };
    const json = await res.json() as { collection?: string; name?: string; image?: string };
    return {
      slug:     json.collection ?? null,
      nftName:  json.name       ?? null,
      imageUrl: json.image      ?? null,
    };
  } catch {
    return { slug: null, nftName: null, imageUrl: null };
  }
}

/**
 * Fetches NFT name and image from Tensor's public mint API.
 * Returns null values on any failure; never throws.
 */
async function getTensorMetadata(
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
async function getCollectionFloorLamports(slug: string): Promise<number | null> {
  if (floorCache.has(slug)) return floorCache.get(slug)!;
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { floorPrice?: number };
    const floor = typeof json.floorPrice === 'number' && json.floorPrice > 0
      ? json.floorPrice
      : null;
    if (floor != null) floorCache.set(slug, floor);
    return floor;
  } catch {
    return null;
  }
}

/**
 * Fetches the highest active collection offer price (in lamports) for a ME collection.
 * Uses the public ME v2 collections/offers API — no key required.
 * The offers endpoint returns prices in SOL; converted to lamports for consistency.
 * Cached for OFFER_TTL_MS (90 seconds). Returns null on any failure; never throws.
 */
async function getCollectionTopOfferLamports(slug: string): Promise<number | null> {
  if (offerCache.has(slug)) return offerCache.get(slug)!;
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/offers?limit=20`,
      { signal: AbortSignal.timeout(4000) },
    );
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
  const mint = event.mintAddress;

  // If the same mint is already being enriched, reuse that promise.
  const inflight = inFlightEnriches.get(mint);
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
    inFlightEnriches.delete(mint);
  });
  inFlightEnriches.set(mint, promise);
  return promise;
}

async function _enrich(event: SaleEvent): Promise<SaleEvent> {
  const mint = event.mintAddress;
  let metadata: NftMetadata | null = null;

  if (successCache.has(mint)) {
    metadata = successCache.get(mint)!;
  } else if (!failureCache.has(mint)) {
    // ── Primary: Helius DAS ──────────────────────────────────────────────────
    try {
      metadata = await getAsset(mint);
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
        };
      }
    }

    // ── Magic Eden token data (slug + optional name/image) ──────────────────
    const meData = await getMeTokenData(mint);
    const meCollectionSlug = meData.slug;
    if (metadata) {
      metadata = { ...metadata, meCollectionSlug };
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
          collectionName:    metadata?.collectionName    ?? null,
          collectionAddress: metadata?.collectionAddress ?? null,
          meCollectionSlug:  meCollectionSlug,
        };
      }
    }

    // ── Solscan / SolanaFM fallback (Core only) ────────────────────────────
    if (event.nftType === 'core' && (!metadata?.nftName || !metadata?.imageUrl)) {
      metadata = await coreEnrichFallback(mint, metadata);
      metadata = { ...metadata, meCollectionSlug: metadata.meCollectionSlug ?? meCollectionSlug };
      successCache.set(mint, metadata);
    } else if (metadata !== null) {
      successCache.set(mint, metadata);
    } else {
      failureCache.set(mint, true);     // non-Core total failure — retry in 60s
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

  const [floorDelta, offerDelta] = await Promise.all([
    computeFloorDelta(slug, event.priceLamports),
    computeOfferDelta(slug, event.priceLamports),
  ]);

  return { ...enriched, floorDelta, offerDelta };
}

async function computeFloorDelta(
  slug: string | null | undefined,
  priceLamports: bigint,
): Promise<number | null> {
  if (!slug) return null;
  const floorLamports = await getCollectionFloorLamports(slug);
  if (floorLamports == null) return null;
  return (Number(priceLamports) - floorLamports) / floorLamports;
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
