import { Pool } from 'pg';
import { activeEnrichCount } from '../enrichment/enrich';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 25,                   // was default 10 — raised to prevent queue buildup
      connectionTimeoutMillis: 4_000, // fail fast instead of waiting forever
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      console.error('[db] unexpected pool error', err);
    });

    // ── TIMING PROBE: log pool queue depth + background task counts every 15s
    setInterval(() => {
      const p = pool!;
      console.log(
        `[pool] total=${p.totalCount}  idle=${p.idleCount}  waiting=${p.waitingCount}` +
        `  activeEnrich=${activeEnrichCount()}`
      );
    }, 15_000).unref();
    // ── END TIMING PROBE ────────────────────────────────────────────────────
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
