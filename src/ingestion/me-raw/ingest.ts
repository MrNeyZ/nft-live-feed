/**
 * ME raw ingestion helper.
 *
 * Fetches a raw Solana transaction from the RPC, runs it through the ME raw
 * parser, and inserts the result. Designed to run alongside (not replace) the
 * Helius enhanced parser — ON CONFLICT (signature) DO NOTHING handles dedup.
 *
 * Fast path
 * ─────────
 * When an optional HeliusEnhancedTransaction is supplied (always the case for
 * webhook-triggered ingests), a preliminary SaleEvent is inserted immediately
 * using the enriched fields Helius already computed (buyer, seller, amount,
 * mint).  This emits an SSE card without waiting for the RPC round-trip.
 *
 * Once the raw RPC fetch + parse completes, patchSaleEventRaw() updates the
 * DB row with the corrected raw-parser data (accurate saleType, nftType,
 * marketplace, seller for pNFT escrow cases) and pushes a `rawpatch` SSE
 * event so connected clients update their cards in place.
 */
import { parseRawMeTransaction } from './parser';
import { RawSolanaTx } from './types';
import { insertSaleEvent, patchSaleEventRaw } from '../../db/insert';
import { HeliusEnhancedTransaction } from '../helius/types';
import { SaleEvent, Marketplace, NftType } from '../../models/sale-event';
import { trace } from '../../trace';
import { extractPaymentInfo, extractNftMint, extractNftMintsInvolved, extractPartiesFromTokenFlow } from './price';
import { extractCoreAssetFromInnerIx } from './decoder';
import { ME_V2_PROGRAM, ME_AMM_PROGRAM, ME_CNFT_PROGRAM } from './programs';
import bs58 from 'bs58';
import { Limiter, Priority, sleep } from '../concurrency';
import { incTxFetch, incTxNull, incTxRetry, startTelemetry } from '../telemetry';
import { incGetTx, incNullGetTx, type GetTxSource } from '../../helius-credit-metrics';
import { saleEventBus } from '../../events/emitter';
import { getMode, isAnyIngestActive } from '../../runtime/mode';
import { recordOutcome as auditRecordOutcome } from '../sales-prefilter-audit';
import { noteAcceptedSale } from '../poll-useful';
import { incEmitted, incDropped, sourceFromMarketplace } from '../source-stats';

/** Map an ME parser's program-touched set to a source label for DROP stats.
 *  programsStr is comma-joined identifiers built from `scanMeInstructions`:
 *  values include 'me_v2', 'mmm', 'me_cnft'. mmm takes precedence (its
 *  noise dominates), then me_v2; cnft and unknown roll into 'me_v2' for
 *  rollup purposes (sourceStats has no cnft bucket). */
function dropSourceFromPrograms(programsStr: string): 'me_v2' | 'mmm' {
  if (programsStr.includes('mmm')) return 'mmm';
  return 'me_v2';
}

// ─── RPC fetch ────────────────────────────────────────────────────────────────

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

// Shared across ALL callers of fetchRawTx (ingestMeRaw + ingestTensorRaw,
// from both listener and poller paths). 4 concurrent with a 75ms inter-call
// gap — avoids HTTP 429 on Helius Developer plan without reintroducing the
// old serial bottleneck. Priority queues give WS notifications the fast lane
// over poller catch-up; low-priority tasks (amm-poller pages-2+) that wait
// longer than STALE_LOW_MS are dropped at admission instead of spending a
// `getTransaction` credit on a sig that no longer matters during a burst.
const STALE_LOW_MS = 20_000;
// Gate: refuse admission when ALL ingest is paused — i.e. trade mode is
// OFF AND the mint tracker is also disabled. The mint tracker is
// independent of trade mode (`isAnyIngestActive()` is true when EITHER
// is on), so when trade mode flips to OFF but the mint tracker stays
// enabled this gate must keep `getTransaction` flowing for `mpl_core`
// / `token_metadata` listener notifications. The previous gate
// (`getMode() !== 'off'`) silently dropped every mint fetchRawTx
// overnight when the operator turned the site OFF, leaving /mints
// empty (root-cause of the 24/7 mint tracker regression).
const rpcLimiter = new Limiter(4, 75, STALE_LOW_MS, () => isAnyIngestActive());
export function rpcLimiterAbortQueued(): number { return rpcLimiter.abortQueued(); }
/** Run an arbitrary RPC thunk through the SHARED getTransaction gate so
 *  out-of-pipeline callers (the resize-status resolver) can't fire ungated
 *  bursts. Same admission gate (isAnyIngestActive) + 4-slot / 75 ms ceiling
 *  as the sale/mint pipeline. Returns null if the gate refuses the slot —
 *  callers treat that as "no result" (fail soft). Default 'low' priority so
 *  best-effort callers never starve live WS ingestion. */
export function runOnRpcLimiter<T>(
  fn: () => Promise<T>,
  priority: Priority = 'low',
): Promise<T | null> {
  return rpcLimiter.run(fn, priority);
}

/**
 * `budget` mode disables listing_refresh_hint emission in the DROP-branch
 * below — listings become TTL-driven but the sale path is unchanged.
 * `full` / `sales_only` keep real-time refresh hints. Mode is read via
 * `getMode()` so a runtime switch takes effect on the next call.
 */

startTelemetry(rpcLimiter);

// ─── Pre-fetch signature dedupe ───────────────────────────────────────────────
//
// Prevents repeated getTransaction calls for the same signature that arrives
// via multiple paths (listener × N subscriptions, raw-poller, webhook).
//
// Pipeline-scoped: 'sale' (me_v2 / mmm / tensor sales) and 'mint' (mpl_core /
// token_metadata mint trackers) maintain INDEPENDENT recent/inflight maps so
// the two pipelines cannot poison each other. Previously a single shared
// `recentSigs` let the mints poller dedup-skip MMM Core sales after fetching
// the same sig — a real sale was lost because the sale parser silently saw
// `fetchRawTx` return null.
//
// Cross-scope sharing of the actual RPC fetch is preserved via:
//   txCache              — short-lived raw-tx cache (CACHE_TTL_MS) read by
//                          either scope to avoid a duplicate getTransaction
//   sharedRpcInFlight    — in-flight RPC promise (one per sig until resolved);
//                          a second concurrent caller (any scope) awaits it
//                          instead of firing its own RPC
//
// Per-scope state:
//   inFlightByScope      — sig is currently being processed by THIS scope
//   recentByScope        — sig was processed by THIS scope within TTL window
//
// All mutations are synchronous, so check+mark sequences remain atomic under
// Node.js's single-threaded event loop.

export type FetchScope = 'sale' | 'mint';
const FETCH_SCOPES: readonly FetchScope[] = ['sale', 'mint'];

const SIG_TTL_MS   = 3 * 60_000; // 3 minutes
const CACHE_TTL_MS = 30_000;     // shared raw-tx cache TTL — long enough for
                                  // mints/poller (3 s cadence) and amm-poller
                                  // dispatchMmmDeferred (5 s defer) to read
                                  // each other's fetch result.

const inFlightByScope: Record<FetchScope, Set<string>> = {
  sale: new Set(),
  mint: new Set(),
};
const recentByScope: Record<FetchScope, Map<string, number>> = {
  sale: new Map(),
  mint: new Map(),
};

const sharedRpcInFlight: Map<string, Promise<RawSolanaTx | null>> = new Map();
const txCache: Map<string, { tx: RawSolanaTx; expiresAt: number }> = new Map();

// ── Negative cache for null/failed getTransaction results ──────────────────
// A sig that returns null (not found / failed / not-yet-indexed) on
// NEG_TX_MIN_NULLS consecutive fetches is cached briefly, so reconnect /
// catch-up / backlog passes stop re-spending getTransaction on it. Coverage is
// preserved two ways: (1) the 2-null threshold means a transiently-late tx that
// resolves on its very next retry is NEVER cached; (2) short TTL → the sig is
// re-fetchable once the entry expires (no permanent blacklist). Keyed by sig
// only (a null tx is null for every scope). Fully additive — it never touches
// recentByScope / inFlight, so existing dedupe semantics are unchanged.
const NEG_TX_TTL_MS    = parseInt(process.env.RPC_NEG_CACHE_TTL_MS ?? '90000', 10) || 90000; // 90s
const NEG_TX_MIN_NULLS = 2;
const NEG_TX_MAX       = 20000;                          // safety cap on the null-count map
const negTxCache:     Map<string, number> = new Map();   // sig → expiry ms (cached null)
const negTxNullCount: Map<string, number> = new Map();   // sig → consecutive nulls (pre-cache)
let   negTxHitLog = 0;

function getCachedTx(sig: string): RawSolanaTx | null {
  const entry = txCache.get(sig);
  if (!entry) return null;
  if (Date.now() < entry.expiresAt) return entry.tx;
  txCache.delete(sig);
  return null;
}

function cacheTx(sig: string, tx: RawSolanaTx): void {
  txCache.set(sig, { tx, expiresAt: Date.now() + CACHE_TTL_MS });
}

function sigSeenInScope(scope: FetchScope, sig: string): boolean {
  if (inFlightByScope[scope].has(sig)) return true;
  const exp = recentByScope[scope].get(sig);
  if (exp === undefined) return false;
  if (Date.now() < exp)  return true;
  recentByScope[scope].delete(sig);
  return false;
}

// Sampled diagnostic log — first occurrence per (scope, decision) plus every
// 100th. Lets the operator confirm scoped dedupe is firing and see the
// cross-scope cache-hit rate without flooding the console.
const _dedupeLogCount = new Map<string, number>();
function logDedupe(sig: string, scope: FetchScope, decision: string): void {
  const key = `${scope}:${decision}`;
  const n   = (_dedupeLogCount.get(key) ?? 0) + 1;
  _dedupeLogCount.set(key, n);
  if (n === 1 || n % 100 === 0) {
    console.log(
      `[dedupe] sig=${sig.slice(0, 12)}… scope=${scope} decision=${decision} count=${n}`,
    );
  }
}

// Periodic sweep for expired entries. Runs every 2 minutes; covers per-scope
// recent maps and the cross-scope tx cache.
setInterval(() => {
  const now = Date.now();
  for (const scope of FETCH_SCOPES) {
    for (const [sig, exp] of recentByScope[scope]) {
      if (now >= exp) recentByScope[scope].delete(sig);
    }
  }
  for (const [sig, entry] of txCache) {
    if (now >= entry.expiresAt) txCache.delete(sig);
  }
  for (const [sig, exp] of negTxCache) {
    if (now >= exp) negTxCache.delete(sig);
  }
  // Pre-cache null counters are short-lived by nature; hard-cap to bound memory
  // (clearing just means a transient single-null sig needs 2 fresh nulls again).
  if (negTxNullCount.size > NEG_TX_MAX) negTxNullCount.clear();
}, 2 * 60_000).unref();

/**
 * Mark a signature as already processed in `scope` so subsequent fetchRawTx
 * calls in the SAME scope dedup-skip without firing RPC. Used by:
 *   - Helius webhook fast path: marks 'sale' so listener raw-fetch is skipped.
 *   - Listener prefilter skip branches: marks 'sale' so the listener's own
 *     poll loop doesn't redundantly re-dispatch a WS-shed sig.
 * Other scopes are unaffected — a 'sale' mark does NOT block a 'mint' fetch.
 *
 * Default scope='sale' preserves prior call-site behaviour. Tensor / ME
 * sale paths share this layer; mint paths must opt in via scope='mint'.
 */
export function markSigFetched(sig: string, scope: FetchScope = 'sale'): void {
  recentByScope[scope].set(sig, Date.now() + SIG_TTL_MS);
}

/**
 * Read-only probe: has this sig been fetched OR pre-filtered within the
 * scope's TTL window, OR is it currently in-flight in that scope? True ⇒ a
 * subsequent `fetchRawTx(sig, ..., scope)` would dedup-skip without firing
 * RPC. Default scope='sale' matches the MMM lean-mode prefilter shim's
 * intent (drop poller-discovered MMM sigs the WS sale path has handled).
 */
export function wasRecentlyFetched(sig: string, scope: FetchScope = 'sale'): boolean {
  if (inFlightByScope[scope].has(sig)) return true;
  const exp = recentByScope[scope].get(sig);
  return exp !== undefined && Date.now() < exp;
}

// ─── Retry parameters ─────────────────────────────────────────────────────────

// Timeout retries only — 429s are never retried (they release the slot immediately).
// Primary path (bestEffort=false): up to 2 retries, delays 500ms → 1000ms.
// Rawpatch path (bestEffort=true): up to 1 retry, delay 500ms.
const PRIMARY_RETRY_ATTEMPTS  = 2;
const RAWPATCH_RETRY_ATTEMPTS = 1;
// Reverted 2026-05-29 (ab95ebe): bumping 500 → 2000 produced a live
// feed regression — sales arrived ~25 s late or were missed entirely
// (sigs 4F79Zo…, 4hWC4Bt…). The longer base delay stretched the retry
// window past the listener's stale-watchdog threshold and let the
// negative cache absorb sigs that would otherwise have surfaced on
// the 1 s attempt. Restoring 500 ms to recover live latency.
const RETRY_BASE_MS            = 500;  // delay for attempt N = RETRY_BASE_MS * 2^(N-1)
const FETCH_TIMEOUT_MS         = 8_000; // abort each attempt after 8s

function isRateLimit(status: number, errMsg?: string): boolean {
  if (status === 429) return true;
  if (errMsg && /rate.limit|too many request/i.test(errMsg)) return true;
  return false;
}

// ─── 429 circuit-breaker ──────────────────────────────────────────────────────
//
// Raw-patch fetches are best-effort: the fast-path SSE card already fired, so
// skipping a raw-parse correction during a rate-limit window costs nothing
// visible to users.
//
// After COOLDOWN_THRESH consecutive fully-exhausted 429 failures, all raw
// fetches are suspended for COOLDOWN_MS. This breaks the spiral:
//   retries → 429s → retries → 429s → ...
// and lets Helius recover before we try again.
//
// One log line is emitted per cooldown entry; the repeated per-sig warn is
// suppressed while the cooldown is active.

const COOLDOWN_MS    = 30_000;  // 30 seconds
const COOLDOWN_THRESH = 2;      // consecutive 429 failures before cooldown (low = fast response)

let consecutive429s = 0;
let cooldownUntil   = 0;        // epoch ms; 0 = inactive
let cooldownLogged  = false;    // suppress duplicate log lines per cooldown window

function onRateLimitExhausted(): void {
  consecutive429s++;
  if (consecutive429s >= COOLDOWN_THRESH) {
    cooldownUntil   = Date.now() + COOLDOWN_MS;
    consecutive429s = 0;
    if (!cooldownLogged) {
      console.warn(`[rawpatch] paused due to rate limit — resuming in ${COOLDOWN_MS / 1000}s`);
      cooldownLogged = true;
    }
  }
}

function onFetchSuccess(): void {
  consecutive429s = 0;
  // Re-arm the log once cooldown has fully expired so the next episode logs again.
  if (cooldownLogged && Date.now() >= cooldownUntil) cooldownLogged = false;
}

/**
 * Fetch a raw transaction from the RPC.
 *
 * bestEffort = true  → rawpatch path: a sale card was already emitted; this
 *                       fetch only corrects metadata. Skipped during 429 cooldown.
 * bestEffort = false → primary path: no sale emitted yet; this fetch IS the
 *                       ingestion. Never skipped due to cooldown.
 */
function deriveTxSource(scope: FetchScope, priority: Priority, bestEffort: boolean): GetTxSource {
  if (bestEffort) return scope === 'mint' ? 'mint_reconcile' : 'sale_poller';
  if (scope === 'mint') {
    if (priority === 'high')   return 'mint_ws';
    if (priority === 'medium') return 'mint_poller';
    return 'mint_reconcile';
  }
  if (priority === 'high') return 'sale_ws';
  return 'sale_poller';
}

export async function fetchRawTx(
  sig: string,
  bestEffort = false,
  priority: Priority = 'medium',
  scope: FetchScope = 'sale',
  txSourceOverride?: GetTxSource,
): Promise<RawSolanaTx | null> {
  // Hard kill switch — only refuse work when BOTH trade ingest and the
  // mint tracker are paused. The mint tracker is independent of trade
  // mode (see `isAnyIngestActive` in src/runtime/mode.ts) so listener
  // notifications for `mpl_core` / `token_metadata` mint targets must
  // keep flowing even with `getMode() === 'off'`.
  if (!isAnyIngestActive()) return null;

  // Circuit-breaker applies only to best-effort (rawpatch) callers.
  // Primary callers must never be silenced by a rawpatch-triggered cooldown.
  if (bestEffort && Date.now() < cooldownUntil) return null;

  // Per-scope dedupe — a fetch in the OTHER scope cannot block this one.
  // Same scope sees its own inflight + recent entries and skips duplicates.
  if (sigSeenInScope(scope, sig)) {
    logDedupe(sig, scope, 'skip_recent');
    return null;
  }

  // Cross-scope tx cache — if any scope just fetched the same tx and the
  // body is still cached, hand it to this caller without spending another
  // getTransaction. Mark this scope as recent so its future calls also dedup.
  const cached = getCachedTx(sig);
  if (cached) {
    recentByScope[scope].set(sig, Date.now() + SIG_TTL_MS);
    logDedupe(sig, scope, 'served_from_cache');
    return cached;
  }

  // Negative cache — skip a sig that has been persistently null (>= 2 fetches)
  // until the short TTL expires, so reconnect/catch-up/backlog don't re-spend
  // getTransaction on it. Re-fetchable after expiry (no permanent block).
  const negExp = negTxCache.get(sig);
  if (negExp != null) {
    if (Date.now() < negExp) {
      if (negTxHitLog++ % 50 === 0) {
        console.log(`[rpc/cache] negative hit scope=${scope} sig=${sig.slice(0, 12)}… (count=${negTxHitLog})`);
      }
      return null;
    }
    negTxCache.delete(sig);  // expired → allow a fresh attempt
  }

  inFlightByScope[scope].add(sig);
  try {
    // Cross-scope shared RPC: if another scope is mid-fetch, await its
    // promise instead of firing a duplicate getTransaction. The first
    // scope to arrive enqueues the rpcLimiter task; later scopes (any)
    // share the resolved tx body. Each scope still records its own
    // recent-mark on success so per-scope dedupe stays accurate.
    const txSource = txSourceOverride ?? deriveTxSource(scope, priority, bestEffort);
    let pending = sharedRpcInFlight.get(sig);
    let firedNew = false;
    if (!pending) {
      pending = (async (): Promise<RawSolanaTx | null> => {
        const result = await rpcLimiter.run(async () => {
          // Re-check after waiting in queue: mode may have flipped to off OR
          // cooldown activated while this sig was queued. Same independence
          // semantics as the entrypoint gate above.
          if (!isAnyIngestActive()) return null;
          if (bestEffort && Date.now() < cooldownUntil) return null;
          const maxRetries = bestEffort ? RAWPATCH_RETRY_ATTEMPTS : PRIMARY_RETRY_ATTEMPTS;
          return _fetchRawTxRpc(sig, maxRetries, scope, txSource);
        }, priority);
        if (result) cacheTx(sig, result);
        return result;
      })();
      sharedRpcInFlight.set(sig, pending);
      pending.finally(() => sharedRpcInFlight.delete(sig));
      firedNew = true;
    }

    const tx = await pending;
    // Only record a TTL dedup entry when the RPC actually returned a tx.
    // Transient failures (429, timeout, non-JSON, null result, stale-drop)
    // must stay retryable by subsequent poller / listener passes.
    if (tx) {
      recentByScope[scope].set(sig, Date.now() + SIG_TTL_MS);
      // A success clears any prior null state so it's never spuriously blocked.
      negTxCache.delete(sig);
      negTxNullCount.delete(sig);
      const source =
        bestEffort              ? 'rawpatch'
        : priority === 'high'   ? `ws:${scope}`
        : priority === 'low'    ? 'poll:backlog'
        :                         'poll:fresh';
      logDedupe(sig, scope, `${firedNew ? 'fetched_rpc' : 'awaited_in_flight'}:${source}`);
    } else {
      // Null/failed: only cache after NEG_TX_MIN_NULLS consecutive nulls so a
      // transiently-late tx (resolves on its first retry) is never cached.
      // Only count the call that actually hit RPC (firedNew) — a shared-inflight
      // awaiter shouldn't double-count the same null.
      if (firedNew) {
        const n = (negTxNullCount.get(sig) ?? 0) + 1;
        if (n >= NEG_TX_MIN_NULLS) {
          negTxCache.set(sig, Date.now() + NEG_TX_TTL_MS);
          negTxNullCount.delete(sig);
        } else {
          negTxNullCount.set(sig, n);
        }
      }
      logDedupe(sig, scope, 'fetch_null');
    }
    return tx;
  } finally {
    inFlightByScope[scope].delete(sig);
  }
}

async function _fetchRawTxRpc(sig: string, maxRetries: number, scope: FetchScope = 'sale', txSource: GetTxSource = 'unknown'): Promise<RawSolanaTx | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [sig, {
      encoding: 'json',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }],
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Between retry attempts the mode may have flipped to off; bail
      // before issuing another getTransaction unless the mint tracker
      // is keeping ingest alive.
      if (!isAnyIngestActive()) return null;
      // Per-attempt timeout — prevents hanging indefinitely on slow RPC nodes.
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        incTxFetch(scope);
        incGetTx(txSource);
        res = await fetch(rpcUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timerId);
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          if (attempt < maxRetries) {
            const delay = RETRY_BASE_MS * (2 ** attempt);
            incTxRetry(scope);
            console.warn(`[fetchRawTx] timeout (${FETCH_TIMEOUT_MS}ms), retrying in ${delay}ms  sig=${sig.slice(0, 12)}...`);
            await sleep(delay);
            continue;
          }
          throw new Error(`RPC timeout after ${maxRetries + 1} attempts`);
        }
        throw fetchErr;
      }
      clearTimeout(timerId);

      // Guard against HTML error pages (Cloudflare, proxy errors, etc.)
      // that would throw a SyntaxError on res.json().
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        const preview = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
        console.warn(`[fetchRawTx] non-JSON response  status=${res.status}  body="${preview}"  sig=${sig.slice(0, 12)}...`);
        return null;
      }

      // HTTP-level rate limit — no retry, release slot immediately, circuit-breaker decides cooldown.
      if (isRateLimit(res.status)) {
        console.warn(`[fetchRawTx] rate limited  sig=${sig.slice(0, 12)}...`);
        onRateLimitExhausted();
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await res.json() as { result?: any; error?: { code?: number; message: string } };

      // RPC-level rate limit — same: no retry, release immediately.
      if (json.error && isRateLimit(0, json.error.message)) {
        console.warn(`[fetchRawTx] rate limited  sig=${sig.slice(0, 12)}...`);
        onRateLimitExhausted();
        return null;
      }

      if (json.error) throw new Error(`RPC: ${json.error.message}`);
      if (!json.result) {
        // Helius logsSubscribe fires ~500–700ms before getTransaction indexes
        // the same tx. One 1s retry converts ~100% of WS nulls to hits
        // (mint_ws probe: 354/354 resolved within 1s, p90=589ms; sale_ws: 93%
        // null rate observed in prod). Eliminates the redundant poller re-fetch.
        // One retry only; if still null the poller remains the fallback.
        if ((txSource === 'mint_ws' || txSource === 'sale_ws') && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        incTxNull(scope); incNullGetTx(txSource); return null;
      }

      onFetchSuccess();
      const tx = json.result;

      // Versioned (v0) transactions load extra accounts from address lookup tables.
      // With raw 'json' encoding they arrive in meta.loadedAddresses, NOT in
      // transaction.message.accountKeys. Merge them so all programIdIndex and
      // accounts[] lookups in the decoder resolve correctly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loaded = (tx.meta as any)?.loadedAddresses ?? {};
      const loadedWritable: string[] = loaded.writable ?? [];
      const loadedReadonly: string[] = loaded.readonly  ?? [];
      // With raw 'json' encoding the per-key `signer` flag is NOT in the
      // RPC payload — the wire format only encodes signer-ness via the
      // message header (`numRequiredSignatures` = first N static keys
      // are signers, fee-payer at index 0). Without this lookup the
      // mint-raw `readTxShape` would see signer:false on every key and
      // emit `minter=null` for every accepted mint. ALT-loaded keys are
      // never signers.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const numRequiredSignatures: number = (tx.transaction?.message as any)?.header?.numRequiredSignatures ?? 0;

      tx.transaction.message.accountKeys = [
        ...staticKeys.map((k: string | { pubkey: string }, i: number) => {
          const isSigner = i < numRequiredSignatures;
          return typeof k === 'string'
            ? { pubkey: k, signer: isSigner, writable: false }
            : { ...k, signer: isSigner };
        }),
        ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true  })),
        ...loadedReadonly.map( (pk: string) => ({ pubkey: pk, signer: false, writable: false })),
      ];

      tx.signature = sig;
      return tx as RawSolanaTx;
    }

  // Exhausted retries without returning — should not be reached
  throw new Error(`fetchRawTx: exhausted ${maxRetries} retries for sig=${sig.slice(0, 12)}...`);
}

// ─── Instruction scanner (debug) ─────────────────────────────────────────────
//
// For every ME-program instruction in a raw tx, extract the 8-byte discriminator
// as hex. Used to log what instructions were seen when parsing fails, so we can
// identify gaps in ME_V2_SALE_INSTRUCTIONS / MMM_SALE_INSTRUCTIONS.

const ME_PROGRAM_LABELS: Record<string, string> = {
  [ME_V2_PROGRAM]:   'me_v2',
  [ME_AMM_PROGRAM]:  'mmm',
  [ME_CNFT_PROGRAM]: 'me_cnft',
};

interface IxScan { program: string; disc: string; }

function scanMeInstructions(tx: RawSolanaTx): IxScan[] {
  const keys = tx.transaction.message.accountKeys;
  const allIxs = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const out: IxScan[] = [];
  for (const ix of allIxs) {
    const prog = keys[ix.programIdIndex]?.pubkey ?? '';
    const label = ME_PROGRAM_LABELS[prog];
    if (!label) continue;
    let disc = 'short';
    try {
      const buf = Buffer.from(bs58.decode(ix.data));
      if (buf.length >= 8) disc = buf.subarray(0, 8).toString('hex');
    } catch { /* skip */ }
    out.push({ program: label, disc });
  }
  return out;
}

// Minimum price for an unknown-candidate event: 0.05 SOL.
// Below this, the transaction is almost certainly not a sale (dust, spam, tests).
const CANDIDATE_MIN_LAMPORTS = 50_000_000n;

// ─── Fast-path event builder ──────────────────────────────────────────────────
//
// Builds a SaleEvent from the Helius enhanced webhook body without an RPC fetch.
// Two tiers:
//   1. events.nft present (Helius-classified txs)   → use structured fields directly
//   2. events.nft absent  (type=UNKNOWN txs)         → extract from tokenTransfers / nativeTransfers
// Raw parse patches saleType, nftType, marketplace, seller, and price afterwards.

/** Minimal typed shapes for the untyped Helius transfer arrays. */
interface HTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
  tokenStandard?: string;
}
interface HNativeTransfer {
  amount?: number;
}

/**
 * Fallback: build a fast event from raw transfer arrays when events.nft is absent.
 * Works for type=UNKNOWN ME/Tensor transactions that still carry tokenTransfers
 * (NFT movement) and nativeTransfers (SOL payment).
 */
function tryBuildFastFromTransfers(
  tx: HeliusEnhancedTransaction,
  parser: string,
  defaultMarketplace: Marketplace,
): SaleEvent | null {
  if (!tx.timestamp) return null;

  const tokenTransfers = tx.tokenTransfers as HTokenTransfer[] | undefined;
  const nativeTransfers = tx.nativeTransfers as HNativeTransfer[] | undefined;
  if (!tokenTransfers?.length || !nativeTransfers?.length) return null;

  // NFT transfers: tokenAmount === 1
  const nftTxs = tokenTransfers.filter((t) => t.tokenAmount === 1 && t.mint);
  if (!nftTxs.length) return null;
  const mint = nftTxs[0].mint!;

  // For pNFT double-hop (escrow → destination) the NFT moves twice for the same mint.
  // Buyer = final recipient of the last hop; seller = sender of the first hop.
  const sameMint = nftTxs.filter((t) => t.mint === mint);
  const buyer  = sameMint[sameMint.length - 1].toUserAccount;
  const seller = sameMint[0].fromUserAccount;
  if (!buyer || !seller || buyer === seller) return null;

  // Price = largest single SOL transfer in the transaction (the payment leg).
  const priceLamports = BigInt(
    Math.max(...nativeTransfers.map((t) => t.amount ?? 0)),
  );
  if (priceLamports <= 0n) return null;

  // nftType from tokenStandard (best-effort; raw parse will correct)
  const std = (nftTxs[0].tokenStandard ?? '').toLowerCase();
  const nftType: NftType =
    std.includes('programmable') ? 'pnft' :
    std === 'compressed'         ? 'cnft' :
    'legacy';

  return {
    signature:         tx.signature,
    blockTime:         new Date(tx.timestamp * 1000),
    marketplace:       defaultMarketplace,
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    currency:          'SOL',
    rawData: { _parser: parser, events: { nft: { saleType: '' } } },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };
}

function tryBuildFastEvent(tx: HeliusEnhancedTransaction): SaleEvent | null {
  // Tier 1: use events.nft when Helius enhanced-parses the transaction
  const nft = tx.events?.nft;
  if (nft?.buyer && nft?.seller && nft?.amount && nft?.nfts?.[0]?.mint && nft?.timestamp) {
    const priceLamports = BigInt(nft.amount);
    if (priceLamports > 0n) {
      const st = (nft.saleType ?? '').toUpperCase();
      return {
        signature:         tx.signature,
        blockTime:         new Date(nft.timestamp * 1000),
        marketplace:       st.includes('AMM') ? 'magic_eden_amm' : 'magic_eden',
        nftType:           'legacy',
        mintAddress:       nft.nfts[0].mint,
        collectionAddress: null,
        seller:            nft.seller,
        buyer:             nft.buyer,
        priceLamports,
        priceSol:          Number(priceLamports) / 1e9,
        currency:          'SOL',
        rawData: { _parser: 'me_helius_fast', events: { nft: { saleType: nft.saleType ?? '' } } },
        nftName:           null,
        imageUrl:          null,
        collectionName:    null,
        magicEdenUrl:      null,
      };
    }
  }
  // Tier 2: type=UNKNOWN — extract from transfer arrays
  return tryBuildFastFromTransfers(tx, 'me_xfer_fast', 'magic_eden');
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

/**
 * Fetch + parse + insert one ME transaction via the raw parser.
 * When heliusTx is supplied the fast path fires immediately — a preliminary
 * event is emitted via SSE using Helius-enhanced data before the RPC round-trip.
 *
 * Raw RPC fetch is SKIPPED for events.nft-based fast paths: Helius-enhanced
 * data is already accurate enough (correct buyer/seller/price), and triggering
 * an RPC fetch for every such event was saturating the pg Pool queue.
 * Raw fetch runs only for transfer-based fast paths (me_xfer_fast), where
 * buyer/seller/price are approximate and need correction.
 *
 * Never throws — all errors are logged and swallowed so callers can fire-and-forget.
 */
export async function ingestMeRaw(
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
  await _ingestMeRaw(sig, heliusTx, priority);
}

async function _ingestMeRaw(
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
  // ── Fast path ───────────────────────────────────────────────────────────────
  let fastPathInserted = false;
  let fastParser: string | undefined;

  if (heliusTx) {
    const fast = tryBuildFastEvent(heliusTx);
    if (fast) {
      fastParser = fast.rawData._parser as string;
      try {
        const id = await insertSaleEvent(fast);
        fastPathInserted = id !== null;
      } catch (err) {
        console.log(`DEDUPE_DEBUG_SKIP ${fast.signature} insert_condition_failed(fast_path): ${(err as Error)?.message ?? 'unknown'}`);
        // Fast path failure is non-fatal — raw path will insert normally.
      }
    }
  }

  // ── Skip raw RPC fetch when not needed ─────────────────────────────────────
  //
  // me_helius_fast  → built from events.nft (Helius-enhanced, accurate).
  //                   Raw parse would only marginally improve nftType/saleType.
  //                   Skipping eliminates the dominant source of pool-queue growth.
  //
  // me_xfer_fast    → built from nativeTransfers/tokenTransfers (approximate).
  //                   buyer/seller/price may be wrong; raw parse is essential.
  //
  // no fast path    → nothing inserted yet; raw path must insert.
  const needsRawFetch = fastParser === 'me_xfer_fast' || (!fastParser && !fastPathInserted);
  if (!needsRawFetch) {
    if (fastPathInserted) {
      // Accurate fast path inserted the event — mark in the sale scope so
      // listener / poller sale paths skip the redundant raw-fetch. The mint
      // scope is independent and its callers must opt in via fetchRawTx
      // scope='mint' / markSigFetched(sig, 'mint').
      markSigFetched(sig, 'sale');
    }
    return;
  }

  // ── Slow path: RPC fetch + raw parse ───────────────────────────────────────
  let tx: RawSolanaTx | null;
  try {
    // bestEffort=true only when fast-path already emitted a sale card —
    // in that case the raw fetch is an optional correction, skippable under cooldown.
    tx = await fetchRawTx(sig, fastPathInserted, priority);
  } catch (err) {
    auditRecordOutcome(sig, 'error');
    console.error(`[me_raw] fetch error  sig=${sig.slice(0, 12)}...`, err);
    return;
  }

  if (!tx) { auditRecordOutcome(sig, 'null_tx'); return; }  // deduped or not found — already processed elsewhere

  // ── Per-tx debug: log every ME instruction discriminator seen ───────────────
  const ixScan = scanMeInstructions(tx);
  const discStr = ixScan.map((s) => `${s.program}:${s.disc}`).join(' ');
  const programsStr = [...new Set(ixScan.map((s) => s.program))].join(',') || 'none';

  const result = parseRawMeTransaction(tx);
  let recovered = false;  // set true if the unknown-candidate path inserts a sale

  if (!result.ok) {
    // Diagnostic for the pre-getTransaction prefilter audit: the WS deny-list
    // matches `Program log: Instruction: <name>` strings, so surface those
    // exact names for every fetched-then-dropped sale-scope tx. Names absent
    // from the ME-v2/MMM deny-lists that recur here are safe deny candidates.
    // Behaviour-neutral — just enriches the existing DROP line.
    const ixLog = Array.isArray((tx.meta as { logMessages?: unknown })?.logMessages)
      ? [...new Set(
          ((tx.meta as { logMessages: string[] }).logMessages)
            .map((l) => /^Program log: Instruction: (.+)$/.exec(l)?.[1]?.toLowerCase())
            .filter((n): n is string => !!n),
        )].join(',')
      : '';
    // Log EVERY failed parse — primary signal for diagnosing missing sales.
    console.log(
      `[me_raw] DROP  sig=${sig.slice(0, 12)}` +
      `  programs=${programsStr}` +
      `  reason="${result.reason}"` +
      (ixLog ? `  ixlog=[${ixLog}]` : '') +
      (ixScan.length ? `  discs=[${discStr}]` : ''),
    );

    // Non-sale ME/MMM tx: could be list / cancel / pool deposit / pool
    // withdraw / repricing. Signal the listings store so any cached slug
    // touching one of these mints is scheduled for reconciliation.
    const touchedMints = extractNftMintsInvolved(tx);
    if (touchedMints.length > 0) saleEventBus.emitTxMintsTouched({ mints: touchedMints });

    // ── Precise live deltas: classify the ME v2 / MMM outer ix ────────────────
    // Verified anchor discriminators — observed live and matched against
    // anchorDisc(name):
    //   ME v2  sell / mip1_sell / core_sell → user listed an NFT  → immediate refresh
    //   MMM    update_pool                   → pool reprice        → immediate refresh
    // ME v2 cancel_sell variants are NOT included yet — not observed live and
    // not independently verified; falls through to the tx_mints_touched
    // dirty+debounce path (still correct, just 10 s slower).
    const ME_V2_LIST_DISCS = new Set<string>([
      '33e685a4017f83ad', // sell
      '3a32ac6fa697165e', // mip1_sell
      '1ff3f73b8653a5da', // core_sell
    ]);
    const MMM_REPRICE_DISCS = new Set<string>([
      'efd6aa4e24231e22', // update_pool       (pool reprice)
      '2f2a9ce4f9a3feb9', // withdraw_sell     (pool-owner pulls NFT from pool → pool listings change)
      'e992d18ecf6840bc', // create_pool       (new pool seeds new listings)
      // Added via MMM audit (2026-04-23): these were already fetched as DROPs
      // but did not trigger a refresh, leaving the listings/bids panels stale
      // until the 30 s TTL cycle caught up. Including them here converts the
      // existing getTransaction spend into useful real-time refresh hints.
      'f87de814754eeaea', // sol_close_pool    (pool closes → its listings disappear)
      '42e50b366da455ee', // sol_deposit_buy   (buy-side SOL added → pool bid capacity up)
      '9a2950e8ae30f623', // sol_withdraw_buy  (buy-side SOL pulled → pool bid capacity down)
    ]);
    const hasMeV2List   = ixScan.some(s => s.program === 'me_v2' && ME_V2_LIST_DISCS.has(s.disc));
    const hasMmmReprice = ixScan.some(s => s.program === 'mmm'   && MMM_REPRICE_DISCS.has(s.disc));
    if (hasMeV2List || hasMmmReprice) {
      // For MMM update_pool the tx has no token-balance delta → touchedMints
      // is empty. Pass all tx account keys so the store can resolve a slug
      // via its poolKey→slug index. For ME v2 list the mint path (emitted
      // for each touched mint) is the primary resolution — poolKeys is
      // harmless there (won't match any MMM pool entry).
      const poolKeys = hasMmmReprice
        ? tx.transaction.message.accountKeys
            .map(k => typeof k === 'string' ? k : k?.pubkey)
            .filter((k): k is string => !!k)
        : undefined;
      if (getMode() !== 'budget') {
        if (touchedMints.length > 0) {
          for (const m of touchedMints) saleEventBus.emitListingRefreshHint({ mint: m, poolKeys });
        } else if (poolKeys && poolKeys.length > 0) {
          // Reprice with no mint — a single hint carrying just the account keys.
          saleEventBus.emitListingRefreshHint({ poolKeys });
        }
      }
      console.log(
        `[me_raw] ${hasMeV2List ? 'LIST' : 'REPRICE'}  sig=${sig.slice(0, 12)}` +
        `  mints=${touchedMints.length}  poolKeys=${poolKeys?.length ?? 0}`,
      );
    }

    // ── Unknown-candidate path ──────────────────────────────────────────────
    // When the reason is a missing instruction match (not a structural failure
    // like missing blockTime or on-chain error), attempt a best-effort generic
    // extraction. If we can resolve price + mint + parties, insert the event
    // so it shows up in the feed rather than being silently dropped.
    // Disabled for fast-path-inserted cases (the SSE card already exists).
    if (!fastPathInserted && result.reason.includes('no recognised')) {
      const payment = extractPaymentInfo(tx);
      // Mint fallback chain: SPL token movement → MPL Core inner CPI.
      // Covers Core NFTs whose asset id doesn't appear in preTokenBalances.
      const splMint  = extractNftMint(tx);
      const coreMint = splMint ? null : extractCoreAssetFromInnerIx(tx);
      const mint     = splMint ?? coreMint;
      if (!payment || payment.priceLamports < CANDIDATE_MIN_LAMPORTS) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_price(candidate:${payment?.priceLamports ?? 'none'})`);
      } else if (!mint) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} empty_mint(candidate)`);
      }
      if (payment && payment.priceLamports >= CANDIDATE_MIN_LAMPORTS && mint) {
        const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
        const seller = payment.seller ?? tkSeller;
        const buyer  = tkBuyer ?? payment.buyer;
        if (!(seller && buyer && seller !== buyer)) {
          console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_seller(candidate:seller=${seller ?? 'none'} buyer=${buyer ?? 'none'})`);
        }
        if (seller && buyer && seller !== buyer) {
          console.log(
            `[me_raw] CAND  sig=${sig.slice(0, 12)}` +
            `  discs=[${discStr}]` +
            `  src=${splMint ? 'spl' : 'core'}` +
            `  price=${(Number(payment.priceLamports) / 1e9).toFixed(4)} SOL` +
            `  mint=${mint.slice(0, 8)}...`,
          );
          const event: SaleEvent = {
            signature:         tx.signature,
            blockTime:         new Date(tx.blockTime! * 1000),
            marketplace:       'magic_eden',
            nftType:           coreMint ? 'metaplex_core' : 'legacy',
            mintAddress:       mint,
            collectionAddress: null,
            seller,
            buyer,
            priceLamports:     payment.priceLamports,
            priceSol:          Number(payment.priceLamports) / 1e9,
            currency:          'SOL',
            rawData: {
              _parser:   'unknown_sale_candidate',
              _program:  programsStr,
              _discs:    discStr,
              _mintFrom: splMint ? 'spl_token_balance' : 'mpl_core_inner_cpi',
              saleType:  'unknown',
            },
            nftName:           null,
            imageUrl:          null,
            collectionName:    null,
            magicEdenUrl:      null,
          };
          try {
            const id = await insertSaleEvent(event);
            if (id) { recovered = true; console.log(`[me_raw] CAND_INSERTED  sig=${sig.slice(0, 12)}`); }
          } catch (err) {
            console.log(`DEDUPE_DEBUG_SKIP ${event.signature} insert_condition_failed(candidate): ${(err as Error)?.message ?? 'unknown'}`);
            console.error(`[me_raw] CAND insert error  sig=${sig.slice(0, 12)}`, err);
          }
        }
      }
    }
    // Audit: a candidate recovery is a real sale (never deny those instructions);
    // otherwise this fetch produced no sale → parser_drop.
    auditRecordOutcome(sig, recovered ? 'accepted_sale' : 'parser_drop');
    if (!recovered) incDropped(dropSourceFromPrograms(programsStr));
    return;
  }

  // Step 4 — raw parser recognised this as a sale.
  auditRecordOutcome(sig, 'accepted_sale');
  noteAcceptedSale(result.event.marketplace);  // feeds AMM-poller useful-ratio backoff
  incEmitted(sourceFromMarketplace(result.event.marketplace));
  trace(sig, 'parse:ok', `parser=me_v2_raw  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`);

  console.log(
    `[me_raw] OK    sig=${sig.slice(0, 12)}` +
    `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}` +
    `  ${result.event.marketplace}/${result.event.nftType}` +
    `  ${result.event.priceSol.toFixed(4)} SOL` +
    `  mint=${result.event.mintAddress.slice(0, 8)}...`,
  );

  console.log(`INSERT_DEBUG_PARSED ${result.event.signature} me_v2_raw ${result.event.marketplace} ${result.event.mintAddress}`);

  try {
    const id = await insertSaleEvent(result.event);
    if (id) {
      console.log(
        `[me_raw] sale  ${result.event.marketplace}/${result.event.nftType}` +
        `  ${result.event.priceSol.toFixed(4)} SOL` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else if (fastPathInserted) {
      await patchSaleEventRaw(result.event);
      console.log(
        `[me_raw] patch ${result.event.marketplace}/${result.event.nftType}` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else {
      console.log(`[me_raw] dup   sig=${sig.slice(0, 12)}...`);
    }
  } catch (err) {
    console.log(`DEDUPE_DEBUG_SKIP ${result.event.signature} insert_condition_failed: ${(err as Error)?.message ?? 'unknown'}`);
    console.error(`[me_raw] insert error  sig=${sig.slice(0, 12)}...`, err);
  }
}
