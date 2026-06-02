/**
 * Manual scanner — Retardio listings with Magic Eden personal offers.
 *
 * Endpoint:
 *   POST /api/tools/retardio-me-offer-scan
 *   body: { slug?: string, minOfferSol?: number, limit?: number }
 *
 * Flow (synchronous, single ~5-10 s scan per call):
 *   1. Fetch active listings for `slug` from ME's public v2 API.
 *   2. For each listing, fetch token-specific offers_received from the
 *      same API.
 *   3. Keep only mints with at least one personal offer.
 *   4. Sort by best-offer price descending.
 *
 * Constraints:
 *   - Manual / on-demand only. Never runs in the background.
 *   - In-memory cache TTL = 45 s so a flurry of clicks doesn't spam ME.
 *   - Sequential fetches with a small gap (REQUEST_GAP_MS) — keeps us
 *     well under ME's published rate limit (~120 req/min, public).
 *   - Default scan ceiling = 60 listings/scan (~12-15 s wall time).
 */

import { Router, Request, Response } from 'express';
/** Alias the global fetch `Response` so `meGet` is unambiguous — the
 *  Express `Response` import above otherwise shadows it. */
type FetchResponse = globalThis.Response;
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  deriveBuyerEscrowPda,
  resolveEscrowBalances,
  classifyFundingStatus,
  lamportsToSol,
  type FundingStatus,
} from './me-bid-escrow';

const ME_API_BASE      = 'https://api-mainnet.magiceden.dev/v2';
const DEFAULT_SLUG     = process.env.RETARDIO_ME_SLUG ?? 'retardio_cousins';
const REQUEST_GAP_MS   = 120;
const SCAN_LIMIT_MAX   = 100;
const SCAN_LIMIT_DFLT  = 60;
const CACHE_TTL_MS     = 45_000;
/** Largest single ME listings page; v2 endpoint accepts up to 100. */
const LISTINGS_PAGE    = 100;
/** Bounded parallelism for per-listing offer fetches. K=2 gives ~2×
 *  speedup vs. the prior fully-sequential loop while keeping the
 *  per-worker 120 ms gap; effective rate ≈ 3 req/s, comfortably under
 *  ME's public-API tolerance for 5–15 s scan windows. Raise only after
 *  observing 429 logs over a longer baseline. */
const SCAN_CONCURRENCY = 2;

// ─── Recent-activity candidate enumeration (replaces holder/DAS scan) ──────
// The original scanner walked /collections/{slug}/listings and pulled
// /tokens/{mint}/offers_received per listed mint. That misses every NFT
// in the collection that has an active personal offer but is NOT currently
// listed — those mints never enter the candidate set.
//
// Fix: in addition to current listings, page ME's collection activities
// feed (/v2/collections/{slug}/activities) bounded by both a time horizon
// (`recentActivityDays`, default 30) AND a page cap (`activityMaxPages`,
// default 20 = 2 000 events) so a single scan can't spiral. We harvest
// `tokenMint` only from marketplace events (list / delist / buy / bid /
// cancelBid / acceptBid) — mmm pool bids and poolUpdates carry no
// tokenMint and are dropped naturally, so the candidate set never grows
// beyond mints that genuinely had marketplace activity. Mints not in
// the listings set become `listed:false` rows with
// listingPrice/spreadSol = null.
//
// Why this and not DAS holder enumeration: scanning every NFT in the
// collection (or every top-N holder) is way too heavy for a manual
// click — wall time at 200 holders was ~60-90s on Retardio. Activity
// enumeration touches only the surface of recently-touched mints,
// which is exactly the population the operator cares about.
/** Marketplace activity types we treat as "this mint had recent
 *  trading-relevant motion". `poolUpdate` (mmm) is excluded — it's a
 *  pool-wide spread tick, has no `tokenMint`, and is by far the bulk
 *  of activity feed traffic on AMM-heavy collections like Retardio.
 *  Plain wallet transfers / metadata-only events also don't appear
 *  here since ME's activities feed already only surfaces marketplace
 *  events; this Set is the additional safety filter on top. */
const ACTIVITY_MARKETPLACE_TYPES: ReadonlySet<string> = new Set([
  'list', 'delist',
  'bid', 'cancelBid', 'acceptBid',
  'buyNow',
]);
/** Default time horizon for the activity candidate scan, in days.
 *  Override via env RECENT_ACTIVITY_DAYS or per-request body. */
const RECENT_ACTIVITY_DAYS_DFLT = Math.max(0, Math.floor(
  Number(process.env.RECENT_ACTIVITY_DAYS ?? 30),
));
/** Hard ceiling on the activity-horizon param to prevent a typo / fat-
 *  finger from asking for 365 days on a hot collection. */
const RECENT_ACTIVITY_DAYS_MAX = 90;
/** ME activities page size — public endpoint accepts up to 100. */
const ACTIVITY_PAGE_LIMIT      = 100;
/** Default cap on activity pages per scan (= ACTIVITY_PAGE_LIMIT events
 *  × N pages). 20 pages × 100 = 2 000 events. On a hot AMM-heavy
 *  collection that's ~hours of coverage, not 30 days — when we hit the
 *  cap before reaching the time horizon, a `coverage_truncated` warning
 *  is emitted so the operator knows the horizon wasn't fully covered. */
const ACTIVITY_MAX_PAGES_DFLT  = Math.max(1, Math.floor(
  Number(process.env.RECENT_ACTIVITY_MAX_PAGES ?? 20),
));
/** Hard ceiling on activity pages — protects against an env typo or a
 *  fat-fingered request asking for 1 000 pages. */
const ACTIVITY_MAX_PAGES_MAX   = 100;
const ACTIVITY_FETCH_TIMEOUT_MS = 8_000;

interface MeListing {
  pdaAddress?:    string;
  tokenMint?:     string;
  seller?:        string;
  price?:         number;       // SOL
  tokenAddress?:  string;
  auctionHouse?:  string;
  extra?:         { img?: string };
  token?:         { name?: string; image?: string };
}

interface MeOffer {
  pdaAddress?:    string;
  tokenMint?:     string;
  buyer?:         string;       // bidder
  price?:         number;       // SOL
  auctionHouse?:  string;
  expiry?:        number;
  // ME has shipped these timestamp fields under several different names
  // across endpoints / endpoint versions; we accept any of them and use
  // the first one that contains a positive number. extractCreatedAt()
  // below handles selection + ms-vs-seconds normalisation. The
  // `[key: string]: unknown` index lets us look up snake-case variants
  // without TypeScript narrowing rejecting them.
  createdAt?:     number;
  created_at?:    number;
  createdTime?:   number;
  created_time?:  number;
  blockTime?:     number;
  block_time?:    number;
  timestamp?:     number;
  [key: string]:  unknown;
}

const CREATED_AT_KEYS = [
  'createdAt', 'created_at', 'createdTime', 'created_time',
  'blockTime', 'block_time', 'timestamp',
] as const;

/** Pick the first populated timestamp field. ME returns most timestamps
 *  in seconds, but a handful of endpoints return ms — we detect by
 *  magnitude (anything ≥ 1e12 is unambiguously ms after 2001) and
 *  normalise to seconds. Returns `null` when none of the known field
 *  names carry a positive number. */
function extractCreatedAt(o: MeOffer): number | null {
  for (const k of CREATED_AT_KEYS) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    return v >= 1e12 ? Math.floor(v / 1000) : v;
  }
  return null;
}

/** One-shot diagnostic: dump the keys ME actually populated on the
 *  first offer we see. Helps pin down which timestamp field name ME
 *  is using on the current endpoint without digging through their
 *  docs. Logs at most once per process. */
let _loggedSampleKeys = false;
function maybeLogSampleKeys(offer: MeOffer): void {
  if (_loggedSampleKeys) return;
  _loggedSampleKeys = true;
  console.log(
    `[tools/retardio-me-offer-scan/sample] ME offer keys = ` +
    JSON.stringify(Object.keys(offer).sort()),
  );
}

// ─── Bid creation-time resolver (RPC fallback) ─────────────────────────────
// ME's offers_received payload carries no timestamp at all (verified live:
// the only fields are pdaAddress / tokenMint / auctionHouse / buyer /
// buyerReferral / tokenSize / price / expiry). To populate AGE we derive
// the creation time on-chain: the offer's `pdaAddress` is a bid escrow PDA,
// and its very first transaction is the bid creation. `getSignaturesForAddress`
// returns signatures newest-first; the last entry of that array is the
// creation tx → its `blockTime` is the bid timestamp.
//
// Cached by pdaAddress for the process lifetime — bid PDAs are short-lived
// (cancel or fill closes them) so the map does not grow unboundedly in
// practice. A negative-cache set skips repeat RPCs for PDAs that didn't
// resolve (defensive for ME PDAs that have somehow lost history).
const offerAgeCache:     Map<string, number> = new Map();   // pda → unix sec
const offerAgeMissCache: Set<string>         = new Set();   // pda we gave up on
/** Bounded parallelism for RPC. Higher = faster scan, but we want to stay
 *  polite — typical scans need 5-15 PDA resolutions, so 5 in flight at a
 *  time keeps wall time well under 1 s of overhead beyond the existing
 *  ME listing/offer fetches. */
const AGE_RESOLVE_CONCURRENCY = 5;
const AGE_RPC_TIMEOUT_MS      = 5_000;

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

async function fetchOfferCreationTime(pda: string): Promise<number | null> {
  try {
    const r = await fetch(rpcUrl(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'getSignaturesForAddress',
        // limit: 1000 returns the full history for a typical bid PDA in
        // one call (bid PDAs see ≤ a handful of txs in their lifetime).
        params:  [pda, { limit: 1000 }],
      }),
      signal: AbortSignal.timeout(AGE_RPC_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const data = await r.json() as { result?: Array<{ blockTime?: number | null }> };
    const sigs = data.result;
    if (!Array.isArray(sigs) || sigs.length === 0) return null;
    // Newest-first → the LAST element is the oldest = bid creation tx.
    const oldest    = sigs[sigs.length - 1];
    const blockTime = oldest?.blockTime;
    return typeof blockTime === 'number' ? blockTime : null;
  } catch {
    return null;
  }
}

/** Resolve ages for many PDAs in parallel, capped concurrency. Returns
 *  a map of pda → unix sec (omits PDAs that didn't resolve). Hits the
 *  in-process cache before issuing any RPC. */
async function resolveOfferAges(pdas: readonly string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const todo: string[] = [];
  for (const pda of pdas) {
    if (!pda) continue;
    if (offerAgeCache.has(pda))     { result.set(pda, offerAgeCache.get(pda)!); continue; }
    if (offerAgeMissCache.has(pda)) continue;
    todo.push(pda);
  }
  if (todo.length === 0) return result;

  let i = 0;
  const workers: Promise<void>[] = [];
  const work = async () => {
    while (i < todo.length) {
      const pda = todo[i++];
      const t   = await fetchOfferCreationTime(pda);
      if (t != null) { offerAgeCache.set(pda, t); result.set(pda, t); }
      else           { offerAgeMissCache.add(pda); }
    }
  };
  for (let w = 0; w < Math.min(AGE_RESOLVE_CONCURRENCY, todo.length); w++) {
    workers.push(work());
  }
  await Promise.all(workers);
  return result;
}

/** Per-offer status — every offer ME returns is kept; this label tells
 *  the UI how to dim/sort it.
 *    AVAILABLE  — `expiry` is a future-dated number (offer is fillable).
 *    EXPIRED    — `expiry` is a past-dated number (offer has lapsed).
 *    EXPECTED   — `expiry` missing / zero / non-finite (open-ended bid
 *                 or a payload variant ME doesn't expose expiry on;
 *                 worth surfacing because the offer is still in ME's
 *                 active set, just not validatable from our side). */
export type OfferStatus = 'AVAILABLE' | 'EXPIRED' | 'EXPECTED';

function classifyOfferStatus(o: MeOffer, nowSec: number): OfferStatus {
  const exp = o.expiry;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return 'EXPECTED';
  return exp > nowSec ? 'AVAILABLE' : 'EXPIRED';
}

/** Lower rank = better. Drives both best-offer selection per listing
 *  and the default sort on the frontend. */
function statusRank(s: OfferStatus): number {
  return s === 'AVAILABLE' ? 0 : s === 'EXPECTED' ? 1 : 2;
}

export interface ScanRow {
  mint:             string;
  nftName:          string | null;
  imageUrl:         string | null;
  /** Null when the mint is not currently listed on ME (Option-H unlisted
   *  rows). LISTING column renders `—` when null; sort partitions listed
   *  rows above unlisted rows regardless of column sort. */
  listingPrice:     number | null;     // SOL
  bestOfferPrice:   number;     // SOL
  /** Null whenever `listingPrice` is null — there is no listing to spread
   *  against. SPREAD column renders `—` when null. */
  spreadSol:        number | null;     // bestOffer - listing  (positive = offer above ask)
  /** Whether this mint has a current ME listing. UI shows an UNLISTED
   *  badge in the STATUS column when false; BEST OFFER colouring still
   *  follows `bestOfferStatus` so an active offer on an unlisted NFT
   *  reads as actionable. */
  listed:           boolean;
  /** Stable identity for the best active offer. ME returns its
   *  `pdaAddress` per offer; the frontend uses this to compare scans
   *  and mark newly-appeared offers as NEW. Falls back to a synthetic
   *  `${mint}:${buyer}:${price}` composite when ME omitted pda. */
  bestOfferId:      string;
  /** Status of the best offer for this listing — see OfferStatus. */
  bestOfferStatus:  OfferStatus;
  /** Unix timestamp seconds when the best offer was placed. Null when
   *  ME didn't provide a createdAt / blockTime. UI renders this as a
   *  human "AGE" string. */
  bestOfferCreatedAt: number | null;
  /** M2 buyer-escrow PDA derived from (auctionHouse, buyer). Null when
   *  ME omitted either side and we couldn't derive. The UI renders a
   *  short version next to the funding badge. */
  fundingWallet:     string | null;
  /** Lamport balance of `fundingWallet`, expressed in SOL. Null = the
   *  RPC didn't return a balance (failure / wallet unresolvable). The
   *  badge renders this number for funded / low / empty. */
  fundingBalanceSol: number | null;
  /** funded → balance ≥ offer price ; low_balance → 0 < balance < price ;
   *  empty  → balance == 0 ; unknown → wallet/balance unresolved. The
   *  scanner does NOT hide rows based on this — every offer ME returned
   *  is still shown, just labeled. */
  fundingStatus:     FundingStatus;
  meUrl:            string;
  tensorUrl:        string;
}

export interface ScanResult {
  ok:           true;
  slug:         string;
  scanned:      number;         // listings checked
  listedTotal:  number;         // total listings from ME (may exceed `scanned`)
  /** Total raw offers seen across all listings (all statuses). */
  offersFetched: number;
  /** Count of offers classified AVAILABLE (future-dated expiry). */
  offersAvailable: number;
  /** Number of activity events ME returned across all pages we walked
   *  during the recent-activity candidate scan. Includes events we then
   *  filtered out (mmm poolUpdate, plain transfers, etc.) — this is
   *  raw upstream volume, not candidate count. */
  activitiesScanned: number;
  /** Unique tokenMints harvested from recent marketplace activities
   *  (list / delist / bid / cancelBid / acceptBid / buyNow). Drives the
   *  unlisted-candidate set; some of these mints may also be in
   *  `listedCandidateMints` and are deduped against the listings scan. */
  activityCandidateMints: number;
  /** Unique tokenMints from the current ME listings page. */
  listedCandidateMints: number;
  /** Mints that produced an UNLISTED row in `withOffers`. Pure
   *  diagnostic count; the rows themselves still appear in `withOffers`. */
  unlistedWithOffers: number;
  /** Backend wall time for this scan, in milliseconds. Surfaced so the
   *  UI can show "took N s" without doing its own client-side
   *  before/after timing. */
  tookMs: number;
  withOffers:   ScanRow[];
  /** Non-fatal warnings raised during the scan — DAS failed, a holder
   *  fetch errored, debugMint upstream returned 4xx, etc. Empty array on
   *  a clean scan. Surfaced so the frontend never silently shows "0
   *  offers" when a candidate-set fetch actually failed upstream. */
  warnings:     string[];
  cachedAt:     number;         // epoch ms
  ttlMs:        number;
}

let cached: { key: string; result: ScanResult } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Marker error for transient Magic Eden listings outages — 5xx, timeout,
 *  or anything we read as "ME is unhealthy right now". The route handler
 *  `instanceof`-checks this to return a structured 503 with a friendly
 *  errorCode the frontend can recognise, instead of the generic 500 /
 *  `scan failed` payload that otherwise renders raw. */
class MeListingsUpstreamError extends Error {
  readonly upstreamStatus:     number;
  readonly upstreamStatusText: string;
  /** Best-effort endpoint label that errored, for log diagnostics. */
  readonly endpoint:           string;
  constructor(endpoint: string, status: number, statusText: string) {
    super(`ME upstream error at ${endpoint}: ${status} ${statusText}`.trim());
    this.name              = 'MeListingsUpstreamError';
    this.upstreamStatus     = status;
    this.upstreamStatusText = statusText;
    this.endpoint           = endpoint;
  }
}

/** Distinct marker for ME 429 responses. Separated from
 *  `MeListingsUpstreamError` so:
 *    1. the frontend can show a precise "rate limited, retry in Xs"
 *       banner with a countdown, instead of the generic outage copy;
 *    2. the per-mint best-effort fetchers (`fetchOffersReceived`,
 *       `fetchTokenInfo`) can let it propagate up through Promise.all
 *       to abort the rest of the scan, rather than swallowing it and
 *       caching a misleading empty-offers result;
 *    3. the route handler can set a process-wide cooldown so a
 *       follow-up scan against a DIFFERENT collection won't immediately
 *       trigger another 429 (ME rate-limits per-IP, not per-slug). */
class MeRateLimitError extends Error {
  readonly retryAfterSec: number;
  readonly endpoint:      string;
  constructor(endpoint: string, retryAfterSec: number) {
    super(`ME rate limit at ${endpoint}; retry in ~${retryAfterSec}s`);
    this.name          = 'MeRateLimitError';
    this.retryAfterSec = retryAfterSec;
    this.endpoint      = endpoint;
  }
}

/** Process-wide ME cooldown timestamp (epoch ms). Updated whenever ANY
 *  ME fetch sees a 429 — the limit is per-IP, so a 429 on one slug means
 *  every other slug is also blocked from ME's perspective for the same
 *  window. `meGet` short-circuits with `MeRateLimitError` while the
 *  cooldown is active so we don't burn requests we already know will fail
 *  and stack up additional 429s. Reset implicitly by the elapsed time —
 *  no setTimeout required. */
let meCooldownUntilMs = 0;

/** Hard ceiling on Retry-After (or our own default backoff). ME's
 *  observed retry windows are 30-60 s; we cap at 5 min so a hostile /
 *  malformed header can't pin the scanner offline. */
const ME_COOLDOWN_MAX_SEC = 300;
/** Default cooldown applied when ME 429s without a usable Retry-After
 *  header (which is the common case for ME — they typically don't ship
 *  one). 60 s is the published guidance window for their public API. */
const ME_COOLDOWN_DEFAULT_SEC = 60;

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(ME_COOLDOWN_MAX_SEC, Math.ceil(n));
  }
  const t = Date.parse(v);
  if (Number.isFinite(t)) {
    const sec = Math.ceil((t - Date.now()) / 1000);
    if (sec > 0) return Math.min(ME_COOLDOWN_MAX_SEC, sec);
  }
  return null;
}

/** Public for the route handler so the pre-flight check can short-circuit
 *  with `ME_RATE_LIMITED` before runScan starts (and burns at least one
 *  ME listings request). Returns 0 when no cooldown is active. */
function getMeCooldownRemainingSec(): number {
  const ms = meCooldownUntilMs - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

interface MeGetOpts {
  endpoint:  string;
  timeoutMs: number;
}

/** Central wrapper around `fetch` for ME endpoints. Enforces the
 *  process-wide 429 cooldown, classifies error responses into
 *  `MeRateLimitError` / `MeListingsUpstreamError`, and lets the caller
 *  decide what to do with non-429 4xx (returns the Response for the
 *  caller to read `.ok` / `.json()` — same shape as the prior direct
 *  fetch call sites). Timeouts and network errors map to a synthetic
 *  upstream error so the caller's existing 5xx branch handles them. */
async function meGet(url: string, opts: MeGetOpts): Promise<FetchResponse> {
  const cooldownLeft = getMeCooldownRemainingSec();
  if (cooldownLeft > 0) {
    throw new MeRateLimitError(opts.endpoint, cooldownLeft);
  }
  let r: FetchResponse;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    throw new MeListingsUpstreamError(
      opts.endpoint,
      0,
      (err as Error)?.message?.slice(0, 80) ?? 'network',
    );
  }
  if (r.status === 429) {
    const ra = parseRetryAfter(r.headers.get('Retry-After'));
    const retryAfter = ra ?? ME_COOLDOWN_DEFAULT_SEC;
    meCooldownUntilMs = Math.max(meCooldownUntilMs, Date.now() + retryAfter * 1000);
    throw new MeRateLimitError(opts.endpoint, retryAfter);
  }
  return r;
}

async function fetchListings(slug: string): Promise<MeListing[]> {
  const out: MeListing[] = [];
  let offset = 0;
  while (out.length < SCAN_LIMIT_MAX) {
    const endpoint = `/collections/${slug}/listings`;
    const url = `${ME_API_BASE}/collections/${encodeURIComponent(slug)}/listings?offset=${offset}&limit=${LISTINGS_PAGE}`;
    // `meGet` throws on a live 429 (→ MeRateLimitError) and on
    // network / timeout failure (→ MeListingsUpstreamError). It does
    // NOT throw on non-429 4xx / 5xx response codes — those flow through
    // here so a 404 (slug typo) reads as "no listings" rather than as
    // an outage, while a 5xx still triggers the offset===0 throw below.
    const r = await meGet(url, { endpoint, timeoutMs: 6_000 });
    if (!r.ok) {
      // First-page upstream failure (5xx / parse glitch) is NOT "this
      // collection has no listings" — it's a transient ME outage.
      // Throw so the route handler returns a structured error and we
      // don't cache / persist a misleading zero-listings result.
      // Without this throw, a single ME hiccup poisons:
      //   - the in-memory cache for 45 s (every client click sees zeros)
      //   - the frontend's localStorage permanently (zero state persists
      //     across reloads until the next successful scan)
      // Subsequent-page failures keep whatever we already paged in —
      // partial results are still useful and we shouldn't bin them.
      if (offset === 0) {
        throw new MeListingsUpstreamError(endpoint, r.status, r.statusText || '');
      }
      break;
    }
    const page = await r.json() as MeListing[];
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < LISTINGS_PAGE) break;
    offset += LISTINGS_PAGE;
    await sleep(REQUEST_GAP_MS);
  }
  return out;
}

async function fetchOffersReceived(mint: string): Promise<MeOffer[]> {
  const endpoint = `/tokens/${mint}/offers_received`;
  const url = `${ME_API_BASE}/tokens/${encodeURIComponent(mint)}/offers_received?limit=20`;
  try {
    const r = await meGet(url, { endpoint, timeoutMs: 5_000 });
    if (!r.ok) return [];
    const data = await r.json() as MeOffer[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    // Mid-scan 429 must NOT be swallowed here: if we silently treat it
    // as "no offers" we'd cache a poisoned empty-offers result and the
    // frontend's localStorage would persist zeros indefinitely. Let it
    // propagate so the worker pool aborts and the route handler returns
    // ME_RATE_LIMITED to the user.
    if (err instanceof MeRateLimitError) throw err;
    return [];
  }
}

interface MeTokenInfo {
  mintAddress?:     string;
  owner?:           string;
  collection?:      string;
  listStatus?:      string;
  name?:            string;
  image?:           string;
}

/** One ME `/tokens/{mint}` lookup. Used by the debugMint path to decide
 *  whether to surface the targeted mint as listed/unlisted and to grab
 *  a name/image for the row. Errors return `null` so the caller can
 *  fall back gracefully. */
async function fetchTokenInfo(mint: string): Promise<MeTokenInfo | null> {
  const endpoint = `/tokens/${mint}`;
  try {
    const r = await meGet(`${ME_API_BASE}/tokens/${encodeURIComponent(mint)}`, {
      endpoint, timeoutMs: 5_000,
    });
    if (!r.ok) return null;
    return await r.json() as MeTokenInfo;
  } catch (err) {
    if (err instanceof MeRateLimitError) throw err;
    return null;
  }
}

// ─── Recent-activity candidate enumeration ────────────────────────────────
// Pages ME's `/collections/{slug}/activities` until either:
//   - blockTime crosses `cutoffSec` (the recent-activity horizon), OR
//   - we've fetched `maxPages` of 100-event pages, OR
//   - upstream returns a partial / empty page.
//
// Per row, we keep `tokenMint` only when:
//   - the event type is in ACTIVITY_MARKETPLACE_TYPES, AND
//   - blockTime is at or after the cutoff, AND
//   - tokenMint is a non-empty string.
// That filters mmm `poolUpdate` / pool `bid` (no tokenMint anyway) and
// anything outside the marketplace event whitelist.
//
// We also opportunistically remember the first `image` URL seen for each
// mint, so unlisted activity-derived rows can still render a thumbnail
// without needing a separate /tokens/{mint} call per candidate.
interface MeActivity {
  signature?: string;
  type?:      string;
  source?:    string;
  tokenMint?: string;
  blockTime?: number;
  image?:     string;
}

interface ActivityScanResult {
  /** Unique tokenMints harvested from marketplace events in window. */
  mints:             Set<string>;
  /** First image URL seen per mint, when an activity event carried one. */
  imageByMint:       Map<string, string>;
  /** Total events ME returned across all pages we walked (pre-filter). */
  activitiesScanned: number;
  pagesFetched:      number;
  /** True when we stopped because we hit `maxPages` while blockTime was
   *  still inside the requested horizon — i.e. coverage is partial. */
  coverageTruncated: boolean;
  /** Non-null when an upstream / parse error short-circuited the walk;
   *  caller pushes this onto the response `warnings` array. */
  warning:           string | null;
}

async function fetchActivityCandidateMints(
  slug:      string,
  cutoffSec: number,
  maxPages:  number,
): Promise<ActivityScanResult> {
  const mints       = new Set<string>();
  const imageByMint = new Map<string, string>();
  let pagesFetched      = 0;
  let activitiesScanned = 0;
  let coverageTruncated = false;
  let warning: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * ACTIVITY_PAGE_LIMIT;
    const endpoint = `/collections/${slug}/activities`;
    const url = `${ME_API_BASE}/collections/${encodeURIComponent(slug)}/activities?offset=${offset}&limit=${ACTIVITY_PAGE_LIMIT}`;
    let rows: MeActivity[] = [];
    try {
      const r = await meGet(url, { endpoint, timeoutMs: ACTIVITY_FETCH_TIMEOUT_MS });
      if (!r.ok) {
        warning = `activities_upstream_${r.status} at offset=${offset}`;
        break;
      }
      const body = await r.json();
      rows = Array.isArray(body) ? body as MeActivity[] : [];
    } catch (err) {
      // 429 propagates so the scan short-circuits with a structured
      // ME_RATE_LIMITED response (the cooldown is already set by meGet).
      // Activity-page generic upstream / timeout becomes a warning.
      if (err instanceof MeRateLimitError) throw err;
      warning = `activities_fetch_failed at offset=${offset}: ${(err as Error).message?.slice(0, 80) ?? 'unknown'}`;
      break;
    }
    if (rows.length === 0) break;          // exhausted
    pagesFetched++;
    activitiesScanned += rows.length;

    let lastBlockTime = 0;
    for (const row of rows) {
      const bt = typeof row.blockTime === 'number' ? row.blockTime : 0;
      if (bt > 0) lastBlockTime = bt;
      // blockTime may be older than the cutoff on this row even though
      // earlier rows in the same page were inside the window — keep
      // scanning the rest of the page but don't add this one.
      if (bt > 0 && bt < cutoffSec) continue;
      if (!row.type || !ACTIVITY_MARKETPLACE_TYPES.has(row.type)) continue;
      const mint = row.tokenMint;
      if (typeof mint !== 'string' || mint.length === 0) continue;
      mints.add(mint);
      if (typeof row.image === 'string' && row.image.length > 0 && !imageByMint.has(mint)) {
        imageByMint.set(mint, row.image);
      }
    }
    // Activities feed is newest-first → once the last row of a page is
    // older than the cutoff, every subsequent page is too. Stop early.
    if (lastBlockTime > 0 && lastBlockTime < cutoffSec) break;
    if (rows.length < ACTIVITY_PAGE_LIMIT)              break;   // last page
    await sleep(REQUEST_GAP_MS);
  }
  if (warning === null && pagesFetched === maxPages) {
    // We exited because we hit the page cap, not because we reached the
    // cutoff or ran out of pages. Coverage is shorter than the requested
    // horizon — the operator should know.
    coverageTruncated = true;
  }
  return { mints, imageByMint, activitiesScanned, pagesFetched, coverageTruncated, warning };
}

interface RunScanOpts {
  slug:                string;
  scanLimit:           number;
  minOfferSol:         number;
  recentActivityDays:  number;
  activityMaxPages:    number;
  /** Optional verification mint. When provided, force-fetch
   *  `/tokens/{debugMint}` + `/tokens/{debugMint}/offers_received` and
   *  ensure the mint appears in `withOffers` regardless of whether the
   *  activity scan caught it. Diagnostic / dev only — no UI surface
   *  required. */
  debugMint?:          string | null;
}

async function runScan(opts: RunScanOpts): Promise<ScanResult> {
  const { slug, scanLimit, minOfferSol, recentActivityDays, activityMaxPages, debugMint } = opts;
  const scanStartedAt = Date.now();
  const warnings: string[] = [];
  const listings = await fetchListings(slug);
  const sliced   = listings.slice(0, scanLimit);
  const out: ScanRow[] = [];
  /** Mints we've already emitted a row for. Lets the unlisted/holder
   *  path and the debugMint path each dedupe against the listed scan
   *  and against each other. */
  const emittedMints = new Set<string>();

  const nowSec = Math.floor(Date.now() / 1000);
  let totalFetched   = 0;
  let totalAvailable = 0;

  // Per-listing handler — extracted from the original sequential loop
  // body so a worker pool can run several in parallel. Body, ordering of
  // checks, and emitted row shape are unchanged; only the surrounding
  // dispatch is concurrent. Mutations to `out` / `totalFetched` /
  // `totalAvailable` are safe because Node's event loop serializes them.
  const processListing = async (l: MeListing): Promise<void> => {
    const mint = l.tokenMint ?? l.tokenAddress;
    if (!mint || typeof l.price !== 'number') return;

    const offers = await fetchOffersReceived(mint);
    if (offers.length === 0) return;
    // Pace only between mints that actually carry an offer to process —
    // empty mints don't add ME load, so no need to throttle them. Real
    // offer-processing calls below still see the gap between iterations
    // (per worker — the pool naturally interleaves across both workers).
    await sleep(REQUEST_GAP_MS);
    if (offers[0]) maybeLogSampleKeys(offers[0]);

    // Keep ALL priced offers; classify status per spec. Best-of-listing
    // is picked by (status rank, price desc) so an AVAILABLE offer
    // always beats EXPECTED, which always beats EXPIRED — within a
    // status tier we still prefer the highest price.
    const priced = offers
      .filter(o => typeof o.price === 'number' && (o.price as number) > 0)
      .map(o => ({ offer: o, status: classifyOfferStatus(o, nowSec) }))
      .sort((a, b) => {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        if (ra !== rb) return ra - rb;
        return (b.offer.price as number) - (a.offer.price as number);
      });

    totalFetched   += offers.length;
    totalAvailable += priced.filter(p => p.status === 'AVAILABLE').length;

    if (priced.length === 0) return;

    const best       = priced[0].offer;
    const bestStatus = priced[0].status;
    const bestPrice  = best.price as number;
    if (bestPrice < minOfferSol) return;

    // Pick whichever timestamp field ME actually populated — see
    // extractCreatedAt for the full alias list and ms→s normalisation.
    // ME's `offers_received` historically has shipped ZERO timestamp
    // fields, so this nearly always returns null and we fall back to
    // the on-chain creation-tx lookup below.
    const createdAt = extractCreatedAt(best);

    // Synthetic fallback keys must NOT include price — the same buyer
    // adjusting their bid would otherwise produce a fresh ID and trip
    // the frontend's NEW-badge "new offer" check. Use auctionHouse to
    // disambiguate when the same buyer holds offers across markets.
    const bestOfferId = best.pdaAddress
      ?? `${mint}:${best.buyer ?? '?'}:${best.auctionHouse ?? '?'}`;

    // Resolve the funding wallet (M2 buyer escrow) for THIS best offer.
    // Balance lookups are deferred to a single batched RPC after the
    // listing-loop completes — see the resolveEscrowBalances() block
    // below — so the scanner makes O(unique buyers) RPC calls regardless
    // of how many listings the buyer has bid on.
    const auctionHouse = typeof best.auctionHouse === 'string' ? best.auctionHouse : null;
    const buyer        = typeof best.buyer        === 'string' ? best.buyer        : null;
    const fundingWallet = (auctionHouse && buyer)
      ? deriveBuyerEscrowPda(auctionHouse, buyer)
      : null;

    out.push({
      mint,
      nftName:            l.token?.name ?? null,
      imageUrl:           l.extra?.img ?? l.token?.image ?? null,
      listingPrice:       l.price,
      bestOfferPrice:     bestPrice,
      spreadSol:          bestPrice - l.price,
      listed:             true,
      bestOfferId,
      bestOfferStatus:    bestStatus,
      bestOfferCreatedAt: createdAt,
      fundingWallet,
      fundingBalanceSol:  null,        // populated post-loop in batched RPC pass
      fundingStatus:      'unknown',   // ditto
      meUrl:              `https://magiceden.io/item-details/${mint}`,
      tensorUrl:          `https://www.tensor.trade/item/${mint}`,
    });
    emittedMints.add(mint);
  };

  // Worker pool: SCAN_CONCURRENCY workers consume listings via a shared
  // index (mirror of `resolveOfferAges` at line ~173). The final sort
  // below is order-independent, so insertion order from concurrent
  // workers does not affect the result.
  let cursor = 0;
  const work = async (): Promise<void> => {
    while (cursor < sliced.length) {
      const idx = cursor++;
      await processListing(sliced[idx]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(SCAN_CONCURRENCY, sliced.length); w++) {
    workers.push(work());
  }
  await Promise.all(workers);

  // ── Recent-activity candidate scan for UNLISTED mints with active offers ──
  // The listed loop above only sees mints currently listed on ME, so an
  // unlisted NFT with a live personal offer (e.g. the bug example
  // AQGck2L… — owner unlisted, two future-dated offers) is invisible.
  // Bounded fix: page recent collection activities up to a time horizon
  // (`recentActivityDays`, default 30) AND a hard page cap
  // (`activityMaxPages`, default 20 ≈ 2 000 events) — whichever comes
  // first. Activity events that carry a `tokenMint` and a marketplace
  // type (list / delist / bid / cancelBid / acceptBid / buyNow) yield
  // candidate mints. For each candidate not already in the listings
  // set, we fetch /tokens/{mint}/offers_received and surface as an
  // UNLISTED row when there's a live offer.
  //
  // Every upstream failure is recorded as a warning, never silently
  // zeroed.
  const listedMintSet = new Set<string>();
  for (const l of listings) {
    const m = l.tokenMint ?? l.tokenAddress;
    if (typeof m === 'string') listedMintSet.add(m);
  }
  let activitiesScanned      = 0;
  let activityCandidateMints = 0;
  let unlistedWithOffers     = 0;
  if (activityMaxPages > 0 && recentActivityDays > 0) {
    const cutoffSec = nowSec - (recentActivityDays * 86_400);
    const actStart  = Date.now();
    const act = await fetchActivityCandidateMints(slug, cutoffSec, activityMaxPages);
    activitiesScanned      = act.activitiesScanned;
    activityCandidateMints = act.mints.size;
    if (act.warning) warnings.push(act.warning);
    if (act.coverageTruncated) {
      warnings.push(
        `activity_coverage_truncated: hit page cap (${activityMaxPages} pages × ${ACTIVITY_PAGE_LIMIT}) ` +
        `before reaching ${recentActivityDays}d horizon — coverage is partial`,
      );
    }
    console.log(
      `[tools/retardio-me-offer-scan/activities] slug=${slug} ` +
      `days=${recentActivityDays} pages=${act.pagesFetched}/${activityMaxPages} ` +
      `events=${act.activitiesScanned} candidates=${act.mints.size} ` +
      `truncated=${act.coverageTruncated} took=${Date.now() - actStart}ms`,
    );

    // Resolve activity candidates that aren't already covered by the
    // listed scan. We use the existing `fetchOffersReceived` and a
    // small worker pool (mirror of the listed pool) so multiple
    // candidates can fetch in flight without spamming ME. Each row
    // mirrors the listed-row shape but with listingPrice / spreadSol
    // null and listed=false.
    const candidates = [...act.mints].filter(m => !listedMintSet.has(m) && !emittedMints.has(m));
    let candCursor = 0;
    const candWork = async (): Promise<void> => {
      while (candCursor < candidates.length) {
        const idx  = candCursor++;
        const mint = candidates[idx];
        // Step 1 — cheap path: fetch only the offers. The token-info
        // call (added in ed994f7 inside a Promise.all here) is
        // deferred to the post-guard block below so candidates that
        // drop out (no offers / no priced / below threshold) never
        // pay for it. Restores the pre-ed994f7 per-worker burst rate.
        const offers = await fetchOffersReceived(mint);
        await sleep(REQUEST_GAP_MS);
        if (offers.length === 0) continue;
        if (offers[0]) maybeLogSampleKeys(offers[0]);
        const priced = offers
          .filter(o => typeof o.price === 'number' && (o.price as number) > 0)
          .map(o => ({ offer: o, status: classifyOfferStatus(o, nowSec) }))
          .sort((a, b) => {
            const ra = statusRank(a.status);
            const rb = statusRank(b.status);
            if (ra !== rb) return ra - rb;
            return (b.offer.price as number) - (a.offer.price as number);
          });
        totalFetched   += offers.length;
        totalAvailable += priced.filter(p => p.status === 'AVAILABLE').length;
        if (priced.length === 0) continue;
        const best       = priced[0].offer;
        const bestStatus = priced[0].status;
        const bestPrice  = best.price as number;
        if (bestPrice < minOfferSol) continue;
        const createdAt = extractCreatedAt(best);
        const bestOfferId = best.pdaAddress
          ?? `${mint}:${best.buyer ?? '?'}:${best.auctionHouse ?? '?'}`;
        const auctionHouse = typeof best.auctionHouse === 'string' ? best.auctionHouse : null;
        const buyer        = typeof best.buyer        === 'string' ? best.buyer        : null;
        const fundingWallet = (auctionHouse && buyer)
          ? deriveBuyerEscrowPda(auctionHouse, buyer)
          : null;
        // Step 2 — confirmed-emit path: only now does this candidate
        // earn the token-info fetch. ≤1 extra ME call per emitted row
        // instead of ≤1 per candidate.
        const info = await fetchTokenInfo(mint);
        await sleep(REQUEST_GAP_MS);
        out.push({
          mint,
          // /tokens/{mint}.name (e.g. "#4058") fuels the frontend's
          // #<num> extraction. Null when the token-info fetch failed —
          // UI degrades via its own fallback chain.
          nftName:            info?.name ?? null,
          imageUrl:           info?.image ?? act.imageByMint.get(mint) ?? null,
          listingPrice:       null,
          bestOfferPrice:     bestPrice,
          spreadSol:          null,
          listed:             false,
          bestOfferId,
          bestOfferStatus:    bestStatus,
          bestOfferCreatedAt: createdAt,
          fundingWallet,
          fundingBalanceSol:  null,
          fundingStatus:      'unknown',
          meUrl:              `https://magiceden.io/item-details/${mint}`,
          tensorUrl:          `https://www.tensor.trade/item/${mint}`,
        });
        emittedMints.add(mint);
        unlistedWithOffers++;
      }
    };
    const candWorkers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(SCAN_CONCURRENCY, candidates.length); w++) {
      candWorkers.push(candWork());
    }
    await Promise.all(candWorkers);
    console.log(
      `[tools/retardio-me-offer-scan/activity-rows] candidates=${candidates.length} ` +
      `unlistedRows=${unlistedWithOffers}`,
    );
  }

  // ── Optional debugMint verification path ─────────────────────────────
  // When ?debugMint=<mint> is supplied, ALWAYS pull that mint's offers
  // directly via /tokens/{mint}/offers_received and its token info via
  // /tokens/{mint}, regardless of whether it surfaced through the
  // listed scan or the holder scan. This is the diagnostic escape hatch
  // for mints whose owner falls outside the top-N holder cap (e.g. a
  // wallet that holds exactly 1 NFT in the collection).
  if (debugMint) {
    if (emittedMints.has(debugMint)) {
      console.log(`[tools/retardio-me-offer-scan/debug] mint=${debugMint} already emitted (listed or holder path)`);
    } else {
      const [info, mintOffers] = await Promise.all([
        fetchTokenInfo(debugMint),
        fetchOffersReceived(debugMint),
      ]);
      if (!info) warnings.push(`debug_mint_token_info_failed: /tokens/${debugMint} upstream error`);
      if (mintOffers.length === 0) {
        warnings.push(`debug_mint_no_offers: /tokens/${debugMint}/offers_received returned 0 offers`);
      }
      if (mintOffers[0]) maybeLogSampleKeys(mintOffers[0]);
      const priced = mintOffers
        .filter(o => typeof o.price === 'number' && (o.price as number) > 0)
        .map(o => ({ offer: o, status: classifyOfferStatus(o, nowSec) }))
        .sort((a, b) => {
          const ra = statusRank(a.status);
          const rb = statusRank(b.status);
          if (ra !== rb) return ra - rb;
          return (b.offer.price as number) - (a.offer.price as number);
        });
      totalFetched   += mintOffers.length;
      totalAvailable += priced.filter(p => p.status === 'AVAILABLE').length;
      if (priced.length > 0) {
        const best       = priced[0].offer;
        const bestStatus = priced[0].status;
        const bestPrice  = best.price as number;
        const isListed   = info?.listStatus === 'listed';
        // Note: debugMint deliberately ignores `minOfferSol` so the
        // operator always sees the target mint when the param is set —
        // it's a verification probe, not a filtered scan result.
        const createdAt = extractCreatedAt(best);
        const bestOfferId = best.pdaAddress
          ?? `${debugMint}:${best.buyer ?? '?'}:${best.auctionHouse ?? '?'}`;
        const auctionHouse = typeof best.auctionHouse === 'string' ? best.auctionHouse : null;
        const buyer        = typeof best.buyer        === 'string' ? best.buyer        : null;
        const fundingWallet = (auctionHouse && buyer)
          ? deriveBuyerEscrowPda(auctionHouse, buyer)
          : null;
        out.push({
          mint:               debugMint,
          nftName:            info?.name ?? null,
          imageUrl:           info?.image ?? null,
          listingPrice:       null,           // debugMint path doesn't know the listing price; even if listed, ME's token endpoint doesn't return it
          bestOfferPrice:     bestPrice,
          spreadSol:          null,
          listed:             isListed,
          bestOfferId,
          bestOfferStatus:    bestStatus,
          bestOfferCreatedAt: createdAt,
          fundingWallet,
          fundingBalanceSol:  null,
          fundingStatus:      'unknown',
          meUrl:              `https://magiceden.io/item-details/${debugMint}`,
          tensorUrl:          `https://www.tensor.trade/item/${debugMint}`,
        });
        emittedMints.add(debugMint);
        if (!isListed) unlistedWithOffers++;
        console.log(
          `[tools/retardio-me-offer-scan/debug] mint=${debugMint} listed=${isListed} ` +
          `offers=${mintOffers.length} best=${bestPrice} status=${bestStatus}`,
        );
      }
    }
  }

  // ── Age backfill via on-chain bid PDA history ─────────────────────────
  // For rows whose `bestOfferStatus` is AVAILABLE or EXPECTED and where
  // ME didn't ship a timestamp, derive the bid creation time from the
  // offer's pdaAddress. EXPIRED is intentionally skipped (the user's
  // workflow doesn't act on expired bids and they may be numerous on
  // popular collections). Cached by pdaAddress for the process lifetime
  // so repeated scans of the same listing don't re-hit RPC.
  const pdasToResolve: string[] = [];
  for (const row of out) {
    if (row.bestOfferCreatedAt != null)        continue;
    if (row.bestOfferStatus === 'EXPIRED')     continue;
    // bestOfferId is the pdaAddress when ME provided one; the synthetic
    // fallback contains ':' so it's easy to discriminate.
    if (row.bestOfferId.includes(':'))         continue;
    pdasToResolve.push(row.bestOfferId);
  }
  if (pdasToResolve.length > 0) {
    const ageStarted = Date.now();
    const ages = await resolveOfferAges(pdasToResolve);
    for (const row of out) {
      if (row.bestOfferCreatedAt == null && ages.has(row.bestOfferId)) {
        row.bestOfferCreatedAt = ages.get(row.bestOfferId)!;
      }
    }
    console.log(
      `[tools/retardio-me-offer-scan/age] resolved=${ages.size}/` +
      `${pdasToResolve.length} cached=${offerAgeCache.size} ` +
      `miss=${offerAgeMissCache.size} took=${Date.now() - ageStarted}ms`,
    );
  }

  // ── Bidder escrow funding check ───────────────────────────────────────
  // For every row whose best offer resolved a funding wallet, batch a
  // single getMultipleAccounts RPC call (deduped by PDA) to fetch
  // lamport balances. The 60 s cache in me-bid-escrow.ts means repeated
  // scans of the same collection within a minute reuse balances and
  // issue zero RPC calls; a fresh scan after expiry typically issues
  // ONE chunked call regardless of row count. We then classify each
  // row's funding status against its own offer price — rows are NEVER
  // dropped based on funding (per spec), only labeled.
  const uniqueWallets = [...new Set(
    out.map(r => r.fundingWallet).filter((w): w is string => !!w),
  )];
  let funded = 0, low = 0, empty = 0, unknown = 0;
  let rpcCalls = 0;
  if (uniqueWallets.length > 0) {
    const { balances, rpcCalls: nCalls } = await resolveEscrowBalances(uniqueWallets);
    rpcCalls = nCalls;
    for (const row of out) {
      if (!row.fundingWallet) { unknown++; continue; }
      const lamports = balances.get(row.fundingWallet) ?? null;
      const status   = classifyFundingStatus(lamports, row.bestOfferPrice);
      row.fundingBalanceSol = lamportsToSol(lamports);
      row.fundingStatus     = status;
      if      (status === 'funded')      funded++;
      else if (status === 'low_balance') low++;
      else if (status === 'empty')       empty++;
      else                               unknown++;
    }
  } else {
    // No resolvable wallets — every row stays at the row-level
    // 'unknown' default. Still emit the summary line so monitoring
    // can spot scans that produced zero funding signal.
    unknown = out.length;
  }
  console.log(
    `[offers/funding] wallets=${uniqueWallets.length} rpc=${rpcCalls} ` +
    `funded=${funded} low=${low} empty=${empty} unknown=${unknown}`,
  );

  // Default order:
  //   1. listed rows before unlisted rows (frontend mirrors this, but
  //      we set it here so non-browser callers also get the ordering)
  //   2. within each group, status priority (AVAILABLE > EXPECTED > EXPIRED)
  //   3. then highest best-offer price
  //   4. then highest spread (listed rows only — unlisted spreadSol is null
  //      and is treated as 0 for tie-break, which keeps the sort stable)
  out.sort((a, b) => {
    if (a.listed !== b.listed) return a.listed ? -1 : 1;
    const ra = statusRank(a.bestOfferStatus);
    const rb = statusRank(b.bestOfferStatus);
    if (ra !== rb) return ra - rb;
    const priceDiff = b.bestOfferPrice - a.bestOfferPrice;
    if (priceDiff !== 0) return priceDiff;
    return (b.spreadSol ?? 0) - (a.spreadSol ?? 0);
  });

  return {
    ok:                     true,
    slug,
    scanned:                sliced.length,
    listedTotal:            listings.length,
    offersFetched:          totalFetched,
    offersAvailable:        totalAvailable,
    activitiesScanned,
    activityCandidateMints,
    listedCandidateMints:   listedMintSet.size,
    unlistedWithOffers,
    withOffers:             out,
    warnings,
    tookMs:                 Date.now() - scanStartedAt,
    cachedAt:               Date.now(),
    ttlMs:                  CACHE_TTL_MS,
  };
}

export function createRetardioOffersRouter(): Router {
  const router = Router();
  // Manual tool — coarse rate limit (one full scan ~10 s, cap clicks at
  // 6/min/wallet so a stuck button doesn't drain ME credits).
  const limit = rateLimit({ limit: 6, windowMs: 60_000, label: 'tools/retardio-me-offer-scan' });

  router.post('/tools/retardio-me-offer-scan', limit, requireAuth, async (req: Request, res: Response) => {
    const slug        = (req.body?.slug as string)        || DEFAULT_SLUG;
    const minOfferSol = Math.max(0, Number(req.body?.minOfferSol ?? 0));
    const scanLimit   = Math.min(SCAN_LIMIT_MAX, Math.max(1, Number(req.body?.limit ?? SCAN_LIMIT_DFLT)));
    const recentActivityDays = Math.min(
      RECENT_ACTIVITY_DAYS_MAX,
      Math.max(0, Math.floor(Number(req.body?.recentActivityDays ?? RECENT_ACTIVITY_DAYS_DFLT))),
    );
    const activityMaxPages = Math.min(
      ACTIVITY_MAX_PAGES_MAX,
      Math.max(0, Math.floor(Number(req.body?.activityMaxPages ?? ACTIVITY_MAX_PAGES_DFLT))),
    );
    // debugMint is a base58-ish address; trim, length-cap, and reject
    // anything that isn't a plausible mint string before forwarding it.
    // Keeps the diagnostic param from being abused as an arbitrary
    // /tokens/<x> probe.
    const rawDebug = typeof req.body?.debugMint === 'string' ? req.body.debugMint.trim() : '';
    const debugMint = (rawDebug.length >= 32 && rawDebug.length <= 64 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(rawDebug))
      ? rawDebug
      : null;
    // Cache key includes every dimension that can change the result —
    // crucially recentActivityDays / activityMaxPages / debugMint so a
    // tuned scan doesn't poison the default scan's cache and vice-versa.
    const cacheKey    = `${slug}|${minOfferSol}|${scanLimit}|d=${recentActivityDays}|p=${activityMaxPages}|dbg=${debugMint ?? ''}`;

    if (cached && cached.key === cacheKey && Date.now() - cached.result.cachedAt < CACHE_TTL_MS) {
      return res.json({ ...cached.result, fromCache: true });
    }

    // Pre-flight ME cooldown gate. If a previous scan (any slug) saw
    // a 429 from ME and the published cooldown hasn't elapsed yet, every
    // ME call we'd make in this scan is going to 429 too — ME limits per
    // IP, not per slug. Short-circuit with ME_RATE_LIMITED so the user
    // sees a precise countdown immediately instead of waiting 5–10 s for
    // runScan to start, hit ME, get rate-limited, and fail the same way.
    {
      const cooldownLeft = getMeCooldownRemainingSec();
      if (cooldownLeft > 0) {
        return res.status(503).json({
          ok:            false,
          errorCode:     'ME_RATE_LIMITED',
          message:       `Magic Eden rate limited — retry in ${cooldownLeft}s`,
          retryAfterSec: cooldownLeft,
        });
      }
    }

    const startedAt = Date.now();
    try {
      const result = await runScan({ slug, scanLimit, minOfferSol, recentActivityDays, activityMaxPages, debugMint });
      cached = { key: cacheKey, result };
      console.log(
        `[tools/retardio-me-offer-scan] slug=${slug} scanned=${result.scanned} ` +
        `withOffers=${result.withOffers.length} listed=${result.listedCandidateMints} ` +
        `unlisted=${result.unlistedWithOffers} activities=${result.activitiesScanned} ` +
        `actCandidates=${result.activityCandidateMints} debug=${debugMint ?? '-'} ` +
        `offersFetched=${result.offersFetched} offersAvailable=${result.offersAvailable} ` +
        `warnings=${result.warnings.length} took=${result.tookMs}ms (handler=${Date.now() - startedAt}ms)`,
      );
      return res.json({ ...result, fromCache: false });
    } catch (err) {
      // Transient ME listings outage → 503 with a structured payload the
      // frontend can render as a friendly "try again in a minute" amber
      // notice (instead of the raw `HTTP 500 — {"ok":false,...}` blob).
      // The cache is intentionally NOT updated so the next click after
      // ME recovers does a real scan.
      if (err instanceof MeRateLimitError) {
        const cooldownLeft = getMeCooldownRemainingSec() || err.retryAfterSec;
        console.warn(
          `[tools/retardio-me-offer-scan] ME rate-limited at ${err.endpoint} ` +
          `slug=${slug} retryAfter=${cooldownLeft}s`,
        );
        return res.status(503).json({
          ok:            false,
          errorCode:     'ME_RATE_LIMITED',
          message:       `Magic Eden rate limited — retry in ${cooldownLeft}s`,
          retryAfterSec: cooldownLeft,
        });
      }
      if (err instanceof MeListingsUpstreamError) {
        console.warn(
          `[tools/retardio-me-offer-scan] upstream ${err.upstreamStatus} ` +
          `at ${err.endpoint} (${err.upstreamStatusText}) slug=${slug}`,
        );
        // Distinguish timeout / network (status === 0) from a real 5xx so
        // the frontend can render slightly different copy. Both reuse the
        // ME_LISTINGS_UPSTREAM code — they're the same actionable state
        // for the operator ("ME is unhealthy, wait and retry") — but the
        // payload carries the underlying status for diagnostics.
        const isTimeout = err.upstreamStatus === 0;
        return res.status(503).json({
          ok:                false,
          errorCode:         'ME_LISTINGS_UPSTREAM',
          message:           isTimeout
            ? 'Magic Eden listings API timed out. Try again in a minute.'
            : 'Magic Eden listings API temporarily unavailable. Try again in a minute.',
          upstreamStatus:     err.upstreamStatus,
          upstreamStatusText: err.upstreamStatusText,
        });
      }
      console.error('[tools/retardio-me-offer-scan] error', err);
      return res.status(500).json({ ok: false, error: 'scan failed' });
    }
  });

  return router;
}
