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
   *  last 10 minutes (backend-tracked). Drives the 🔥 fallback. */
  sells10m?:  number;
  /** When backend determined the wallet is visibly dumping despite a
   *  weak/null DAS count. Frontend renders 🔥 instead of a number. */
  signal?:    'multi';
}

export type FeedAction =
  | { type: 'snapshot';     events: FeedEvent[] }
  | { type: 'live';         event:  FeedEvent }
  | { type: 'meta';         patch:  MetaPatch }
  | { type: 'rawpatch';     patch:  RawPatch }
  | { type: 'seller_count'; patch:  SellerCountPatch }
  | { type: 'remove';       signature: string }
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
      return patchWhere(
        state,
        ev => ev.signature === patch.signature || ev.mintAddress === patch.mintAddress,
        ev => {
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
        },
      );
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
        ev =>
          (!!patch.signature && ev.signature === patch.signature) ||
          (ev.seller === patch.seller && ev.collectionAddress === patch.collection),
        ev => {
          // Backfill collectionAddress when we matched by signature
          // (the row had it null at sale time but the backend has now
          // resolved it). That repair lets future seller+collection
          // patches for the same wallet+collection light up THIS row
          // too without re-needing a signature match.
          const nextColl    = ev.collectionAddress ?? patch.collection;
          // Sticky-merge count — a later signal-only patch (count=null,
          // signal='multi') must NOT overwrite a previously-resolved
          // DAS count. DAS-resolved values are authoritative; the 🔥
          // signal is supplementary.
          const nextCount   = (typeof patch.count === 'number' && Number.isFinite(patch.count))
            ? patch.count
            : (ev.sellerRemainingCount ?? null);
          const nextSells   = patch.sells10m ?? ev.sellerSells10m ?? 0;
          const nextSignal  = patch.signal ?? null;
          if (
            ev.sellerRemainingCount === nextCount &&
            ev.collectionAddress    === nextColl  &&
            ev.sellerSells10m       === nextSells &&
            ev.sellerSignal         === nextSignal
          ) return ev;
          return {
            ...ev,
            sellerRemainingCount: nextCount,
            sellerSells10m:       nextSells,
            sellerSignal:         nextSignal,
            collectionAddress:    nextColl,
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
