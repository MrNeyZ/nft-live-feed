'use client';

// VictoryLabs — shared collection-floor cache for the floor-delta badge
// (FloorChip) fallback.
//
// Extracted verbatim (behaviour byte-identical) from feed/page.tsx, which
// used to keep this as page-local `useState` + refs — meaning /multi's
// SalesFeedPanel (a separate mounted tree) had no access to it at all, and
// even two /feed tabs never shared a fetch. Module-scope cache (same
// pattern as collection-icons.ts) so every consumer — /feed, /multi, any
// future card feed — reads through the SAME resolved floors: once ANY
// mounted instance fetches a slug's floor, a freshly-mounted instance
// elsewhere gets an instant cache hit instead of re-fetching and possibly
// landing on a different result depending on timing.
//
// Two sources merged into one slug/address-keyed map:
//   - ME-slug floor, via /api/collections/bids (batched, 500ms debounce).
//   - Slug-less cNFT floor (DRiP / Tensor-native), via
//     /api/collections/cnft-floor, keyed by on-chain collection address —
//     `isCnftDust` looks up `meCollectionSlug ?? collectionAddress`, so
//     both sources write into the same map.

import { useEffect, useRef, useState } from 'react';
import type { FeedEvent } from './mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** How long a fetched floor is considered fresh enough to skip a refresh. */
const FLOOR_REQUEST_TTL_MS = 5 * 60_000;
/** Retry TTL when floor fetch returns null (ME 429 / miss) — much shorter. */
const FLOOR_MISS_TTL_MS = 60_000;
/** Bound on the shared cache size. */
const FLOOR_BY_SLUG_MAX = 500;

// Module-scope shared state — every hook instance reads/writes the same
// maps, so the fetch itself is deduped across simultaneously-mounted
// components (not just within one).
const floorCache: Record<string, number | null> = {};
const requestedFloor  = new Map<string, number>();
const pendingFloor    = new Set<string>();
let floorFetchTimer: ReturnType<typeof setTimeout> | null = null;

const requestedCnftAddr = new Map<string, number>();
const pendingCnftAddr   = new Set<string>();
let cnftFloorTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
function notify(): void { for (const l of listeners) l(); }

function boundCache(): void {
  const keys = Object.keys(floorCache);
  if (keys.length > FLOOR_BY_SLUG_MAX) {
    const drop = keys.length - FLOOR_BY_SLUG_MAX;
    for (let i = 0; i < drop; i++) delete floorCache[keys[i]];
  }
}

function scheduleFloorFetch(): void {
  if (pendingFloor.size === 0 || floorFetchTimer) return;
  floorFetchTimer = setTimeout(async () => {
    floorFetchTimer = null;
    const batch = Array.from(pendingFloor).slice(0, 80);
    pendingFloor.clear();
    try {
      const res = await fetch(
        `${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(batch.join(','))}`,
      );
      if (!res.ok) {
        const t = Date.now() - (FLOOR_REQUEST_TTL_MS - FLOOR_MISS_TTL_MS);
        for (const s of batch) requestedFloor.set(s, t);
        return;
      }
      const data = await res.json() as {
        bids?: Record<string, { floorLamports: number | null }>;
      };
      if (!data.bids) return;
      const bids = data.bids;
      const now = Date.now();
      for (const s of batch) {
        const v = bids[s];
        const hasFloor = v != null && typeof v.floorLamports === 'number';
        requestedFloor.set(s, hasFloor ? now : now - (FLOOR_REQUEST_TTL_MS - FLOOR_MISS_TTL_MS));
      }
      for (const [slug, v] of Object.entries(bids)) {
        floorCache[slug] = typeof v.floorLamports === 'number' ? v.floorLamports / 1e9 : null;
      }
      boundCache();
      notify();
    } catch {
      const t = Date.now() - (FLOOR_REQUEST_TTL_MS - FLOOR_MISS_TTL_MS);
      for (const s of batch) requestedFloor.set(s, t);
    }
  }, 500);
}

function scheduleCnftFloorFetch(): void {
  if (pendingCnftAddr.size === 0 || cnftFloorTimer) return;
  cnftFloorTimer = setTimeout(async () => {
    cnftFloorTimer = null;
    const batch = Array.from(pendingCnftAddr).slice(0, 20);
    pendingCnftAddr.clear();
    const fetchedAt = Date.now();
    for (const a of batch) requestedCnftAddr.set(a, fetchedAt);
    try {
      const res = await fetch(
        `${API_BASE}/api/collections/cnft-floor?addresses=${encodeURIComponent(batch.join(','))}`,
      );
      if (!res.ok) return;
      const data = await res.json() as {
        floors?: Record<string, { floorLamports: number | null }>;
      };
      if (!data.floors) return;
      for (const [addr, v] of Object.entries(data.floors)) {
        floorCache[addr] = typeof v.floorLamports === 'number' ? v.floorLamports / 1e9 : null;
      }
      boundCache();
      notify();
    } catch { /* transient — retried on the next unseen slug-less cNFT */ }
  }, 500);
}

/** Slug/address → floor (SOL) or null (resolved miss). Feeds the FloorChip
 *  fallback (`slugFloor` prop on FeedCard) and `isCnftDust`'s floor lookup.
 *  Shared module-scope cache: every mounted instance (/feed, /multi's
 *  SalesFeedPanel, …) reads the same resolved floors. */
export function useFloorBySlug(events: readonly FeedEvent[]): Record<string, number | null> {
  const [, forceRender] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const l = () => forceRender(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    const now = Date.now();
    for (const e of events) {
      if (!e.meCollectionSlug) continue;
      const last = requestedFloor.get(e.meCollectionSlug);
      if (last != null && now - last < FLOOR_REQUEST_TTL_MS) continue;
      pendingFloor.add(e.meCollectionSlug);
    }
    scheduleFloorFetch();

    for (const e of events) {
      if (e.nftType !== 'cnft' || e.meCollectionSlug || !e.collectionAddress) continue;
      const addr = e.collectionAddress;
      const last = requestedCnftAddr.get(addr);
      if (last != null && now - last < FLOOR_REQUEST_TTL_MS) continue;
      pendingCnftAddr.add(addr);
    }
    scheduleCnftFloorFetch();
  }, [events]);

  return floorCache;
}
