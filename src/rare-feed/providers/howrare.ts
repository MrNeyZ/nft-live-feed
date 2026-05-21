/**
 * HowRare.is rarity provider — the working keyless rank source for the MVP.
 *
 *   GET https://api.howrare.is/v0.1/collections/{slug}
 *
 * Returns the WHOLE collection in one call: `result.data.items[]` each with
 * `mint` + `rank` (+ `all_ranks`, `attributes`), and `items.length` ≈ total
 * supply. So instead of a per-mint call we fetch a collection ONCE, build a
 * mint→rank map, and cache it — every subsequent sale in that collection is a
 * pure in-memory lookup (zero extra HTTP). Public, no key, no scraping.
 *
 * Slug caveat: HowRare slugs sometimes differ from Magic Eden slugs (e.g. ME
 * `solana_monkey_business` → HowRare `smb`). resolveSlug() tries a few
 * candidates + an env-extensible alias map, and negative-caches misses so we
 * don't refetch a 404 collection every sale.
 */
import { getJson, type RarityProvider, type RarityFetch } from './shared';

const BASE = 'https://api.howrare.is/v0.1/collections';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const POSITIVE_TTL_MS = envInt('RARE_FEED_RARITY_TTL_MS',   24 * 60 * 60 * 1000);
const NEGATIVE_TTL_MS = envInt('RARE_FEED_NEGATIVE_TTL_MS', 30 * 60 * 1000);
const MAX_COLLECTIONS = 200;   // bound the in-memory collection cache

// Built-in ME-slug → HowRare-slug aliases. Extend at runtime via
// RARE_FEED_HOWRARE_ALIASES="meSlug:howrareSlug,meSlug2:howrareSlug2".
//
// Each entry below is HIGH-CONFIDENCE: confirmed by a mint-membership audit
// over our top-100 highest-volume collections — a real sale mint of the ME
// slug was found in the mapped HowRare collection's item list (not guessed by
// name). See the audit in the PR description.
const BUILTIN_ALIASES: Record<string, string> = {
  solana_monkey_business: 'smb',
  theheist:               'the_heist',
  mad_lads:               'madlads',
  gates_of_brohalla:      'brohalla',
  elixir_ovols:           'elixirovols',
  famous_fox_federation:  'famousfoxfederation',
  mindlings:              'mindfolk_mindlings',
  smb_gen3:               'smbgen3',
  solana_feline_business: 'solanafelinebusiness',
};
function loadAliases(): Record<string, string> {
  const out = { ...BUILTIN_ALIASES };
  const raw = (process.env.RARE_FEED_HOWRARE_ALIASES ?? '').trim();
  if (raw) {
    for (const pair of raw.split(',')) {
      const [me, hr] = pair.split(':').map(s => s.trim());
      if (me && hr) out[me] = hr;
    }
  }
  return out;
}
const ALIASES = loadAliases();

/** Candidate HowRare slugs to try for a given ME slug, in order. */
function slugCandidates(meSlug: string): string[] {
  const c = new Set<string>();
  if (ALIASES[meSlug]) c.add(ALIASES[meSlug]);   // explicit alias wins
  c.add(meSlug);
  c.add(meSlug.toLowerCase());
  c.add(meSlug.replace(/_+$/g, ''));             // trailing underscores (e.g. "solnautz___")
  return [...c].filter(Boolean);
}

interface CollMap { ranks: Map<string, number>; supply: number; at: number; hrSlug: string }
const positive = new Map<string, CollMap>();      // me-slug → map
const negativeAt = new Map<string, number>();      // me-slug → ts of last 404/miss
const inFlight = new Map<string, Promise<CollMap | null>>();

interface HowRareItem { mint?: string; rank?: number }
interface HowRareResp { result?: { api_code?: number; data?: { items?: HowRareItem[] } } }

async function fetchCollection(meSlug: string): Promise<CollMap | null> {
  for (const cand of slugCandidates(meSlug)) {
    const json = await getJson<HowRareResp>(`${BASE}/${encodeURIComponent(cand)}`, {
      label: 'howrare', timeoutMs: 20_000,
    });
    const items = json?.result?.data?.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    const ranks = new Map<string, number>();
    for (const it of items) {
      if (typeof it.mint === 'string' && typeof it.rank === 'number' && it.rank > 0) {
        ranks.set(it.mint, it.rank);
      }
    }
    if (ranks.size === 0) continue;
    console.log(`[rare/rarity] howrare collection meSlug=${meSlug} hrSlug=${cand} items=${ranks.size}`);
    return { ranks, supply: items.length, at: Date.now(), hrSlug: cand };
  }
  return null;
}

async function getCollection(meSlug: string): Promise<CollMap | null> {
  const hit = positive.get(meSlug);
  if (hit && Date.now() - hit.at < POSITIVE_TTL_MS) return hit;
  const negAt = negativeAt.get(meSlug);
  if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) return null;   // recently 404'd

  const existing = inFlight.get(meSlug);
  if (existing) return existing;

  const p = (async () => {
    const map = await fetchCollection(meSlug);
    if (map) {
      positive.set(meSlug, map);
      negativeAt.delete(meSlug);
      // Bound the cache — drop the oldest collection when over the cap.
      if (positive.size > MAX_COLLECTIONS) {
        let oldestKey: string | null = null; let oldestAt = Infinity;
        for (const [k, v] of positive) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
        if (oldestKey) positive.delete(oldestKey);
      }
    } else {
      negativeAt.set(meSlug, Date.now());
      console.log(`[rare/rarity] howrare no_slug meSlug=${meSlug} (tried ${slugCandidates(meSlug).join('/')})`);
    }
    return map;
  })().finally(() => inFlight.delete(meSlug));
  inFlight.set(meSlug, p);
  return p;
}

export const howRareProvider: RarityProvider = {
  name: 'howrare',
  enabled() { return (process.env.RARE_FEED_HOWRARE_ENABLED ?? 'true').trim().toLowerCase() !== 'false'; },
  async resolve(mint: string, slug: string | null): Promise<RarityFetch | null> {
    if (!slug) return null;
    const coll = await getCollection(slug);
    if (!coll) return null;
    const rank = coll.ranks.get(mint);
    if (rank == null) return null;
    return {
      rank,
      supply:           coll.supply,
      collectionSymbol: coll.hrSlug,
      traits:           null,
      raw:              { provider: 'howrare', hrSlug: coll.hrSlug, rank, supply: coll.supply },
      source:           'howrare',
    };
  },
};
