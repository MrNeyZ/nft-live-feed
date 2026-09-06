// On-demand SIMD-0437 rent-refund resolver for Live Feed Sales.
//
// FLOW
//   sale ingest → insert.ts calls enqueueRentRefundLookup(mint, signature)
//     IFF the same prefilter the resize resolver uses matches
//     (nftType ∈ {legacy, pnft} AND priceLamports ≤ 0.03 SOL).
//   worker tick → pops one mint, runs ONE getAccountInfo on the mint
//     account, computes surplus over the CURRENT rent-exempt minimum,
//     emits a RentRefundPatch and persists.
//
// SIGNAL
//   SIMD-0437 lowers `lamports_per_byte` for token/mint accounts in five
//   mainnet steps. A mint account funded before a step holds more than the
//   new minimum — a surplus the holder can withdraw via WithdrawExcessLamports
//   (p-token ix 38) without closing the account. We flag the NFT when that
//   surplus exists:
//     surplus = mintAccount.lamports − minRentExempt(mintAccount.space)
//     status  = surplus > DUST_LAMPORTS ? 'has_refund' : 'none'
//   `minRentExempt` is read live from the chain (getMinimumBalanceForRentExemption)
//   so the threshold tracks whatever SIMD step is active — no redeploy per step.
//
// COST
//   1 getAccountInfo per mint (base64, no data slice) + a per-space
//   minRentExempt lookup that's cached and refreshed daily. Positive AND
//   negative results are TTL-rechecked: a 'none' can become 'has_refund' as
//   later steps lower the minimum; a 'has_refund' becomes 'none' once skimmed.
//
// SAFEGUARDS (mirror resize-status-resolver)
//   - Prefilter at the call site (legacy/pNFT, ≤ 0.03 SOL).
//   - In-memory positive cache + negative cache, both TTL'd.
//   - Sequential queue, WORKER_INTERVAL_MS spacing, MAX_QUEUE hard cap.
//   - Every failure path is fail-soft: no patch, keep the prior cache row.

import { saleEventBus, RentRefundPatch } from '../events/emitter';
import { runOnRpcLimiter } from '../ingestion/me-raw/ingest';
import {
  loadAllRentRefundStatuses,
  saveRentRefundStatus,
  type RentRefundStatus,
  type RentRefundStatusRow,
} from '../db/rent-refund-status';

const WORKER_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS  = 12_000;
const MAX_QUEUE           = 500;
// Recheck cadence for BOTH states — a 'none' can flip positive when the next
// SIMD-0437 step lowers the minimum; a 'has_refund' flips to 'none' once the
// holder skims it. 14 days keeps RPC spend negligible while staying current
// across the (weeks-to-months) step rollout.
const RECHECK_TTL_MS      = 14 * 24 * 60 * 60 * 1000;
// Surplus below this is rounding noise / not worth a badge (~0.00005 SOL).
const DUST_LAMPORTS       = 50_000;
// minRentExempt(space) is refreshed at most this often (it only changes when
// a SIMD-0437 step activates — days/weeks apart).
const RENT_MIN_TTL_MS     = 24 * 60 * 60 * 1000;

interface CacheEntry { row: RentRefundStatusRow; }
const cache = new Map<string, CacheEntry>();
const inflight = new Set<string>();
const queue: Array<{ mint: string; signature: string | null }> = [];
const queued = new Set<string>();

const rentMinCache = new Map<number, { value: number; atMs: number }>();

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  return runOnRpcLimiter<T | null>(async () => {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
      clearTimeout(tid);
      const j = await res.json() as { result?: T; error?: { message: string } };
      if (j.error) { console.log(`[rent-refund] ${method} err msg=${j.error.message}`); return null; }
      return j.result ?? null;
    } catch (e) {
      clearTimeout(tid);
      console.log(`[rent-refund] ${method} fail err=${(e as Error).message}`);
      return null;
    }
  });
}

async function minRentExempt(space: number): Promise<number | null> {
  const hit = rentMinCache.get(space);
  if (hit && Date.now() - hit.atMs < RENT_MIN_TTL_MS) return hit.value;
  const v = await rpc<number>('getMinimumBalanceForRentExemption', [space]);
  if (typeof v !== 'number') return hit?.value ?? null;
  rentMinCache.set(space, { value: v, atMs: Date.now() });
  return v;
}

interface AccountInfoValue { lamports: number; space?: number; data: [string, string] }

/** One getAccountInfo on the NFT's mint account → surplus over the current
 *  rent-exempt minimum. Returns null on any failure (fail-soft). */
async function detectSurplus(mint: string): Promise<number | null> {
  const r = await rpc<{ value: AccountInfoValue | null }>('getAccountInfo', [
    mint, { encoding: 'base64', commitment: 'confirmed' },
  ]);
  const v = r?.value;
  if (!v) return null;
  const space = typeof v.space === 'number'
    ? v.space
    : Buffer.from(v.data[0], 'base64').length;
  const min = await minRentExempt(space);
  if (min == null) return null;
  return v.lamports - min;
}

function classify(surplus: number): RentRefundStatus {
  return surplus > DUST_LAMPORTS ? 'has_refund' : 'none';
}

/** Should we (re-)resolve this mint now? */
function shouldResolve(mint: string): boolean {
  if (inflight.has(mint) || queued.has(mint)) return false;
  const ce = cache.get(mint);
  if (!ce) return true;
  return (Date.now() - ce.row.checkedAtMs) >= RECHECK_TTL_MS;
}

function emitPatch(signature: string, mint: string, status: RentRefundStatus): void {
  const patch: RentRefundPatch = { signature, mint, rentRefund: status };
  saleEventBus.emitRentRefundPatch(patch);
}

/** Schedule a resolution; fire an immediate patch when the cached value is
 *  fresh and positive so a re-sale of the same mint lights the dot without
 *  waiting for the next worker tick. */
export function enqueueRentRefundLookup(mint: string, signature: string | null): void {
  if (!mint) return;
  if (!shouldResolve(mint)) {
    const ce = cache.get(mint);
    if (ce && signature && ce.row.status === 'has_refund') {
      emitPatch(signature, mint, 'has_refund');
    }
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    console.log(`[rent-refund] queue full (${MAX_QUEUE}) — dropping mint=${mint}`);
    return;
  }
  queue.push({ mint, signature });
  queued.add(mint);
}

let workerBusy = false;
async function workerTick(): Promise<void> {
  if (workerBusy) return;
  const job = queue.shift();
  if (!job) return;
  queued.delete(job.mint);
  inflight.add(job.mint);
  workerBusy = true;
  try {
    const surplus = await detectSurplus(job.mint);
    if (surplus == null) return;   // fail-soft — keep prior cache row, no patch
    const status = classify(surplus);
    const row: RentRefundStatusRow = {
      mint:            job.mint,
      status,
      surplusLamports: Math.max(0, surplus),
      checkedAtMs:     Date.now(),
    };
    cache.set(job.mint, { row });
    try { await saveRentRefundStatus(row); }
    catch (e) { console.log(`[rent-refund] save fail mint=${job.mint} err=${(e as Error).message}`); }
    if (job.signature && status === 'has_refund') emitPatch(job.signature, job.mint, status);
    console.log(`[rent-refund] mint=${job.mint} status=${status} surplusLamports=${Math.max(0, surplus)}`);
  } finally {
    inflight.delete(job.mint);
    workerBusy = false;
  }
}

/** Synchronous cache lookup — SSE buildSaleFrame + events-router re-stamp. */
export function getCachedRentRefundStatus(mint: string): RentRefundStatus | null {
  return cache.get(mint)?.row.status ?? null;
}

export async function startRentRefundResolver(): Promise<void> {
  try {
    const persisted = await loadAllRentRefundStatuses();
    for (const [mint, row] of persisted) cache.set(mint, { row });
    console.log(`[rent-refund] resolver started · preloaded=${persisted.size}`);
  } catch (e) {
    console.log(`[rent-refund] preload failed: ${(e as Error).message}`);
  }
  setInterval(workerTick, WORKER_INTERVAL_MS);
}
