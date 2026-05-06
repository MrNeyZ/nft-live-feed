/**
 * Late image-resolution retry for /feed sale cards.
 *
 * Background: when a sale lands for a fresh mint, the synchronous
 * enrichment pipeline (`enrich()` in ./enrich.ts) tries DAS → on-chain
 * → ME → Tensor → Solscan/SolanaFM. If every source returns null or
 * partial metadata WITHOUT an `imageUrl`, the result is cached
 * (`successCache`, 7 min TTL for partials; `failureCache`, 60 s TTL
 * for total misses) and the card displays the abbr/color placeholder
 * forever — no further attempt is made for that signature.
 *
 * Common cause: DAS hasn't indexed the asset yet. Same-collection mints
 * indexed earlier light up fine; the just-minted one doesn't. Retrying
 * DAS a few times after the initial enrich resolves most of these.
 *
 * This module:
 *   - Schedules 3 DAS getAsset retries at 15 s / 60 s / 180 s after the
 *     initial enrich completes with `imageUrl == null`.
 *   - Bypasses `successCache` (calls `getAsset` directly) — the cached
 *     partial is precisely what we're trying to upgrade.
 *   - On resolution, emits a `MetaUpdate` carrying the resolved image
 *     plus any other DAS-provided fields (sticky-merged on the frontend
 *     reducer with `?? ev.X` semantics, so a null patch field never
 *     overwrites an existing value).
 *   - Per-mint dedup: only one retry chain runs per `mintAddress`.
 *   - Per-mint backoff (`recentlyAttempted`, 20 min TTL): once a chain
 *     completes (success or exhaustion), no fresh chain is re-armed for
 *     the same mint until the backoff expires. Bounds RPC under burst.
 *   - Never blocks the sale SSE frame; never re-enters the synchronous
 *     enrich pipeline.
 */

import { TtlCache } from './cache';
import { getAsset } from './helius-das';
import { saleEventBus } from '../events/emitter';

/** Retry cadence after initial enrich finishes with no image. */
const RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
/** Per-mint backoff TTL after a chain completes. 20 min sits inside the
 *  user-spec'd 10–30 min band; comfortably longer than the 7 min
 *  successCache TTL upstream so the retry fires again only after the
 *  enrich-side cache has rolled. */
const RECENTLY_ATTEMPTED_TTL_MS = 20 * 60_000;

/** mints whose retry chain is currently active (timer pending or DAS
 *  call in flight). Re-entry is silent. */
const inflight = new Set<string>();
/** Bounded backoff: mint → marker. TtlCache has its own size + sweep
 *  so the Set above stays small even under sustained mint churn. */
const recentlyAttempted = new TtlCache<string, true>(RECENTLY_ATTEMPTED_TTL_MS, 60_000);

interface ScheduleArgs {
  mintAddress:       string;
  signature:         string;
  collectionName:    string | null;
  collectionAddress: string | null;
  meCollectionSlug:  string | null;
  nftName:           string | null;
}

export function scheduleImageRetry(args: ScheduleArgs): void {
  const mint = args.mintAddress;
  const sig  = args.signature;
  if (!mint) {
    console.log(`[feed/image] miss sig=${sig.slice(0, 12)}… mint=— reason=no_mint_address`);
    return;
  }
  if (inflight.has(mint) || recentlyAttempted.has(mint)) return;

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
        let meta;
        try {
          meta = await getAsset(mint);
        } catch (err) {
          console.log(
            `[feed/image] retry-error attempt=${i + 1}/${RETRY_DELAYS_MS.length} ` +
            `mint=${mint.slice(0, 8)}… err=${(err as Error).message}`,
          );
          continue;
        }
        const image = meta?.imageUrl;
        if (!image) {
          if (i === RETRY_DELAYS_MS.length - 1) {
            console.log(
              `[feed/image] retry-exhausted sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
              `attempts=${RETRY_DELAYS_MS.length}`,
            );
          }
          continue;
        }
        // Got an image. Emit a sticky MetaUpdate. Frontend reducer uses
        // `patch.field ?? ev.field`, so:
        //   - null fields here NEVER overwrite an existing non-null on
        //     the row (e.g. floorDelta/offerDelta resolved during
        //     initial enrich are preserved).
        //   - the resolved imageUrl wins because the row's prior value
        //     is null (that's the trigger for this retry chain).
        saleEventBus.emitMetaUpdate({
          mintAddress:       mint,
          signature:         sig,
          // Prefer DAS-provided fields when present; otherwise echo
          // back the ones the row already has. We never patch with
          // less specific data than what arrived during initial enrich.
          nftName:           meta.nftName           ?? args.nftName,
          imageUrl:          image,
          collectionName:    meta.collectionName    ?? args.collectionName,
          collectionAddress: meta.collectionAddress ?? args.collectionAddress,
          meCollectionSlug:  meta.meCollectionSlug  ?? args.meCollectionSlug,
          // Floor/offer deltas are computed at enrich time against the
          // sale's specific priceLamports; we don't recompute here and
          // we don't want to overwrite. Sending null leaves whatever
          // the row already has thanks to the reducer's `??` semantics.
          floorDelta:        null,
          offerDelta:        null,
        });
        console.log(
          `[feed/image] patch sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
          `image=yes source=das attempt=${i + 1}`,
        );
        return;
      }
    } finally {
      inflight.delete(mint);
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
