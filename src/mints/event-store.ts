/**
 * Server-side persistence for the Mint Tracker live feed.
 *
 * The recent-mints feed used to live only in an in-memory ring + meta buffer,
 * which were wiped on every backend restart — so devices fell back to their own
 * localStorage and diverged. This module makes Postgres the source of truth:
 *   • every emitted mint event is upserted into `mint_events`
 *   • every mint_meta enrichment patch updates the row in place
 *   • on boot the in-memory ring + meta buffer are hydrated from the table,
 *     so the SSE replay (and the /api/mints/recent snapshot) are identical for
 *     all clients and survive restarts
 *   • a periodic retention cleanup keeps the table bounded
 *
 * No Helius RPC, no per-client polling — DB only. Decoupled from the hot path
 * via the event bus (same pattern as the SSE fan-out).
 */
import { getPool } from '../db/client';
import {
  saleEventBus,
  hydrateRecentMintMeta,
  type MintEventWire,
  type MintMetaPatch,
} from '../events/emitter';
import { hydrateRecentMints } from './accumulator';
import { recordMintedAt, FRESH_WINDOW_MS } from './fresh-mint-cache';

const RETENTION_DAYS = parseInt(process.env.MINT_EVENTS_RETENTION_DAYS ?? '7', 10) || 7;
const RECENT_LIMIT   = 150;   // matches RECENT_MINTS_MAX + frontend LIVE_FEED_MAX
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A stored event = the wire shape plus the per-mint enrichment columns. */
export interface StoredMintEvent extends MintEventWire {
  nftName:     string | null;
  nftImageUrl: string | null;
}

const INSERT_SQL = `
  INSERT INTO mint_events
    (signature, mint_address, collection_address, grouping_key, grouping_kind,
     source_label, program_source, mint_type, price_lamports, minter, block_time,
     core_launchpad, payment_mint, payment_amount, payment_decimals, collection_create)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (signature, mint_address) DO NOTHING
`;

/** Upsert one emitted mint event. Fire-and-forget; never throws into the bus. */
export async function insertMintEvent(ev: MintEventWire): Promise<void> {
  try {
    await getPool().query(INSERT_SQL, [
      ev.signature,
      ev.mintAddress ?? '',
      ev.collectionAddress,
      ev.groupingKey,
      ev.groupingKind,
      ev.sourceLabel,
      ev.programSource,
      ev.mintType,
      ev.priceLamports,
      ev.minter,
      ev.blockTime ? new Date(ev.blockTime) : null,
      ev.coreLaunchpad === true,
      ev.paymentMint     ?? null,
      ev.paymentAmount   ?? null,
      ev.paymentDecimals ?? null,
      ev.collectionCreate === true,
    ]);
  } catch (err) {
    noteStoreError('insert', err);
  }
}

const PATCH_SQL = `
  UPDATE mint_events
     SET nft_name      = COALESCE($3, nft_name),
         nft_image_url = COALESCE($4, nft_image_url),
         updated_at    = now()
   WHERE signature = $1 AND mint_address = $2
`;

/** Patch the per-mint name/image when enrichment resolves. COALESCE keeps an
 *  already-resolved value if a later patch arrives with a null field. */
export async function patchMintEventMeta(p: MintMetaPatch): Promise<void> {
  try {
    await getPool().query(PATCH_SQL, [
      p.signature,
      p.mintAddress ?? '',
      p.nftName ?? null,
      p.imageUrl ?? null,
    ]);
  } catch (err) {
    noteStoreError('patch', err);
  }
}

const LOAD_SQL = `
  SELECT signature, mint_address, collection_address, grouping_key, grouping_kind,
         source_label, program_source, mint_type, price_lamports, minter, block_time,
         nft_name, nft_image_url, core_launchpad,
         payment_mint, payment_amount, payment_decimals, collection_create
    FROM mint_events
   ORDER BY block_time DESC NULLS LAST, id DESC
   LIMIT $1
`;

/** Newest-first recent events with enrichment columns merged in. */
export async function loadRecentMintEvents(limit = RECENT_LIMIT): Promise<StoredMintEvent[]> {
  const { rows } = await getPool().query(LOAD_SQL, [limit]);
  return rows.map((r): StoredMintEvent => ({
    signature:         r.signature,
    blockTime:         r.block_time ? new Date(r.block_time).toISOString() : '',
    programSource:     r.program_source,
    mintAddress:       r.mint_address === '' ? null : r.mint_address,
    collectionAddress: r.collection_address ?? null,
    groupingKey:       r.grouping_key,
    groupingKind:      r.grouping_kind,
    mintType:          r.mint_type,
    priceLamports:     r.price_lamports != null ? Number(r.price_lamports) : null,
    minter:            r.minter ?? null,
    sourceLabel:       r.source_label,
    coreLaunchpad:     r.core_launchpad === true,
    collectionCreate:  r.collection_create === true,
    paymentMint:       r.payment_mint ?? null,
    paymentAmount:     r.payment_amount ?? null,
    paymentDecimals:   r.payment_decimals != null ? Number(r.payment_decimals) : null,
    nftName:           r.nft_name ?? null,
    nftImageUrl:       r.nft_image_url ?? null,
  }));
}

/**
 * One-time boot hydration for the FRESH-badge cache: earliest created_at
 * per mint_address within the freshness window. Runs once at startup only —
 * never on the sale hot path. Keeps the cache correct across a backend
 * restart without needing a live DB query per sale.
 */
async function hydrateFreshMintCache(): Promise<number> {
  const { rows } = await getPool().query<{ mint_address: string; created_at: string }>(
    `SELECT mint_address, MIN(created_at) AS created_at
       FROM mint_events
      WHERE created_at >= now() - ($1 || ' milliseconds')::interval
        AND mint_address <> ''
      GROUP BY mint_address`,
    [String(FRESH_WINDOW_MS)],
  );
  for (const r of rows) {
    recordMintedAt(r.mint_address, new Date(r.created_at).getTime());
  }
  return rows.length;
}

/** Delete events older than the retention window. Returns rows removed. */
export async function cleanupOldMintEvents(): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM mint_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)],
  );
  return rowCount ?? 0;
}

/** Wire up persistence: hydrate the in-memory buffers from the DB, subscribe
 *  to the bus to persist live events + meta patches, and schedule cleanup. */
export async function startMintEventPersistence(): Promise<void> {
  // 1) Hydrate the ring + meta buffer so the SSE replay is correct immediately
  //    after a restart (identical for every device).
  try {
    const recent = await loadRecentMintEvents(RECENT_LIMIT);
    const chrono = recent.slice().reverse();   // ring keeps oldest-first
    hydrateRecentMints(chrono.map(({ nftName, nftImageUrl, ...wire }) => {
      void nftName; void nftImageUrl;
      return wire;
    }));
    hydrateRecentMintMeta(
      chrono
        .filter(e => e.nftName != null || e.nftImageUrl != null)
        .map(e => ({ signature: e.signature, mintAddress: e.mintAddress, nftName: e.nftName, imageUrl: e.nftImageUrl })),
    );
    console.log(`[mints/store] hydrated recent events=${recent.length} retentionDays=${RETENTION_DAYS}`);
  } catch (err) {
    console.warn(`[mints/store] hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Persist live events + enrichment patches (decoupled via the bus).
  saleEventBus.onMint((ev) => { void insertMintEvent(ev); });
  saleEventBus.onMintMeta((p) => { void patchMintEventMeta(p); });

  // 2b) FRESH-badge cache: record every live mint's first-observed time.
  // Same bus subscription pattern as the DB persistence above, just an
  // additional in-memory listener — no extra ingestion, no DB write.
  saleEventBus.onMint((ev) => { recordMintedAt(ev.mintAddress, Date.now()); });
  try {
    const freshHydrated = await hydrateFreshMintCache();
    console.log(`[mints/store] fresh-mint cache hydrated entries=${freshHydrated}`);
  } catch (err) {
    console.warn(`[mints/store] fresh-mint cache hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Retention cleanup at boot + daily.
  void cleanupOldMintEvents()
    .then(n => console.log(`[mints/store] cleanup deleted=${n}`))
    .catch(() => { /* non-fatal */ });
  const timer = setInterval(() => { void cleanupOldMintEvents().catch(() => {}); }, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// ── Sampled error log (avoid flooding under a DB blip during a hot launch) ───
let storeErrCount = 0;
function noteStoreError(op: string, err: unknown): void {
  if (storeErrCount++ % 50 === 0) {
    console.warn(`[mints/store] ${op} error (count=${storeErrCount}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
