/**
 * In-memory listings state engine.
 *
 * Before: `/collections/listings` re-fetched ME + MMM + Tensor on every
 * request (30 s per-(slug,limit) response cache). No persistence across
 * collections. MMM per-NFT prices were all equal to `spotPrice` because the
 * bonding curve wasn't applied.
 *
 * Now: a single process-wide `Map<id, Listing>` holds normalized per-NFT
 * rows from every source. Per-slug indexes make `getByCollection(slug)` O(1)
 * on the hot path. A per-slug TTL drives a **scoped** refresh — only that
 * slug's rows are replaced — so the store accumulates data across
 * collections and is reconciled incrementally by sale-event removals
 * between snapshots.
 *
 * Sources covered (same as before, but normalized through one schema):
 *   - ME direct  (auction-house escrow listings)
 *   - MMM pools  (sell_sided / two_sided — one Listing per held mint)
 *   - Tensor     (requires TENSOR_API_KEY — no-op otherwise)
 *
 * Not yet covered — requires ingestion refactor, deferred by rule:
 *   - On-chain LIST / CANCEL / POOL_UPDATE events. The existing ingestion
 *     pipeline only emits `sale`. Those three transitions are reconciled by
 *     the scoped snapshot refresh rather than per-event.
 */

import { saleEventBus } from '../events/emitter';
import { SaleEvent } from '../models/sale-event';
import { getPool } from '../db/client';
import { isSlugHot } from './subscribers';
import { meAuthHeaders } from '../me-api-cooldown';
import { recordFirstListedAtObservation, type ListingTimeQuality } from '../analytics/mint-lifecycle';
import { TtlCache } from '../enrichment/cache';
import { getCatalogEntry } from './collection-catalog';

export type ListingSource = 'ME' | 'MMM' | 'TENSOR';
export type ListingType   = 'listing' | 'pool';

export interface Listing {
  /** Stable unique id.
   *   ME      → `ME:${mint}:${seller}`
   *   MMM     → `MMM:${poolKey}:${mint}` (pool can hold many mints)
   *   TENSOR  → `TENSOR:${mint}:${seller}`
   */
  id:           string;
  mint:         string;
  priceSol:     number;
  source:       ListingSource;
  type:         ListingType;
  seller:       string;
  /** Collection slug (me_collection_slug) — scope for per-collection queries. */
  slug:         string;
  /** Fields below are pass-through for the legacy API adapter. */
  auctionHouse: string;
  tokenAta:     string;
  rank:         number | null;
  /** Epoch ms when the listing was created on-chain. Null when unavailable. */
  listedAt:     number | null;
  /** Provenance of `listedAt`, for mint-lifecycle's durable first-listing
   *  record (src/analytics/mint-lifecycle.ts): 'exact' when it came from a
   *  real list-transaction timestamp (ME `/activities?type=list` or
   *  Tensor's `listing.txAt`), 'approximate' when it's ME's buyNow-fallback
   *  surrogate for pool-hosted listings, null when `listedAt` itself is
   *  null. Not surfaced on the legacy wire adapter (`toWire`) — internal to
   *  this store and its mint-lifecycle consumer only. */
  listedAtQuality?: ListingTimeQuality | null;
  /** NFT item name from ME's `token.name` (often just `"#4101"`). Null for
   *  sources without an upstream name field (MMM pool rows). */
  nftName:      string | null;
  /** NFT thumbnail URL from ME's `extra.img` / `token.image`. Null when
   *  unavailable. */
  imageUrl:     string | null;
}

// ─── Core store ──────────────────────────────────────────────────────────────

const byId         = new Map<string, Listing>();
const byCollection = new Map<string, Set<string>>(); // slug    → id set
const byMint       = new Map<string, Set<string>>(); // mint    → id set
const byPoolKey    = new Map<string, Set<string>>(); // poolKey → slug set (MMM)
const lastFetch    = new Map<string, number>();       // slug    → epoch ms
const lastTouch    = new Map<string, number>();       // slug    → epoch ms (read/open activity)
const inFlight     = new Map<string, Promise<void>>(); // slug   → in-flight fetch

const DEFAULT_TTL_MS    = 30_000;
/** Keep a slug's rows in memory this long after the last read/refresh before
 *  the GC sweep evicts them. Covers tab-switch / brief back-nav flows
 *  without forcing a cold fetch. */
const WARM_TTL_MS       = 5 * 60_000;
const GC_INTERVAL_MS    = 60_000;
/** Debounce window for dirty-triggered reconciliation — multiple markDirty()
 *  calls within this window collapse into a single refresh per slug. */
const DIRTY_DEBOUNCE_MS = 10_000;
/** Upper bound on concurrent external snapshot fetches across all slugs —
 *  prevents a burst of freshly-opened tabs from hammering ME/Tensor/MMM. */
const MAX_CONCURRENT_SNAPSHOTS = 2;
/** Soft cap on the long-lived mint→slug reverse index. Bounded so a
 *  long-running process can't grow unbounded as it ingests millions of
 *  sales. FIFO eviction — older associations fall out first. */
const MINT_TO_SLUG_MAX  = 50_000;

// ─── Mint suppression (sold + delisted) ──────────────────────────────────────
// onSale / onListingConfirmedDelist remove a mint's listings immediately, but
// the next scoped snapshot can RE-ADD it because ME/MMM listing APIs lag the
// chain by minutes (they still report the just-sold/just-cancelled NFT as
// listed). We hold a short TTL set of recently-removed mints and skip re-adding
// them during snapshot apply, so they can't reappear as buyable until upstream
// catches up. Authoritative signal = our own on-chain `sale` / confirmed-delist
// events. Env override `LISTINGS_SOLD_SUPPRESS_TTL_MS` (kept for back-compat).
const SUPPRESS_TTL_MS = (() => {
  const raw = parseInt((process.env.LISTINGS_SOLD_SUPPRESS_TTL_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
})();
type SuppressReason = 'sold' | 'delisted';
const suppressedAt = new Map<string, { at: number; reason: SuppressReason }>(); // mint → {at, reason}

/** Record a mint as recently sold/delisted so a lagging snapshot can't re-add
 *  it; opportunistic expiry sweep only when the map grows large (no timer). */
function markSuppressed(mint: string, reason: SuppressReason): void {
  const now = Date.now();
  suppressedAt.set(mint, { at: now, reason });
  if (suppressedAt.size > 5_000) {
    for (const [m, e] of suppressedAt) if (now - e.at >= SUPPRESS_TTL_MS) suppressedAt.delete(m);
  }
}

function indexAdd(m: Map<string, Set<string>>, key: string, id: string): void {
  let s = m.get(key);
  if (!s) { s = new Set(); m.set(key, s); }
  s.add(id);
}
function indexDel(m: Map<string, Set<string>>, key: string, id: string): void {
  const s = m.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) m.delete(key);
}

function add(l: Listing): void {
  // Suppress re-adding a recently sold/delisted mint: a lagging ME/MMM snapshot
  // can still report it as listed. Skip until the TTL expires (then clean the
  // entry opportunistically — no timer).
  const sup = suppressedAt.get(l.mint);
  if (sup !== undefined) {
    if (Date.now() - sup.at < SUPPRESS_TTL_MS) {
      console.log(`[listings/suppress] skip reason=${sup.reason} mint=${l.mint.slice(0, 8)}… slug=${l.slug} source=${l.id.split(':')[0]}`);
      return;
    }
    suppressedAt.delete(l.mint);
  }
  byId.set(l.id, l);
  indexAdd(byCollection, l.slug, l.id);
  indexAdd(byMint,       l.mint, l.id);
  // Every snapshot row confirms a mint→slug association — persist it into
  // the long-lived index so it survives the mint later leaving `byMint`
  // (e.g. after sale or cancel reconciliation).
  recordMintSlug(l.mint, l.slug);
  // Index MMM pool membership so `listing_refresh_hint` can resolve a slug
  // from an `update_pool` tx (which has no token-balance delta → no mint
  // extractable from the receipt).
  if (l.source === 'MMM') {
    const poolKey = l.id.split(':')[1];
    if (poolKey) indexAdd(byPoolKey, poolKey, l.slug);
  }
  // Durable first-listing recording (mint-lifecycle Stage 3) — fire-and-
  // forget, no new ME/RPC request (this is a timestamp listings-store
  // already resolved as part of its own snapshot fetch). Only when a
  // listedAt was actually resolved; the write itself is idempotent/
  // monotonic (LEAST()-based upsert) so redundant calls across snapshot
  // refreshes are harmless, just unnecessary — recordFirstListedAtObservation
  // short-circuits those via its own in-process dedup set.
  if (l.listedAt != null) {
    void recordFirstListedAtObservation(l.mint, l.listedAt, l.listedAtQuality ?? 'unknown');
  }
}

function removeById(id: string): void {
  const l = byId.get(id);
  if (!l) return;
  byId.delete(id);
  indexDel(byCollection, l.slug, id);
  indexDel(byMint,       l.mint, id);
  if (l.source === 'MMM') {
    const poolKey = l.id.split(':')[1];
    if (poolKey) indexDel(byPoolKey, poolKey, l.slug);
  }
}

/**
 * Replace every stored row for `slug` with `listings`. Scoped — other slugs
 * and index entries are untouched. Used after a fresh snapshot fetch.
 */
function replaceCollection(slug: string, listings: Listing[]): void {
  const ids = byCollection.get(slug);
  if (ids) {
    for (const id of Array.from(ids)) removeById(id);
  }
  for (const l of listings) add(l);
}

// ─── Activity tracking + GC sweep ────────────────────────────────────────────
//
// Each read or refresh for a slug bumps `lastTouch`. The GC sweep evicts any
// slug whose lastTouch is older than WARM_TTL_MS — warm-then-cold lifecycle
// without explicit open/close signals from the frontend.

function touch(slug: string): void {
  lastTouch.set(slug, Date.now());
}

function evictSlug(slug: string): void {
  const ids = byCollection.get(slug);
  if (ids) {
    for (const id of Array.from(ids)) removeById(id);
  }
  byCollection.delete(slug);
  lastTouch.delete(slug);
  lastFetch.delete(slug);
}

setInterval(() => {
  const now = Date.now();
  for (const [slug, t] of lastTouch) {
    if (now - t > WARM_TTL_MS) evictSlug(slug);
  }
}, GC_INTERVAL_MS).unref();

// ─── Snapshot-fetch rate limit (simple semaphore) ────────────────────────────
//
// Per-slug coalescing (`inFlight`) already prevents duplicate concurrent
// fetches for the same slug. This cap bounds *total* concurrent external
// snapshot calls across all slugs so opening three collections at once
// can't trigger three parallel ME+MMM+Tensor fan-outs.

let snapshotsInFlight = 0;
const snapshotQueue: Array<() => void> = [];

function acquireSnapshotSlot(): Promise<() => void> {
  return new Promise(resolve => {
    const release = () => {
      snapshotsInFlight--;
      const next = snapshotQueue.shift();
      if (next) next();
    };
    const start = () => {
      snapshotsInFlight++;
      resolve(release);
    };
    if (snapshotsInFlight < MAX_CONCURRENT_SNAPSHOTS) start();
    else snapshotQueue.push(start);
  });
}

// ─── Dirty flag + debounced reconciliation ───────────────────────────────────
//
// When a delta cannot be derived safely (e.g. a new listing event type that
// ingestion doesn't yet parse), callers can signal `markDirty(slug)` instead
// of forcing a refresh. Multiple markDirty calls within the debounce window
// coalesce into one refresh per slug — no spam.

const dirtySlugs = new Set<string>();
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;

export function markDirty(slug: string): void {
  dirtySlugs.add(slug);
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(async () => {
    dirtyTimer = null;
    const slugs = Array.from(dirtySlugs);
    dirtySlugs.clear();
    for (const s of slugs) {
      try { await ensureFresh(s, 0); } catch { /* swallow */ }
    }
  }, DIRTY_DEBOUNCE_MS);
}

// ─── Wire-format helper (duplicates shape in collection-listings.ts) ─────────
//
// Kept here so the store can emit snapshot deltas without taking a
// circular import on the adapter. Identical to `toListingOut` semantically.
function toWire(l: Listing) {
  return {
    id:           l.id,
    mint:         l.mint,
    seller:       l.seller,
    auctionHouse: l.auctionHouse,
    priceSol:     l.priceSol,
    tokenAta:     l.tokenAta,
    rank:         l.rank,
    marketplace:  l.source === 'TENSOR' ? 'tensor' as const : 'me' as const,
    listedAt:     l.listedAt,
    nftName:      l.nftName,
    imageUrl:     l.imageUrl,
  };
}

// ─── Live updates from the sale-event bus ────────────────────────────────────
//
// The only ingestion transition we can react to without touching ingestion
// code is `sale`: an NFT that sold can no longer be listed, so any row we
// hold for that mint (across all sources) is stale and must be removed.
//
// Side-effect registration on module load is intentional — the store becomes
// reactive as soon as `collection-listings.ts` imports it; no app-init wiring
// required.

saleEventBus.onSale((event: SaleEvent) => {
  if (!event.mintAddress) return;
  // Record the sale FIRST (even when no live listing exists right now) so a
  // later lagging snapshot can't re-add this mint. See `add()` for the skip.
  markSuppressed(event.mintAddress, 'sold');
  const ids = byMint.get(event.mintAddress);
  if (!ids || ids.size === 0) return;
  // Snapshot each affected row's identity BEFORE removal, then emit one
  // id-based delta per row. Mint-wide removal is still the correct
  // behavior for sales (proof: after a confirmed sale the NFT is in the
  // buyer's wallet, so every escrow/pool listing for that mint is stale),
  // but fanning out per-id keeps the wire format uniform with
  // cancel/delist/withdraw transitions where mint-wide removal is NOT
  // correct (e.g. ME direct cancel doesn't invalidate a sibling MMM pool
  // entry for the same mint).
  const targets: Array<{ slug: string; id: string }> = [];
  for (const id of Array.from(ids)) {
    const l = byId.get(id);
    if (l) targets.push({ slug: l.slug, id });
    removeById(id);
  }
  for (const t of targets) saleEventBus.emitListingRemove(t);
});

// ─── Long-lived mint → slug reverse index ────────────────────────────────────
//
// Complements `byMint` (which only holds mints with currently-live listings).
// Populated from two free sources of truth:
//   1. Every snapshot `add(l)` — the listing itself carries slug.
//   2. `saleEventBus.onMetaUpdate` — post-enrichment mint→slug resolution
//      for sold NFTs.
//
// Used only by `markMintDirty` when `byMint` misses, so a new listing for a
// mint we're not actively tracking can still trigger reconciliation IF we've
// previously seen that mint (via sale or prior snapshot) AND the slug is
// currently warm. Brand-new mints from never-seen collections still fall
// through to the 5-min frontend reconciliation fallback — deliberate.
//
// FIFO-bounded so a long-running process doesn't grow this unboundedly.

const mintToSlug      = new Map<string, string>();
const mintToSlugQueue: string[] = [];

function recordMintSlug(mint: string, slug: string): void {
  if (!mint || !slug) return;
  const existing = mintToSlug.get(mint);
  if (existing === slug) return;
  if (!existing) {
    mintToSlugQueue.push(mint);
    if (mintToSlugQueue.length > MINT_TO_SLUG_MAX) {
      const evict = mintToSlugQueue.shift();
      if (evict) mintToSlug.delete(evict);
    }
  }
  mintToSlug.set(mint, slug);
}

// Parallel mint→collectionName index. Same lifecycle/bounds as mint→slug.
// Lets the FIRST `sale` frame carry the human collection name (not just the
// slug) for any mint seen before — which is what the render-layer blacklist
// (user FEED list is keyed by NAME) and the backend pre-emit name gate need
// to drop a known blacklisted collection without the "paint then remove"
// flash. New (never-seen) mints still resolve only via enrichment.
const mintToName      = new Map<string, string>();
const mintToNameQueue: string[] = [];

function recordMintName(mint: string, name: string): void {
  if (!mint || !name) return;
  const existing = mintToName.get(mint);
  if (existing === name) return;
  if (!existing) {
    mintToNameQueue.push(mint);
    if (mintToNameQueue.length > MINT_TO_SLUG_MAX) {
      const evict = mintToNameQueue.shift();
      if (evict) mintToName.delete(evict);
    }
  }
  mintToName.set(mint, name);
}

// Meta-update carries the canonical mint→slug + mint→name pairing post-enrichment.
saleEventBus.onMetaUpdate((u) => {
  if (u.mintAddress && u.meCollectionSlug) recordMintSlug(u.mintAddress, u.meCollectionSlug);
  if (u.mintAddress && u.collectionName)   recordMintName(u.mintAddress, u.collectionName);
});

// One-time boot preload: sale_events already carries me_collection_slug for
// every row live ingestion or backfill has written. Without this preload the
// mint→slug index starts empty and list-event refresh hints silently drop
// for any mint whose collection hasn't yet produced a live sale in the
// current process lifetime — the case we reproduced on `retardio_cousins`
// where 383 active ME listings existed but new-list events had no slug
// resolution path, suppressing every listing_refresh_hint.
//
// Deferred 5 s so the DB pool has completed its SELECT 1 handshake. FIFO
// cap is enforced inside recordMintSlug.
setTimeout(() => {
  (async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ mint_address: string; me_collection_slug: string | null; collection_name: string | null }>(
        `SELECT DISTINCT mint_address, me_collection_slug, collection_name
         FROM sale_events
         WHERE (me_collection_slug IS NOT NULL OR collection_name IS NOT NULL)
           AND mint_address <> ''
         ORDER BY mint_address
         LIMIT ${MINT_TO_SLUG_MAX}`,
      );
      for (const r of rows) {
        if (r.me_collection_slug) recordMintSlug(r.mint_address, r.me_collection_slug);
        if (r.collection_name)    recordMintName(r.mint_address, r.collection_name);
      }
      console.log(`[listings-store] preloaded ${rows.length} mint→slug/name pairs from sale_events`);
    } catch (err) {
      console.error('[listings-store] mint→slug preload failed', err);
    }
  })();
}, 5_000).unref();

// ─── tx-mints-touched → debounced reconciliation ─────────────────────────────
//
// Fires when ingestion parses a program tx that wasn't a sale. Any NFT mint
// that appears in the tx AND currently has rows in our byMint index is a
// signal that the row's source (ME direct listing, MMM pool, Tensor listing)
// may have changed in a way we can't derive precisely — new listing,
// cancel/delist, pool deposit/withdraw, pool repricing, etc. `markDirty`
// schedules one debounced reconciliation per affected slug (see below);
// `listing_snapshot` then carries the reconciled state to clients.

saleEventBus.onTxMintsTouched(({ mints }) => {
  for (const m of mints) markMintDirty(m);
});

// ─── Precise delist hook ─────────────────────────────────────────────────────
//
// Fires when ingestion sees a verified TCOMP delist* instruction. Same shape
// as the sale hook — look up every id for the mint, remove them, fan out
// id-based listing_remove SSE deltas. No external fetch, no debounce.

saleEventBus.onListingConfirmedDelist(({ mint }) => {
  if (!mint) return;
  // Record FIRST (even with no live listing now) so a lagging snapshot can't
  // re-add the just-cancelled mint. Mirrors the sold-mint suppression path.
  markSuppressed(mint, 'delisted');
  const ids = byMint.get(mint);
  if (!ids || ids.size === 0) return;
  const targets: Array<{ slug: string; id: string }> = [];
  for (const id of Array.from(ids)) {
    const l = byId.get(id);
    if (l) targets.push({ slug: l.slug, id });
    removeById(id);
  }
  for (const t of targets) saleEventBus.emitListingRemove(t);
});

// ─── Immediate-refresh hook ──────────────────────────────────────────────────
//
// Fires on verified list / reprice / pool-update instructions. Unlike the
// debounced markDirty path (10 s window), this calls ensureFresh directly
// with a small coalescing TTL so a burst of list events for the same slug
// triggers at most one refresh per ~2 s. New row appears in < 5 s instead
// of the 10-second-debounce baseline.

const REFRESH_HINT_TTL_MS = 2_000;

saleEventBus.onListingRefreshHint(({ mint, poolKeys }) => {
  const refreshed = new Set<string>();
  const doRefresh = (slug: string) => {
    if (refreshed.has(slug)) return;
    if (!lastTouch.has(slug)) return;   // only warm slugs
    // Cold-slug gate: a listing_refresh_hint only triggers the expensive
    // ensureFresh fan-out when at least one Collection page tab is currently
    // viewing this slug (heartbeat within HEARTBEAT_TTL_MS). Cold slugs fall
    // back to the endpoint-triggered refresh path the moment a user opens
    // the page — no visible regression on the hot path.
    if (!isSlugHot(slug)) return;
    refreshed.add(slug);
    void ensureFresh(slug, REFRESH_HINT_TTL_MS);
  };

  // Path 1: precise mint → all slugs it's currently listed on.
  if (mint) {
    const ids = byMint.get(mint);
    if (ids && ids.size > 0) {
      for (const id of ids) {
        const l = byId.get(id);
        if (l) doRefresh(l.slug);
      }
    } else {
      // Widened mint path: long-lived mint→slug index (preloaded from
      // sale_events + kept current by onMetaUpdate and snapshot adds).
      const slug = mintToSlug.get(mint);
      if (slug) doRefresh(slug);
    }
  }

  // Path 2: MMM `update_pool` tx has no mint but its account keys include
  // the pool PDA. Walk them against our poolKey→slug index; any match
  // refreshes that slug. Bounded by the typical 10–20 account keys per tx
  // and the `refreshed` set dedup.
  if (poolKeys && poolKeys.length > 0) {
    for (const k of poolKeys) {
      const slugs = byPoolKey.get(k);
      if (!slugs) continue;
      for (const s of slugs) doRefresh(s);
    }
  }
});

/** Resolve a mint to a slug using the long-lived `mintToSlug` index.
 *  Populated from sale_events on boot (~18k pairs for an active DB) and
 *  kept current by `onMetaUpdate`. Used at sale-emit time so SSE `sale`
 *  frames carry `meCollectionSlug` synchronously — otherwise enrichment
 *  fills it later via `meta`, and the frontend's slug filter drops every
 *  live sale in the meantime. */
export function slugForMint(mint: string): string | null {
  if (!mint) return null;
  return mintToSlug.get(mint) ?? null;
}

/** Human collection name for a previously-enriched mint, or null. Mirror of
 *  slugForMint — lets insert.ts stamp the first `sale` frame + run the
 *  pre-emit name blacklist gate for any mint we've seen before. */
export function nameForMint(mint: string): string | null {
  if (!mint) return null;
  return mintToName.get(mint) ?? null;
}

export function markMintDirty(mint: string): void {
  const ids = byMint.get(mint);
  if (ids && ids.size > 0) {
    // Precise path: mint has live rows. Each row's slug gets marked.
    const slugs = new Set<string>();
    for (const id of ids) {
      const l = byId.get(id);
      if (l) slugs.add(l.slug);
    }
    for (const s of slugs) markDirty(s);
    return;
  }

  // Widened path: mint isn't currently listed (new-listing case). Look up
  // the historical mint→slug index. Gate on `lastTouch` to avoid waking
  // cold collections — a reconcile for a slug no SSE client is watching
  // would pre-warm cache nobody needs.
  const slug = mintToSlug.get(mint);
  if (!slug) return;
  if (!lastTouch.has(slug)) return;
  markDirty(slug);
}

// ─── Snapshot loaders (per source → normalized Listing) ──────────────────────

interface MeRawListing {
  tokenMint?:    string;
  seller?:       string;
  auctionHouse?: string;
  price?:        number;       // SOL
  tokenAddress?: string;
  rarity?:       { howrare?: { rank?: number }; moonrank?: { rank?: number } };
  /** ME thumbnail URL (primary). */
  extra?:        { img?: string };
  /** ME token metadata — carries canonical item name (often just `"#4101"`)
   *  and a duplicate of `extra.img`. */
  token?:        { name?: string; image?: string };
}

// ME's /v2/collections/{slug}/listings silently returns `[]` for limit > 100
// — a server-side cap that isn't documented in the response. The prior
// single-shot limit=500 call was collapsing every collection's ME coverage
// to zero. We now page with limit=100 until ME returns a short page or we
// hit MAX_PAGES. Verified against:
//   transdimensional_fox_federation: 228 rows (3 pages)
//   pfp_gen2:                         380 rows (4 pages)
//   listedCount (ME /stats):          314 / 381 respectively (the rest live
//                                     in pool/secondary sources we don't scrape)
const ME_PAGE_SIZE = 100;
const ME_MAX_PAGES = 10;   // hard upper bound = 1000 listings per collection

/**
 * ME's /listings response carries no timestamp for when a listing was
 * created. The sibling /activities?type=list endpoint does — it returns the
 * `list` transaction block time per mint. We fetch one page (100 most-recent
 * list events) and build a mint→listedAtMs map. Listings whose tokenMint
 * appears in the map get a real timestamp; anything older than the 100-row
 * window stays `null` and renders as "—" on the frontend (truthful).
 *
 * One extra HTTP call per snapshot refresh, runs in parallel with the
 * listings pagination (Promise.all below).
 */
interface MeListActivity { tokenMint?: string; blockTime?: number; type?: string }

/**
 * Pool-hosted ME listings (rows where `listingSource=MMM`, `auctionHouse=""`)
 * do not emit `type=list` activities, so `fetchMeListedAtMap` can never
 * resolve them — they stay "—" forever. Their natural listed-at surrogate is
 * the NFT's most-recent `buyNow` sale: for a pool-listed NFT, the last sale
 * is when the pool acquired it, so the NFT has been in the pool (i.e.
 * listed) since that block. One page of `?type=buyNow` (500 rows) covers
 * days-to-months of pool churn for most collections.
 */
async function fetchMeBuyNowMap(slug: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const PAGE_SIZE = 500;
  const MAX_PAGES = 2;      // up to 1 000 buyNow fills — enough for pool churn
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/activities?type=buyNow&offset=${offset}&limit=${PAGE_SIZE}`;
      const res = await fetch(url, { headers: meAuthHeaders(), signal: AbortSignal.timeout(6_000) });
      if (!res.ok) break;
      const json = await res.json() as MeListActivity[];
      if (!Array.isArray(json) || json.length === 0) break;
      for (const a of json) {
        if (!a.tokenMint || typeof a.blockTime !== 'number' || a.blockTime <= 0) continue;
        const ms = a.blockTime * 1000;
        const prev = out.get(a.tokenMint) ?? 0;
        if (ms > prev) out.set(a.tokenMint, ms);
      }
      if (json.length < PAGE_SIZE) break;
    }
  } catch { /* partial map is still useful */ }
  return out;
}

async function fetchMeListedAtMap(slug: string): Promise<Map<string, number>> {
  // Paginate across up to MAX_PAGES of list activities so busy collections
  // (like degods with 118+ active listings) don't leave ~70% of rows with a
  // null listedAt. ME returns 100 activities/page; a short page signals
  // history exhausted. 3 pages = 300 events covers the active inventory
  // window for most collections without a large extra ME load.
  const out = new Map<string, number>();
  const PAGE_SIZE = 100;
  // 10 pages = 1 000 list events. Empirically covers active-listing inventory
  // for mid-activity collections (sensei: 5 of 10 missing mints resolved on
  // pages 3–9; 3-page cap recovered zero of them). Short-page early-exit
  // keeps cost bounded — we only hit this ceiling for the busiest slugs.
  const MAX_PAGES = 10;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/activities?type=list&offset=${offset}&limit=${PAGE_SIZE}`;
      const res = await fetch(url, { headers: meAuthHeaders(), signal: AbortSignal.timeout(6_000) });
      if (!res.ok) break;
      const json = await res.json() as MeListActivity[];
      if (!Array.isArray(json) || json.length === 0) break;
      for (const a of json) {
        if (!a.tokenMint || typeof a.blockTime !== 'number' || a.blockTime <= 0) continue;
        const ms = a.blockTime * 1000;
        const prev = out.get(a.tokenMint) ?? 0;
        // Keep the most recent list event per mint (covers list → delist → list cycles).
        if (ms > prev) out.set(a.tokenMint, ms);
      }
      if (json.length < PAGE_SIZE) break;  // reached end of list-activity history
    }
  } catch { /* partial result fine — map just stays smaller */ }
  return out;
}

// 2026-05-29: per-slug TTL cache + inflight dedup for the two ME activities
// derived maps. The maps are pure enrichment (listedAt timestamp + buyNow
// fallback URL grouping) — never the source of truth for "is this listing
// active". The active-listings list itself is re-fetched on every snapshot
// from /listings, so caching the activities maps for ~5 min cannot make
// stale rows permanent. Saves ~12 ME API calls per snapshot per slug
// (up to 10 list pages + 2 buyNow pages) on the common warm path.
interface MeActivitiesCacheEntry {
  listedAt: Map<string, number>;
  buyNow:   Map<string, number>;
  at:       number;
}
const ME_ACTIVITIES_TTL_MS = 5 * 60_000;
const meActivitiesCache:    Map<string, MeActivitiesCacheEntry>                = new Map();
const meActivitiesInflight: Map<string, Promise<{ listedAt: Map<string, number>; buyNow: Map<string, number> }>> = new Map();

async function getMeActivitiesMaps(
  slug: string,
): Promise<{ listedAt: Map<string, number>; buyNow: Map<string, number> }> {
  const now = Date.now();
  const cached = meActivitiesCache.get(slug);
  if (cached && now - cached.at < ME_ACTIVITIES_TTL_MS) {
    console.log(`[listings/me-activities] cache=hit slug=${slug} ageMs=${now - cached.at}`);
    return { listedAt: cached.listedAt, buyNow: cached.buyNow };
  }
  const inflight = meActivitiesInflight.get(slug);
  if (inflight) {
    console.log(`[listings/me-activities] cache=inflight slug=${slug}`);
    return inflight;
  }
  console.log(`[listings/me-activities] cache=miss slug=${slug}`);
  const p = (async () => {
    const [listedAt, buyNow] = await Promise.all([
      fetchMeListedAtMap(slug),
      fetchMeBuyNowMap(slug),
    ]);
    meActivitiesCache.set(slug, { listedAt, buyNow, at: Date.now() });
    return { listedAt, buyNow };
  })().finally(() => meActivitiesInflight.delete(slug));
  meActivitiesInflight.set(slug, p);
  return p;
}

async function fetchMeDirect(slug: string): Promise<Listing[]> {
  const out: Listing[] = [];
  // Activities maps come from a 5-min per-slug cache (getMeActivitiesMaps);
  // first listings page still runs in parallel via the resolved promise so
  // warm-cache snapshots avoid the round-trips entirely while cold snapshots
  // preserve the prior parallel-fetch latency profile.
  const meActivitiesPromise   = getMeActivitiesMaps(slug);
  const listedAtByMintPromise = meActivitiesPromise.then(m => m.listedAt);
  const buyNowByMintPromise   = meActivitiesPromise.then(m => m.buyNow);
  try {
    for (let page = 0; page < ME_MAX_PAGES; page++) {
      const offset = page * ME_PAGE_SIZE;
      const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/listings?offset=${offset}&limit=${ME_PAGE_SIZE}`;
      const res = await fetch(url, { headers: meAuthHeaders(), signal: AbortSignal.timeout(6_000) });
      if (!res.ok) break;
      const json = await res.json() as MeRawListing[];
      if (!Array.isArray(json) || json.length === 0) break;
      for (const l of json) {
        // NOTE: ME's /listings also includes pool-hosted listings (MMM-source)
        // where `auctionHouse` is an empty string, not a non-AH identifier.
        // Those rows carry full `token.name` + `extra.img` metadata — far
        // richer than what we can reconstruct from /mmm/pools directly — so
        // accept them. Buy-flow gating elsewhere already treats empty AH as
        // a non-buyable row; this is the same existing pattern MMM-from-pool
        // rows follow.
        if (!l.tokenMint || !l.seller || !l.tokenAddress) continue;
        if (typeof l.price !== 'number' || l.price <= 0) continue;
        out.push({
          id:           `ME:${l.tokenMint}:${l.seller}`,
          mint:         l.tokenMint,
          priceSol:     l.price,                                      // ME returns SOL already
          source:       'ME',
          type:         'listing',
          seller:       l.seller,
          slug,
          auctionHouse: l.auctionHouse ?? '',
          tokenAta:     l.tokenAddress,
          rank:         l.rarity?.howrare?.rank ?? l.rarity?.moonrank?.rank ?? null,
          listedAt:        null,   // filled in after the activities map resolves
          listedAtQuality: null,
          nftName:      l.token?.name ?? null,
          imageUrl:     l.extra?.img ?? l.token?.image ?? null,
        });
      }
      // Short page → we've reached the end. Spare ME the extra round-trip.
      if (json.length < ME_PAGE_SIZE) break;
    }
  } catch { /* partial result still useful — return what we have */ }
  // Join the activities timestamps after listings are collected. A real
  // list-transaction timestamp — 'exact' quality for mint-lifecycle.
  const listedAtByMint = await listedAtByMintPromise;
  if (listedAtByMint.size > 0) {
    for (const l of out) {
      const t = listedAtByMint.get(l.mint);
      if (t) { l.listedAt = t; l.listedAtQuality = 'exact'; }
    }
  }
  // Second-pass: for anything still unresolved (primarily MMM pool-hosted
  // rows, `auctionHouse=''`), fall back to the last buyNow block time —
  // a surrogate, not a real list event, so 'approximate' quality.
  const stillMissing = out.some(l => !l.listedAt);
  if (stillMissing) {
    const buyNowByMint = await buyNowByMintPromise;
    if (buyNowByMint.size > 0) {
      for (const l of out) {
        if (l.listedAt) continue;
        const t = buyNowByMint.get(l.mint);
        if (t) { l.listedAt = t; l.listedAtQuality = 'approximate'; }
      }
    }
  }
  return out;
}

interface MmmPoolRaw {
  poolType?:           string;
  spotPrice?:          number;   // lamports (next-out quote)
  curveType?:          string;   // 'exp' | 'linear'
  curveDelta?:         number;   // bps for exp, lamports for linear
  sellsideAssetAmount?: number;
  poolOwner?:          string;
  poolKey?:            string;
  mints?:              string[];
}

/**
 * MMM bonding-curve price for the k-th NFT out (0-indexed). `spotPrice` is
 * the quote for the next NFT; each subsequent fill moves one step along the
 * curve. Ascending direction — sell-side pools compound spot upward as
 * inventory drains.
 *
 *   exp    : spot * (1 + delta/10000)^k
 *   linear : spot + delta * k
 *
 * Fees (lpFeeBp, creator royalty) are intentionally excluded — this is the
 * raw pool quote in lamports, converted to SOL exactly once at call site.
 */
function mmmPriceLamports(spot: number, curveType: string | undefined, delta: number, k: number): number {
  if (k === 0) return spot;
  if (curveType === 'exp')    return spot * Math.pow(1 + delta / 10_000, k);
  if (curveType === 'linear') return spot + delta * k;
  return spot;
}

async function fetchMmmPools(slug: string): Promise<Listing[]> {
  try {
    const url = `https://api-mainnet.magiceden.dev/v2/mmm/pools?collectionSymbol=${encodeURIComponent(slug)}&limit=100`;
    const res = await fetch(url, { headers: meAuthHeaders(), signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return [];
    const json = await res.json() as { results?: MmmPoolRaw[] };
    const pools = Array.isArray(json.results) ? json.results : [];
    const out: Listing[] = [];
    for (const p of pools) {
      const mints = Array.isArray(p.mints) ? p.mints : [];
      const spot  = typeof p.spotPrice === 'number' ? p.spotPrice : 0;
      const owner = p.poolOwner ?? p.poolKey;
      if (mints.length === 0 || spot <= 0 || !owner || !p.poolKey) continue;
      const delta = typeof p.curveDelta === 'number' ? p.curveDelta : 0;
      for (let i = 0; i < mints.length; i++) {
        const mint = mints[i];
        if (!mint) continue;
        const lamports = mmmPriceLamports(spot, p.curveType, delta, i);
        out.push({
          id:           `MMM:${p.poolKey}:${mint}`,
          mint,
          priceSol:     lamports / 1e9,                             // ← single lamports→SOL conversion
          source:       'MMM',
          type:         'pool',
          seller:       owner,
          slug,
          auctionHouse: '',                                          // MMM uses fulfill_sell, not AH buy_now
          tokenAta:     '',                                          // resolved at buy-build time
          rank:         null,                                        // pools don't carry rarity
          // Pool `updatedAt` is pool-wide (any spot change, any NFT add/remove)
          // — not a per-mint deposit timestamp. Leave null so the UI shows "—"
          // rather than a misleading relative time. No quality either —
          // there's no per-mint timestamp here at all, exact or approximate.
          listedAt:        null,
          listedAtQuality: null,
          nftName:      null,   // MMM pool response doesn't carry per-mint name
          imageUrl:     null,   // likewise no per-mint image
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Tensor `active_listings` item shape (current tensordev API). The feed
 *  aggregates listings across marketplaces, so `listing.source` may be
 *  MAGICEDEN_V2, TENSORSWAP, TCOMP, etc. */
interface TensorActiveListing {
  mint?:       string;          // mint address (top-level string, not an object)
  rarityRank?: number;          // top-level, replaces v2's mint.rarityRankHR/TT
  listing?: {
    seller?: string;
    price?:  string;            // lamports
    txId?:   string;
    txAt?:   string;            // ISO8601
    source?: string;
  };
}

/** Resolved Tensor collection identity. Tensor's `slugDisplay` (e.g.
 *  `madlads`) differs from the ME slug we're queried with (`slugMe`, e.g.
 *  `mad_lads`), so we keep all aliases to bridge the two namespaces. */
export interface TensorCollMeta {
  collId:      string;
  slugDisplay: string | null;
  slugMe:      string | null;
  slugAtlas3:  string | null;
  symbol:      string | null;
}

/** slug/alias → Tensor meta. collIds are stable once found, so a HIT is
 *  cached for the life of the process (permanent Map) — populated under the
 *  queried slug AND every known alias (slugMe / slugDisplay / symbol) so a
 *  later query by any of them is a hit with zero requests.
 *
 *  A MISS is a different story: it used to be cached permanently too (same
 *  Map, `null` value), on the theory that Tensor genuinely doesn't track
 *  every ME collection. In practice a single transient failure — a network
 *  blip or timeout on ANY of the up-to-4 candidate probes — looked
 *  identical to a genuine "Tensor doesn't have this" miss, permanently
 *  locking that collection out of ME BID / TNSR BID / Tensor-sourced
 *  LISTED for the rest of the process's uptime (confirmed live: a
 *  resolution that had worked minutes earlier came back null after no
 *  code/data change, just process time passing). TTL'd instead — long
 *  enough that a genuinely-untracked collection isn't re-probed on every
 *  request (still respects the shared 1 req/sec gate), short enough that a
 *  one-off blip recovers within a few dashboard polls instead of needing a
 *  backend restart. */
const TENSOR_MISS_TTL_MS = 5 * 60_000;
const tensorCollMetaCache = new Map<string, TensorCollMeta>();
const tensorCollMetaMissCache = new TtlCache<string, true>(TENSOR_MISS_TTL_MS, 60_000);

/** Sequential gate over all tensordev requests, enforcing ≥1 req/sec. Each
 *  request waits for the previous to settle, then a 1 s spacer. */
let tensorFetchChain: Promise<unknown> = Promise.resolve();
export function tensorFetch(url: string): Promise<Response> {
  const res = tensorFetchChain.then(() =>
    fetch(url, {
      // Key read here only — never logged. Callers guard on its presence.
      headers: { 'x-tensor-api-key': process.env.TENSOR_API_KEY ?? '', Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    }),
  );
  tensorFetchChain = res.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, 1_000)));
  return res;
}

/** Generic Tensor slug candidates derived from our app (ME) slug, covering
 *  both directions of separator mismatch (NOT hardcoded per collection):
 *    1. as-is                        (`mad_lads`)
 *    2. lowercased                   (`mad_lads`)
 *    3. trailing separators stripped (`pepe_cards` ← ME slug `pepe_cards_`)
 *    4. underscores removed          (`madlads`  ← Tensor's slugDisplay)
 *    5. hyphens removed              (`madlads`)
 *    6. underscores → hyphens        (`mad-lads`)
 *    7. hyphens → underscores        (`mad_lads`)
 *  Deduped (order-preserving) and capped at 4 attempts to respect 1 req/sec
 *  and avoid request fan-out. */
function tensorSlugCandidates(appSlug: string): string[] {
  const variants = [
    appSlug,
    appSlug.toLowerCase(),
    appSlug.replace(/[_-]+$/, ''),
    appSlug.replace(/_/g, ''),
    appSlug.replace(/-/g, ''),
    appSlug.replace(/_/g, '-'),
    appSlug.replace(/-/g, '_'),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of variants) {
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out.slice(0, 4);
}

/** Resolve our app slug to Tensor's collId, trying a few generic slug-shape
 *  candidates (NOT hardcoded per collection). Caches the result under the
 *  queried slug plus every alias so ME slug and Tensor slugDisplay both
 *  resolve to the same collId. Returns null on a miss (TTL'd — see
 *  tensorCollMetaMissCache's doc). */
export async function resolveTensorMeta(appSlug: string): Promise<TensorCollMeta | null> {
  const cached = tensorCollMetaCache.get(appSlug);
  if (cached !== undefined) return cached;
  if (tensorCollMetaMissCache.has(appSlug)) return null;

  // ME slugs are sometimes a straight concatenation of the display name
  // (`sagamonkes`) while Tensor's real slug keeps word separators
  // (`saga_monkes`) — confirmed live: find_collection?filter=sagamonkes
  // 404s, filter=saga_monkes resolves. tensorSlugCandidates can only
  // strip/swap EXISTING separators, so it can never bridge a fully-
  // concatenated slug; deriving one straight from the catalog's display
  // name (spaces -> underscores) covers that case generically.
  const catalogName = getCatalogEntry(appSlug)?.name;
  const nameCandidate = catalogName
    ? catalogName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : null;
  const candidates = tensorSlugCandidates(appSlug);
  if (nameCandidate && !candidates.includes(nameCandidate)) candidates.push(nameCandidate);

  let meta: TensorCollMeta | null = null;
  for (const candidate of candidates) {
    // A prior resolution may already have cached this candidate as a hit.
    const pre = tensorCollMetaCache.get(candidate);
    if (pre) { meta = pre; break; }
    // Skip a candidate another slug already probed to a miss within the
    // TTL window — saves a round-trip through the shared rate gate.
    if (tensorCollMetaMissCache.has(candidate)) continue;
    try {
      const res = await tensorFetch(
        `https://api.mainnet.tensordev.io/api/v1/collections/find_collection?filter=${encodeURIComponent(candidate)}`,
      );
      if (res.ok) {
        const j = await res.json() as {
          collId?: string; slugDisplay?: string; slugMe?: string; slugAtlas3?: string; symbol?: string;
        };
        if (typeof j.collId === 'string' && j.collId.length > 0) {
          meta = {
            collId:      j.collId,
            slugDisplay: typeof j.slugDisplay === 'string' ? j.slugDisplay : null,
            slugMe:      typeof j.slugMe === 'string' ? j.slugMe : null,
            slugAtlas3:  typeof j.slugAtlas3 === 'string' ? j.slugAtlas3 : null,
            symbol:      typeof j.symbol === 'string' ? j.symbol : null,
          };
          break;
        }
      }
      // non-ok / no collId (e.g. 404) → fall through to the next candidate.
    } catch {
      // network/timeout → try the next candidate.
    }
    tensorCollMetaMissCache.set(candidate, true);
  }

  // Cache the queried slug (hit permanent, miss TTL'd) + every alias on a
  // hit. Symbols are aliased only when ≥4 chars, to avoid short tickers
  // colliding with an unrelated collection's slug.
  if (meta) {
    tensorCollMetaCache.set(appSlug, meta);
    if (meta.slugMe)                            tensorCollMetaCache.set(meta.slugMe, meta);
    if (meta.slugDisplay)                       tensorCollMetaCache.set(meta.slugDisplay, meta);
    if (meta.slugAtlas3)                        tensorCollMetaCache.set(meta.slugAtlas3, meta);
    if (meta.symbol && meta.symbol.length >= 4) tensorCollMetaCache.set(meta.symbol, meta);
  } else {
    tensorCollMetaMissCache.set(appSlug, true);
  }
  return meta;
}

async function fetchTensor(slug: string): Promise<Listing[]> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return [];
  try {
    const meta = await resolveTensorMeta(slug);
    if (!meta) return [];
    const res = await tensorFetch(
      `https://api.mainnet.tensordev.io/api/v1/mint/active_listings`
      + `?collId=${encodeURIComponent(meta.collId)}&sortBy=ListingPriceAsc&limit=250`,
    );
    if (!res.ok) return [];
    const json = await res.json() as { mints?: TensorActiveListing[] };
    const mints = Array.isArray(json.mints) ? json.mints : [];
    const out: Listing[] = [];
    for (const m of mints) {
      const mint = m.mint;
      const seller = m.listing?.seller;
      const priceLamports = m.listing?.price;
      if (!mint || !seller || !priceLamports) continue;
      // Skip Magic Eden-sourced rows: fetchMeDirect already owns those, and
      // active_listings aggregates across marketplaces — including them would
      // double-count the same mint under a second `TENSOR:` id.
      if ((m.listing?.source ?? '').startsWith('MAGIC')) continue;
      const n = Number(priceLamports);
      if (!Number.isFinite(n) || n <= 0) continue;
      const txAtMs = m.listing?.txAt ? Date.parse(m.listing.txAt) : NaN;
      out.push({
        id:           `TENSOR:${mint}:${seller}`,
        mint,
        priceSol:     n / 1e9,                                       // ← single lamports→SOL conversion
        source:       'TENSOR',
        type:         'listing',
        seller,
        slug,
        auctionHouse: '',
        tokenAta:     '',
        rank:         typeof m.rarityRank === 'number' ? m.rarityRank : null,
        // active_listings carries listing.txAt — wire it through as listedAt.
        // A real list-transaction timestamp, same as ME's own — 'exact'.
        listedAt:        Number.isFinite(txAtMs) ? txAtMs : null,
        listedAtQuality: Number.isFinite(txAtMs) ? 'exact' : null,
        nftName:      null,   // active_listings has `name`/`imageUri`; not wired to Listing yet
        imageUrl:     null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchSnapshot(slug: string): Promise<Listing[]> {
  const [me, mmm, tensor] = await Promise.all([
    fetchMeDirect(slug),
    fetchMmmPools(slug),
    fetchTensor(slug),
  ]);
  return [...me, ...mmm, ...tensor];
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Ensure `slug`'s rows in the store are fresher than `ttlMs`. Coalesces
 * concurrent callers onto one fetch. Scoped refresh — only `slug`'s rows
 * are replaced on completion; other slugs and unrelated rows remain in place.
 */
export async function ensureFresh(slug: string, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  touch(slug);
  if (Date.now() - (lastFetch.get(slug) ?? 0) < ttlMs) return;
  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async () => {
    const release = await acquireSnapshotSlot();
    try {
      const fresh = await fetchSnapshot(slug);
      replaceCollection(slug, fresh);
      lastFetch.set(slug, Date.now());
      // Push the new state to any SSE client viewing this slug. Frontend
      // replaces its local array on `listing_snapshot`.
      saleEventBus.emitListingSnapshot({
        slug,
        listings: fresh.map(toWire),
      });
    } finally {
      release();
      inFlight.delete(slug);
    }
  })();
  inFlight.set(slug, task);
  return task;
}

export function getByCollection(slug: string): Listing[] {
  touch(slug);
  const ids = byCollection.get(slug);
  if (!ids) return [];
  const out: Listing[] = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (l) out.push(l);
  }
  return out;
}

/**
 * Lightweight, fetch-free floor lookup.
 *
 * Returns the minimum `priceSol` across all in-memory listings for
 * `slug`, expressed in lamports. The listings store is already
 * populated as a side effect of normal ingestion (LIST/cancel/sale
 * events feed it via deltas + periodic snapshots), so this is O(N)
 * over the slug's listings — typically small (≤ a few hundred) and
 * always cheap relative to a network round-trip.
 *
 * Trade-off: derived floor may be slightly stale (TTL-bounded by the
 * listings-store's own snapshot cadence), but it is always available
 * for any actively-traded collection and never costs an API/RPC call.
 * That matches the product preference: "slightly stale but always-
 * present" floor over "perfect but missing".
 *
 * Returns null when the slug has zero in-memory listings (collection
 * we've never indexed) — caller hides the floor chip in that case.
 *
 * Does NOT call `touch(slug)` — the listings-store's freshness loop
 * is driven by user navigation; a passive floor read shouldn't
 * trigger refetches for every event passing through enrichment.
 */
export function getDerivedFloorLamports(slug: string): number | null {
  const ids = byCollection.get(slug);
  if (!ids || ids.size === 0) return null;
  let minSol = Infinity;
  // Skip MMM/AMM pool entries — their `priceSol` is the pool's
  // `spotPrice` (a curve quote, not a real per-NFT listing) and can
  // sit well below or above the actual collection floor. Two sales
  // seconds apart can land on different curve ticks → the floor
  // appears to "jump" between rows in /feed even when no real
  // listing changed. The non-pool min is the stable signal we want
  // for the discount-vs-floor metric. Falls back to whatever non-
  // pool listing exists; if there are NO non-pool listings, returns
  // null so callers move on to the ME-API floor cache instead.
  //
  // ME-only: the FloorChip's whole point is "vs Magic Eden floor" —
  // mixing in Tensor's own listings here made a Tensor sale's % look
  // like it was measured against ME when it was actually measured
  // against a blended, marketplace-varying floor (same collection,
  // two sales seconds apart, silently different reference floors).
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) continue;
    if (l.type === 'pool') continue;
    if (l.source !== 'ME') continue;
    if (l.priceSol > 0 && l.priceSol < minSol) minSol = l.priceSol;
  }
  if (!Number.isFinite(minSol)) return null;
  return Math.round(minSol * 1e9);
}
