/**
 * Shared Magic Eden `/v2/collections/{slug}/stats` fetcher.
 *
 * Single short-TTL cache + per-slug in-flight dedup so concurrent callers
 * (enrichment floor lookup, collection-bids endpoint) don't fan out into
 * duplicate ME requests for the same slug. Returns the raw JSON object
 * unmodified — every caller extracts whatever fields it needs locally.
 *
 * Returns `null` on any failure (network error, non-2xx, parse failure)
 * so call sites can keep their existing null-handling instead of growing
 * a try/catch around this helper.
 */

// Deliberately NOT importing the shared me-api-cooldown module — this
// endpoint runs on its own isolated, keyless (public) rate budget instead
// of the shared authed-key one every other ME consumer (rare-feed,
// retardio-offers, mmm-pools, spl20, collection-bids' mmm/tensor calls)
// draws from. Two reasons:
//   1. Isolation: an unrelated consumer's 429 used to trip the shared
//      process-wide cooldown and blank floor-delta badges feed-wide for
//      60s even though floor-delta itself never made the offending call
//      (confirmed live, repeatedly, throughout 2026-08-25).
//   2. Budget: floor-delta is the highest-value, most latency-sensitive ME
//      consumer in the project (computed per real sale, shown live) — it
//      shouldn't compete with background scan tools for the same authed
//      quota. Keyless traffic hits Cloudflare's own per-IP limiter sooner
//      than authed calls (see me-api-cooldown.ts's own comment on this),
//      but that's a materially smaller, self-contained cost: a missed
//      floor lookup just skips one badge, vs. an authed 429 elsewhere
//      silently killing floor-delta for everyone for a full minute.
let cooldownUntil = 0;

const ME_STATS_TTL_MS = 12_000;
const ME_STATS_TIMEOUT_MS = 4_000;

// ── Rate gate ────────────────────────────────────────────────────────────────
// This endpoint had no proactive throttle at all — unlike Tensor (tensorFetch,
// serial 1 req/sec) and ME's own mmm/pools (concurrency-capped). Confirmed
// live (Jul 2026): a single /api/collections/bids batch of ~20-28 distinct
// slugs fires that many concurrent getMeStats calls at once (one dashboard
// or /feed poll, unrelated to actual trade volume — floor/listed lookups
// happen for every VISIBLE collection regardless of how many are actually
// trading), which tripped ME's rate limit on several slugs simultaneously
// and triggered the shared 60s meCooldownActive() window — during which
// EVERY collection's floor lookup (including ones that never made their own
// request) returns null, killing floor-delta badges feed-wide for a minute.
//
// A pure concurrency cap (originally 5-at-once here) turned out NOT to be
// enough on its own: it bounds parallelism, not *rate* — when slots free up
// quickly (each ME request takes well under a second), 5 concurrent slots
// can still dispatch well over 5 requests/sec in aggregate. Confirmed live
// again (Aug 2026): multiple 429 bursts across many DIFFERENT collections
// firing close together, not one slug being re-hit (that path was already
// covered by the per-slug in-flight dedup below) — i.e. this is aggregate
// cross-collection volume, exactly what a concurrency cap doesn't limit.
//
// Switched to the same sequential-chain-with-spacer shape as Tensor's
// `tensorFetch` (listings-store.ts) — every call funnels through one chain
// with a fixed minimum gap between dispatches, so the real limiter is req/sec
// across ALL slugs combined, not "how many happen to be in flight". Faster
// than Tensor's 1 req/sec (ME's limit is looser) but still hard-capped.
const ME_STATS_MIN_INTERVAL_MS = 300; // ~3.3 req/sec global ceiling, all slugs combined

let meStatsChain: Promise<unknown> = Promise.resolve();
function scheduleMeStatsCall<T>(fn: () => Promise<T>): Promise<T> {
  const result = meStatsChain.then(fn);
  meStatsChain = result.catch(() => undefined).then(
    () => new Promise<void>((resolve) => setTimeout(resolve, ME_STATS_MIN_INTERVAL_MS)),
  );
  return result;
}

export interface MeStatsRaw {
  floorPrice?: number;     // lamports
  listedCount?: number;
  volumeAll?: number;      // lamports
  // Other fields ME returns are passed through untouched.
  [k: string]: unknown;
}

interface CacheEntry { stats: MeStatsRaw | null; fetchedAt: number }

const cache    = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MeStatsRaw | null>>();

export async function getMeStats(slug: string): Promise<MeStatsRaw | null> {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && now - hit.fetchedAt < ME_STATS_TTL_MS) return hit.stats;

  // Guard before touching inFlight: a cooldown early-return inside the IIFE
  // (the old shape) left an already-resolved Promise<null> in inFlight because
  // inFlight.set runs after the IIFE and the try/finally never executed, so
  // inFlight.delete was never called. Future callers then hit the stale entry
  // and returned null permanently. Checking here keeps inFlight untouched.
  if (Date.now() < cooldownUntil) return null;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = scheduleMeStatsCall(async (): Promise<MeStatsRaw | null> => {
    try {
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`,
        { signal: AbortSignal.timeout(ME_STATS_TIMEOUT_MS) },
      );
      if (res.status === 429) {
        cooldownUntil = Date.now() + 60_000;
        cache.set(slug, { stats: null, fetchedAt: Date.now() });
        // Unlike rare-feed's getJson(), this path used to fail silently —
        // a 429 here (e.g. the concurrent boot-time burst: rarity replay +
        // snapshot floor pre-warm + per-sale enrichment all hitting ME at
        // once) left no trace, making "floor_delta null right after a
        // restart" look inexplicable in the logs.
        console.warn(`[me-stats] 429 — cooling down 60s slug=${slug}`);
        return null;
      }
      if (!res.ok) {
        cache.set(slug, { stats: null, fetchedAt: Date.now() });
        return null;
      }
      const json = (await res.json()) as MeStatsRaw;
      cache.set(slug, { stats: json, fetchedAt: Date.now() });
      return json;
    } catch (err) {
      console.error(`[me-stats-error] slug=${slug} ${(err as Error)?.message ?? err}`);
      cache.set(slug, { stats: null, fetchedAt: Date.now() });
      return null;
    } finally {
      inFlight.delete(slug);
    }
  });
  inFlight.set(slug, task);
  return task;
}
