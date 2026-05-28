// DB helpers for the `collection_created` table (migration 012).
// Caller responsibility: only `src/mints/collection-created-resolver.ts`.
import { getPool } from './client';

export interface CollectionCreatedRow {
  collectionAddress: string;
  createdAtMs:       number;
  resolvedAtMs:      number;
  source:            string;
}

/** Bulk load every cached row on boot — feeds the resolver's in-memory
 *  cache and lets us patch any accumulator rows that are already open
 *  for those collections without any RPC traffic. */
export async function loadAllCollectionCreated(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const res = await getPool().query<{ collection_address: string; created_at_ms: string }>(
    `SELECT collection_address, created_at_ms FROM collection_created`,
  );
  for (const row of res.rows) {
    const ts = Number(row.created_at_ms);
    if (Number.isFinite(ts) && ts > 0) out.set(row.collection_address, ts);
  }
  return out;
}

/** Idempotent upsert. ON CONFLICT keeps the row's `created_at_ms`
 *  but updates `resolved_at_ms` so the cache row reflects the most
 *  recent successful resolution attempt. */
export async function saveCollectionCreated(
  collectionAddress: string,
  createdAtMs:       number,
  resolvedAtMs:      number,
  source:            string = 'gsfa',
): Promise<void> {
  await getPool().query(
    `INSERT INTO collection_created (collection_address, created_at_ms, resolved_at_ms, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (collection_address) DO UPDATE
       SET resolved_at_ms = EXCLUDED.resolved_at_ms`,
    [collectionAddress, createdAtMs, resolvedAtMs, source],
  );
}
