/**
 * Single shared client for Magic Eden's `GET /v2/tokens/{mint}` endpoint.
 *
 * Before this module existed, `enrich.ts`, `me-metadata.ts`, and
 * `me-collection-name.ts` each fetched this same endpoint independently —
 * no shared cache, no in-flight dedup, each with its own timeout/retry
 * policy. A burst of sales/lookups for the same mint (or unrelated mints
 * arriving concurrently) could fire 2-3x the necessary ME requests against
 * one shared per-IP rate limit, which is exactly what tripped the 429s
 * documented in me-api-cooldown.ts.
 *
 * This module is now the ONLY place that issues that raw fetch. Every
 * caller — `enrich.ts` (sale enrichment), `image-retry.ts` (image backfill),
 * `me-collection-name.ts` (mint-tracker name fallback), `name-backfill.ts`
 * (late name sweep), and `tools-me-tensor-arb.ts` (mint→slug resolution) —
 * goes through `getMeTokenData()`.
 *
 * Guarantees:
 *   - bounded TTL cache (positive hits cached longer than misses/failures)
 *   - in-flight dedup: concurrent calls for the same mint share one fetch
 *   - respects the process-wide ME cooldown (me-api-cooldown.ts)
 *   - single timeout policy
 *   - never throws — always resolves to an EMPTY-shaped result on failure
 */

import { TtlCache } from './cache';
import { meCooldownActive, setMeCooldown, meAuthHeaders } from '../me-api-cooldown';

export interface MeTokenData {
  slug:           string | null;
  collectionName: string | null;
  nftName:        string | null;
  imageUrl:       string | null;
}

const EMPTY: MeTokenData = { slug: null, collectionName: null, nftName: null, imageUrl: null };

const FETCH_TIMEOUT_MS = 5_000;
// Real token data (name/image/collection) is effectively static after mint —
// safe to hold for a while. Misses/failures get a short TTL so a transient
// 429/timeout/unindexed-mint retries soon instead of pinning EMPTY for
// minutes, while still absorbing a same-mint burst within that window.
const HIT_TTL_MS  = 10 * 60_000;
const MISS_TTL_MS = 60_000;

const hitCache  = new TtlCache<string, MeTokenData>(HIT_TTL_MS, 60_000);
const missCache = new TtlCache<string, true>(MISS_TTL_MS, 60_000);
const inflight  = new Map<string, Promise<MeTokenData>>();

/** Internal result: `cacheable` distinguishes a real fact about this mint
 *  (terminal 404, or a successful response) from a transient/global miss
 *  (active cooldown, this call's own 429, network/timeout exhaustion) that
 *  says nothing about the mint itself and must NOT pin EMPTY into the miss
 *  cache — otherwise a same-mint retry stays wrongly suppressed long after
 *  the cooldown that caused it has cleared. */
async function fetchMeTokenData(mint: string): Promise<{ data: MeTokenData; cacheable: boolean }> {
  // Skip immediately if the process-wide ME cooldown is active (set by any
  // ME caller — rare feed, retardio scanner, etc — hitting 429 on the
  // shared IP quota).
  if (meCooldownActive()) return { data: EMPTY, cacheable: false };
  // Two attempts max: a single short-backoff retry recovers the data after
  // a transient rate-limit (429 / CF 1015 / 403) or timeout under load.
  // Terminal client errors (404 unknown mint, 400/401) are NOT retried.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status = 0;
    let reason = 'unknown';
    try {
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(mint)}`,
        { headers: meAuthHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
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
          data: {
            slug:           json.collection     ?? null,
            collectionName: json.collectionName ?? null,
            nftName:        json.name           ?? null,
            imageUrl:       json.image          ?? null,
          },
          cacheable: true,
        };
      }
      reason = `http_${status}`;
      if (status === 429) {
        setMeCooldown(60_000);
        console.warn(`[me-token-cache] ME 429 — process-wide cooldown set (60s)`);
        return { data: EMPTY, cacheable: false };
      }
      // Terminal client errors (404 unknown mint, 400/401) are not retried
      // and ARE a real fact about this mint — safe to cache as a miss.
      const retryable = status === 403 || status === 408 || status >= 500;
      if (!retryable) {
        console.warn(`[me-token-cache] resolve failed mint=${mint.slice(0, 8)} status=${status} reason=${reason} attempts=${attempt}`);
        return { data: EMPTY, cacheable: true };
      }
    } catch (e) {
      reason = (e instanceof Error && e.name === 'TimeoutError') ? 'timeout' : 'fetch_error';
      // network/timeout is transient → allowed to retry
    }
    if (attempt === 2) {
      // Single quiet line per mint only on FINAL failure — never on success
      // or on the first (retried) attempt, so logs don't flood under load.
      console.warn(`[me-token-cache] resolve failed mint=${mint.slice(0, 8)} status=${status} reason=${reason} attempts=${attempt}`);
      // Exhausted retries on a transient condition (timeout/network/5xx) —
      // not a confirmed fact about the mint, so don't pin it as a miss.
      return { data: EMPTY, cacheable: false };
    }
    // Short backoff (500-1000 ms) before the single retry.
    await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
  }
  return { data: EMPTY, cacheable: false }; // unreachable (loop always returns by attempt 2) — satisfies tsc
}

/**
 * Fetches the Magic Eden token record for a mint.
 * Returns slug, human-readable collectionName, nftName, and imageUrl (all may be null).
 * Cached (hit + miss), in-flight-deduped, cooldown-aware. Never throws.
 */
export async function getMeTokenData(mint: string): Promise<MeTokenData> {
  if (!mint) return EMPTY;
  const hit = hitCache.get(mint);
  if (hit !== undefined) return hit;
  if (missCache.has(mint)) return EMPTY;
  const live = inflight.get(mint);
  if (live) return live;

  const p = (async (): Promise<MeTokenData> => {
    try {
      const { data, cacheable } = await fetchMeTokenData(mint);
      if (data.slug || data.collectionName || data.nftName || data.imageUrl) {
        hitCache.set(mint, data);
      } else if (cacheable) {
        missCache.set(mint, true);
      }
      return data;
    } finally {
      inflight.delete(mint);
    }
  })();
  inflight.set(mint, p);
  return p;
}
