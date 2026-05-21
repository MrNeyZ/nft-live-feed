/**
 * Rare Feed — persistence for accepted rare-sale events (rare_feed_events).
 *
 * Insert is dedupe-safe (ON CONFLICT (sale_signature) DO NOTHING), so a sale
 * re-emitted by the AMM gap-healer or replayed on SSE reconnect can never
 * create a second rare row. Reads are newest-first for the Tools page;
 * retention is a bounded periodic + boot cleanup.
 */
import { getPool } from '../db/client';
import { cleanupOldRarityCache } from './rarity';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RETENTION_DAYS = envInt('RARE_FEED_RETENTION_DAYS', 7);
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RareFeedEvent {
  saleSignature:    string;
  mintAddress:      string;
  collectionSlug:   string | null;
  collectionName:   string | null;
  nftName:          string | null;
  imageUrl:         string | null;
  source:           string | null;
  salePriceSol:     number;
  floorPriceSol:    number | null;
  floorDeltaPct:    number | null;
  rarityRank:       number | null;
  totalSupply:      number | null;
  rarityPercentile: number | null;
  raritySource:     string | null;
  rareScore:        number;
  reasonTags:       string[];
  saleTime:         Date | null;
}

const INSERT_SQL = `
  INSERT INTO rare_feed_events
    (sale_signature, mint_address, collection_slug, collection_name, nft_name,
     image_url, source, sale_price_sol, floor_price_sol, floor_delta_pct,
     rarity_rank, total_supply, rarity_percentile, rarity_source, rare_score,
     reason_tags, sale_time)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  ON CONFLICT (sale_signature) DO NOTHING
  RETURNING id
`;

/** Insert an accepted rare event. Returns true when a new row was written,
 *  false when it was a duplicate (already-recorded signature). */
export async function insertRareEvent(e: RareFeedEvent): Promise<boolean> {
  const { rows } = await getPool().query(INSERT_SQL, [
    e.saleSignature,
    e.mintAddress,
    e.collectionSlug,
    e.collectionName,
    e.nftName,
    e.imageUrl,
    e.source,
    e.salePriceSol,
    e.floorPriceSol,
    e.floorDeltaPct,
    e.rarityRank,
    e.totalSupply,
    e.rarityPercentile,
    e.raritySource,
    e.rareScore,
    e.reasonTags,
    e.saleTime,
  ]);
  return (rows.length ?? 0) > 0;
}

export interface RareFeedRow extends RareFeedEvent {
  id:        number;
  createdAt: Date;
}

const RECENT_SQL = `
  SELECT id, sale_signature, mint_address, collection_slug, collection_name,
         nft_name, image_url, source, sale_price_sol, floor_price_sol,
         floor_delta_pct, rarity_rank, total_supply, rarity_percentile,
         rarity_source, rare_score, reason_tags, sale_time, created_at
    FROM rare_feed_events
   WHERE rare_score >= $2
   ORDER BY sale_time DESC NULLS LAST, id DESC
   LIMIT $1
`;

/** Newest-first rare events at or above `minScore`. */
export async function loadRecentRareEvents(limit: number, minScore: number): Promise<RareFeedRow[]> {
  const { rows } = await getPool().query(RECENT_SQL, [limit, minScore]);
  return rows.map((r): RareFeedRow => ({
    id:               Number(r.id),
    saleSignature:    r.sale_signature,
    mintAddress:      r.mint_address,
    collectionSlug:   r.collection_slug ?? null,
    collectionName:   r.collection_name ?? null,
    nftName:          r.nft_name ?? null,
    imageUrl:         r.image_url ?? null,
    source:           r.source ?? null,
    salePriceSol:     r.sale_price_sol != null ? Number(r.sale_price_sol) : 0,
    floorPriceSol:    r.floor_price_sol != null ? Number(r.floor_price_sol) : null,
    floorDeltaPct:    r.floor_delta_pct != null ? Number(r.floor_delta_pct) : null,
    rarityRank:       r.rarity_rank != null ? Number(r.rarity_rank) : null,
    totalSupply:      r.total_supply != null ? Number(r.total_supply) : null,
    rarityPercentile: r.rarity_percentile != null ? Number(r.rarity_percentile) : null,
    raritySource:     r.rarity_source ?? null,
    rareScore:        r.rare_score != null ? Number(r.rare_score) : 0,
    reasonTags:       Array.isArray(r.reason_tags) ? r.reason_tags : [],
    saleTime:         r.sale_time ? new Date(r.sale_time) : null,
    createdAt:        new Date(r.created_at),
  }));
}

/** Delete rare events older than the retention window. Returns rows removed. */
export async function cleanupOldRareEvents(): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM rare_feed_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)],
  );
  return rowCount ?? 0;
}

/** Boot + periodic retention cleanup for BOTH rare_feed_events and the
 *  per-mint rarity cache (mint_rarity_cache), which would otherwise grow one
 *  row per distinct mint forever. */
function runCleanup(): void {
  void cleanupOldRareEvents()
    .then(n => console.log(`[rare/feed] retention cleanup deleted=${n} (keep ${RETENTION_DAYS}d)`))
    .catch(() => { /* non-fatal */ });
  void cleanupOldRarityCache()
    .then(n => console.log(`[rare/rarity] cleanup deleted=${n}`))
    .catch(() => { /* non-fatal */ });
}

export function startRareFeedRetention(): void {
  runCleanup();
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
