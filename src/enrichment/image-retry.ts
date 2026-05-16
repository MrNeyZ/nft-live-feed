/**
 * Late image-resolution retry for /feed sale cards.
 *
 * Background: when a sale lands for a fresh mint, the synchronous
 * enrichment pipeline (`enrich()` in ./enrich.ts) tries DAS → on-chain
 * → ME → Tensor → Solscan/SolanaFM. If every source returns null or
 * partial metadata WITHOUT an `imageUrl`, the card displays the
 * abbr/color placeholder forever. ME being marked STALE on the frontend
 * (Magic Eden API failures) makes this much more common — entire
 * launches like HUNDLAND NFT can have name + everything else but no
 * image because Tensor + ME are the only sources that index the asset
 * and both are down/missing.
 *
 * This module schedules background retries that walk the FULL fallback
 * chain (not just DAS), with a final last-resort lookup of the
 * collection's own image as a strictly-better fallback than the
 * abbr/color placeholder.
 *
 *   t+15 s : DAS getAsset(mint) → on-chain Metaplex → Tensor → ME
 *   t+60 s : same chain
 *   t+180s : same chain + collection-image fallback
 *
 * On the first source that returns an imageUrl, emit a `MetaUpdate`
 * patch and stop retrying. Frontend reducer uses `?? ev.X` so a null
 * field never overwrites an existing non-null on the row.
 *
 * Per-mint dedup (only one chain per mint) + 20 min `recentlyAttempted`
 * backoff bound RPC under burst.
 */

import { TtlCache } from './cache';
import { getAsset, getCollectionImage } from './helius-das';
import { getMetaplexOnchainMetadata } from './metaplex-onchain';
import { getMeTokenData, getTensorMetadata } from './enrich';
import { saleEventBus } from '../events/emitter';

const RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
const RECENTLY_ATTEMPTED_TTL_MS = 20 * 60_000;

const inflight = new Set<string>();
const recentlyAttempted = new TtlCache<string, true>(RECENTLY_ATTEMPTED_TTL_MS, 60_000);

/* Per-collection rolling-window ceiling. Per-mint dedup + 20-min
 * backoff above already gate individual mints; this layer caps the
 * *batch* rate during a launch where hundreds of unique mints share
 * one collection and the image host is flapping. Rolling 60s window,
 * 50 retries/collection — beyond that we skip (a missing image is
 * fine; runaway DAS credits aren't). Log throttled to every 25 skips
 * to keep the channel readable. Pure in-memory, no timers — entries
 * are pruned lazily on each scheduleImageRetry call. */
const COLLECTION_WINDOW_MS      = 60_000;
const COLLECTION_RETRY_LIMIT    = 50;
const COLLECTION_SKIP_LOG_EVERY = 25;
const collectionRetries = new Map<string, number[]>();
const collectionSkips   = new Map<string, number>();

interface ScheduleArgs {
  mintAddress:       string;
  signature:         string;
  collectionName:    string | null;
  collectionAddress: string | null;
  meCollectionSlug:  string | null;
  nftName:           string | null;
}

interface ResolvedImage {
  imageUrl:       string;
  source:         'das' | 'onchain' | 'tensor' | 'me' | 'collection_das';
  nftName?:       string | null;
  collectionName?: string | null;
}

export function scheduleImageRetry(args: ScheduleArgs): void {
  const mint = args.mintAddress;
  const sig  = args.signature;
  if (!mint) {
    console.log(`[feed/image] miss sig=${sig.slice(0, 12)}… mint=— reason=no_mint_address`);
    return;
  }
  if (inflight.has(mint) || recentlyAttempted.has(mint)) return;

  // Per-collection ceiling check. Skipped when no collectionAddress
  // is known (can't bucket without a key — falls back to per-mint
  // dedup alone, same behaviour as before this patch).
  if (args.collectionAddress) {
    const ts     = Date.now();
    const cutoff = ts - COLLECTION_WINDOW_MS;
    let bucket = collectionRetries.get(args.collectionAddress);
    if (bucket) {
      // In-place prune of entries older than the rolling window.
      let writeIdx = 0;
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i] >= cutoff) bucket[writeIdx++] = bucket[i];
      }
      bucket.length = writeIdx;
      if (writeIdx === 0) {
        collectionRetries.delete(args.collectionAddress);
        collectionSkips.delete(args.collectionAddress);
        bucket = undefined;
      }
    }
    const count = bucket?.length ?? 0;
    if (count >= COLLECTION_RETRY_LIMIT) {
      const next = (collectionSkips.get(args.collectionAddress) ?? 0) + 1;
      collectionSkips.set(args.collectionAddress, next);
      if (next % COLLECTION_SKIP_LOG_EVERY === 0) {
        console.log(
          `[mints/image-retry] collection ceiling hit collection=${args.collectionAddress.slice(0, 8)}… skipped=${next}`,
        );
      }
      return;
    }
    if (bucket) bucket.push(ts);
    else        collectionRetries.set(args.collectionAddress, [ts]);
  }

  inflight.add(mint);
  recentlyAttempted.set(mint, true);

  console.log(
    `[feed/image] miss sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
    `reason=null_after_initial_enrich  scheduling retries=${RETRY_DELAYS_MS.length}`,
  );

  void (async () => {
    try {
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        await sleep(RETRY_DELAYS_MS[i]);
        const isLast = i === RETRY_DELAYS_MS.length - 1;
        const resolved = await resolveImage(mint, args.collectionAddress, isLast);
        if (!resolved) {
          if (isLast) {
            console.log(
              `[feed/image] retry-exhausted sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
              `attempts=${RETRY_DELAYS_MS.length}  collectionFallbackTried=${args.collectionAddress ? 'yes' : 'no'}`,
            );
          }
          continue;
        }
        // Sticky MetaUpdate. Frontend reducer's `?? ev.X` semantics
        // mean null fields here never overwrite existing values; only
        // the resolved imageUrl (and any newly-discovered name/
        // collectionName from the same source) lands.
        saleEventBus.emitMetaUpdate({
          mintAddress:       mint,
          signature:         sig,
          nftName:           resolved.nftName        ?? args.nftName,
          imageUrl:          resolved.imageUrl,
          collectionName:    resolved.collectionName ?? args.collectionName,
          collectionAddress: args.collectionAddress,
          meCollectionSlug:  args.meCollectionSlug,
          floorDelta:        null,
          offerDelta:        null,
        });
        console.log(
          `[feed/image] patch sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
          `image=yes source=${resolved.source} attempt=${i + 1}`,
        );
        return;
      }
    } finally {
      inflight.delete(mint);
    }
  })();
}

/** Walk the full enrichment chain looking for an image URL only. Each
 *  source is tried in turn; the first one to return a non-empty
 *  `imageUrl` wins. On the final retry attempt (`includeCollection`),
 *  if every per-NFT source still failed, fall back to the collection's
 *  own image — strictly better than the abbr/color placeholder. */
async function resolveImage(
  mint:                 string,
  collectionAddress:    string | null,
  includeCollection:    boolean,
): Promise<ResolvedImage | null> {
  // 1. DAS getAsset(mint) — most authoritative when indexed.
  try {
    const meta = await getAsset(mint);
    if (meta?.imageUrl) {
      return {
        imageUrl:       meta.imageUrl,
        source:         'das',
        nftName:        meta.nftName,
        collectionName: meta.collectionName,
      };
    }
  } catch (err) {
    console.log(`[feed/image] retry-source=das err=${(err as Error).message} mint=${mint.slice(0, 8)}…`);
  }
  // 2. On-chain Metaplex metadata (legacy + pNFT). Free Solana RPC.
  try {
    const onchain = await getMetaplexOnchainMetadata(mint);
    if (onchain.imageUrl) {
      return {
        imageUrl: onchain.imageUrl,
        source:   'onchain',
        nftName:  onchain.nftName ?? null,
      };
    }
  } catch (err) {
    console.log(`[feed/image] retry-source=onchain err=${(err as Error).message} mint=${mint.slice(0, 8)}…`);
  }
  // 3. Tensor public mint API.
  try {
    const tensor = await getTensorMetadata(mint);
    if (tensor.imageUrl) {
      return {
        imageUrl: tensor.imageUrl,
        source:   'tensor',
        nftName:  tensor.nftName ?? null,
      };
    }
  } catch (err) {
    console.log(`[feed/image] retry-source=tensor err=${(err as Error).message} mint=${mint.slice(0, 8)}…`);
  }
  // 4. Magic Eden token API. Often `STALE` in prod — kept last among
  //    per-NFT sources because of its unreliability.
  try {
    const me = await getMeTokenData(mint);
    if (me.imageUrl) {
      return {
        imageUrl:       me.imageUrl,
        source:         'me',
        nftName:        me.nftName,
        collectionName: me.collectionName,
      };
    }
  } catch (err) {
    console.log(`[feed/image] retry-source=me err=${(err as Error).message} mint=${mint.slice(0, 8)}…`);
  }
  // 5. Final retry only — collection-level image. Replaces the
  //    abbr/color placeholder with the collection's own art when no
  //    per-NFT source ever surfaces one (e.g. HUNDLAND-style fresh
  //    launches whose individual assets aren't indexed by Tensor/ME).
  if (includeCollection && collectionAddress) {
    try {
      const collImage = await getCollectionImage(collectionAddress);
      if (collImage) {
        return { imageUrl: collImage, source: 'collection_das' };
      }
    } catch (err) {
      console.log(
        `[feed/image] retry-source=collection_das err=${(err as Error).message} ` +
        `collection=${collectionAddress.slice(0, 8)}…`,
      );
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
