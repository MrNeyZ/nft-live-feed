// On-demand resize-status resolver for Live Feed Sales (Path C).
//
// FLOW
//   sale ingest →  insertSaleEvent.afterInsert hook calls
//     enqueueResizeLookup(mint, signature)  IFF prefilter matches
//     (nftType ∈ {legacy, pnft} AND priceLamports ≤ PREFILTER_MAX_LAMPORTS).
//   worker tick → pops one mint, runs one gSFA + ≤ MAX_TX_FETCHES
//     getTransaction calls, emits a ResizeStatusPatch and persists.
//
// SIGNALS (validated empirically — see investigation notes)
//   RSZE DistributeToLegacyNft (RSZE1NgJ…) → mint at ix.accounts[5]
//     → mark mint as CLAIMED.
//   TM IX: Resize (metaqbxx…) signed by ResizebfwTEZ… → mint at ix.accounts[2]
//     → mark mint as METAPLEX_RESIZED.
//   Both → 'claimed' (resized + claimed).
//   Only resized → 'metaplex_resized_unclaimed' (BADGE).
//   Only claimed → 'user_resized' (direct, no Metaplex involvement).
//   Neither → 'none'.
//
// CREDIT SAFEGUARDS
//   - Prefilter at the call site: legacy/pNFT, price ≤ 0.03 SOL.
//   - Mint is resolved at most once (positive cache forever; negative
//     cache TTL'd via NEG_TTL_MS so we don't perpetually rescan never-
//     resized mints that just happen to re-sell cheaply).
//   - Per-mint: 1 getSignaturesForAddress (limit 200) + ≤ MAX_TX_FETCHES
//     getTransaction. Worst case = MAX_TX_FETCHES + 1 RPC per mint.
//   - Global queue is sequential; WORKER_INTERVAL_MS spaces RPC traffic.
//   - Mint tracker / runtime can be off — resolver continues for sales,
//     but will idle if no sales are coming in either.
//   - In-memory FIFO queue is hard-capped at MAX_QUEUE.
//   - Stalled queue overflow is dropped (not retried) — losing the
//     badge on a few extreme bursts is acceptable; never block the bus.

import { saleEventBus, ResizeStatusPatch } from '../events/emitter';
import { runOnRpcLimiter } from '../ingestion/me-raw/ingest';
import { incTxFetch } from '../ingestion/telemetry';
import {
  getResizeStatus,
  loadAllResizeStatuses,
  saveResizeStatus,
  type ResizeStatus,
  type ResizeStatusRow,
} from '../db/resize-status';

const RSZE_PROGRAM       = 'RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4';
const RESIZE_AUTHORITY   = 'ResizebfwTEZTLbHbctTByvXYECKTJQXnMWG8g9XLix';
const TM_PROGRAM         = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

const SIG_PAGE_LIMIT     = 200;
// Lowered 20 → 10: resize detection is best-effort, not worth a 20-call
// burst. Combined with routing every fetch through the shared rpcLimiter
// (below), this halves the worst-case per-mint getTransaction spend and
// removes the ungated burst that stacked on the main pipeline.
const MAX_TX_FETCHES     = 10;
const WORKER_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUEUE          = 500;
const NEG_TTL_MS         = 24 * 60 * 60 * 1000;  // 'none' is rechecked after 24h

interface CacheEntry { row: ResizeStatusRow; }
const cache = new Map<string, CacheEntry>();
const inflight = new Set<string>();   // mints currently being resolved (dedupe)
const queue: Array<{ mint: string; signature: string | null }> = [];
const queued = new Set<string>();

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo { signature: string; blockTime: number | null; err: unknown }

async function fetchSigs(mint: string): Promise<SigInfo[]> {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [mint, { limit: SIG_PAGE_LIMIT, commitment: 'confirmed' }],
      }),
      signal: ctl.signal,
    });
    clearTimeout(tid);
    const j = await res.json() as { result?: SigInfo[]; error?: { message: string } };
    if (j.error) { console.log(`[resize] gSFA err mint=${mint} msg=${j.error.message}`); return []; }
    return j.result ?? [];
  } catch (e) {
    clearTimeout(tid);
    console.log(`[resize] gSFA fail mint=${mint} err=${(e as Error).message}`);
    return [];
  }
}

/** Lightweight tx fetch — base64 encoding so we can inspect program IDs
 *  via accountKeys without paying for jsonParsed inflation, and inspect
 *  instructions by reading them from the message. We deserialize the
 *  raw fields we need (accountKeys, instructions, signer index). */
interface ParsedTx {
  signer: string | null;
  // program-id → list of {accountIndices, dataB58} of ixs that hit it.
  // For our purposes we only need to know, per mint:
  //   1. Did RSZE appear with accounts[5] === mint?
  //   2. Did TM appear with accounts[2] === mint and signer === RESIZE_AUTHORITY?
  hits: Array<{ programId: string; accounts: string[]; logIxName: string | null }>;
}

async function fetchTx(sig: string): Promise<ParsedTx | null> {
  // Route through the SHARED getTransaction gate (4 slots / 75 ms) so resize
  // lookups can't fire ungated bursts. 'low' priority yields to live WS
  // ingestion; a null return (gate refused OR fetch failed) → fail soft,
  // exactly as before. incTxFetch('mint') feeds the shared tx/min telemetry
  // so Helius and internal counters no longer disagree.
  return runOnRpcLimiter<ParsedTx | null>(async () => {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    incTxFetch('mint');
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      }),
      signal: ctl.signal,
    });
    clearTimeout(tid);
    interface TxResult {
      meta?: { logMessages?: string[] };
      transaction?: { message?: {
        accountKeys?: Array<string | { pubkey: string; signer?: boolean }>;
        instructions?: Array<{ programId?: string; program?: string; accounts?: string[]; data?: string; parsed?: unknown }>;
      } };
    }
    const j = await res.json() as { result?: TxResult; error?: { message: string } };
    if (j.error || !j.result) return null;
    const msg = j.result.transaction?.message;
    if (!msg) return null;
    // signer = first account marked signer (jsonParsed) OR the first key
    const keys = msg.accountKeys ?? [];
    let signer: string | null = null;
    for (const k of keys) {
      if (typeof k === 'object' && k.signer) { signer = k.pubkey; break; }
    }
    if (!signer && keys.length > 0) {
      const k0 = keys[0];
      signer = typeof k0 === 'string' ? k0 : k0.pubkey;
    }
    const hits: ParsedTx['hits'] = [];
    const logs = j.result.meta?.logMessages ?? [];
    for (const ix of msg.instructions ?? []) {
      const pid = ix.programId ?? ix.program;
      if (!pid) continue;
      if (pid !== RSZE_PROGRAM && pid !== TM_PROGRAM) continue;
      const accs = (ix.accounts ?? []).filter((a): a is string => typeof a === 'string');
      // Best-effort: pick the first matching `Program log: Instruction: X` /
      // `Program log: IX: X` from logs. Good enough since RSZE only has
      // DistributeToLegacyNft today and TM Resize is uniquely tagged.
      const logIxName = (() => {
        for (const l of logs) {
          if (l.startsWith('Program log: Instruction:') || l.startsWith('Program log: IX:')) {
            return l.split(':').pop()?.trim() ?? null;
          }
        }
        return null;
      })();
      hits.push({ programId: pid, accounts: accs, logIxName });
    }
    return { signer, hits };
  } catch {
    clearTimeout(tid);
    return null;
  }
  }, 'low');
}

interface Detection {
  resized:    { sig: string; ts: number | null } | null;
  claimed:    { sig: string; ts: number | null } | null;
}

async function detectForMint(mint: string): Promise<Detection> {
  const det: Detection = { resized: null, claimed: null };
  const sigs = await fetchSigs(mint);
  if (sigs.length === 0) return det;
  let fetched = 0;
  for (const s of sigs) {
    if (det.resized && det.claimed) break;
    if (fetched >= MAX_TX_FETCHES) break;
    if (s.err) continue;
    fetched++;
    const tx = await fetchTx(s.signature);
    if (!tx) continue;
    for (const h of tx.hits) {
      if (!det.claimed && h.programId === RSZE_PROGRAM && h.accounts[5] === mint) {
        det.claimed = { sig: s.signature, ts: s.blockTime };
      }
      if (!det.resized && h.programId === TM_PROGRAM
          && tx.signer === RESIZE_AUTHORITY
          && h.accounts[2] === mint) {
        det.resized = { sig: s.signature, ts: s.blockTime };
      }
    }
  }
  return det;
}

function classify(det: Detection): ResizeStatus {
  if (det.resized && det.claimed) return 'claimed';
  if (det.resized) return 'metaplex_resized_unclaimed';
  if (det.claimed) return 'user_resized';
  return 'none';
}

/** Should we (re-)resolve this mint? */
function shouldResolve(mint: string): boolean {
  if (inflight.has(mint) || queued.has(mint)) return false;
  const ce = cache.get(mint);
  if (!ce) return true;
  if (ce.row.status !== 'none') return false;          // positive → never re-check
  return (Date.now() - ce.row.checkedAtMs) >= NEG_TTL_MS;
}

/** Schedule a resolution. Originating sale signature is recorded so
 *  the patch event can carry it (frontend uses it as the row match key). */
export function enqueueResizeLookup(mint: string, signature: string | null): void {
  if (!mint) return;
  if (!shouldResolve(mint)) {
    // Already-resolved positive → fire the patch immediately so a
    // freshly-arriving sale of the same mint gets the badge without
    // waiting for the next worker tick.
    const ce = cache.get(mint);
    if (ce && signature && ce.row.status === 'metaplex_resized_unclaimed') {
      emitPatch(signature, mint, ce.row.status);
    }
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    console.log(`[resize] queue full (${MAX_QUEUE}) — dropping mint=${mint}`);
    return;
  }
  queue.push({ mint, signature });
  queued.add(mint);
}

function emitPatch(signature: string, mint: string, status: ResizeStatus): void {
  const patch: ResizeStatusPatch = { signature, mint, resizeStatus: status };
  saleEventBus.emitResizeStatusPatch(patch);
}

let workerBusy = false;
async function workerTick(): Promise<void> {
  if (workerBusy) return;
  const job = queue.shift();
  if (!job) return;
  queued.delete(job.mint);
  inflight.add(job.mint);
  workerBusy = true;
  const t0 = Date.now();
  try {
    const det = await detectForMint(job.mint);
    const status = classify(det);
    const now = Date.now();
    const row: ResizeStatusRow = {
      mint:         job.mint,
      status,
      checkedAtMs:  now,
      resizedSig:   det.resized?.sig ?? null,
      resizedAtMs:  det.resized?.ts != null ? det.resized.ts * 1000 : null,
      claimedSig:   det.claimed?.sig ?? null,
      claimedAtMs:  det.claimed?.ts != null ? det.claimed.ts * 1000 : null,
    };
    cache.set(job.mint, { row });
    try { await saveResizeStatus(row); }
    catch (e) { console.log(`[resize] save fail mint=${job.mint} err=${(e as Error).message}`); }
    if (job.signature && status === 'metaplex_resized_unclaimed') {
      emitPatch(job.signature, job.mint, status);
    }
    console.log(
      `[resize] mint=${job.mint} status=${status} ` +
      `resized=${det.resized?.sig?.slice(0,12) ?? '—'} claimed=${det.claimed?.sig?.slice(0,12) ?? '—'} ` +
      `elapsedMs=${now - t0}`,
    );
  } finally {
    inflight.delete(job.mint);
    workerBusy = false;
  }
}

/** Synchronous cache lookup — used by SSE buildSaleFrame so the
 *  initial frame can carry the status if it's already known. */
export function getCachedResizeStatus(mint: string): ResizeStatus | null {
  return cache.get(mint)?.row.status ?? null;
}

export async function startResizeStatusResolver(): Promise<void> {
  try {
    const persisted = await loadAllResizeStatuses();
    for (const [mint, row] of persisted) cache.set(mint, { row });
    console.log(`[resize] resolver started · preloaded=${persisted.size}`);
  } catch (e) {
    console.log(`[resize] preload failed: ${(e as Error).message}`);
  }
  setInterval(workerTick, WORKER_INTERVAL_MS);
}

// Convenience exposing the DB layer for tests (and future callers).
export { getResizeStatus };
