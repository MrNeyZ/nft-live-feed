/**
 * READ-ONLY historical audit: how many `sale_events` rows for ME v2's
 * `coreExecuteSaleV2` instruction have a buyer wrongly attributed to a
 * program-owned escrow PDA instead of the real signer (2026-08-05 fix,
 * see src/ingestion/me-raw/parser.ts's `resolveCoreBuyerDetailed`).
 *
 * ZERO DATABASE MUTATIONS. This script only SELECTs and writes local
 * artifact files. It reuses the EXACT deployed decision function
 * (`resolveCoreBuyerDetailed`, imported — not re-derived) so the audit's
 * verdict is guaranteed to match what the live parser would produce today.
 *
 * A separate, not-yet-written mutation/backfill command is required to
 * actually apply any change — this script never performs one.
 *
 * RESUMABILITY
 *   Progress checkpoints to `data/audits/core-buyer-attribution-checkpoint.json`
 *   after every DB page (keyset cursor on `(block_time, id)`, oldest-first).
 *   Re-running without `--restart` picks up where the last run left off —
 *   safe to interrupt (Ctrl-C, crash, OOM) at any point; nothing is lost
 *   except the current in-flight RPC batch.
 *
 * OUTPUT ARTIFACTS (all under data/audits/)
 *   core-buyer-attribution-changes.jsonl    — one JSON line per proposed
 *     change (buyer_changed rows only), append-mode, safe across resumes.
 *   core-buyer-attribution-issues.jsonl     — one line per row that could
 *     NOT be confidently classified as changed/unchanged (transaction_
 *     unavailable / unsupported_or_ambiguous / rpc_retryable_error),
 *     for manual follow-up.
 *   core-buyer-attribution-summary.json     — rewritten at the end (and
 *     periodically) from the full run: counts by classification, plus
 *     the changed-set broken down by price bucket / tx shape / old-buyer
 *     account type / month.
 *   core-buyer-attribution-checkpoint.json  — resumability cursor + running
 *     counts.
 *
 * USAGE
 *   npm run audit:core-buyer-attribution
 *   npm run audit:core-buyer-attribution -- --limit=5000
 *   npm run audit:core-buyer-attribution -- --restart
 *   npm run audit:core-buyer-attribution -- --batch=6 --page-size=300 --sleep-ms=150
 *
 * FLAGS
 *   --limit=N       stop after N rows scanned THIS RUN (default: unbounded — full table)
 *   --page-size=N   DB rows fetched per keyset page (default 500)
 *   --batch=N       RPC concurrency, own dedicated limiter — NOT the shared
 *                   production rpcLimiter, deliberately, so a large audit
 *                   scan can never compete with live ingestion's RPC budget
 *                   (default 4, matching production's own concurrency but
 *                   isolated)
 *   --sleep-ms=N    pause between DB pages, ms (default 150)
 *   --restart       ignore any existing checkpoint, start from the oldest row
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/client';
import { resolveCoreBuyerDetailed } from '../ingestion/me-raw/parser';
import { findMeV2SaleIx } from '../ingestion/me-raw/decoder';
import { RawSolanaTx } from '../ingestion/me-raw/types';
import { Limiter } from '../ingestion/concurrency';
import { sleep } from '../ingestion/concurrency';
import * as fs from 'fs';
import * as path from 'path';

// ─── args ───────────────────────────────────────────────────────────────────
function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}
const LIMIT      = flag('limit')     ? parseInt(flag('limit')!, 10)     : null;
const PAGE_SIZE  = flag('page-size') ? Math.max(1, parseInt(flag('page-size')!, 10)) : 500;
const BATCH      = flag('batch')     ? Math.max(1, parseInt(flag('batch')!, 10))     : 4;
const SLEEP_MS   = flag('sleep-ms')  ? Math.max(0, parseInt(flag('sleep-ms')!, 10))  : 150;
const RESTART    = flag('restart') !== undefined;

// ─── artifact paths ─────────────────────────────────────────────────────────
const AUDIT_DIR       = path.join(process.cwd(), 'data', 'audits');
const CHECKPOINT_FILE = path.join(AUDIT_DIR, 'core-buyer-attribution-checkpoint.json');
const CHANGES_FILE    = path.join(AUDIT_DIR, 'core-buyer-attribution-changes.jsonl');
const ISSUES_FILE     = path.join(AUDIT_DIR, 'core-buyer-attribution-issues.jsonl');
const SUMMARY_FILE    = path.join(AUDIT_DIR, 'core-buyer-attribution-summary.json');

// ─── RPC (mirrors the deployed fetchRawTx's raw-json accountKeys merge —
//     see me-raw/ingest.ts — including the numRequiredSignatures → signer
//     derivation resolveCoreBuyerDetailed's signer check depends on) ────────
const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }
const RPC_URL = `https://beta.helius-rpc.com/?api-key=${API_KEY}`;

// Dedicated limiter for this audit — intentionally NOT the shared production
// rpcLimiter (me-raw/ingest.ts), so a full-table historical scan can never
// compete with live ingestion for RPC budget. Same shape (bounded concurrency
// + inter-dispatch gap), separate instance.
const auditLimiter = new Limiter(BATCH, 75);

class RetryableRpcError extends Error {}

async function fetchTxRaw(sig: string, attempt = 0): Promise<RawSolanaTx | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableRpcError(`http ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as { result?: any; error?: { message: string; code?: number } };
    if (json.error) {
      // Generic server errors are typically transient on Solana RPC nodes.
      if (json.error.code === -32000 || json.error.code === -32603) {
        throw new RetryableRpcError(`RPC ${json.error.code}: ${json.error.message}`);
      }
      throw new Error(`RPC: ${json.error.message}`);
    }
    if (!json.result) return null; // confirmed not found — NOT retryable

    const tx = json.result;
    const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
    const loaded = tx.meta?.loadedAddresses ?? {};
    const loadedWritable: string[] = loaded.writable ?? [];
    const loadedReadonly:  string[] = loaded.readonly  ?? [];
    // Same reconstruction as the live pipeline's fetchRawTx — signer flags
    // are NOT in the raw 'json' RPC payload; derived from the message
    // header (numRequiredSignatures = first N static keys are signers).
    // resolveCoreBuyerDetailed's signer check depends on this being right.
    const numRequiredSignatures: number = tx.transaction?.message?.header?.numRequiredSignatures ?? 0;
    tx.transaction.message.accountKeys = [
      ...staticKeys.map((k, i: number) => {
        const isSigner = i < numRequiredSignatures;
        return typeof k === 'string' ? { pubkey: k, signer: isSigner, writable: false } : { ...k, signer: isSigner };
      }),
      ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true })),
      ...loadedReadonly.map((pk: string) => ({ pubkey: pk, signer: false, writable: false })),
    ];
    tx.signature = sig;
    return tx as RawSolanaTx;
  } catch (err) {
    if (err instanceof RetryableRpcError || (err instanceof Error && err.name === 'TimeoutError')) {
      if (attempt < 3) { await sleep(400 * (attempt + 1)); return fetchTxRaw(sig, attempt + 1); }
      throw new RetryableRpcError(String(err));
    }
    throw err;
  }
}

// ─── classification ─────────────────────────────────────────────────────────

type Classification =
  | 'buyer_changed'
  | 'buyer_unchanged'
  | 'transaction_unavailable'
  | 'unsupported_or_ambiguous'
  | 'rpc_retryable_error';

interface Row {
  id: string;
  signature: string;
  block_time: string;
  mint_address: string;
  price_sol: string;
  price_lamports: string;
  buyer: string;
}

interface ChangeRecord {
  saleEventId: string;
  signature: string;
  blockTime: string;
  mint: string;
  priceSol: number;
  priceLamports: string;
  oldBuyer: string;
  proposedBuyer: string;
  buyerDeltaLamports: number;
  candidateAcctIdx: number | null;
  instructionName: string;
  oldBuyerWasSigner: boolean;
  txShape: 'buyer_initiated_deposit_buyv2' | 'other';
  reason: string;
}

interface IssueRecord {
  saleEventId: string;
  signature: string;
  blockTime: string;
  classification: Classification;
  detail: string;
}

function isSignerInTx(tx: RawSolanaTx, pubkey: string): boolean {
  const keys = tx.transaction.message.accountKeys as unknown as Array<{ pubkey: string; signer: boolean }>;
  return keys.some((k) => k.pubkey === pubkey && k.signer === true);
}

function inferTxShape(tx: RawSolanaTx): 'buyer_initiated_deposit_buyv2' | 'other' {
  const logs = tx.meta?.logMessages ?? [];
  const names = logs
    .map((l) => /Program log: Instruction: (\w+)/.exec(l)?.[1])
    .filter((n): n is string => !!n);
  return names.includes('BuyV2') && names.includes('Deposit') ? 'buyer_initiated_deposit_buyv2' : 'other';
}

async function classify(row: Row): Promise<
  | { kind: 'buyer_changed'; record: ChangeRecord }
  | { kind: 'buyer_unchanged' }
  | { kind: 'transaction_unavailable' }
  | { kind: 'unsupported_or_ambiguous'; detail: string }
  | { kind: 'rpc_retryable_error'; detail: string }
> {
  let tx: RawSolanaTx | null;
  try {
    tx = await fetchTxRaw(row.signature);
  } catch (err) {
    return { kind: 'rpc_retryable_error', detail: String(err) };
  }
  if (!tx) return { kind: 'transaction_unavailable' };

  const match = findMeV2SaleIx(tx);
  if (!match || match.instructionName !== 'coreExecuteSaleV2') {
    return { kind: 'unsupported_or_ambiguous', detail: `re-derived instruction=${match?.instructionName ?? 'none'}` };
  }

  const resolution = resolveCoreBuyerDetailed(tx, match);
  if (resolution.buyer === null) {
    return { kind: 'unsupported_or_ambiguous', detail: `resolveCoreBuyerDetailed declined: ${resolution.rejectReason}` };
  }
  if (resolution.buyer === row.buyer) {
    return { kind: 'buyer_unchanged' };
  }

  return {
    kind: 'buyer_changed',
    record: {
      saleEventId:        row.id,
      signature:           row.signature,
      blockTime:            row.block_time,
      mint:                row.mint_address,
      priceSol:            Number(row.price_sol),
      priceLamports:        row.price_lamports,
      oldBuyer:            row.buyer,
      proposedBuyer:        resolution.buyer,
      buyerDeltaLamports:   resolution.candidateDeltaLamports ?? 0,
      candidateAcctIdx:    resolution.candidateAcctIdx,
      instructionName:      resolution.instructionName,
      oldBuyerWasSigner:   isSignerInTx(tx, row.buyer),
      txShape:              inferTxShape(tx),
      reason:              'resolveCoreBuyerDetailed: signer + non-positive delta at verified buyerAcctIdx',
    },
  };
}

// ─── checkpoint ─────────────────────────────────────────────────────────────

interface Checkpoint {
  lastBlockTime: string | null;
  lastId: string | null;
  scanned: number;
  changed: number;
  unchanged: number;
  unavailable: number;
  unsupported: number;
  rpcError: number;
  startedAt: string;
  updatedAt: string;
}

function loadCheckpoint(): Checkpoint {
  if (!RESTART) {
    try {
      const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    } catch { /* no checkpoint yet, or --restart */ }
  }
  return {
    lastBlockTime: null, lastId: null,
    scanned: 0, changed: 0, unchanged: 0, unavailable: 0, unsupported: 0, rpcError: 0,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function saveCheckpoint(cp: Checkpoint): void {
  cp.updatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function appendJsonl(file: string, obj: unknown): void {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// ─── summary ────────────────────────────────────────────────────────────────

function priceBucket(sol: number): string {
  if (sol < 0.03) return '<0.03';
  if (sol < 0.1)  return '0.03-0.1';
  if (sol < 0.5)  return '0.1-0.5';
  if (sol < 2)    return '0.5-2';
  return '2+';
}

function rewriteSummary(cp: Checkpoint): void {
  const byPriceBucket: Record<string, number> = {};
  const byTxShape: Record<string, number> = {};
  const byOldBuyerType: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let totalChangedSeen = 0;

  if (fs.existsSync(CHANGES_FILE)) {
    const lines = fs.readFileSync(CHANGES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const r = JSON.parse(line) as ChangeRecord;
      totalChangedSeen++;
      const pb = priceBucket(r.priceSol);
      byPriceBucket[pb] = (byPriceBucket[pb] ?? 0) + 1;
      byTxShape[r.txShape] = (byTxShape[r.txShape] ?? 0) + 1;
      const buyerType = r.oldBuyerWasSigner ? 'signer_wallet' : 'non_signer_pda';
      byOldBuyerType[buyerType] = (byOldBuyerType[buyerType] ?? 0) + 1;
      const month = r.blockTime.slice(0, 7); // YYYY-MM
      byMonth[month] = (byMonth[month] ?? 0) + 1;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    checkpoint: cp,
    counts: {
      scanned:      cp.scanned,
      buyer_changed: cp.changed,
      buyer_unchanged: cp.unchanged,
      transaction_unavailable: cp.unavailable,
      unsupported_or_ambiguous: cp.unsupported,
      rpc_retryable_error: cp.rpcError,
    },
    changedBreakdown: {
      totalChangedRecordsOnDisk: totalChangedSeen,
      byPriceBucket, byTxShape, byOldBuyerType, byMonth,
    },
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function fetchPage(cp: Checkpoint, size: number): Promise<Row[]> {
  const pool = getPool();
  const where = [
    `marketplace = 'magic_eden'`,
    `raw_data->>'_instruction' = 'coreExecuteSaleV2'`,
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  if (cp.lastBlockTime && cp.lastId) {
    params.push(cp.lastBlockTime, cp.lastId);
    where.push(`(block_time, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(size);
  const sql = `
    SELECT id, signature, block_time, mint_address, price_sol, price_lamports, buyer
      FROM sale_events
     WHERE ${where.join(' AND ')}
     ORDER BY block_time ASC, id ASC
     LIMIT $${params.length}
  `;
  const { rows } = await pool.query<Row>(sql, params);
  return rows;
}

async function main(): Promise<void> {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const cp = loadCheckpoint();

  console.log('Core buyer-attribution audit — READ-ONLY, zero DB mutations');
  console.log(`resuming from lastBlockTime=${cp.lastBlockTime ?? '(start)'} lastId=${cp.lastId ?? '(start)'}`);
  console.log(`page-size=${PAGE_SIZE} batch=${BATCH} sleep=${SLEEP_MS}ms limit-this-run=${LIMIT ?? 'unbounded'}\n`);

  let scannedThisRun = 0;

  for (;;) {
    if (LIMIT !== null && scannedThisRun >= LIMIT) break;

    const remaining = LIMIT !== null ? Math.min(PAGE_SIZE, LIMIT - scannedThisRun) : PAGE_SIZE;
    const page = await fetchPage(cp, remaining);
    if (page.length === 0) { console.log('No more rows — full scan complete.'); break; }

    const results = await Promise.all(
      page.map((row) => auditLimiter.run(() => classify(row))),
    );

    for (let i = 0; i < results.length; i++) {
      const row = page[i];
      const result = results[i]; // may be null if the limiter's gate refused — never happens here (no gate configured)
      cp.scanned++;
      scannedThisRun++;
      if (!result) { cp.rpcError++; appendJsonl(ISSUES_FILE, { saleEventId: row.id, signature: row.signature, blockTime: row.block_time, classification: 'rpc_retryable_error', detail: 'limiter refused admission' } satisfies IssueRecord); continue; }

      if (result.kind === 'buyer_changed') {
        cp.changed++;
        appendJsonl(CHANGES_FILE, result.record);
        console.log(`  CHANGED  ${row.signature.slice(0, 16)}…  ${result.record.oldBuyer.slice(0, 10)}… → ${result.record.proposedBuyer.slice(0, 10)}…  price=${result.record.priceSol}`);
      } else if (result.kind === 'buyer_unchanged') {
        cp.unchanged++;
      } else if (result.kind === 'transaction_unavailable') {
        cp.unavailable++;
        appendJsonl(ISSUES_FILE, { saleEventId: row.id, signature: row.signature, blockTime: row.block_time, classification: result.kind, detail: 'getTransaction returned null' } satisfies IssueRecord);
      } else if (result.kind === 'unsupported_or_ambiguous') {
        cp.unsupported++;
        appendJsonl(ISSUES_FILE, { saleEventId: row.id, signature: row.signature, blockTime: row.block_time, classification: result.kind, detail: result.detail } satisfies IssueRecord);
      } else {
        cp.rpcError++;
        appendJsonl(ISSUES_FILE, { saleEventId: row.id, signature: row.signature, blockTime: row.block_time, classification: result.kind, detail: result.detail } satisfies IssueRecord);
      }
    }

    const last = page[page.length - 1];
    cp.lastBlockTime = last.block_time;
    cp.lastId = last.id;
    saveCheckpoint(cp);
    rewriteSummary(cp);

    console.log(`  … scanned=${cp.scanned} changed=${cp.changed} unchanged=${cp.unchanged} unavailable=${cp.unavailable} unsupported=${cp.unsupported} rpcError=${cp.rpcError}`);

    if (page.length < remaining) break; // short page = reached the end
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`FINAL: scanned=${cp.scanned} changed=${cp.changed} unchanged=${cp.unchanged}`);
  console.log(`unavailable=${cp.unavailable} unsupported=${cp.unsupported} rpcError=${cp.rpcError}`);
  console.log(`\nArtifacts:`);
  console.log(`  ${CHANGES_FILE}`);
  console.log(`  ${ISSUES_FILE}`);
  console.log(`  ${SUMMARY_FILE}`);
  console.log(`  ${CHECKPOINT_FILE}`);
  console.log(`\nZERO database rows were modified by this script.`);

  await closePool();
}

main().catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
