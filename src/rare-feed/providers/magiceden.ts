/**
 * Magic Eden rarity provider.
 *
 * ME's public `/v2/tokens/{mint}` rarely carries a rarity rank for Solana
 * collections (verified live — most return only attributes/collection/image),
 * so ME is the LAST resort in the provider chain: used only when a rank field
 * actually exists. The tolerant parser tries many top-level + nested field
 * names; supply (when a rank is present but supply isn't on the token payload)
 * is filled from the collection stats endpoint, cached per symbol.
 *
 * Note: ME's token-level `supply` is the per-NFT SPL supply (always 1) — NOT
 * collection size — so it is deliberately excluded as a rarity denominator.
 */
import { getJson, firstPositiveInt, type RarityProvider, type RarityFetch } from './shared';

const TOKEN_BASE = 'https://api-mainnet.magiceden.dev/v2/tokens';
const STATS_BASE = 'https://api-mainnet.magiceden.dev/v2/collections';

const RANK_KEYS = [
  'rank', 'rankA', 'rarityRank', 'rarityRankTT',
  'rarityRankMoonrank', 'rarityRankHR', 'rarityRankStat',
] as const;
const TOKEN_SUPPLY_KEYS = ['totalMints'] as const;
const STATS_SUPPLY_KEYS = ['totalItems', 'totalSupply', 'supply', 'itemCount', 'totalMints'] as const;

function nestedRarityRank(obj: Record<string, unknown>): number | null {
  const rarity = obj['rarity'];
  if (!rarity || typeof rarity !== 'object') return null;
  for (const provider of Object.values(rarity as Record<string, unknown>)) {
    if (provider && typeof provider === 'object') {
      const r = firstPositiveInt(provider as Record<string, unknown>, ['rank', 'rarityRank']);
      if (r != null) return r;
    } else {
      const n = typeof provider === 'number' ? provider : NaN;
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return null;
}

const supplyBySymbol = new Map<string, { supply: number | null; at: number }>();
const SUPPLY_TTL_MS = 6 * 60 * 60 * 1000;

async function collectionSupply(symbol: string): Promise<number | null> {
  const hit = supplyBySymbol.get(symbol);
  if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.supply;
  const json = await getJson<Record<string, unknown>>(
    `${STATS_BASE}/${encodeURIComponent(symbol)}/stats`,
    { label: 'magiceden', timeoutMs: 6_000 },
  );
  const supply = json ? firstPositiveInt(json, STATS_SUPPLY_KEYS) : null;
  supplyBySymbol.set(symbol, { supply, at: Date.now() });
  return supply;
}

export const magicEdenProvider: RarityProvider = {
  name: 'magiceden',
  enabled() { return true; },
  async resolve(mint: string): Promise<RarityFetch | null> {
    const json = await getJson<Record<string, unknown>>(
      `${TOKEN_BASE}/${encodeURIComponent(mint)}`,
      { label: 'magiceden', timeoutMs: 5_000 },
    );
    if (!json) return null;
    const rank = firstPositiveInt(json, RANK_KEYS) ?? nestedRarityRank(json);
    if (rank == null) return null;   // ME has no rank for this mint → chain continues

    let supply = firstPositiveInt(json, TOKEN_SUPPLY_KEYS);
    const collectionSymbol =
      (typeof json['collection'] === 'string' ? json['collection'] as string : null) ??
      (typeof json['collectionSymbol'] === 'string' ? json['collectionSymbol'] as string : null);
    if (supply == null && collectionSymbol) supply = await collectionSupply(collectionSymbol);
    if (supply == null) return null;  // can't compute a percentile without supply

    return {
      rank, supply, collectionSymbol,
      traits: json['attributes'] ?? json['attrs'] ?? null,
      raw: json, source: 'magiceden',
    };
  },
};
