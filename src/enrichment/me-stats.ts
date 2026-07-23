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

import { meCooldownActive, setMeCooldown, meAuthHeaders } from '../me-api-cooldown';

const ME_STATS_TTL_MS = 12_000;
const ME_STATS_TIMEOUT_MS = 4_000;

// ── Concurrency gate ─────────────────────────────────────────────────────────
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
// Bounded here, global to the process, so every caller benefits — not just
// /bids. Same shape as collection-bids.ts's MMM pools gate.
const ME_STATS_MAX_CONCURRENT = 5;
let meStatsActive = 0;
const meStatsQueue: Array<() => void> = [];

function acquireMeStatsSlot(): Promise<void> {
  if (meStatsActive < ME_STATS_MAX_CONCURRENT) { meStatsActive++; return Promise.resolve(); }
  return new Promise<void>((resolve) => { meStatsQueue.push(() => { meStatsActive++; resolve(); }); });
}
function releaseMeStatsSlot(): void {
  meStatsActive--;
  const next = meStatsQueue.shift();
  if (next) next();
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
  if (meCooldownActive()) return null;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async (): Promise<MeStatsRaw | null> => {
    await acquireMeStatsSlot();
    try {
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`,
        { headers: meAuthHeaders(), signal: AbortSignal.timeout(ME_STATS_TIMEOUT_MS) },
      );
      if (res.status === 429) {
        setMeCooldown(60_000);
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
      releaseMeStatsSlot();
      inFlight.delete(slug);
    }
  })();
  inFlight.set(slug, task);
  return task;
}
