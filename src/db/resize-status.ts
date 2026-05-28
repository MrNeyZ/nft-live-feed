// DB helpers for the `mint_resize_status` cache table (migration 013).
// Caller responsibility: only `src/mints/resize-status-resolver.ts`.
import { getPool } from './client';

export type ResizeStatus =
  | 'none'
  | 'metaplex_resized_unclaimed'
  | 'claimed'
  | 'user_resized';

export interface ResizeStatusRow {
  mint:         string;
  status:       ResizeStatus;
  checkedAtMs:  number;
  resizedSig:   string | null;
  resizedAtMs:  number | null;
  claimedSig:   string | null;
  claimedAtMs:  number | null;
}

/** Single-mint lookup. Returns null when never resolved. */
export async function getResizeStatus(mint: string): Promise<ResizeStatusRow | null> {
  const res = await getPool().query<{
    mint: string; status: string;
    checked_at_ms: string;
    resized_sig: string | null;  resized_at_ms: string | null;
    claimed_sig: string | null;  claimed_at_ms: string | null;
  }>(
    `SELECT mint, status, checked_at_ms, resized_sig, resized_at_ms, claimed_sig, claimed_at_ms
       FROM mint_resize_status WHERE mint = $1`,
    [mint],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    mint:         row.mint,
    status:       row.status as ResizeStatus,
    checkedAtMs:  Number(row.checked_at_ms),
    resizedSig:   row.resized_sig,
    resizedAtMs:  row.resized_at_ms != null ? Number(row.resized_at_ms) : null,
    claimedSig:   row.claimed_sig,
    claimedAtMs:  row.claimed_at_ms != null ? Number(row.claimed_at_ms) : null,
  };
}

/** Preload every cached row into memory on resolver boot — avoids a
 *  DB round trip per sale lookup. Universe is bounded by the number of
 *  prefilter-matching live sales we've ever seen (small). */
export async function loadAllResizeStatuses(): Promise<Map<string, ResizeStatusRow>> {
  const out = new Map<string, ResizeStatusRow>();
  const res = await getPool().query<{
    mint: string; status: string;
    checked_at_ms: string;
    resized_sig: string | null;  resized_at_ms: string | null;
    claimed_sig: string | null;  claimed_at_ms: string | null;
  }>(
    `SELECT mint, status, checked_at_ms, resized_sig, resized_at_ms, claimed_sig, claimed_at_ms
       FROM mint_resize_status`,
  );
  for (const r of res.rows) {
    out.set(r.mint, {
      mint:         r.mint,
      status:       r.status as ResizeStatus,
      checkedAtMs:  Number(r.checked_at_ms),
      resizedSig:   r.resized_sig,
      resizedAtMs:  r.resized_at_ms != null ? Number(r.resized_at_ms) : null,
      claimedSig:   r.claimed_sig,
      claimedAtMs:  r.claimed_at_ms != null ? Number(r.claimed_at_ms) : null,
    });
  }
  return out;
}

/** Idempotent upsert. Resolutions are one-shot per mint — if a row
 *  exists with a positive signal (resized_sig or claimed_sig), the
 *  upsert leaves those fields intact and only refreshes the status +
 *  checked_at_ms. (The resolver currently never revisits a resolved
 *  mint, but this guard makes the helper safe for future TTL passes.) */
export async function saveResizeStatus(row: ResizeStatusRow): Promise<void> {
  await getPool().query(
    `INSERT INTO mint_resize_status
       (mint, status, checked_at_ms, resized_sig, resized_at_ms, claimed_sig, claimed_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mint) DO UPDATE
       SET status        = EXCLUDED.status,
           checked_at_ms = EXCLUDED.checked_at_ms,
           resized_sig   = COALESCE(mint_resize_status.resized_sig, EXCLUDED.resized_sig),
           resized_at_ms = COALESCE(mint_resize_status.resized_at_ms, EXCLUDED.resized_at_ms),
           claimed_sig   = COALESCE(mint_resize_status.claimed_sig, EXCLUDED.claimed_sig),
           claimed_at_ms = COALESCE(mint_resize_status.claimed_at_ms, EXCLUDED.claimed_at_ms)`,
    [row.mint, row.status, row.checkedAtMs, row.resizedSig, row.resizedAtMs, row.claimedSig, row.claimedAtMs],
  );
}
