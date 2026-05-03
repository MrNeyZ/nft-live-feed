/**
 * Magic Eden collection-name fallback for /mints.
 *
 * Used ONLY when the primary metadata path (DAS getAsset → LMNFT
 * homepage scraper → strip-#N from nftName) hasn't surfaced a real
 * collection name yet. ME's `/v2/tokens/{mintAddress}` returns
 * `{collection, collectionName, name, image}` for any indexed Solana
 * mint — public endpoint, no auth, single round-trip per mint.
 *
 * Cache TTL is 20 min (collection-name barely changes after launch),
 * single-flight per mintAddress, never throws. Caller is responsible
 * for sticky-merge: this module only returns the lookup result;
 * patching the accumulator stays in collection-confirm.ts where the
 * "is current name weak?" check is made.
 */

import { TtlCache } from './cache';

const ME_TOKEN_ENDPOINT = 'https://api-mainnet.magiceden.dev/v2/tokens/';
const TTL_MS            = 20 * 60_000;
const SWEEP_MS          = 5 * 60_000;
const FETCH_TIMEOUT_MS  = 6_000;

export interface MeCollectionLookup {
  collectionName: string | null;
  collectionSlug: string | null;
}

const cache    = new TtlCache<string, MeCollectionLookup>(TTL_MS, SWEEP_MS);
const inflight = new Map<string, Promise<MeCollectionLookup>>();

interface MeTokenResponse {
  collection?:     unknown;
  collectionName?: unknown;
}

export async function getMagicEdenCollectionName(mintAddress: string): Promise<MeCollectionLookup> {
  if (!mintAddress) return { collectionName: null, collectionSlug: null };
  const hit = cache.get(mintAddress);
  if (hit !== undefined) return hit;
  const live = inflight.get(mintAddress);
  if (live) return live;
  const p = (async (): Promise<MeCollectionLookup> => {
    try {
      const res = await fetch(`${ME_TOKEN_ENDPOINT}${encodeURIComponent(mintAddress)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const out: MeCollectionLookup = { collectionName: null, collectionSlug: null };
        cache.set(mintAddress, out);
        console.log(`[mints/name-fallback-miss] reason=http_${res.status} mint=${mintAddress.slice(0, 8)}…`);
        return out;
      }
      const json = (await res.json()) as MeTokenResponse;
      const collectionName = typeof json.collectionName === 'string' && json.collectionName.length > 0
        ? json.collectionName
        : null;
      const collectionSlug = typeof json.collection === 'string' && json.collection.length > 0
        ? json.collection
        : null;
      const out: MeCollectionLookup = { collectionName, collectionSlug };
      cache.set(mintAddress, out);
      if (collectionName) {
        console.log(
          `[mints/name-fallback] source=magiceden ` +
          `collection=${collectionName} name=${collectionName} slug=${collectionSlug ?? '—'}`,
        );
      } else {
        console.log(
          `[mints/name-fallback-miss] reason=no_collection_name mint=${mintAddress.slice(0, 8)}…`,
        );
      }
      return out;
    } catch (e) {
      const out: MeCollectionLookup = { collectionName: null, collectionSlug: null };
      cache.set(mintAddress, out);
      console.log(
        `[mints/name-fallback-miss] reason=fetch_error mint=${mintAddress.slice(0, 8)}… ` +
        `msg=${(e as Error).message}`,
      );
      return out;
    } finally {
      inflight.delete(mintAddress);
    }
  })();
  inflight.set(mintAddress, p);
  return p;
}
