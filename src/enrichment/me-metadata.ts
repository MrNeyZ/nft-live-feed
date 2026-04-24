/**
 * Magic Eden v2 tokens API — fallback metadata source for MPL Core assets.
 *
 * Helius DAS returns "Asset Not Found" for many Core mints.  ME's own API
 * indexes them and can return name + image.
 *
 * Endpoint: GET https://api-mainnet.magiceden.dev/v2/tokens/{mint}
 *
 * Only called from enrich.ts after DAS has already failed for a Core event.
 * Throws on any HTTP or parse error so the caller can apply a synthetic fallback.
 */

import { NftMetadata } from './helius-das';

// Verified live shape of ME v2 /tokens/{mint} response:
//   { mintAddress, collection (slug), collectionName, name, image, … }
interface MeTokenResponse {
  name?:           string;
  image?:          string;
  collection?:     string;   // slug
  collectionName?: string;   // human-readable collection name
}

/**
 * Fetch NFT metadata from Magic Eden's v2 tokens endpoint.
 * Throws on non-200 responses and on empty/invalid JSON.
 */
export async function getMeTokenMetadata(mintAddress: string): Promise<NftMetadata> {
  const res = await fetch(
    `https://api-mainnet.magiceden.dev/v2/tokens/${mintAddress}`,
    { headers: { Accept: 'application/json' } },
  );

  if (!res.ok) {
    throw new Error(`ME tokens HTTP ${res.status}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`ME tokens non-JSON response (${ct})`);
  }

  const json = (await res.json()) as MeTokenResponse;

  // ME returns 200 with an empty object when the mint is not indexed
  if (!json.name && !json.image) {
    throw new Error('ME tokens: empty response (mint not indexed)');
  }

  return {
    nftName:           json.name           ?? null,
    imageUrl:          json.image          ?? null,
    collectionName:    json.collectionName ?? null,
    // ME v2 tokens API does not expose the on-chain collection group address
    collectionAddress: null,
    meCollectionSlug:  json.collection     ?? null,
  };
}
