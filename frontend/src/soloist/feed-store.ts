/**
 * Feed state: normalized by event id (== signature), ordered newest-first.
 *
 * Three code paths that used to be ad-hoc `setEvents(prev => …)` calls
 * scattered across the page component now go through explicit actions:
 *
 *   1. `snapshot` — REST /events/latest (initial load, or paused→resume)
 *   2. `live`     — single SSE `sale` event
 *   3. `meta` / `rawpatch` / `remove` — row patches
 *
 * Separating these actions gives a single place for dedup, ordering, and
 * eviction rules, and removes the duplicated patch logic that previously
 * lived inside each SSE listener. It also gives collection-scoped views a
 * ready-made container: the same reducer shape works for a per-slug feed,
 * and selectors below are where derived stats can be added without
 * touching the reducer.
 *
 * Pure module — no React imports, no side effects. Safe to unit-test.
 */

import { FeedEvent } from './mock-data';
import { collectionMeta } from './from-backend';
import { isFeedEventBlacklisted } from './blacklist-filter';

const DEFAULT_MAX = 200;

export interface FeedState {
  /** id → event. id === event.signature. */
  byId:  Map<string, FeedEvent>;
  /** Ordered id list, newest-first (by event.ts desc). */
  order: string[];
  /** Hard cap on retained rows. Oldest entries beyond this are evicted. */
  max:   number;
}

export const EMPTY_FEED: FeedState = {
  byId:  new Map(),
  order: [],
  max:   DEFAULT_MAX,
};

export function initFeedState(max: number = DEFAULT_MAX): FeedState {
  return { byId: new Map(), order: [], max };
}

// Payload shapes for patch actions — mirror the corresponding SSE frames.
export interface MetaPatch {
  mintAddress:      string;
  signature:        string;
  nftName:          string | null;
  imageUrl:         string | null;
  collectionName:   string | null;
  meCollectionSlug: string | null;
  /** Backend computes these post-enrichment (when slug + floor lookup
   *  resolve), so they're typically null on the first `sale` frame and
   *  arrive on the follow-up `meta` frame. Reducer below applies them
   *  to the existing FeedEvent so the FloorChip can render. */
  floorDelta?:      number | null;
  offerDelta?:      number | null;
}

export interface RawPatch {
  signature:   string;
  seller?:     string | null;
  buyer?:      string | null;
  saleType?:   string;
  nftType?:    string;
  priceSol?:   number;
}

/** Seller-collection-count patch — late-arriving async result.
 *  Carries the originating `signature` as the primary match key (works
 *  even when the row's collectionAddress was null at sale time), plus
 *  seller+collection so the same patch can fan out to every other row
 *  from the same wallet+collection and persist across reloads in
 *  localStorage under the composite key. */
export interface SellerCountPatch {
  signature?: string;
  seller:     string;
  collection: string;
  /** Authoritative DAS count. May be null when DAS returned nothing
   *  but the multi-sell signal still applies. */
  count:      number | null;
  /** Sell-side sales the same wallet made for this collection in the
   *  last 10 minutes (backend-tracked). Persisted alongside the count
   *  for tooltip detail; not rendered as a badge. */
  sells10m?:  number;
  /** Legacy field — backend used to ship a `'multi'` dumping signal so
   *  the frontend could render a 🔥 hint. The hint was removed; the
   *  field is kept on the patch type only for back-compat with stale
   *  SSE messages and is silently ignored by the reducer. */
  signal?:    'multi';
}

/** Resize-status patch — late-arriving result from the backend
 *  resize-status-resolver. Matches by originating sale signature.
 *  Only `metaplex_resized_unclaimed` triggers the RESIZE badge. */
export interface ResizeStatusPatch {
  signature:    string;
  mint:         string;
  resizeStatus: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized';
}

/** Late-resolved rarity patch — backend `rarity` SSE channel. The live `sale`
 *  frame can go out without rarity (the backend sync getter is in-process-only
 *  and misses while cold); the backend resolves it async and emits this so the
 *  badge / Rare Feed appear without a reload. Keyed by `mintAddress`; only ever
 *  carries a finite rank + supply>0. */
export interface RarityPatch {
  mintAddress:  string;
  rarityRank:   number;
  totalSupply:  number;
  raritySource: string | null;
  oneOfOne?:    boolean;
}

export type FeedAction =
  | { type: 'snapshot';      events: FeedEvent[] }
  | { type: 'live';          event:  FeedEvent }
  | { type: 'meta';          patch:  MetaPatch; blacklist?: ReadonlySet<string> }
  | { type: 'rawpatch';      patch:  RawPatch }
  | { type: 'seller_count';  patch:  SellerCountPatch }
  | { type: 'resize_status'; patch:  ResizeStatusPatch }
  | { type: 'rarity';        patch:  RarityPatch }
  | { type: 'remove';        signature: string }
  | { type: 'reset' };

// ─── internal helpers ────────────────────────────────────────────────────────

/** Insert `ev` into state at the correct position by ts desc. No-op if already present. */
function insertOrdered(state: FeedState, ev: FeedEvent): FeedState {
  if (state.byId.has(ev.id)) return state;
  const byId  = new Map(state.byId);
  byId.set(ev.id, ev);
  const order = state.order.slice();
  // Linear scan: same cost as the old .sort() per insert but allocation-light.
  let i = 0;
  while (i < order.length) {
    const existing = byId.get(order[i]);
    if (!existing || existing.ts <= ev.ts) break;
    i++;
  }
  order.splice(i, 0, ev.id);
  if (order.length > state.max) {
    const evicted = order.splice(state.max);
    for (const id of evicted) byId.delete(id);
  }
  return { ...state, byId, order };
}

/** Apply `transform` to every event matching `predicate`. Returns same ref if nothing changed. */
function patchWhere(
  state: FeedState,
  predicate: (ev: FeedEvent) => boolean,
  transform: (ev: FeedEvent) => FeedEvent,
): FeedState {
  let changed = false;
  let byId: Map<string, FeedEvent> | null = null;
  for (const [id, ev] of state.byId) {
    if (!predicate(ev)) continue;
    const next = transform(ev);
    if (next === ev) continue;
    if (!byId) byId = new Map(state.byId);
    byId.set(id, next);
    changed = true;
  }
  return changed && byId ? { ...state, byId } : state;
}

// ─── reducer ─────────────────────────────────────────────────────────────────

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'snapshot': {
      // Merge into existing state. Existing ids (which may carry live
      // patches applied before the snapshot resolved) win; snapshot fills
      // any gaps. Used both for first load and paused→resume refetch.
      let next = state;
      for (const ev of action.events) next = insertOrdered(next, ev);
      return next;
    }
    case 'live': {
      return insertOrdered(state, action.event);
    }
    case 'meta': {
      const { patch } = action;
      const bl = action.blacklist;
      const matches = (ev: FeedEvent): boolean =>
        ev.signature === patch.signature || ev.mintAddress === patch.mintAddress;
      const applyPatch = (ev: FeedEvent): FeedEvent => {
        const nextName = patch.collectionName ?? ev.collectionName;
        const vis      = collectionMeta(patch.collectionName);
        return {
          ...ev,
          mintAddress:      patch.mintAddress     || ev.mintAddress,
          nftName:          patch.nftName         ?? ev.nftName,
          imageUrl:         patch.imageUrl        ?? ev.imageUrl,
          collectionName:   nextName,
          meCollectionSlug: patch.meCollectionSlug ?? ev.meCollectionSlug,
          abbr:             patch.collectionName ? vis.abbr  : ev.abbr,
          color:            patch.collectionName ? vis.color : ev.color,
          // Floor / offer deltas are computed by the backend during
          // enrichment and arrive on the meta frame — propagate so the
          // FloorChip in FeedCard renders once the value is known.
          // `??` semantics keep any previously-applied non-null value
          // when a later patch arrives without one.
          floorDelta:       patch.floorDelta      ?? ev.floorDelta,
        };
      };
      // Blacklist boundary on the LATE path: a sale frame often lands with a
      // null collectionName/slug (enrichment pending), so it passes the
      // sale-handler boundary filter and paints; the `meta` frame then
      // reveals the real name. If that name (or slug) is blacklisted, REMOVE
      // the row in this same dispatch instead of applying the patch — so it
      // disappears the instant its identity is known, with no second render
      // tick (the prior code applied the name and waited for the render memo,
      // which is the flash). Matches by signature OR mintAddress, same as the
      // patch predicate. No-op when no blacklist set is supplied.
      let removeIds: string[] | null = null;
      let byIdPatched: Map<string, FeedEvent> | null = null;
      for (const [id, ev] of state.byId) {
        if (!matches(ev)) continue;
        const patched = applyPatch(ev);
        if (bl && bl.size > 0 && isFeedEventBlacklisted(patched, bl)) {
          (removeIds ??= []).push(id);
          continue;
        }
        if (patched === ev) continue;
        (byIdPatched ??= new Map(state.byId)).set(id, patched);
      }
      if (removeIds) {
        const byId = byIdPatched ?? new Map(state.byId);
        for (const id of removeIds) byId.delete(id);
        const removed = new Set(removeIds);
        const order = state.order.filter(id => !removed.has(id));
        return { ...state, byId, order };
      }
      return byIdPatched ? { ...state, byId: byIdPatched } : state;
    }
    case 'rawpatch': {
      const { patch } = action;
      return patchWhere(
        state,
        ev => ev.signature === patch.signature,
        ev => ({
          ...ev,
          seller:      patch.seller      ?? ev.seller,
          buyer:       patch.buyer       ?? ev.buyer,
          saleTypeRaw: patch.saleType    ?? ev.saleTypeRaw,
          nftType:     patch.nftType     ?? ev.nftType,
          price:       patch.priceSol    ?? ev.price,
          grossPrice:  patch.priceSol    ?? ev.grossPrice,
        }),
      );
    }
    case 'seller_count': {
      const { patch } = action;
      return patchWhere(
        state,
        // Match priority: signature when present (backfills row data
        // for the originating sale), then seller+collection (fans out
        // to every visible sibling row in the same dump batch and
        // catches late `seller_count_update` patches from the
        // exact-fallback path which arrive WITHOUT a signature).
        ev =>
          (!!patch.signature && ev.signature === patch.signature) ||
          (ev.seller === patch.seller && ev.collectionAddress === patch.collection),
        ev => {
          // Backfill collectionAddress when we matched by signature.
          // Without this, a row that landed with collectionAddress=null
          // would never be reachable by subsequent seller+collection
          // patches (including the late exact-scan update which has
          // no signature).
          const nextColl  = ev.collectionAddress ?? patch.collection;
          // Sticky-merge count — a patch without a finite count must
          // NOT overwrite a previously-resolved value. DAS counts win.
          const nextCount = (typeof patch.count === 'number' && Number.isFinite(patch.count))
            ? patch.count
            : (ev.sellerRemainingCount ?? null);
          const nextSells = patch.sells10m ?? ev.sellerSells10m ?? 0;
          if (
            ev.sellerRemainingCount === nextCount &&
            ev.collectionAddress    === nextColl  &&
            ev.sellerSells10m       === nextSells
          ) return ev;
          return {
            ...ev,
            sellerRemainingCount: nextCount,
            sellerSells10m:       nextSells,
            collectionAddress:    nextColl,
          };
        },
      );
    }
    case 'resize_status': {
      // Match by originating sale signature. Patch is sticky — if the
      // value is unchanged we return state to keep the byId map
      // reference identical (avoids needless rerender churn).
      const { patch } = action;
      return patchWhere(
        state,
        ev => ev.signature === patch.signature,
        ev => ev.resizeStatus === patch.resizeStatus ? ev : { ...ev, resizeStatus: patch.resizeStatus },
      );
    }
    case 'rarity': {
      // Late-resolved rarity, matched by mintAddress (fans out to every row of
      // the same mint). Sticky merge: if the row ALREADY has a finite rank +
      // supply we keep it (never overwrite resolved rarity); otherwise fill
      // from the patch. The patch itself is guaranteed finite + supply>0 by the
      // backend, so we never write null/negative. RarityRankBadge re-renders
      // automatically once the fields are present — no card-side change.
      const { patch } = action;
      if (!(patch.rarityRank > 0) || !(patch.totalSupply > 0)) return state;
      return patchWhere(
        state,
        ev => ev.mintAddress === patch.mintAddress,
        ev => {
          const hasRarity =
            typeof ev.rarityRank === 'number' && Number.isFinite(ev.rarityRank) && ev.rarityRank > 0 &&
            typeof ev.totalSupply === 'number' && Number.isFinite(ev.totalSupply) && ev.totalSupply > 0;
          if (hasRarity) return ev; // keep existing finite rarity — sticky
          return {
            ...ev,
            rarityRank:       patch.rarityRank,
            totalSupply:      patch.totalSupply,
            rarityPercentile: patch.rarityRank / patch.totalSupply,
            raritySource:     patch.raritySource,
            oneOfOne:         patch.oneOfOne ?? ev.oneOfOne ?? false,
          };
        },
      );
    }
    case 'remove': {
      if (!state.byId.has(action.signature)) return state;
      const byId  = new Map(state.byId);
      byId.delete(action.signature);
      const order = state.order.filter(id => id !== action.signature);
      return { ...state, byId, order };
    }
    case 'reset': {
      // Discard all rows while preserving `max`. Used when a collection page
      // switches slug — the prior slug's history must not leak into the new view.
      return initFeedState(state.max);
    }
  }
}

// ─── selectors ───────────────────────────────────────────────────────────────
//
// Centralized read-side so the view never walks `byId` directly. Future
// collection-scoped / filtered / derived-stats selectors live here.

export function orderedEvents(state: FeedState): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const id of state.order) {
    const ev = state.byId.get(id);
    if (ev) out.push(ev);
  }
  return out;
}

export function feedSize(state: FeedState): number {
  return state.order.length;
}
