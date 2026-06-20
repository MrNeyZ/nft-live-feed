/**
 * Best-effort rarity lookup for the regular Live Feed, reading ONLY the
 * existing `mint_rarity_cache` (populated by the rare-feed evaluator). No
 * provider/RPC calls — a cache miss simply means "no badge".
 *
 * Two in-process layers keep DB load low:
 *   • a per-mint TTL cache (hits AND misses cached), bounded FIFO;
 *   • per-mint in-flight dedup so concurrent lookups do one query.
 * The SSE hot path uses the sync getter (returns cached value, primes on miss);
 * the REST path uses the async batch lookup (one query for all uncached mints).
 */
import { getPool } from '../db/client';
import { saleEventBus } from '../events/emitter';

// Count of late rarity patches emitted (sync-miss → async DB resolve). Logged
// sparsely (first emit + every 50th) so the path is observable without spam.
let lateRarityPatchCount = 0;

export interface RarityLite {
  rarityRank:       number;
  totalSupply:      number;
  rarityPercentile: number;
  raritySource:     string | null;
  /** True only when the mint carries a stored "1/1"-style trait (never from rank). */
  oneOfOne:         boolean;
}

// Split TTLs: a resolved rarity is stable (10 min), but a MISS must expire fast
// so a sale whose mint_rarity_cache row lands seconds later (the resolver writes
// asynchronously) isn't stranded badge-less. The resolver also pushes a patch on
// write (rarity.ts), so this short negative TTL is just a safety re-check.
const POS_TTL_MS = 10 * 60_000;   // 10 min — resolved rarity is stable
const NEG_TTL_MS = 25 * 1_000;    // 25 s — re-check misses quickly
const MAX_SIZE = 20_000;

interface Entry { value: RarityLite | null; expiresAt: number }
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<RarityLite | null>>();

function cacheSet(mint: string, value: RarityLite | null): void {
  if (cache.size >= MAX_SIZE) {
    let drop = MAX_SIZE / 10;
    for (const k of cache.keys()) { cache.delete(k); if (--drop <= 0) break; }
  }
  cache.set(mint, { value, expiresAt: Date.now() + (value ? POS_TTL_MS : NEG_TTL_MS) });
}
/** Fresh cached value, `null` (cached miss), or `undefined` (not cached/stale). */
function cacheGet(mint: string): RarityLite | null | undefined {
  const e = cache.get(mint);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { cache.delete(mint); return undefined; }
  return e.value;
}

/** Prime the in-process cache from the resolver write path so the next sale
 *  frame for this mint is warm and any stale negative entry is replaced. */
export function cacheRarity(mint: string, value: RarityLite): void {
  if (!mint) return;
  cacheSet(mint, value);
}

// "1/1" detection — strictly from a STORED trait value, never inferred from
// rank. Matches the values collections actually store (e.g. {value:"1/1"}).
const ONE_OF_ONE_VALUES = new Set(['1/1', '1of1', 'oneofone', '1:1']);
export function detectOneOfOne(traits: unknown): boolean {
  if (!Array.isArray(traits)) return false;
  for (const t of traits) {
    const v = (t && typeof t === 'object' && 'value' in t) ? (t as { value?: unknown }).value : undefined;
    if (typeof v !== 'string') continue;
    if (ONE_OF_ONE_VALUES.has(v.toLowerCase().replace(/\s+/g, ''))) return true;
  }
  return false;
}

/** Validate a raw mint_rarity_cache row → RarityLite or null. */
function toLite(r: { rarity_rank: number | null; total_supply: number | null; rarity_source: string | null; traits?: unknown } | undefined): RarityLite | null {
  if (!r || r.rarity_rank == null || r.total_supply == null) return null;
  const rank = Number(r.rarity_rank);
  const supply = Number(r.total_supply);
  if (!Number.isFinite(rank) || !Number.isFinite(supply) || supply <= 0 || rank <= 0) return null;
  return { rarityRank: rank, totalSupply: supply, rarityPercentile: rank / supply, raritySource: r.rarity_source ?? null, oneOfOne: detectOneOfOne(r.traits) };
}

/** Async single-mint lookup (cached + in-flight-deduped). */
export async function primeRarity(mint: string): Promise<RarityLite | null> {
  const cached = cacheGet(mint);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(mint);
  if (existing) return existing;
  const p = (async () => {
    try {
      const { rows } = await getPool().query(
        'SELECT rarity_rank, total_supply, rarity_source, traits FROM mint_rarity_cache WHERE mint_address = $1', [mint],
      );
      const v = toLite(rows[0]);
      cacheSet(mint, v);
      // Late resolution: the live `sale` frame for this mint already went out
      // without rarity (sync getter is in-process-only and missed while cold).
      // Push a patch so connected clients light up the badge / Rare Feed
      // without a reload. `toLite` returns non-null ONLY for a finite rank +
      // supply>0, so this never emits a null/negative patch. Fire-and-forget.
      if (v) {
        saleEventBus.emitRarityPatch({
          mintAddress:  mint,
          rarityRank:   v.rarityRank,
          totalSupply:  v.totalSupply,
          raritySource: v.raritySource,
          oneOfOne:     v.oneOfOne,
        });
        lateRarityPatchCount++;
        if (lateRarityPatchCount === 1 || lateRarityPatchCount % 50 === 0) {
          console.log(
            `[rarity-patch] emitted late rarity patch #${lateRarityPatchCount} ` +
            `mint=${mint.slice(0, 8)}… rank=${v.rarityRank}/${v.totalSupply} src=${v.raritySource ?? '—'}`,
          );
        }
      }
      return v;
    } catch {
      return null;   // fail-soft — never block the feed
    } finally {
      inFlight.delete(mint);
    }
  })();
  inFlight.set(mint, p);
  return p;
}

/** Hot-path sync getter: returns the cached value (or null/undefined), and
 *  primes the cache in the background on a miss so the next frame has it. */
export function rarityForMintSync(mint: string | null | undefined): RarityLite | null {
  if (!mint) return null;
  const cached = cacheGet(mint);
  if (cached !== undefined) return cached;
  void primeRarity(mint);   // fire-and-forget; this frame gets no badge
  return null;
}

/** Batch lookup for REST snapshots: one query for all uncached mints. */
export async function rarityForMints(mints: Array<string | null | undefined>): Promise<Map<string, RarityLite | null>> {
  const out = new Map<string, RarityLite | null>();
  const misses: string[] = [];
  for (const m of mints) {
    if (!m) continue;
    const c = cacheGet(m);
    if (c !== undefined) out.set(m, c);
    else if (!misses.includes(m)) misses.push(m);
  }
  if (misses.length > 0) {
    try {
      const { rows } = await getPool().query(
        'SELECT mint_address, rarity_rank, total_supply, rarity_source, traits FROM mint_rarity_cache WHERE mint_address = ANY($1)',
        [misses],
      );
      const byMint = new Map(rows.map((r: { mint_address: string }) => [r.mint_address, r]));
      for (const m of misses) {
        const v = toLite(byMint.get(m) as never);
        cacheSet(m, v);
        out.set(m, v);
      }
    } catch {
      for (const m of misses) out.set(m, null);   // fail-soft
    }
  }
  return out;
}
