/**
 * Magic Eden collection-name fallback for /mints.
 *
 * Used ONLY when the primary metadata path (DAS getAsset → LMNFT
 * homepage scraper → strip-#N from nftName) hasn't surfaced a real
 * collection name yet. Thin adapter over the shared `getMeTokenData()`
 * client (`./me-token-cache`) — that module owns the actual fetch,
 * cache, in-flight dedup, timeout, and cooldown integration for
 * `GET /v2/tokens/{mint}`; this file only narrows the result to the
 * two fields `/mints` cares about.
 *
 * Caller is responsible for sticky-merge: this module only returns the
 * lookup result; patching the accumulator stays in collection-confirm.ts
 * where the "is current name weak?" check is made.
 */

import { getMeTokenData } from './me-token-cache';

export interface MeCollectionLookup {
  collectionName: string | null;
  collectionSlug: string | null;
}

export async function getMagicEdenCollectionName(mintAddress: string): Promise<MeCollectionLookup> {
  if (!mintAddress) return { collectionName: null, collectionSlug: null };
  const data = await getMeTokenData(mintAddress);
  if (data.collectionName) {
    console.log(
      `[mints/name-fallback] source=magiceden collection=${data.collectionName} ` +
      `name=${data.collectionName} slug=${data.slug ?? '—'}`,
    );
  } else {
    console.log(`[mints/name-fallback-miss] mint=${mintAddress.slice(0, 8)}…`);
  }
  return { collectionName: data.collectionName, collectionSlug: data.slug };
}
