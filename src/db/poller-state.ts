import { getPool } from './client';

export async function getLastSig(cursorKey: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT last_sig FROM poller_state WHERE cursor_key = $1',
    [cursorKey]
  );
  return result.rows[0]?.last_sig ?? null;
}

export async function setLastSig(cursorKey: string, sig: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO poller_state (cursor_key, last_sig, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE
       SET last_sig = EXCLUDED.last_sig, updated_at = NOW()`,
    [cursorKey, sig]
  );
}
