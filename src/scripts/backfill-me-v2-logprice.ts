/**
 * Backfill: correct historical ME v2 fixed-price sale prices to the canonical
 * on-chain log price.
 *
 * WHY
 *   Before the log-price fix (parser.ts → readMeV2PriceFromLogs), ME v2 sales
 *   stored `price_lamports` = the buyer's GROSS SOL outflow, which bundles
 *   royalty + marketplace fee + network fee on top of the real list/sale
 *   price. The frontend renders historical rows as `price_sol` (seller-net is
 *   SSE-only, never persisted), so every stored ME v2 row displays the
 *   inflated gross. The live parser now reads the explicit ME settlement log
 *   `"price":N`; this script re-parses past rows through that same parser and
 *   rewrites the price to match.
 *
 *   Example: sig 21V7qF… — stored 0.015279685 (gross) → 0.014 (log price).
 *
 * SAFETY
 *   - REDUCE-ONLY. A row is updated only when the re-parsed price is strictly
 *     LOWER than the stored price (the fix can only ever remove fees). Rows
 *     where the new price ≥ old, or where the log line is absent (parser falls
 *     back to gross → new == old), are skipped untouched.
 *   - Lucky-buy rows are excluded — their price is seller-net by design and
 *     the parser ignores their raffle-price log; nothing to correct.
 *   - DRY-RUN by default. Pass --apply to write. Re-running is safe and
 *     resumable: corrected rows re-parse to new == old and are skipped.
 *   - Each updated row records `_priceFix` + `_grossLamports` in raw_data for
 *     auditability and so a future pass can recognise already-fixed rows.
 *
 * USAGE
 *   npm run backfill:me-logprice                       # dry-run, all rows
 *   npm run backfill:me-logprice -- --apply            # write changes
 *   npm run backfill:me-logprice -- --limit=200        # cap rows scanned
 *   npm run backfill:me-logprice -- --sig=<signature>  # single row (validation)
 *   npm run backfill:me-logprice -- --apply --batch=8 --sleep-ms=120
 *
 * FLAGS
 *   --apply              perform UPDATEs (default: dry-run, no writes)
 *   --limit=N            process at most N rows (default: all)
 *   --sig=<sig>          restrict to one signature
 *   --batch=N            RPC concurrency (default 8)
 *   --sleep-ms=N         pause between batches, ms (default 100)
 *   --min-diff=N         only update when (old - new) ≥ N lamports (default 1)
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/client';
import { parseRawMeTransaction } from '../ingestion/me-raw/parser';
import { RawSolanaTx } from '../ingestion/me-raw/types';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// ─── args ───────────────────────────────────────────────────────────────────
function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}
const APPLY    = flag('apply') !== undefined;
const LIMIT    = flag('limit')   ? parseInt(flag('limit')!, 10)   : null;
const SIG      = flag('sig')     ?? null;
const BATCH    = flag('batch')   ? Math.max(1, parseInt(flag('batch')!, 10))   : 8;
const SLEEP_MS = flag('sleep-ms')? Math.max(0, parseInt(flag('sleep-ms')!, 10)) : 100;
const MIN_DIFF = flag('min-diff')? Math.max(1, parseInt(flag('min-diff')!, 10)) : 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── RPC (mirrors replay-test.ts getTx, incl. v0 accountKeys merge) ───────────
async function getTx(sig: string, attempt = 0): Promise<RawSolanaTx | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
      }),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as { result?: any; error?: { message: string } };
    if (json.error) throw new Error(`RPC: ${json.error.message}`);
    if (!json.result) return null;

    const tx = json.result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded = (tx.meta as any)?.loadedAddresses ?? {};
    const loadedWritable: string[] = loaded.writable ?? [];
    const loadedReadonly:  string[] = loaded.readonly  ?? [];
    tx.transaction.message.accountKeys = [
      ...staticKeys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : k)),
      ...loadedWritable.map((pk) => ({ pubkey: pk, signer: false, writable: true  })),
      ...loadedReadonly.map( (pk) => ({ pubkey: pk, signer: false, writable: false })),
    ];
    tx.signature = sig;
    return tx as RawSolanaTx;
  } catch (err) {
    if (attempt < 4) { await sleep(250 * (attempt + 1)); return getTx(sig, attempt + 1); }
    throw err;
  }
}

// ─── row processing ───────────────────────────────────────────────────────────
interface Row { id: string; signature: string; price_lamports: string; price_sol: string; }

type Outcome =
  | { kind: 'update'; sig: string; oldLam: bigint; newLam: bigint }
  | { kind: 'skip';   sig: string; reason: string };

async function evaluate(row: Row): Promise<Outcome> {
  const oldLam = BigInt(row.price_lamports);
  const tx = await getTx(row.signature);
  if (!tx) return { kind: 'skip', sig: row.signature, reason: 'tx not found' };

  const result = parseRawMeTransaction(tx);
  if (!result.ok) return { kind: 'skip', sig: row.signature, reason: `parse: ${result.reason}` };
  if (result.event.marketplace !== 'magic_eden') {
    return { kind: 'skip', sig: row.signature, reason: `marketplace=${result.event.marketplace}` };
  }

  const newLam = result.event.priceLamports;
  if (newLam <= 0n)        return { kind: 'skip', sig: row.signature, reason: 'reparsed price ≤ 0' };
  if (newLam >= oldLam)    return { kind: 'skip', sig: row.signature, reason: `no reduction (new ${newLam} ≥ old ${oldLam})` };
  if (oldLam - newLam < BigInt(MIN_DIFF)) {
    return { kind: 'skip', sig: row.signature, reason: `diff < ${MIN_DIFF}` };
  }
  return { kind: 'update', sig: row.signature, oldLam, newLam };
}

const UPDATE_SQL = `
  UPDATE sale_events
     SET price_lamports = $2,
         price_sol      = $3,
         raw_data       = COALESCE(raw_data, '{}'::jsonb) || $4::jsonb
   WHERE id = $1
`;

async function apply(id: string, oldLam: bigint, newLam: bigint): Promise<void> {
  const pool = getPool();
  const audit = JSON.stringify({ _priceFix: 'me_v2_logprice', _grossLamports: oldLam.toString() });
  await pool.query(UPDATE_SQL, [id, newLam.toString(), Number(newLam) / 1e9, audit]);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pool = getPool();

  const where: string[] = [`raw_data->>'_parser' = 'me_v2_raw'`,
                           `COALESCE(raw_data->>'_subtype','') <> 'lucky_buy'`,
                           `price_lamports > 0`];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  if (SIG) { params.push(SIG); where.push(`signature = $${params.length}`); }

  let sql = `SELECT id, signature, price_lamports, price_sol
               FROM sale_events
              WHERE ${where.join(' AND ')}
              ORDER BY block_time DESC`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;

  const { rows } = await pool.query<Row>(sql, params);

  console.log(`ME v2 log-price backfill — mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`candidates: ${rows.length}  batch=${BATCH}  sleep=${SLEEP_MS}ms  min-diff=${MIN_DIFF} lamports\n`);

  let updated = 0, skipped = 0, errors = 0;
  let sumOldLam = 0n, sumNewLam = 0n;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const outcomes = await Promise.all(slice.map(async (row) => {
      try { return await evaluate(row); }
      catch (err) { return { kind: 'error' as const, sig: row.signature, reason: String(err) }; }
    }));

    for (let j = 0; j < outcomes.length; j++) {
      const o = outcomes[j];
      if (o.kind === 'error') {
        errors++;
        console.log(`  ⚠ ${o.sig.slice(0, 16)}… ${o.reason}`);
      } else if (o.kind === 'skip') {
        skipped++;
      } else {
        updated++;
        sumOldLam += o.oldLam; sumNewLam += o.newLam;
        const tag = APPLY ? '✓' : '·';
        console.log(`  ${tag} ${o.sig.slice(0, 16)}…  ${(Number(o.oldLam) / 1e9).toFixed(6)} → ${(Number(o.newLam) / 1e9).toFixed(6)} SOL`);
        if (APPLY) await apply(slice[j].id, o.oldLam, o.newLam);
      }
    }

    if ((i / BATCH) % 25 === 0) {
      console.log(`  … ${Math.min(i + BATCH, rows.length)}/${rows.length} scanned  (upd=${updated} skip=${skipped} err=${errors})`);
    }
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`scanned=${rows.length}  to-update=${updated}  skipped=${skipped}  errors=${errors}`);
  console.log(`price corrected (sum): ${(Number(sumOldLam) / 1e9).toFixed(4)} → ${(Number(sumNewLam) / 1e9).toFixed(4)} SOL`);
  console.log(APPLY ? 'APPLIED.' : 'DRY-RUN — no rows written. Re-run with --apply to persist.');

  await closePool();
}

main().catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
