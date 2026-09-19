/**
 * artistproof.digital pack-slug lookup.
 *
 * Artist Proof (the ART launchpad — see
 * `src/ingestion/mint-raw/launchpad-detector.ts` for the on-chain
 * fingerprint) has no per-collection page keyed by the on-chain
 * collection address; the user-facing URL is
 *   https://artistproof.digital/packs/{slug}
 * where `{slug}` is a DB-assigned slug that does NOT always match a
 * simple slugify(name) — e.g. the on-chain collection named
 * "Happy Birthday AP" has `slug: "ap-bday"` in their own DB, not
 * "happy-birthday-ap". The slug must be looked up, not derived.
 *
 * Artist Proof is a Supabase-backed app (built on lovable.dev); their
 * client bundle embeds a Supabase "publishable" key — the same
 * client-safe key every visitor's browser already uses to read public
 * rows via PostgREST. We call the same public REST endpoint directly.
 * Two tables can hold the slug depending on the piece's type:
 *   - `drops`    — curated/exhibition pieces (e.g. AP Genesis entries).
 *   - `editions` — standalone artist-minted editions.
 * Both are queried by `collection_address`; first hit wins.
 */

const SUPABASE_URL = 'https://qzbpkikfxlmbivgigtnx.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_rVuCxoizRbgp8cpHa7D0Ow_hP1d4F1V';
const FETCH_TIMEOUT_MS = 8_000;
/** Positive hits are effectively immutable (a piece's slug doesn't
 *  change); negative results are cached for a much shorter window in
 *  case the piece simply hadn't landed in their DB yet at lookup time. */
const POSITIVE_TTL_MS = 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 10 * 60_000;

interface CacheEntry { info: ArtProofInfo | null; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

export interface ArtProofInfo {
  slug:      string;
  /** Planned cap — `drops.total_items` (a "pack" drop's declared item
   *  count) or `editions.supply` (a standalone edition's print run).
   *  Neither table stores this on-chain (MPL Core's CollectionV1 has no
   *  cap field at all — see core-supply-refresher.ts), so this is the
   *  only source for it. Null when the row doesn't carry one. */
  maxSupply: number | null;
}

/** `drops` and `editions` name their columns differently (`total_items` vs
 *  `supply`) — confirmed via the field list Artist Proof's own client
 *  bundle selects (`id, slug, name, ..., total_items, claimed_count, ...`
 *  for drops; `slug, ..., supply, minted_count, ...` for editions). Neither
 *  is a simple slugify of the piece name (e.g. "Happy Birthday AP" →
 *  "ap-bday"), so both fields must come from the table, not be derived. */
const TABLE_COLUMNS: Record<'drops' | 'editions', string> = {
  drops:    'slug,total_items',
  editions: 'slug,supply',
};

async function queryTable(table: 'drops' | 'editions', collectionAddress: string): Promise<ArtProofInfo | null> {
  const url = `${SUPABASE_URL}/rest/v1/${table}` +
    `?select=${TABLE_COLUMNS[table]}&collection_address=eq.${encodeURIComponent(collectionAddress)}&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        apikey:        SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = await res.json() as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0] as { slug?: unknown; total_items?: unknown; supply?: unknown };
    if (typeof row.slug !== 'string' || row.slug.length === 0) return null;
    const cap = table === 'drops' ? row.total_items : row.supply;
    const maxSupply = typeof cap === 'number' && cap > 0 ? cap : null;
    return { slug: row.slug, maxSupply };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the artistproof.digital pack slug + planned cap for an on-chain
 *  collection address. Cached (positive: 24h, negative: 10min) — safe to
 *  call once per confirmed mint without worrying about hammering their
 *  API. */
export async function resolveArtProofInfo(collectionAddress: string): Promise<ArtProofInfo | null> {
  const now = Date.now();
  const cached = cache.get(collectionAddress);
  if (cached && cached.expiresAt > now) return cached.info;

  let info = await queryTable('drops', collectionAddress);
  if (!info) info = await queryTable('editions', collectionAddress);

  cache.set(collectionAddress, {
    info,
    expiresAt: now + (info ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return info;
}
