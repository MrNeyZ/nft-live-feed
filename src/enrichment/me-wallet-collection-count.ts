/**
 * Owner holdings count for a Magic Eden collection slug, via
 * `GET /v2/wallets/{owner}/tokens?collection_symbol={slug}`.
 *
 * Scan primitive for `seller-holdings.ts`'s (seed / reconcile) machinery,
 * used ONLY as a fallback when a mint has no verified on-chain Collection
 * (Helius DAS `grouping` empty — `resolveCollectionForMint` returns null),
 * which is common for older/legacy collections. Those mints already have
 * their ME slug resolved elsewhere in the enrichment pipeline
 * (`me-token-cache.ts` → `SaleEvent.meCollectionSlug`), so this module
 * takes the slug as a given rather than re-resolving it.
 *
 * Same care as `me-token-cache.ts`: TTL cache, in-flight dedup, respects
 * the process-wide ME cooldown, never throws. This is a heavier call than
 * `/v2/tokens/{mint}` (returns the wallet's full per-collection listing),
 * so it must only ever run from `seller-holdings.ts`'s first-sight/
 * reconcile paths (rare — once per (seller, slug) pair, then bounded by
 * the same TTL/low-count/N-decrements triggers), never per-sale.
 */

import { TtlCache } from './cache';
import { meCooldownActive, setMeCooldown, meAuthHeaders } from '../me-api-cooldown';

const FETCH_TIMEOUT_MS = 8_000;
// A wallet's real holdings for one collection change slowly relative to
// this cache's purpose (it's only ever consulted right before a fresh
// scan would otherwise run) — mirrors me-token-cache.ts's hit/miss split.
const HIT_TTL_MS  = 5 * 60_000;
const MISS_TTL_MS = 60_000;
// ME's wallet-tokens endpoint page size; a single page comfortably covers
// the vast majority of holders. Not paginated further — see the count
// warning below for the rare page-cap case.
const PAGE_LIMIT = 500;

const hitCache  = new TtlCache<string, number>(HIT_TTL_MS, 60_000);
const missCache = new TtlCache<string, true>(MISS_TTL_MS, 60_000);
const inflight  = new Map<string, Promise<number | null>>();

function key(owner: string, slug: string): string {
  return `${owner}|${slug}`;
}

async function fetchCount(owner: string, slug: string): Promise<{ count: number | null; cacheable: boolean }> {
  if (meCooldownActive()) return { count: null, cacheable: false };
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status = 0;
    let reason = 'unknown';
    try {
      const url =
        `https://api-mainnet.magiceden.dev/v2/wallets/${encodeURIComponent(owner)}/tokens` +
        `?offset=0&limit=${PAGE_LIMIT}&collection_symbol=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { headers: meAuthHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      status = res.status;
      if (res.ok) {
        const json = await res.json() as unknown;
        if (!Array.isArray(json)) {
          console.warn(`[me-wallet-collection-count] unexpected non-array response owner=${owner.slice(0, 8)}… slug=${slug}`);
          return { count: null, cacheable: false };
        }
        if (json.length === PAGE_LIMIT) {
          // Can't distinguish "exactly PAGE_LIMIT" from "more, truncated"
          // without a second page — log so a real undercount is visible
          // rather than silently trusting a possibly-truncated number.
          console.warn(`[me-wallet-collection-count] hit page cap (${PAGE_LIMIT}) owner=${owner.slice(0, 8)}… slug=${slug} — count may be truncated`);
        }
        return { count: json.length, cacheable: true };
      }
      reason = `http_${status}`;
      if (status === 429) {
        setMeCooldown(60_000);
        console.warn(`[me-wallet-collection-count] ME 429 — process-wide cooldown set (60s)`);
        return { count: null, cacheable: false };
      }
      const retryable = status === 403 || status === 408 || status >= 500;
      if (!retryable) {
        console.warn(`[me-wallet-collection-count] failed owner=${owner.slice(0, 8)}… slug=${slug} status=${status} attempts=${attempt}`);
        return { count: null, cacheable: false };
      }
    } catch (e) {
      reason = (e instanceof Error && e.name === 'TimeoutError') ? 'timeout' : 'fetch_error';
    }
    if (attempt === 2) {
      console.warn(`[me-wallet-collection-count] failed owner=${owner.slice(0, 8)}… slug=${slug} status=${status} reason=${reason} attempts=${attempt}`);
      return { count: null, cacheable: false };
    }
    await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
  }
  return { count: null, cacheable: false }; // unreachable — satisfies tsc
}

/**
 * Owner's current holdings count within a ME collection slug.
 * Cached (hit + miss), in-flight-deduped, cooldown-aware. Never throws.
 * Matches `getOwnerCollectionDeepCount`'s `{ count }` shape so it can be
 * passed as `seller-holdings.ts`'s pluggable scan function.
 */
export async function getOwnerCollectionCountViaMe(
  owner: string,
  slug: string,
): Promise<{ count: number | null }> {
  if (!owner || !slug) return { count: null };
  const k = key(owner, slug);
  const hit = hitCache.get(k);
  if (hit !== undefined) return { count: hit };
  if (missCache.has(k)) return { count: null };
  const live = inflight.get(k);
  if (live) return { count: await live };

  const p = (async (): Promise<number | null> => {
    try {
      const { count, cacheable } = await fetchCount(owner, slug);
      if (count != null) {
        hitCache.set(k, count);
      } else if (cacheable) {
        missCache.set(k, true);
      }
      return count;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return { count: await p };
}
