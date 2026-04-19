/**
 * Minimal migration runner. Run with: npm run migrate
 * Reads all .sql files in migrations/ in order and executes them.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getPool, closePool } from './client';

async function migrate() {
  const pool = getPool();
  const migrationsDir = path.join(__dirname, 'migrations');

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[migrate] running ${file}`);
    await pool.query(sql);
    console.log(`[migrate] done    ${file}`);
  }

  await closePool();
  console.log('[migrate] all migrations complete');
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
