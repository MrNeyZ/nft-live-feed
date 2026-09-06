// DB helpers for the `mint_rent_refund_status` cache table (migration 022).
// Caller responsibility: only `src/mints/rent-refund-resolver.ts`.
import { getPool } from './client';

export type RentRefundStatus = 'none' | 'has_refund';

export interface RentRefundStatusRow {
  mint:            string;
  status:          RentRefundStatus;
  surplusLamports: number;
  checkedAtMs:     number;
}

/** Preload every cached row on resolver boot — avoids a DB round trip per
 *  sale lookup. Universe is bounded by prefilter-matching sales ever seen. */
export async function loadAllRentRefundStatuses(): Promise<Map<string, RentRefundStatusRow>> {
  const out = new Map<string, RentRefundStatusRow>();
  const res = await getPool().query<{
    mint: string; status: string; surplus_lamports: string; checked_at_ms: string;
  }>(
    `SELECT mint, status, surplus_lamports, checked_at_ms FROM mint_rent_refund_status`,
  );
  for (const r of res.rows) {
    out.set(r.mint, {
      mint:            r.mint,
      status:          r.status as RentRefundStatus,
      surplusLamports: Number(r.surplus_lamports),
      checkedAtMs:     Number(r.checked_at_ms),
    });
  }
  return out;
}

/** Idempotent upsert — the resolver re-checks on a TTL so both fields
 *  are always refreshed to the latest observation. */
export async function saveRentRefundStatus(row: RentRefundStatusRow): Promise<void> {
  await getPool().query(
    `INSERT INTO mint_rent_refund_status (mint, status, surplus_lamports, checked_at_ms)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (mint) DO UPDATE
       SET status           = EXCLUDED.status,
           surplus_lamports  = EXCLUDED.surplus_lamports,
           checked_at_ms     = EXCLUDED.checked_at_ms`,
    [row.mint, row.status, row.surplusLamports, row.checkedAtMs],
  );
}
