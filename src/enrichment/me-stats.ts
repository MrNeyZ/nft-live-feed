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

const ME_STATS_TTL_MS = 12_000;
const ME_STATS_TIMEOUT_MS = 4_000;

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

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async (): Promise<MeStatsRaw | null> => {
    try {
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`,
        { signal: AbortSignal.timeout(ME_STATS_TIMEOUT_MS) },
      );
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
  })();
  inFlight.set(slug, task);
  return task;
}
