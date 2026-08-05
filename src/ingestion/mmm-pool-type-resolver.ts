/**
 * MMM pool-type resolver — AMM badge FALLBACK/CORROBORATION ONLY
 * (2026-07-15 — this module is no longer the sole source of truth for the
 * badge; see below).
 *
 * As of 2026-07-15 the primary, authoritative AMM-fill signal is computed
 * SYNCHRONOUSLY at parse time from the MMM `lp_fee` program log (see
 * `src/ingestion/me-raw/parser.ts`'s "Synchronous AMM-fill classification"
 * block) and persisted in `sale_events.raw_data._ammFill` — no ME API
 * round-trip, no staleness window, and it survives REST reads / reloads
 * (unlike this module's `poolType`, which remains SSE-live-only per the
 * SCOPE note below). The frontend's `saleKind()` (feed/lib/sale-kind.ts)
 * uses THIS module's `poolType` only when `ammFill` carries no evidence
 * either way (non-MMM sale, MMM fulfillSell direction, an unverified
 * instruction variant, or a pre-existing row) — `poolType` can corroborate
 * an unresolved case but can never override a confirmed `ammFill` value,
 * even a confirmed `false`. This module otherwise still matters: it's the
 * only signal for instruction variants / directions the lp_fee invariant
 * doesn't cover, and for debugging/cross-checking a resolved `_ammFill`
 * against ME's own classification.
 *
 * FLOW
 *   sale ingest (MMM AMM, poolAddress captured at parse time) → insert.ts
 *   calls getCachedPoolType() to stamp a FRESH cache hit synchronously onto
 *   the first `sale` frame; a miss/stale entry calls
 *   enqueuePoolTypeLookup(poolAddress, owner, signature) fire-and-forget.
 *   The worker resolves via Magic Eden's owner-keyed `/mmm/pools` endpoint,
 *   exact-matches `poolKey === poolAddress`, writes the cache, and emits a
 *   `pool_type` SSE patch keyed by the originating signature.
 *
 * WHY poolAddress, NOT owner, IS THE CACHE KEY
 *   One ME owner wallet can run multiple pools of different poolType —
 *   confirmed live 2026-07-11 (owner F7BDq8Ys… held 11 buy_sided + 4
 *   invalid pools simultaneously). Caching by owner would silently mis-tag
 *   every sibling pool with whichever type was last resolved. The owner
 *   query's response is fanned out across ALL of that owner's pools in one
 *   call (cheap — see ownerCache below), but only the ONE entry whose
 *   `poolKey` exactly equals `poolAddress` is ever written to the
 *   classification cache.
 *
 * TTL — 5 minutes, NOT 24–48h. poolType is mutable (a deposit/withdraw
 *   instruction changes a pool's funding side — see
 *   docs/mmm-pool-checklist.md) and this badge's entire purpose is
 *   correctness, so staleness must self-heal fast. Disk persistence is a
 *   warm-start convenience only (mirrors the existing `fvcaInfoCache` /
 *   `data/mmm-fvca-info-cache.json` pattern in tools-mmm-pools.ts) — any
 *   entry older than POSITIVE_TTL_MS is discarded the instant it's loaded,
 *   exactly as a stale in-memory hit would be. Disk never grants an entry a
 *   longer effective life than memory would.
 *
 * FAIL CLOSED
 *   - No poolAddress captured at parse time (unmapped instruction variant —
 *     see programs.ts `poolAcctIdx`, or extraction failed) → lookup never
 *     runs, no AMM.
 *   - No owner resolvable for the ME query → lookup never runs, no AMM.
 *   - ME request fails, times out, or is in cooldown → nothing cached, no
 *     AMM. Short in-memory negative throttle (NEG_TTL_MS) stops the same
 *     failing/not-yet-found pool from being re-queried on every sale.
 *   - poolKey not present in the owner's pool list, or its raw `poolType`
 *     isn't one of `buy_sided` / `sell_sided` / `two_sided` (e.g. `invalid`
 *     — a real, common ME state, see docs/mmm-pool-checklist.md) → nothing
 *     cached, no AMM. A wrong/mismatched "owner" guess is harmless here:
 *     the exact-poolKey-match requirement means it just resolves to
 *     "not found", never a wrong classification.
 *
 * SCOPE — no DB migration, no historical backfill, no REST-path
 *   resolution. `sale_events` carries no column for either poolAddress or
 *   poolType; a page reload / collection-drilldown / trade-history read
 *   never sees a badge for a past sale. Only a client connected to the
 *   live SSE feed at classification time (or shortly after, via the
 *   `pool_type` patch) can see it — an accepted, deliberate scope
 *   narrowing, not a bug.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { saleEventBus, PoolTypePatch } from '../events/emitter';
import { meAuthHeaders, meCooldownActive, setMeCooldown } from '../me-api-cooldown';

export type ResolvedPoolType = 'buy' | 'sell' | 'two_sided';

const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';

// Correctness-first: bottom of the 5–10 min range the architecture review
// specified, since poolType can change under a pool at any time.
const POSITIVE_TTL_MS    = 5 * 60_000;
// Failed / not-found lookups are retried after this window — long enough
// that a permanently-erroring or genuinely-invalid pool isn't hammered on
// every sale, short enough that a transient ME hiccup self-heals soon.
const NEG_TTL_MS         = 2 * 60_000;
// Owner-response reuse window — a call-dedup convenience ONLY. Never the
// source of a classification; every read from it still exact-matches
// poolKey === poolAddress before anything is cached.
const OWNER_CACHE_TTL_MS = 5 * 60_000;

const MAX_QUEUE          = 500;
const WORKER_INTERVAL_MS = 1_500;
const FETCH_TIMEOUT_MS   = 15_000;

const CACHE_FILE = path.join(__dirname, '../../data/mmm-pool-type-cache.json');

interface CacheEntry { poolType: ResolvedPoolType; cachedAt: number }
const cache    = new Map<string, CacheEntry>();   // poolAddress -> entry
const negCache = new Map<string, number>();        // poolAddress -> failedAt
const inflight = new Set<string>();                 // poolAddress currently resolving
const queue: Array<{ poolAddress: string; owner: string; signature: string }> = [];
const queued = new Set<string>();

interface OwnerCacheEntry { pools: Map<string, string>; fetchedAt: number } // poolKey -> raw ME poolType
const ownerCache = new Map<string, OwnerCacheEntry>();
// `ownerCache` previously had no eviction at all — an owner resolved once
// and never looked up again (the common case: most wallets sell one pool
// and move on) stayed allocated for the life of the process. TTL sweep +
// hard cap, same shape as `negCache`'s size-triggered cleanup above. No new
// timer: piggybacked onto `mmm-prefilter.ts`'s existing 60 s summary tick
// (see `sweepOwnerCache` export below), since that's the closest ambient
// MMM-scoped housekeeping cadence already running in the live pipeline.
const OWNER_CACHE_MAX = 2_000;
export function sweepOwnerCache(): void {
  const now = Date.now();
  for (const [owner, entry] of ownerCache) {
    if (now - entry.fetchedAt >= OWNER_CACHE_TTL_MS) ownerCache.delete(owner);
  }
  if (ownerCache.size <= OWNER_CACHE_MAX) return;
  const overflow = ownerCache.size - OWNER_CACHE_MAX;
  const it = ownerCache.keys();
  for (let i = 0; i < overflow; i++) {
    const r = it.next();
    if (r.done) break;
    ownerCache.delete(r.value);
  }
}

function isFresh(cachedAt: number, ttl: number): boolean {
  return Date.now() - cachedAt < ttl;
}

/** Normalizes Magic Eden's raw poolType string. `invalid` (a real, common
 *  ME state for drained/closed pools — see docs/mmm-pool-checklist.md) and
 *  anything unrecognized both map to null = unresolved, never cached. */
function normalizePoolType(raw: string | undefined): ResolvedPoolType | null {
  switch (raw) {
    case 'buy_sided':  return 'buy';
    case 'sell_sided': return 'sell';
    case 'two_sided':  return 'two_sided';
    default:           return null;
  }
}

// ── Disk warm-start (fvcaInfoCache / knownPoolFirstSeen convention) ──────────
(function loadFromDisk(): void {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw) as Array<[string, CacheEntry]>;
    const now = Date.now();
    let loaded = 0, discardedStale = 0;
    for (const [k, v] of entries) {
      if (now - v.cachedAt < POSITIVE_TTL_MS) { cache.set(k, v); loaded++; }
      else discardedStale++;
    }
    console.log(`[mmm-pool-type] loaded ${loaded} fresh cache entries from disk (${discardedStale} stale, discarded)`);
  } catch { /* first boot or corrupt file — start empty, non-fatal */ }
})();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveDebounced(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fsp.writeFile(CACHE_FILE, JSON.stringify([...cache.entries()]), 'utf8').catch(() => { /* non-fatal */ });
  }, 2_000);
}

// ── ME owner-pools fetch ──────────────────────────────────────────────────────

interface MePoolResult { poolKey?: string; poolType?: string }

async function fetchOwnerPools(owner: string): Promise<Map<string, string>> {
  const hit = ownerCache.get(owner);
  if (hit && isFresh(hit.fetchedAt, OWNER_CACHE_TTL_MS)) return hit.pools;

  const out = new Map<string, string>();
  if (meCooldownActive()) return out;
  try {
    const url = `${ME_BASE}/mmm/pools?owner=${encodeURIComponent(owner)}&showInvalid=true&limit=100`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VictoryLabs/1.0', ...meAuthHeaders() },
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) { setMeCooldown(60_000); return out; }
    if (!res.ok) return out;
    const data = await res.json() as { results?: MePoolResult[] };
    for (const p of data.results ?? []) {
      if (p.poolKey && p.poolType) out.set(p.poolKey, p.poolType);
    }
    ownerCache.set(owner, { pools: out, fetchedAt: Date.now() });
  } catch { /* fail soft — out stays empty, caller treats as unresolved */ }
  return out;
}

// ── Public surface ─────────────────────────────────────────────────────────

/** Synchronous cache lookup — used by insert.ts so the initial `sale`
 *  frame can carry poolType if it's already known. Returns null (and
 *  evicts) on a stale hit — disk-loaded entries are already TTL-filtered
 *  at load time, so this only prunes entries that have aged out since. */
export function getCachedPoolType(poolAddress: string): ResolvedPoolType | null {
  const hit = cache.get(poolAddress);
  if (!hit) return null;
  if (!isFresh(hit.cachedAt, POSITIVE_TTL_MS)) { cache.delete(poolAddress); return null; }
  return hit.poolType;
}

function shouldResolve(poolAddress: string): boolean {
  if (inflight.has(poolAddress) || queued.has(poolAddress)) return false;
  const hit = cache.get(poolAddress);
  if (hit && isFresh(hit.cachedAt, POSITIVE_TTL_MS)) return false; // fresh positive — no need
  const neg = negCache.get(poolAddress);
  if (neg !== undefined && Date.now() - neg < NEG_TTL_MS) return false; // recent failure — throttled
  return true;
}

/** Schedule a resolution. Fire-and-forget — never blocks the sale-ingest
 *  hot path. `owner` is whichever party the parser already resolved as the
 *  pool-controller wallet for this instruction's direction (buyer for
 *  fulfillBuy/takeBid, seller for fulfillSell) — a wrong guess is safe (see
 *  module doc), so no extra RPC is spent verifying it first. */
export function enqueuePoolTypeLookup(poolAddress: string | null | undefined, owner: string | null | undefined, signature: string): void {
  if (!poolAddress || !owner) return;
  if (!shouldResolve(poolAddress)) return;
  if (queue.length >= MAX_QUEUE) {
    console.log(`[mmm-pool-type] queue full (${MAX_QUEUE}) — dropping pool=${poolAddress.slice(0, 8)}…`);
    return;
  }
  queue.push({ poolAddress, owner, signature });
  queued.add(poolAddress);
}

function emitPatch(signature: string, poolAddress: string, poolType: ResolvedPoolType): void {
  const patch: PoolTypePatch = { signature, poolAddress, poolType };
  saleEventBus.emitPoolTypePatch(patch);
}

let workerBusy = false;
async function workerTick(): Promise<void> {
  if (workerBusy) return;
  const job = queue.shift();
  if (!job) return;
  queued.delete(job.poolAddress);
  inflight.add(job.poolAddress);
  workerBusy = true;
  try {
    const ownerPools = await fetchOwnerPools(job.owner);
    const rawType = ownerPools.get(job.poolAddress); // exact poolKey match — the ONLY write path
    const normalized = normalizePoolType(rawType);
    if (normalized) {
      cache.set(job.poolAddress, { poolType: normalized, cachedAt: Date.now() });
      negCache.delete(job.poolAddress);
      saveDebounced();
      emitPatch(job.signature, job.poolAddress, normalized);
      console.log(`[mmm-pool-type] resolved pool=${job.poolAddress.slice(0, 8)}… type=${normalized} owner=${job.owner.slice(0, 8)}…`);
    } else {
      negCache.set(job.poolAddress, Date.now());
      if (negCache.size > 5_000) {
        const now = Date.now();
        for (const [k, t] of negCache) if (now - t >= NEG_TTL_MS) negCache.delete(k);
      }
      console.log(`[mmm-pool-type] unresolved pool=${job.poolAddress.slice(0, 8)}… rawType=${rawType ?? 'not_found'} owner=${job.owner.slice(0, 8)}…`);
    }
  } catch (e) {
    negCache.set(job.poolAddress, Date.now());
    console.log(`[mmm-pool-type] lookup failed pool=${job.poolAddress.slice(0, 8)}… err=${(e as Error).message}`);
  } finally {
    inflight.delete(job.poolAddress);
    workerBusy = false;
  }
}

export function startMmmPoolTypeResolver(): void {
  setInterval(workerTick, WORKER_INTERVAL_MS);
  console.log('[mmm-pool-type] resolver started');
}

/** Test-only affordances. Inert in production — no production code path
 *  references `__testHooks`. */
export const __testHooks = {
  ownerCacheSize: (): number => ownerCache.size,
  ownerCacheMax: OWNER_CACHE_MAX,
  ownerCacheTtlMs: OWNER_CACHE_TTL_MS,
  seedOwnerCache: (owner: string, fetchedAt: number): void => {
    ownerCache.set(owner, { pools: new Map(), fetchedAt });
  },
  sweepOwnerCache,
};
