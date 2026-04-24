/**
 * Local verified-collection catalog.
 *
 * Powers /api/collections/search without any dependency on ingestion history.
 * Persists to Postgres (`collection_catalog` table, migration 006) so the
 * catalog survives process restarts and doesn't need a full ME re-pagination
 * on boot. An in-memory mirror keeps query-time search sub-10 ms.
 *
 * Lifecycle:
 *   boot:
 *     - SELECT existing rows into in-memory mirror (instant search).
 *     - Fire a background refresh (non-blocking) to upsert newer data.
 *   every CHECK_INTERVAL_MS:
 *     - If last successful refresh > REFRESH_INTERVAL_MS ago, re-refresh.
 *   refresh:
 *     - Paginate ME `/v2/collections`, keep only rows where `isBadged=true`,
 *       UPSERT into Postgres, rebuild the in-memory mirror.
 *     - Transient failures preserve the previous snapshot.
 *
 * Source filter: only collections that carry ME's verified badge (isBadged=true)
 * make it into the catalog. Unverified / spam collections never pollute search.
 */

import { Limiter } from '../ingestion/concurrency';
import { getPool } from '../db/client';

const ME_API_BASE          = 'https://api-mainnet.magiceden.dev/v2';
const PAGE_SIZE            = 500;
const MAX_PAGES            = 120;                 // 60k ceiling; early-exits on short page
const FETCH_TIMEOUT_MS     = 8_000;
const REFRESH_INTERVAL_MS  = 12 * 60 * 60_000;    // 12 h
const CHECK_INTERVAL_MS    =  1 * 60 * 60_000;    // recheck hourly
const DB_UPSERT_CHUNK      = 500;

export interface CatalogEntry {
  slug:    string;
  name:    string;
  image:   string | null;
  twitter: string | null;
  discord: string | null;
  website: string | null;
}

let catalog: CatalogEntry[] = [];
let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;

const limiter = new Limiter(1, 500);

interface MeCollectionRaw {
  symbol?:   string;
  name?:     string;
  image?:    string;
  isBadged?: boolean;
  twitter?:  string;
  discord?:  string;
  website?:  string;
}

/** Normalise the sometimes-empty-string socials ME returns into `null`. */
function emptyToNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

async function fetchPage(offset: number): Promise<MeCollectionRaw[] | null> {
  const out = await limiter.run(async () => {
    try {
      const res = await fetch(
        `${ME_API_BASE}/collections?offset=${offset}&limit=${PAGE_SIZE}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const json = await res.json() as unknown;
      return Array.isArray(json) ? json as MeCollectionRaw[] : null;
    } catch {
      return null;
    }
  });
  return out ?? null;
}

async function upsertChunk(rows: CatalogEntry[]): Promise<void> {
  if (rows.length === 0) return;
  const pool = getPool();
  // Build VALUES list safely with parameter placeholders. 6 cols per row.
  const values: (string | null)[] = [];
  const placeholders: string[] = [];
  rows.forEach((r, i) => {
    const base = i * 6;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, TRUE, NOW())`,
    );
    values.push(r.slug, r.name, r.image, r.twitter, r.discord, r.website);
  });
  const sql = `
    INSERT INTO collection_catalog (slug, name, image, twitter, discord, website, verified_me, updated_at)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        image = EXCLUDED.image,
        twitter = EXCLUDED.twitter,
        discord = EXCLUDED.discord,
        website = EXCLUDED.website,
        verified_me = TRUE,
        updated_at = NOW()
  `;
  await pool.query(sql, values);
}

async function loadFromDb(): Promise<CatalogEntry[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      slug: string; name: string; image: string | null;
      twitter: string | null; discord: string | null; website: string | null;
    }>(
      `SELECT slug, name, image, twitter, discord, website
         FROM collection_catalog
        WHERE verified_me = TRUE`,
    );
    return rows.map(r => ({
      slug:    r.slug,
      name:    r.name,
      image:   r.image,
      twitter: r.twitter,
      discord: r.discord,
      website: r.website,
    }));
  } catch {
    return [];
  }
}

/** Read one slug's row from the in-memory mirror. Used by the `/meta`
 *  route so the Collection page can render Twitter / Discord / website
 *  icons without any live ME round-trip. Null if slug isn't catalogued. */
export function getCatalogEntry(slug: string): CatalogEntry | null {
  for (const e of catalog) if (e.slug === slug) return e;
  return null;
}

async function doRefresh(): Promise<void> {
  const next: CatalogEntry[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await fetchPage(page * PAGE_SIZE);
    if (!items) break;
    if (items.length === 0) break;
    for (const c of items) {
      if (!c.symbol || typeof c.symbol !== 'string') continue;
      if (c.isBadged !== true) continue;  // only ME-verified rows
      next.push({
        slug:    c.symbol,
        name:    String(c.name ?? c.symbol),
        image:   typeof c.image === 'string' ? c.image : null,
        twitter: emptyToNull(c.twitter),
        discord: emptyToNull(c.discord),
        website: emptyToNull(c.website),
      });
    }
    if (items.length < PAGE_SIZE) break;
  }

  if (next.length === 0) {
    console.warn('[catalog] refresh returned 0 verified entries — keeping previous snapshot');
    return;
  }

  // UPSERT in chunks so any single page failure still lands what came before.
  try {
    for (let i = 0; i < next.length; i += DB_UPSERT_CHUNK) {
      await upsertChunk(next.slice(i, i + DB_UPSERT_CHUNK));
    }
  } catch (err) {
    console.warn('[catalog] DB upsert failed — keeping previous snapshot:', (err as Error).message);
    return;
  }

  catalog = next;
  lastRefreshAt = Date.now();
  console.log(`[catalog] refreshed: ${catalog.length} verified collections (persisted to DB)`);
}

export function refreshCatalog(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

export function catalogSize(): number { return catalog.length; }

/**
 * Rank-ordered substring search against the in-memory catalog.
 *   0 — exact slug or name
 *   1 — slug- or name-prefix
 *   2 — substring in slug or name
 */
export function searchCatalog(q: string, limit: number): CatalogEntry[] {
  const qq = q.toLowerCase();
  if (!qq) return [];
  type Ranked = { entry: CatalogEntry; rank: number };
  const results: Ranked[] = [];
  for (const entry of catalog) {
    const s = entry.slug.toLowerCase();
    const n = entry.name.toLowerCase();
    let r: number | null = null;
    if (s === qq || n === qq)                      r = 0;
    else if (s.startsWith(qq) || n.startsWith(qq)) r = 1;
    else if (s.includes(qq)   || n.includes(qq))   r = 2;
    if (r !== null) results.push({ entry, rank: r });
  }
  results.sort((a, b) => a.rank - b.rank);
  return results.slice(0, limit).map(r => r.entry);
}

/**
 * Boot wiring: hydrate the in-memory mirror from the DB for instant search,
 * then fire a background refresh (non-blocking). Schedules periodic refresh.
 */
export async function startCatalogRefreshLoop(): Promise<void> {
  try {
    catalog = await loadFromDb();
    if (catalog.length > 0) {
      console.log(`[catalog] loaded ${catalog.length} verified collections from DB`);
      lastRefreshAt = Date.now();  // treat DB-backed state as fresh until schedule fires
    }
  } catch { /* DB may not have migration yet — refresh will populate */ }

  void refreshCatalog();

  setInterval(() => {
    if (Date.now() - lastRefreshAt >= REFRESH_INTERVAL_MS) void refreshCatalog();
  }, CHECK_INTERVAL_MS).unref();
}
