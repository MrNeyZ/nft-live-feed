/**
 * Tensor rarity provider — OFFICIAL API only, gated behind TENSOR_API_KEY.
 *
 *   GET https://api.mainnet.tensordev.io/api/v1/mint?mints={mint}
 *   header: x-tensor-api-key: <key>
 *
 * Status: this is the future-primary source. It is a clean no-op when
 * TENSOR_API_KEY is unset (`enabled()` → false), so today it never runs.
 *
 * IMPORTANT — the response parsing below is UNVERIFIED: Tensor's free/public
 * endpoints are decommissioned (api.tensor.so DNS-dead) or Cloudflare-walled
 * (graphql.tensor.trade), and we have no key, so the field mapping is written
 * from Tensor's documented field names (rarityRankTT / rarityRankTTStat /
 * rarityRankHR / rarityRankMoonrank, numMints/totalSupply, slug). The parser
 * is tolerant; confirm and adjust against a live response when a key is added.
 *
 * Per the explicit constraint: NO scraping, NO Cloudflare-bypassed GraphQL,
 * NO unofficial bot-walled endpoints. Official keyed API or nothing.
 */
import { getJson, firstPositiveInt, type RarityProvider, type RarityFetch } from './shared';

const BASE = 'https://api.mainnet.tensordev.io/api/v1';

// Tensor publishes rank under several algo-specific names. Prefer Tensor's own
// (TT) ranks, then statistical / HowRare / Moonrank variants.
const RANK_KEYS = [
  'rarityRankTT', 'rarityRankTTStat', 'rarityRankHR',
  'rarityRankMoonrank', 'rarityRankStat', 'rank',
] as const;
const SUPPLY_KEYS = ['numMints', 'totalSupply', 'numItems', 'supply'] as const;

function tensorKey(): string | null {
  const k = (process.env.TENSOR_API_KEY ?? '').trim();
  return k.length > 0 ? k : null;
}

export const tensorProvider: RarityProvider = {
  name: 'tensor',
  enabled() { return tensorKey() != null; },
  async resolve(mint: string): Promise<RarityFetch | null> {
    const key = tensorKey();
    if (!key) return null;
    const json = await getJson<unknown>(
      `${BASE}/mint?mints=${encodeURIComponent(mint)}`,
      { label: 'tensor', timeoutMs: 6_000, headers: { 'x-tensor-api-key': key } },
    );
    if (!json) return null;
    // Tolerant: accept either a bare object or an array of mint objects.
    const obj = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== 'object') return null;
    // Some Tensor shapes nest the mint under `mint` / `data`.
    const node = (obj['mint'] && typeof obj['mint'] === 'object' ? obj['mint']
      : obj['data'] && typeof obj['data'] === 'object' ? obj['data']
      : obj) as Record<string, unknown>;

    const rank = firstPositiveInt(node, RANK_KEYS);
    if (rank == null) return null;
    const supply = firstPositiveInt(node, SUPPLY_KEYS);
    if (supply == null) return null;
    const collectionSymbol =
      (typeof node['slug'] === 'string' ? node['slug'] as string : null) ??
      (typeof node['slugDisplay'] === 'string' ? node['slugDisplay'] as string : null);

    return {
      rank, supply, collectionSymbol,
      traits: node['attributes'] ?? node['attrs'] ?? null,
      raw: json, source: 'tensor',
    };
  },
};
