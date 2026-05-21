/**
 * Rare Feed — rarity enrichment via Magic Eden v2 token API, DB-cached.
 *
 *   GET https://api-mainnet.magiceden.dev/v2/tokens/{mintAddress}
 *
 * Rarity is read from ME ONLY (no Tensor, no self-computed rarity, no HTML
 * scraping — per the MVP spec). The flow is deliberately cache-heavy and
 * fail-soft so Rare Feed never adds meaningful ME load and never blocks the
 * live feed:
 *
 *   1. DB cache hit (mint_rarity_cache) within TTL  → no ME call.
 *        - positive (rank found):  RARE_FEED_RARITY_TTL_MS   (default 24h)
 *        - negative (no rank):     RARE_FEED_NEGATIVE_TTL_MS (default 30m)
 *   2. Cache miss → ONE ME fetch, tolerant-parsed, then upserted (positive or
 *      negative). A no-rank result is cached negatively so we don't re-spam ME
 *      for a collection ME simply doesn't rank.
 *   3. Bounded concurrency (RARE_FEED_RARITY_CONCURRENCY, 2–4) + per-mint
 *      in-flight dedup + a process-wide 429 cooldown.
 *
 * ME field names vary across collections/versions, so the rank + supply
 * extractors try many candidate keys (top-level and nested) and log
 * `[rare/rarity] no_rank` when none match.
 */
import { getPool } from '../db/client';

const ME_TOKEN_BASE   = 'https://api-mainnet.magiceden.dev/v2/tokens';
const ME_STATS_BASE   = 'https://api-mainnet.magiceden.dev/v2/collections';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RARITY_TTL_MS   = envInt('RARE_FEED_RARITY_TTL_MS',   24 * 60 * 60 * 1000);
const NEGATIVE_TTL_MS = envInt('RARE_FEED_NEGATIVE_TTL_MS', 30 * 60 * 1000);
/** ME rarity fetch concurrency. Clamped to [1,4] — the spec calls for 2–4. */
const CONCURRENCY     = Math.min(4, Math.max(1, envInt('RARE_FEED_RARITY_CONCURRENCY', 3)));
const FETCH_TIMEOUT_MS = 5_000;
/** Cooldown applied process-wide when ME 429s, so we stop hitting it. */
const ME_COOLDOWN_MS  = 60_000;

export interface Rarity {
  rarityRank:       number | null;
  totalSupply:      number | null;
  rarityPercentile: number | null;
  collectionSymbol: string | null;
  source:           string;          // 'magiceden'
  traits:           unknown | null;
  raw:              unknown | null;
}

const NEGATIVE: Omit<Rarity, 'raw' | 'traits' | 'collectionSymbol'> = {
  rarityRank: null, totalSupply: null, rarityPercentile: null, source: 'magiceden',
};

// ─── Tolerant ME field extraction ────────────────────────────────────────────
// Rank can appear at the top level under several names, or nested inside a
// `rarity` object (moonrank / howrare). Lower rank = rarer. We take the first
// positive integer we find, preferring explicit top-level rank fields.
const RANK_KEYS = [
  'rank', 'rankA', 'rarityRank', 'rarityRankTT',
  'rarityRankMoonrank', 'rarityRankHR', 'rarityRankStat',
] as const;
// On the TOKEN payload, `supply` is the SPL token supply of the NFT itself
// (always 1) — NOT the collection size — so it must NOT be read as a rarity
// denominator. `totalMints` is the only field that, when present on a token /
// launchpad payload, means "mints in the collection". Collection size proper
// is read from the stats endpoint with STATS_SUPPLY_KEYS.
const TOKEN_SUPPLY_KEYS = ['totalMints'] as const;
const STATS_SUPPLY_KEYS = ['totalItems', 'totalSupply', 'supply', 'itemCount', 'totalMints'] as const;

function firstPositiveInt(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/** Pull a rank out of a nested `rarity` object, e.g.
 *  `{ rarity: { moonrank: { rank: 42 }, howrare: { rank: 50 } } }`. */
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

interface ParsedToken {
  rank:             number | null;
  supply:           number | null;
  collectionSymbol: string | null;
  traits:           unknown | null;
}

function parseToken(json: Record<string, unknown>): ParsedToken {
  const rank = firstPositiveInt(json, RANK_KEYS) ?? nestedRarityRank(json);
  const supply = firstPositiveInt(json, TOKEN_SUPPLY_KEYS);
  const collectionSymbol =
    (typeof json['collection'] === 'string' ? (json['collection'] as string) : null) ??
    (typeof json['collectionSymbol'] === 'string' ? (json['collectionSymbol'] as string) : null);
  const traits = json['attributes'] ?? json['attrs'] ?? null;
  return { rank, supply, collectionSymbol, traits };
}

// ─── ME fetch plumbing (concurrency + dedup + cooldown) ───────────────────────
let inFlightCount = 0;
const waiters: Array<() => void> = [];
const inFlightByMint = new Map<string, Promise<Rarity>>();
let meCooldownUntil = 0;

function acquire(): Promise<void> {
  if (inFlightCount < CONCURRENCY) { inFlightCount++; return Promise.resolve(); }
  return new Promise<void>((resolve) => waiters.push(() => { inFlightCount++; resolve(); }));
}
function release(): void {
  inFlightCount--;
  const next = waiters.shift();
  if (next) next();
}

async function meGetJson(url: string): Promise<Record<string, unknown> | null> {
  if (Date.now() < meCooldownUntil) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 429) {
      meCooldownUntil = Date.now() + ME_COOLDOWN_MS;
      console.warn('[rare/rarity] ME 429 — cooling down 60s');
      return null;
    }
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Per-collection supply fallback. ME's token endpoint frequently omits supply;
 *  the collection stats endpoint carries it. Cached per symbol in memory with
 *  a long TTL — supply is effectively static for a closed collection. */
const supplyBySymbol = new Map<string, { supply: number | null; at: number }>();
const SUPPLY_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchCollectionSupply(symbol: string): Promise<number | null> {
  const hit = supplyBySymbol.get(symbol);
  if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.supply;
  const json = await meGetJson(`${ME_STATS_BASE}/${encodeURIComponent(symbol)}/stats`);
  const supply = json ? firstPositiveInt(json, STATS_SUPPLY_KEYS) : null;
  supplyBySymbol.set(symbol, { supply, at: Date.now() });
  return supply;
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
  const hasRank = row.rarity_rank != null;
  // Positive rows live for RARITY_TTL_MS; negative (no-rank) rows for the
  // shorter NEGATIVE_TTL_MS so we re-check ME for newly-ranked collections.
  const ttl = hasRank ? RARITY_TTL_MS : NEGATIVE_TTL_MS;
  if (ageMs > ttl) return null;   // stale → caller refetches
  return {
    rarityRank:       row.rarity_rank,
    totalSupply:      row.total_supply,
    rarityPercentile: row.rarity_percentile != null ? Number(row.rarity_percentile) : null,
    collectionSymbol: row.collection_symbol,
    source:           row.rarity_source ?? 'magiceden',
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
        r.source,
        r.traits != null ? JSON.stringify(r.traits) : null,
        r.raw != null ? JSON.stringify(r.raw) : null,
      ],
    );
  } catch (err) {
    console.warn(`[rare/rarity] cache write failed mint=${mint.slice(0, 8)}…: ${(err as Error).message}`);
  }
}

async function fetchAndCache(mint: string): Promise<Rarity> {
  await acquire();
  try {
    const json = await meGetJson(`${ME_TOKEN_BASE}/${encodeURIComponent(mint)}`);
    if (!json) {
      // ME unavailable / cooled down / 4xx. Negative-cache so we back off, but
      // keep it short via NEGATIVE_TTL_MS.
      const neg: Rarity = { ...NEGATIVE, collectionSymbol: null, traits: null, raw: null };
      await writeCache(mint, neg);
      console.log(`[rare/rarity] miss mint=${mint.slice(0, 8)}… (no ME response)`);
      return neg;
    }
    const parsed = parseToken(json);

    let supply = parsed.supply;
    if (parsed.rank != null && supply == null && parsed.collectionSymbol) {
      // We have a rank but the token payload didn't carry supply — one cached
      // stats lookup per collection fills it in.
      supply = await fetchCollectionSupply(parsed.collectionSymbol);
    }

    const percentile = parsed.rank != null && supply != null && supply > 0
      ? parsed.rank / supply
      : null;

    const rarity: Rarity = {
      rarityRank:       parsed.rank,
      totalSupply:      supply,
      rarityPercentile: percentile,
      collectionSymbol: parsed.collectionSymbol,
      source:           'magiceden',
      traits:           parsed.traits,
      raw:              json,
    };
    await writeCache(mint, rarity);
    if (parsed.rank == null) {
      console.log(`[rare/rarity] no_rank mint=${mint.slice(0, 8)}… symbol=${parsed.collectionSymbol ?? '?'}`);
    } else {
      console.log(
        `[rare/rarity] fetched mint=${mint.slice(0, 8)}… rank=${parsed.rank} ` +
        `supply=${supply ?? '?'} pct=${percentile != null ? (percentile * 100).toFixed(2) + '%' : '?'}`,
      );
    }
    return rarity;
  } finally {
    release();
  }
}

/**
 * Resolve rarity for a mint. DB-cache first (no ME call on hit), then a single
 * bounded ME fetch on miss. Never throws — returns a NEGATIVE result on any
 * failure so the caller can fail-soft.
 */
export async function getRarity(mint: string): Promise<Rarity> {
  if (!mint) return { ...NEGATIVE, collectionSymbol: null, traits: null, raw: null };

  try {
    const cached = await readCache(mint);
    if (cached) {
      console.log(`[rare/rarity] hit mint=${mint.slice(0, 8)}… rank=${cached.rarityRank ?? 'none'}`);
      return cached;
    }
  } catch (err) {
    console.warn(`[rare/rarity] cache read failed mint=${mint.slice(0, 8)}…: ${(err as Error).message}`);
  }

  // Dedupe concurrent misses for the same mint onto one ME fetch.
  const existing = inFlightByMint.get(mint);
  if (existing) return existing;
  const p = fetchAndCache(mint).finally(() => inFlightByMint.delete(mint));
  inFlightByMint.set(mint, p);
  return p;
}
