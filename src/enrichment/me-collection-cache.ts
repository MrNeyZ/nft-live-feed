/**
 * Single shared client for Magic Eden's `GET /v2/collections/{slug}`
 * endpoint (the plain per-collection record — name/socials/image; NOT
 * `/stats`, `/listings`, or `/activities`, which are different endpoints
 * with different contracts and stay on their own dedicated call sites).
 *
 * Before this module existed, `collection-meta.ts` and `collection-search.ts`
 * each fetched this endpoint independently with their own cache/timeout.
 * This module is now the only place that issues that raw fetch; both
 * callers narrow the shared result to the fields they need and keep
 * applying their own caller-specific logic on top (URL-safety coercion in
 * collection-meta.ts, DB-name backstop, etc).
 *
 * Guarantees: bounded TTL cache (hit + miss), in-flight dedup, cooldown
 * integration, single timeout policy, fail-soft EMPTY (never throws).
 */

import { TtlCache } from './cache';
import { meCooldownActive, setMeCooldown, meAuthHeaders } from '../me-api-cooldown';

export interface MeCollectionData {
  /** ME's `symbol` field — the canonical slug, echoed back. */
  slug:    string | null;
  name:    string | null;
  image:   string | null;
  twitter: string | null;
  discord: string | null;
  website: string | null;
}

const EMPTY: MeCollectionData = {
  slug: null, name: null, image: null, twitter: null, discord: null, website: null,
};

const FETCH_TIMEOUT_MS = 5_000;
// Collection name/socials/image are effectively static — safe to hold for a
// while. Misses get a short TTL so a transient 429/timeout retries soon
// rather than pinning EMPTY for an hour, while still absorbing a burst of
// lookups for the same slug within that window.
const HIT_TTL_MS  = 60 * 60_000;
const MISS_TTL_MS = 2 * 60_000;

const hitCache  = new TtlCache<string, MeCollectionData>(HIT_TTL_MS, 5 * 60_000);
const missCache = new TtlCache<string, true>(MISS_TTL_MS, 60_000);
const inflight  = new Map<string, Promise<MeCollectionData>>();

interface MeCollectionResponse {
  symbol?:  string;
  name?:    string;
  image?:   string;
  twitter?: string;
  discord?: string;
  website?: string;
}

/** `cacheable` mirrors me-token-cache.ts: an active cooldown or this call's
 *  own 429 says nothing about the slug itself and must not pin EMPTY into
 *  the miss cache. */
async function fetchMeCollectionData(slug: string): Promise<{ data: MeCollectionData; cacheable: boolean }> {
  if (meCooldownActive()) return { data: EMPTY, cacheable: false };
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}`,
      { headers: meAuthHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) {
      if (res.status === 429) {
        setMeCooldown(60_000);
        console.warn(`[me-collection-cache] ME 429 — process-wide cooldown set (60s)`);
        return { data: EMPTY, cacheable: false };
      }
      // Any other non-ok (404 unknown slug, 5xx, etc) is a real fact worth
      // caching briefly — a genuinely unindexed slug shouldn't be re-hit on
      // every request until MISS_TTL_MS rolls.
      return { data: EMPTY, cacheable: true };
    }
    const json = await res.json() as MeCollectionResponse;
    return {
      data: {
        slug:    typeof json.symbol  === 'string' && json.symbol.length  > 0 ? json.symbol  : null,
        name:    typeof json.name    === 'string' && json.name.length    > 0 ? json.name    : null,
        image:   typeof json.image   === 'string' && json.image.length   > 0 ? json.image   : null,
        twitter: typeof json.twitter === 'string' && json.twitter.length > 0 ? json.twitter : null,
        discord: typeof json.discord === 'string' && json.discord.length > 0 ? json.discord : null,
        website: typeof json.website === 'string' && json.website.length > 0 ? json.website : null,
      },
      cacheable: true,
    };
  } catch {
    // network/timeout — transient, don't pin as a miss.
    return { data: EMPTY, cacheable: false };
  }
}

/**
 * Fetches the Magic Eden collection record for a slug. Cached (hit + miss),
 * in-flight-deduped, cooldown-aware. Never throws.
 */
export async function getMeCollectionData(slug: string): Promise<MeCollectionData> {
  if (!slug) return EMPTY;
  const hit = hitCache.get(slug);
  if (hit !== undefined) return hit;
  if (missCache.has(slug)) return EMPTY;
  const live = inflight.get(slug);
  if (live) return live;

  const p = (async (): Promise<MeCollectionData> => {
    try {
      const { data, cacheable } = await fetchMeCollectionData(slug);
      if (data.slug || data.name || data.image || data.twitter || data.discord || data.website) {
        hitCache.set(slug, data);
      } else if (cacheable) {
        missCache.set(slug, true);
      }
      return data;
    } finally {
      inflight.delete(slug);
    }
  })();
  inflight.set(slug, p);
  return p;
}
