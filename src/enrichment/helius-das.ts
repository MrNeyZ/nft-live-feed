/**
 * Helius Digital Asset Standard (DAS) getAsset call.
 * Docs: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api
 */

export interface NftMetadata {
  nftName: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  /** On-chain collection group address from DAS grouping (group_key === 'collection'). */
  collectionAddress: string | null;
  /** Magic Eden verified collection slug (e.g. "froganas"). Null when unknown. */
  meCollectionSlug: string | null;
}

// Minimal shape of the Helius DAS getAsset response we care about
interface DasAsset {
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
    collection_metadata?: { name?: string };
  }>;
}

interface DasResponse {
  result?: DasAsset;
  error?: { code: number; message: string };
}

export async function getAsset(mintAddress: string): Promise<NftMetadata> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');

  const res = await fetch(
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'enrich',
        method: 'getAsset',
        params: { id: mintAddress },
      }),
      signal: AbortSignal.timeout(8_000),
    }
  );

  if (!res.ok) {
    throw new Error(`DAS getAsset HTTP ${res.status}`);
  }

  const json = (await res.json()) as DasResponse;
  if (json.error) {
    throw new Error(`DAS getAsset error ${json.error.code}: ${json.error.message}`);
  }

  const asset = json.result;
  const collection = asset?.grouping?.find((g) => g.group_key === 'collection');

  return {
    nftName: asset?.content?.metadata?.name ?? null,
    imageUrl: asset?.content?.links?.image ?? null,
    collectionName: collection?.collection_metadata?.name ?? null,
    collectionAddress: collection?.group_value ?? null,
    meCollectionSlug: null,  // populated separately in enrich.ts via ME public API
  };
}
