/**
 * Rare Feed — rarity resolution. DB-cached, pluggable multi-provider chain.
 *
 * Provider priority (first to return a rank+supply wins):
 *   1. Tensor   — official keyed API; primary WHEN TENSOR_API_KEY is set,
 *                 otherwise skipped cleanly (future-primary).
 *   2. HowRare  — keyless, working today; collection-bulk cached per slug.
 *   3. ME       — only if its token payload actually carries a rank (rare).
 *
 * Flow:
 *   1. Per-mint DB cache hit (mint_rarity_cache) within TTL → no network.
 *        positive (rank): RARE_FEED_RARITY_TTL_MS (24h)
 *        negative (no rank anywhere): RARE_FEED_NEGATIVE_TTL_MS (30m)
 *   2. Miss → walk the enabled providers in priority order; first hit is
 *      cached (with its `rarity_source`) and returned. No hit → negative cache.
 *   3. Per-mint in-flight dedup so concurrent sales of one mint do one pass.
 *
 * Cache schema is generic: rarity_source ∈ {tensor, howrare, magiceden}, and
 * the provider's raw response is stored in `raw`. Fail-soft throughout — any
 * error yields a NEGATIVE result so the evaluator never blocks.
 */
import { getPool } from '../db/client';
import { tensorProvider } from './providers/tensor';
import { howRareProvider } from './providers/howrare';
import { magicEdenProvider } from './providers/magiceden';
import type { RarityProvider, RaritySource } from './providers/shared';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const RARITY_TTL_MS   = envInt('RARE_FEED_RARITY_TTL_MS',   24 * 60 * 60 * 1000);
const NEGATIVE_TTL_MS = envInt('RARE_FEED_NEGATIVE_TTL_MS', 30 * 60 * 1000);
/** Row-retention for the rarity cache (days). Far longer than either freshness
 *  TTL above, so cleanup only ever removes long-stale rows — and stale rows are
 *  re-fetched on demand anyway, so deletion is lossless. */
const CACHE_RETENTION_DAYS = envInt('RARE_FEED_RARITY_CACHE_RETENTION_DAYS', 14);

/** Priority order. Tensor first (no-ops without a key), then HowRare, then ME. */
const PROVIDERS: RarityProvider[] = [tensorProvider, howRareProvider, magicEdenProvider];

export interface Rarity {
  rarityRank:       number | null;
  totalSupply:      number | null;
  rarityPercentile: number | null;
  collectionSymbol: string | null;
  source:           RaritySource | 'none';
  traits:           unknown | null;
  raw:              unknown | null;
}

function negative(): Rarity {
  return { rarityRank: null, totalSupply: null, rarityPercentile: null, collectionSymbol: null, source: 'none', traits: null, raw: null };
}

// ─── DB cache ─────────────────────────────────────────────────────────────────
interface CacheRow {
  collection_symbol: string | null;
  rarity_rank:       number | null;
  total_supply:      number | null;
  rarity_percentile: string | number | null;
  rarity_source:     string;
  traits:            unknown | null;
  raw:               unknown | null;
  fetched_at:        Date;
}

async function readCache(mint: string): Promise<Rarity | null> {
  const { rows } = await getPool().query<CacheRow>(
    `SELECT collection_symbol, rarity_rank, total_supply, rarity_percentile,
            rarity_source, traits, raw, fetched_at
       FROM mint_rarity_cache WHERE mint_address = $1`,
    [mint],
  );
  const row = rows[0];
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  const ttl = row.rarity_rank != null ? RARITY_TTL_MS : NEGATIVE_TTL_MS;
  if (ageMs > ttl) return null;   // stale → refetch
  return {
    rarityRank:       row.rarity_rank,
    totalSupply:      row.total_supply,
    rarityPercentile: row.rarity_percentile != null ? Number(row.rarity_percentile) : null,
    collectionSymbol: row.collection_symbol,
    source:           (row.rarity_source as RaritySource) ?? 'none',
    traits:           row.traits ?? null,
    raw:              row.raw ?? null,
  };
}

async function writeCache(mint: string, r: Rarity): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO mint_rarity_cache
         (mint_address, collection_symbol, rarity_rank, total_supply,
          rarity_percentile, rarity_source, traits, raw, fetched_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (mint_address) DO UPDATE SET
         collection_symbol = EXCLUDED.collection_symbol,
         rarity_rank       = EXCLUDED.rarity_rank,
         total_supply      = EXCLUDED.total_supply,
         rarity_percentile = EXCLUDED.rarity_percentile,
         rarity_source     = EXCLUDED.rarity_source,
         traits            = EXCLUDED.traits,
         raw               = EXCLUDED.raw,
         fetched_at        = now(),
         updated_at        = now()`,
      [
        mint,
        r.collectionSymbol,
        r.rarityRank,
        r.totalSupply,
        r.rarityPercentile,
        r.source,   // 'tensor' | 'howrare' | 'magiceden' | 'none' (negative cache)
        r.traits != null ? JSON.stringify(r.traits) : null,
        r.raw != null ? JSON.stringify(r.raw) : null,
      ],
    );
  } catch (err) {
    console.warn(`[rare/rarity] cache write failed mint=${mint.slice(0, 8)}…: ${(err as Error).message}`);
  }
}

/**
 * Prune long-stale rows from mint_rarity_cache. Without this the cache grows
 * one row per distinct mint ever seen, forever (rare_feed_events has retention,
 * this didn't). Safe + lossless: the cutoff (CACHE_RETENTION_DAYS) is far beyond
 * both the positive (24h) and negative (30m) freshness TTLs, so only rows that
 * are already stale — and would be re-fetched on next access anyway — are
 * removed. Parameterized. Returns rows deleted.
 */
export async function cleanupOldRarityCache(): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM mint_rarity_cache WHERE fetched_at < now() - ($1 || ' days')::interval`,
    [String(CACHE_RETENTION_DAYS)],
  );
  return rowCount ?? 0;
}

// ─── Provider chain ─────────────────────────────────────────────────────────
const inFlightByMint = new Map<string, Promise<Rarity>>();

async function resolveViaProviders(mint: string, slug: string | null): Promise<Rarity> {
  for (const p of PROVIDERS) {
    if (!p.enabled()) continue;
    let hit;
    try {
      hit = await p.resolve(mint, slug);
    } catch (err) {
      console.warn(`[rare/rarity] provider=${p.name} error mint=${mint.slice(0, 8)}…: ${(err as Error).message}`);
      continue;
    }
    if (hit && hit.supply > 0) {
      const percentile = hit.rank / hit.supply;
      const rarity: Rarity = {
        rarityRank: hit.rank, totalSupply: hit.supply, rarityPercentile: percentile,
        collectionSymbol: hit.collectionSymbol, source: hit.source, traits: hit.traits, raw: hit.raw,
      };
      await writeCache(mint, rarity);
      console.log(
        `[rare/rarity] hit source=${hit.source} mint=${mint.slice(0, 8)}… ` +
        `rank=${hit.rank}/${hit.supply} pct=${(percentile * 100).toFixed(2)}%`,
      );
      return rarity;
    }
  }
  // No provider had a rank. Negative-cache so we back off (short TTL).
  const neg = negative();
  await writeCache(mint, neg);
  console.log(`[rare/rarity] no_rank mint=${mint.slice(0, 8)}… slug=${slug ?? '?'} (all providers)`);
  return neg;
}

/**
 * Resolve rarity for a mint (slug is the ME collection slug, used by HowRare).
 * DB-cache first, then the provider chain. Never throws.
 */
export async function getRarity(mint: string, slug: string | null = null): Promise<Rarity> {
  if (!mint) return negative();

  try {
    const cached = await readCache(mint);
    if (cached) return cached;
  } catch (err) {
    console.warn(`[rare/rarity] cache read failed mint=${mint.slice(0, 8)}…: ${(err as Error).message}`);
  }

  const existing = inFlightByMint.get(mint);
  if (existing) return existing;
  const p = resolveViaProviders(mint, slug).finally(() => inFlightByMint.delete(mint));
  inFlightByMint.set(mint, p);
  return p;
}
