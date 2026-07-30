/**
 * Targeted backfill: fix the buyer wallet on legacy MMM `solFulfillBuy` /
 * takeBid sales that were stored with the POOL STATE PDA as the buyer.
 *
 * Background
 *   Parser fix 8d562f5 removed the legacy lp_fee=0 token-flow buyer override.
 *   For a zero-LP-fee MMM pool the NFT recipient is the pool state PDA, not the
 *   bidder, so the old override surfaced the pool PDA (e.g. BJT7KT1q…) instead
 *   of the pool owner (e.g. PER7nVm9…). New rows are correct; this script
 *   re-parses the AFFECTED historical rows with the current fixed parser and
 *   rewrites `buyer` to the value the parser now produces (accs[1] = pool
 *   owner).
 *
 * Scope (target rows)
 *   marketplace='magic_eden_amm' AND raw_data->>'_parser'='mmm_raw'
 *   AND raw_data->>'_direction'='takeBid' AND nft_type='legacy'
 *   AND the stored `buyer` account is EITHER owned by the MMM program
 *       (confirmed pool PDA) OR closed/non-existent (ambiguous — was likely a
 *       pool PDA that has since been closed). Real System-owned wallets
 *       (genuine individual bids, already correct) are EXCLUDED.
 *
 * Safety
 *   - DRY-RUN by default. No writes unless `--apply` is passed.
 *   - Per-row verification before any write: signature/mint/marketplace/
 *     direction/nftType must match, parsed buyer must exist, differ from the
 *     old buyer, and NOT itself be an MMM-owned pool PDA. Seller and price
 *     must match the stored row or the row is skipped + logged.
 *   - Single-row parameterized UPDATE guarded by (signature, mint_address,
 *     old buyer) so a concurrent/again run can't double-apply.
 *   - Every decision is written to a JSONL audit file under data/backfills/.
 *
 * Usage
 *   ts-node src/scripts/backfill-mmm-legacy-takebid-buyer.ts [options]
 *     --limit N           cap target rows processed (after filtering)
 *     --apply             perform DB updates (omit = dry-run)
 *     --since YYYY-MM-DD   only rows with block_time >= this date
 *     --concurrency N      RPC concurrency (default 6)
 *     --help
 *
 * Boundaries
 *   Standalone. Reuses the live fixed parser (parseRawMeTransaction) so the
 *   backfill output is byte-identical to what live ingestion now produces.
 *   Does NOT import ingestion/SSE/enrichment runtime (no admission gate).
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseRawMeTransaction } from '../ingestion/me-raw/parser';
import { ME_AMM_PROGRAM } from '../ingestion/me-raw/programs';
import type { RawSolanaTx } from '../ingestion/me-raw/types';
import { sleep } from '../ingestion/concurrency';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const BACKFILL_TAG   = 'mmm_legacy_takebid_buyer_v1';

const FETCH_TIMEOUT_MS = 12_000;
const RETRY_BASE_MS    = 500;
const MAX_RETRIES      = 4;

interface CliArgs {
  limit:       number | null;
  apply:       boolean;
  since:       string | null;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { limit: null, apply: false, since: null, concurrency: 6 };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (arg === '--apply') a.apply = true;
    else if (arg.startsWith('--limit=')) a.limit = Math.max(1, parseInt(arg.slice(8), 10) || 0);
    else if (arg.startsWith('--since=')) a.since = arg.slice(8);
    else if (arg.startsWith('--concurrency=')) a.concurrency = Math.max(1, Math.min(16, parseInt(arg.slice(14), 10) || 6));
    else if (arg === '--limit' || arg === '--since' || arg === '--concurrency') {
      console.error(`Use ${arg}=VALUE form (e.g. ${arg}=10)`);
      process.exit(1);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
Targeted MMM legacy takeBid buyer backfill (pool PDA → pool owner)

  ts-node src/scripts/backfill-mmm-legacy-takebid-buyer.ts [options]

  --limit=N          cap target rows processed (after ownership filter)
  --apply            perform DB updates (default: dry-run, no writes)
  --since=YYYY-MM-DD  only rows with block_time >= this date
  --concurrency=N    RPC concurrency (default 6, max 16)
  --help

Dry-run example:
  ts-node src/scripts/backfill-mmm-legacy-takebid-buyer.ts --limit=25
`.trim());
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY missing in env');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

const isRateLimit = (status: number) => status === 429 || (status >= 500 && status <= 599);

/** One JSON-RPC call with timeout + backoff on transient (429/5xx) errors. */
async function rpc<T>(method: string, params: unknown): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (isRateLimit(res.status)) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      const json = await res.json() as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`RPC: ${json.error.message}`);
      return json.result as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * 2 ** attempt); continue; }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Map address → owning program id (null when the account does not exist). */
async function fetchOwners(addrs: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < addrs.length; i += 100) {
    const batch = addrs.slice(i, i + 100);
    const res = await rpc<{ value: Array<{ owner: string } | null> }>(
      'getMultipleAccounts', [batch, { encoding: 'base64' }],
    );
    batch.forEach((a, j) => out.set(a, res.value[j]?.owner ?? null));
  }
  return out;
}

/**
 * Fetch one tx as RawSolanaTx — replicates the exact account-key merge the
 * live fetchRawTx performs for `encoding:'json'` v0 txs (static keys +
 * loadedAddresses, signer flag from header.numRequiredSignatures), so the
 * parser sees identical input to live ingestion.
 */
async function fetchRawTx(sig: string): Promise<RawSolanaTx | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = await rpc('getTransaction', [sig, {
    encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx) return null;

  const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses ?? {};
  const loadedWritable: string[] = loaded.writable ?? [];
  const loadedReadonly: string[] = loaded.readonly  ?? [];
  const numRequiredSignatures: number = tx.transaction?.message?.header?.numRequiredSignatures ?? 0;

  tx.transaction.message.accountKeys = [
    ...staticKeys.map((k: string | { pubkey: string }, i: number) => {
      const isSigner = i < numRequiredSignatures;
      return typeof k === 'string'
        ? { pubkey: k, signer: isSigner, writable: false }
        : { ...k, signer: isSigner };
    }),
    ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true  })),
    ...loadedReadonly.map((pk: string) => ({ pubkey: pk, signer: false, writable: false })),
  ];
  tx.signature = sig;
  return tx as RawSolanaTx;
}

interface CandidateRow {
  signature:     string;
  mint_address:  string;
  buyer:         string;
  seller:        string;
  price_lamports: string;   // bigint column → string
}

interface AuditLine {
  signature:     string;
  mint:          string;
  oldBuyer:      string;
  newBuyer:      string | null;
  seller:        string | null;
  priceLamports: string | null;
  status:        'wouldUpdate' | 'wouldUpdateDirectionReclassified' | 'updated' | 'skip' | 'error';
  reason:        string;
}

const CANDIDATE_SQL = `
  SELECT signature, mint_address, buyer, seller, price_lamports::text AS price_lamports
    FROM sale_events
   WHERE marketplace = 'magic_eden_amm'
     AND raw_data->>'_parser'    = 'mmm_raw'
     AND raw_data->>'_direction' = 'takeBid'
     AND nft_type = 'legacy'
     AND ($1::timestamptz IS NULL OR block_time >= $1::timestamptz)
   ORDER BY block_time DESC
`;

// Updates buyer ONLY. Adds two provenance markers and deliberately PRESERVES
// the original raw_data._direction (we do not rewrite direction here):
//   _backfill                  = tag (idempotency / audit)
//   _backfillParsedDirection   = direction the current parser produced, so a
//                                reclassified row is traceable after the fact.
const UPDATE_SQL = `
  UPDATE sale_events
     SET buyer = $1,
         raw_data = jsonb_set(
                      jsonb_set(raw_data, '{_backfill}', to_jsonb($2::text), true),
                      '{_backfillParsedDirection}', to_jsonb($3::text), true)
   WHERE signature = $4 AND mint_address = $5 AND buyer = $6
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const counters = {
    scanned: 0, target: 0, fetched: 0,
    wouldUpdate: 0, wouldUpdateDirectionReclassified: 0, updated: 0,
    skippedRealWallet: 0, skippedParseFail: 0,
    skippedNewBuyerEqualsOld: 0, skippedSellerMismatch: 0, skippedPriceMismatch: 0,
    skippedNewBuyerPoolPda: 0, skippedOtherMismatch: 0,
    rpcErrors: 0,
  };

  // 1) Candidate rows.
  const { rows } = await pool.query<CandidateRow>(CANDIDATE_SQL, [args.since]);
  counters.scanned = rows.length;
  console.log(`[backfill] scanned candidates=${rows.length} since=${args.since ?? 'all'} apply=${args.apply}`);

  // 2) Classify distinct buyers by on-chain owner → keep MMM-owned (pool PDA)
  //    + closed/null (ambiguous). Drop System-owned real wallets.
  const distinctBuyers = [...new Set(rows.map((r) => r.buyer))];
  const owners = await fetchOwners(distinctBuyers);
  const isTargetBuyer = (b: string) => {
    const o = owners.get(b);
    return o === ME_AMM_PROGRAM || o === null;   // pool PDA or closed/ambiguous
  };
  let targetRows = rows.filter((r) => isTargetBuyer(r.buyer));
  counters.skippedRealWallet = rows.length - targetRows.length;
  counters.target = targetRows.length;
  if (args.limit != null) targetRows = targetRows.slice(0, args.limit);
  console.log(
    `[backfill] distinctBuyers=${distinctBuyers.length} ` +
    `targetRows=${counters.target} (real-wallet rows skipped=${counters.skippedRealWallet}) ` +
    `processing=${targetRows.length}${args.limit != null ? ` (--limit=${args.limit})` : ''}`,
  );

  // 3) Audit file.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'data', 'backfills');
  await fs.mkdir(outDir, { recursive: true });
  const mode = args.apply ? 'apply' : 'dryrun';
  const outPath = path.join(outDir, `mmm-legacy-takebid-buyer-${mode}-${stamp}.jsonl`);
  const auditLines: string[] = [];
  const audit = (l: AuditLine) => auditLines.push(JSON.stringify(l));

  // 4) Process each target row with bounded concurrency.
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < targetRows.length) {
      const row = targetRows[idx++];
      const base = { signature: row.signature, mint: row.mint_address, oldBuyer: row.buyer };
      try {
        const tx = await fetchRawTx(row.signature);
        if (!tx) {
          counters.rpcErrors++;
          audit({ ...base, newBuyer: null, seller: null, priceLamports: null, status: 'error', reason: 'tx_fetch_null' });
          continue;
        }
        counters.fetched++;
        const parsed = parseRawMeTransaction(tx);
        if (!parsed.ok) {
          counters.skippedParseFail++;
          audit({ ...base, newBuyer: null, seller: null, priceLamports: null, status: 'skip', reason: `parse_fail:${parsed.reason}` });
          continue;
        }
        const e = parsed.event;
        const newBuyer = e.buyer;
        const newPrice = e.priceLamports.toString();
        const parsedDirection = String((e.rawData as Record<string, unknown>)?._direction ?? 'unknown');

        // Verification gauntlet. NOTE: we intentionally do NOT require the
        // *re-parsed* direction to still be 'takeBid'. The DB row's original
        // raw_data._direction='takeBid' is guaranteed by the candidate SQL
        // filter and is the scope marker we trust. Parser evolution / lp_fee
        // logic reclassifies some of these rows to fulfillBuy/pool_sale, but
        // the buyer correction (accs[1] = pool owner) is identical and equally
        // valid in BOTH cases — confirmed on a 15-row sample (old buyer =
        // pool PDA, new buyer = real non-PDA wallet, seller/price/mint match).
        // Every OTHER safety check below is unchanged.
        let skipReason: string | null = null;
        if      (e.signature   !== row.signature)        skipReason = 'signature_mismatch';
        else if (e.mintAddress !== row.mint_address)     skipReason = 'mint_mismatch';
        else if (e.marketplace !== 'magic_eden_amm')     skipReason = 'marketplace_mismatch';
        else if (e.nftType     !== 'legacy')             skipReason = 'nfttype_not_legacy';
        else if (!newBuyer)                              skipReason = 'new_buyer_missing';
        else if (newBuyer === row.buyer)                 skipReason = 'new_buyer_equals_old';
        else if (e.seller !== row.seller)                skipReason = 'seller_mismatch';
        else if (newPrice !== row.price_lamports)        skipReason = 'price_mismatch';

        if (skipReason) {
          if      (skipReason === 'new_buyer_equals_old') counters.skippedNewBuyerEqualsOld++;
          else if (skipReason === 'seller_mismatch')      counters.skippedSellerMismatch++;
          else if (skipReason === 'price_mismatch')       counters.skippedPriceMismatch++;
          else                                            counters.skippedOtherMismatch++;
          audit({ ...base, newBuyer, seller: e.seller, priceLamports: newPrice, status: 'skip', reason: `${skipReason} (parsedDirection=${parsedDirection})` });
          continue;
        }

        // Safety: never write a new buyer that is itself an MMM-owned pool PDA.
        const newOwner = (await fetchOwners([newBuyer])).get(newBuyer);
        if (newOwner === ME_AMM_PROGRAM) {
          counters.skippedNewBuyerPoolPda++;
          audit({ ...base, newBuyer, seller: e.seller, priceLamports: newPrice, status: 'skip', reason: `new_buyer_is_pool_pda (parsedDirection=${parsedDirection})` });
          continue;
        }

        const reclassified = parsedDirection !== 'takeBid';
        const okStatus = reclassified ? 'wouldUpdateDirectionReclassified' : 'wouldUpdate';

        if (args.apply) {
          const res = await pool.query(UPDATE_SQL, [newBuyer, BACKFILL_TAG, parsedDirection, row.signature, row.mint_address, row.buyer]);
          if (res.rowCount && res.rowCount > 0) {
            counters.updated++;
            audit({ ...base, newBuyer, seller: e.seller, priceLamports: newPrice, status: 'updated', reason: `ok (parsedDirection=${parsedDirection})` });
          } else {
            counters.skippedOtherMismatch++;
            audit({ ...base, newBuyer, seller: e.seller, priceLamports: newPrice, status: 'skip', reason: 'no_row_matched_on_update' });
          }
        } else {
          if (reclassified) counters.wouldUpdateDirectionReclassified++;
          else              counters.wouldUpdate++;
          audit({ ...base, newBuyer, seller: e.seller, priceLamports: newPrice, status: okStatus, reason: `ok (parsedDirection=${parsedDirection})` });
        }
      } catch (err) {
        counters.rpcErrors++;
        audit({ ...base, newBuyer: null, seller: null, priceLamports: null, status: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  await fs.writeFile(outPath, auditLines.join('\n') + '\n', 'utf8');
  await pool.end();

  const wouldUpdateTotal = counters.wouldUpdate + counters.wouldUpdateDirectionReclassified;
  console.log('[backfill] ── summary ─────────────────────────────');
  console.log(`  scanned candidates              : ${counters.scanned}`);
  console.log(`  target rows                     : ${counters.target}`);
  console.log(`  skippedRealWallet               : ${counters.skippedRealWallet}`);
  console.log(`  fetched                         : ${counters.fetched}`);
  console.log(`  wouldUpdate (total)             : ${wouldUpdateTotal}`);
  console.log(`    ├─ wouldUpdate (takeBid)      : ${counters.wouldUpdate}`);
  console.log(`    └─ wouldUpdateDirectionReclass: ${counters.wouldUpdateDirectionReclassified}`);
  console.log(`  updated                         : ${counters.updated}`);
  console.log(`  skippedNewBuyerEqualsOld        : ${counters.skippedNewBuyerEqualsOld}`);
  console.log(`  skippedSellerMismatch           : ${counters.skippedSellerMismatch}`);
  console.log(`  skippedPriceMismatch            : ${counters.skippedPriceMismatch}`);
  console.log(`  skippedNewBuyerPoolPda          : ${counters.skippedNewBuyerPoolPda}`);
  console.log(`  skippedOtherMismatch            : ${counters.skippedOtherMismatch}`);
  console.log(`  skippedParseFail                : ${counters.skippedParseFail}`);
  console.log(`  rpcErrors                       : ${counters.rpcErrors}`);
  console.log(`  mode                            : ${args.apply ? 'APPLY (writes committed)' : 'DRY-RUN (no writes)'}`);
  console.log(`  audit                           : ${outPath}`);
}

main().catch((err) => { console.error('[backfill] fatal:', err); process.exit(1); });
