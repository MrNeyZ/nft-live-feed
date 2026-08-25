/**
 * Late image / collection-slug / floor_delta retry for /feed sale cards.
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
 * Originally image-only. Widened (2026-08-25) to also retry
 * `meCollectionSlug` / `floorDelta` on the SAME schedule — a real,
 * repeatedly-confirmed failure mode leaves those two null forever with
 * no retry path at all: either the initial `_enrich()` call gets killed
 * by its 25s watchdog (some internal await stalls — image AND slug both
 * lost), or `_enrich()` completes fine but the slug genuinely wasn't
 * resolvable yet (image/name succeed via DAS, which doesn't need a
 * slug, while slug resolution — local-index → DB recovery → ME token
 * fetch — comes up empty). Previously NEITHER case ever got revisited
 * because `db/insert.ts` only scheduled a retry when `imageUrl` was
 * missing — a sale with image+name but no slug (e.g. Boryoku Babyz,
 * mint 8EsSZmLk…, 2026-08-25) never got a retry chance at all.
 *
 * Also fixes a second, independent gap: a successful retry used to only
 * `emitMetaUpdate` (live SSE patch to whoever's currently connected) —
 * NEVER written back to `sale_events`. A page reload / a client that
 * wasn't connected at that exact moment saw the field as permanently
 * null even after a successful late resolve. Every successful field
 * here is now persisted via `RETRY_PATCH_SQL` (COALESCE — only fills
 * currently-null columns, never clobbers) before the SSE emit.
 *
 *   t+15 s : slug (local/DB, free) → floor_delta ; DAS → on-chain → Tensor → ME (image)
 *   t+60 s : same chain
 *   t+180s : same chain + collection-image fallback
 *
 * On the first source that returns an imageUrl, emit a `MetaUpdate`
 * patch and stop retrying (slug/floor_delta, once resolved on an
 * earlier attempt, aren't recomputed on later attempts). Frontend
 * reducer uses `?? ev.X` so a null field never overwrites an existing
 * non-null on the row.
 *
 * Per-mint dedup (only one chain per mint) + 20 min `recentlyAttempted`
 * backoff bound RPC under burst.
 */

import { TtlCache } from './cache';
import { getAsset, getCollectionImage } from './helius-das';
import { getMetaplexOnchainMetadata } from './metaplex-onchain';
import { getMeTokenData, getTensorMetadata, computeFloorDelta, recoverSlugByMint, recoverSlugByCollection } from './enrich';
import { slugForMint } from '../server/listings-store';
import { saleEventBus } from '../events/emitter';
import { getMintedAt } from '../mints/fresh-mint-cache';
import { isBlacklistedCollection } from '../db/blacklist';
import { markMintBlocked } from '../db/blocked-mint-cache';
import { getPool } from '../db/client';

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
  /** Needed to (re)compute floor_delta once a slug resolves late. */
  priceLamports:     bigint;
}

const RETRY_PATCH_SQL = `
  UPDATE sale_events SET
    nft_name           = COALESCE(nft_name, $2),
    image_url           = COALESCE(image_url, $3),
    collection_name     = COALESCE(collection_name, $4),
    me_collection_slug  = COALESCE(me_collection_slug, $5),
    floor_delta          = COALESCE(floor_delta, $6)
  WHERE signature = $1
`;

interface ResolvedImage {
  imageUrl:       string;
  source:         'das' | 'onchain' | 'tensor' | 'me' | 'collection_das';
  nftName?:       string | null;
  collectionName?: string | null;
  meCollectionSlug?: string | null;
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
    let currentSlug = args.meCollectionSlug;
    let floorDelta: number | null = null;
    let floorResolved = false; // stop recomputing once we've got a value once
    try {
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        await sleep(RETRY_DELAYS_MS[i]);
        const isLast = i === RETRY_DELAYS_MS.length - 1;

        // Slug + floor_delta — independent of image resolution, same
        // schedule. Cheap-first, same priority order as _enrich() itself:
        // free in-memory index → DB recovery → paid ME lookup happens
        // implicitly inside resolveImage()'s own getMeTokenData() call
        // below, whose slug we also capture if still unresolved.
        const slugBefore = currentSlug;
        let floorDeltaThisRound: number | null = null;
        if (!currentSlug) {
          currentSlug = slugForMint(mint)
            ?? (await recoverSlugByMint(mint))?.slug
            ?? (args.collectionAddress ? (await recoverSlugByCollection(args.collectionAddress))?.slug : null)
            ?? null;
        }
        if (currentSlug && !floorResolved) {
          floorDeltaThisRound = await computeFloorDelta(currentSlug, args.priceLamports);
          if (floorDeltaThisRound != null) { floorDelta = floorDeltaThisRound; floorResolved = true; }
        }

        const resolved = await resolveImage(mint, args.collectionAddress, isLast);
        // getMeTokenData is already fetched inside resolveImage's own ME
        // fallback step — piggyback its slug if everything above missed.
        if (!currentSlug && resolved?.meCollectionSlug) {
          currentSlug = resolved.meCollectionSlug;
          if (!floorResolved) {
            floorDeltaThisRound = await computeFloorDelta(currentSlug, args.priceLamports);
            if (floorDeltaThisRound != null) { floorDelta = floorDeltaThisRound; floorResolved = true; }
          }
        }

        const slugIsNew = currentSlug !== slugBefore;
        // Note: floorDeltaThisRound (not the accumulated floorDelta) —
        // once resolved once it stays non-null across later iterations,
        // and would otherwise re-trigger a no-op patch every attempt.
        const gotSomethingNew = !!resolved || slugIsNew || floorDeltaThisRound != null;
        if (!gotSomethingNew) {
          if (isLast) {
            console.log(
              `[feed/image] retry-exhausted sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
              `attempts=${RETRY_DELAYS_MS.length}  collectionFallbackTried=${args.collectionAddress ? 'yes' : 'no'}`,
            );
          }
          continue;
        }

        const patchedName = resolved?.nftName        ?? args.nftName;
        const patchedCollectionName = resolved?.collectionName ?? args.collectionName;
        const patchedImage = resolved?.imageUrl ?? null;

        // This retry chain is the ONLY place a blacklisted collection's real
        // identity can surface for a row whose synchronous enrichment came
        // back entirely null (the pre-insert AND post-enrichment gates in
        // db/insert.ts had nothing to match against — see blacklist.ts's own
        // "staratlascrew timeouts" note). Without this check, a row like
        // that stays visible forever once this patch lands, because nothing
        // downstream ever re-checks it. Real incident: mint
        // GkgnMQiViNHtmYTwVc9F1YCD55zdJrtPa1Dsg2fEcSKM (Star Atlas Crew,
        // Tensor cNFT takeBidFullMeta) — initial enrich() returned all
        // nulls, this retry later resolved the real collection name via
        // DAS, and the card stayed up with no blacklist check at all.
        if (isBlacklistedCollection({
          collectionAddress: args.collectionAddress,
          meCollectionSlug:  currentSlug,
          collectionName:    patchedCollectionName,
          nftName:           patchedName,
          signature:         sig,
          mintAddress:       mint,
        })) {
          console.log(
            `[feed/blacklist-learn] reason=collection_match source=image_retry ` +
            `mint=${mint} collection=${patchedCollectionName ?? 'null'} sig=${sig.slice(0, 12)}...`,
          );
          markMintBlocked(mint, 'collection_match');
          await getPool().query('DELETE FROM sale_events WHERE signature = $1', [sig]);
          saleEventBus.emitRemove(sig);
          return;
        }

        // Persist first (COALESCE — only fills currently-null columns,
        // never clobbers a value that landed some other way meanwhile),
        // THEN patch live clients. Previously this only emitted the SSE
        // patch — a page reload after a successful late resolve still
        // saw permanent nulls because nothing ever wrote it to the row.
        await getPool().query(RETRY_PATCH_SQL, [
          sig, patchedName, patchedImage, patchedCollectionName, currentSlug, floorDelta,
        ]);

        // Sticky MetaUpdate. Frontend reducer's `?? ev.X` semantics
        // mean null fields here never overwrite existing values; only
        // the resolved imageUrl (and any newly-discovered name/
        // collectionName/slug/floorDelta from the same round) lands.
        saleEventBus.emitMetaUpdate({
          mintAddress:       mint,
          signature:         sig,
          nftName:           patchedName,
          imageUrl:          patchedImage,
          collectionName:    patchedCollectionName,
          collectionAddress: args.collectionAddress,
          meCollectionSlug:  currentSlug,
          floorDelta,
          offerDelta:        null,
          mintedAtMs:        getMintedAt(mint),
        });
        console.log(
          `[feed/image] patch sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
          `image=${resolved ? 'yes' : 'no'} slug=${currentSlug ?? 'no'} floorDelta=${floorDelta ?? 'no'} attempt=${i + 1}`,
        );
        if (resolved) return; // image found — stop the chain, same as before
        // image still missing — keep retrying it; slug/floor_delta (if
        // found this round) already persisted above and won't be
        // recomputed again (floorResolved / currentSlug guards).
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
    const meta = await getAsset(mint, 'image_retry');
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
        meCollectionSlug: me.slug,
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
      const collImage = await getCollectionImage(collectionAddress, 'image_retry');
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
