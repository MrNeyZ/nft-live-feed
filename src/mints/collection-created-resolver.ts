// Resolve on-chain collection creation timestamps by walking
// `getSignaturesForAddress` backwards to the earliest signature touching
// the collection address. Driven entirely off the accumulator's
// currentMintStatuses() — no hot-path coupling.
//
// CREDIT SAFEGUARDS
//   - Hard page cap (MAX_PAGES) so a pathological address can't blow
//     a thousand RPC calls.
//   - One in-flight request at a time + WORKER_INTERVAL_MS spacing
//     keeps the average burn ≤1 call / WORKER_INTERVAL_MS.
//   - Persistent positive cache in `collection_created` (DB) + in-memory
//     cache — a successfully-resolved address is NEVER re-resolved.
//   - Negative cache (NEG_TTL_MS): an address that resolved to "no
//     blockTime found" or that hit an error is held back from re-queue
//     for the TTL window.
//   - Mint tracker disabled → worker idles (no RPC, no queue drain).
import {
  currentMintStatuses,
  patchAccumulatorCollectionCreated,
} from './accumulator';
import { isMintTrackerEnabled } from '../runtime/mode';
import {
  loadAllCollectionCreated,
  saveCollectionCreated,
} from '../db/collection-created';

interface CacheEntry {
  createdAtMs:  number | null; // null = resolved but no blockTime found / error
  resolvedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const queue: string[] = [];           // FIFO of pending addresses
const queued = new Set<string>();     // dedupe guard for `queue`

const PAGE_LIMIT          = 1000;
const MAX_PAGES           = 6;        // ≤ 6000 sigs scanned per collection
const NEG_TTL_MS          = 6 * 60 * 60 * 1000;  // re-try failures after 6h
const REQUEST_TIMEOUT_MS  = 12_000;
const WORKER_INTERVAL_MS  = 2_500;    // ≤ 1 collection per ~2.5s
const SCANNER_INTERVAL_MS = 30_000;   // scan accumulator for new addrs every 30s

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo {
  signature: string;
  blockTime: number | null;
}

async function fetchSigsPage(addr: string, before: string | null): Promise<SigInfo[]> {
  const opts: { limit: number; commitment: string; before?: string } = {
    limit: PAGE_LIMIT,
    commitment: 'confirmed',
  };
  if (before) opts.before = before;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [addr, opts],
      }),
      signal: ctl.signal,
    });
    clearTimeout(tid);
    const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
    if (json.error) {
      console.log(`[col-created] rpc error addr=${addr} msg=${json.error.message}`);
      return [];
    }
    return json.result ?? [];
  } catch (e) {
    clearTimeout(tid);
    console.log(`[col-created] fetch failed addr=${addr} err=${(e as Error).message}`);
    return [];
  }
}

/** Walk backwards in PAGE_LIMIT-sized pages until either we hit a
 *  short page (= reached the end of the address's history) or we hit
 *  MAX_PAGES (= safety cap). Returns the blockTime (ms) of the oldest
 *  signature we reached, or null if nothing usable was found. */
async function resolveOne(addr: string): Promise<{ createdAtMs: number | null; pages: number }> {
  let before: string | null = null;
  let lastBlockTimeSec: number | null = null;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const sigs = await fetchSigsPage(addr, before);
    pages++;
    if (sigs.length === 0) break;
    const oldest = sigs[sigs.length - 1];
    if (typeof oldest.blockTime === 'number') lastBlockTimeSec = oldest.blockTime;
    if (sigs.length < PAGE_LIMIT) break;   // reached the genesis end
    before = oldest.signature;
  }
  return {
    createdAtMs: lastBlockTimeSec != null ? lastBlockTimeSec * 1000 : null,
    pages,
  };
}

function shouldEnqueue(addr: string): boolean {
  if (!addr) return false;
  if (queued.has(addr)) return false;
  const c = cache.get(addr);
  if (!c) return true;
  if (c.createdAtMs != null) return false;                    // resolved
  return (Date.now() - c.resolvedAtMs) >= NEG_TTL_MS;          // neg-cache expired
}

function enqueue(addr: string): void {
  if (!shouldEnqueue(addr)) return;
  queued.add(addr);
  queue.push(addr);
}

let workerInFlight = false;
async function workerTick(): Promise<void> {
  if (workerInFlight) return;
  if (!isMintTrackerEnabled()) return;
  const addr = queue.shift();
  if (!addr) return;
  queued.delete(addr);
  workerInFlight = true;
  try {
    const before = Date.now();
    const { createdAtMs, pages } = await resolveOne(addr);
    const now = Date.now();
    cache.set(addr, { createdAtMs, resolvedAtMs: now });
    if (createdAtMs != null) {
      try {
        await saveCollectionCreated(addr, createdAtMs, now);
      } catch (e) {
        console.log(`[col-created] db save failed addr=${addr} err=${(e as Error).message}`);
      }
      patchAccumulatorCollectionCreated(addr, createdAtMs);
      console.log(
        `[col-created] resolved addr=${addr} createdAt=${new Date(createdAtMs).toISOString()} ` +
        `pages=${pages} elapsedMs=${now - before}`,
      );
    } else {
      console.log(
        `[col-created] no-blocktime addr=${addr} pages=${pages} ` +
        `elapsedMs=${now - before} (neg-cached for ${NEG_TTL_MS / 3600000}h)`,
      );
    }
  } finally {
    workerInFlight = false;
  }
}

/** Periodically scan the live accumulator for collectionAddresses that
 *  (a) we know but (b) the cache hasn't covered yet, and queue them.
 *  Decoupling the queue from `recordMint` keeps the hot path RPC-free. */
function scannerTick(): void {
  if (!isMintTrackerEnabled()) return;
  const rows = currentMintStatuses();
  let queuedThisTick = 0;
  for (const r of rows) {
    if (!r.collectionAddress) continue;
    if (shouldEnqueue(r.collectionAddress)) {
      enqueue(r.collectionAddress);
      queuedThisTick++;
    }
    // Self-heal: row exists but accumulator was never patched (e.g.
    // resolver-startup raced with first event). Push the cached
    // value through again — patchAccumulator is a no-op if equal.
    const cached = cache.get(r.collectionAddress);
    if (cached?.createdAtMs != null) {
      patchAccumulatorCollectionCreated(r.collectionAddress, cached.createdAtMs);
    }
  }
  if (queuedThisTick > 0) {
    console.log(`[col-created] scanner queued=${queuedThisTick} total-queue=${queue.length}`);
  }
}

export async function startCollectionCreatedResolver(): Promise<void> {
  try {
    const persisted = await loadAllCollectionCreated();
    const now = Date.now();
    for (const [addr, ts] of persisted) {
      cache.set(addr, { createdAtMs: ts, resolvedAtMs: now });
      // Patch any accumulator entries already open for this collection.
      patchAccumulatorCollectionCreated(addr, ts);
    }
    console.log(`[col-created] resolver started · preloaded=${persisted.size}`);
  } catch (e) {
    console.log(`[col-created] preload failed: ${(e as Error).message}`);
  }
  setInterval(workerTick, WORKER_INTERVAL_MS);
  setInterval(scannerTick, SCANNER_INTERVAL_MS);
  // Kick the scanner immediately so newly-restored accumulator rows
  // get patched within ~3s instead of waiting a full 30s.
  setTimeout(scannerTick, 3_000);
}
