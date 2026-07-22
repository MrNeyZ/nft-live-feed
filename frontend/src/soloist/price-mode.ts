// Per-user "Inclusive fees" toggle. Affects only AMM_SELL display.
//
//   Inclusive fees ON  → AMM_SELL shows gross / pool price (always,
//                        overrides the floor-based rule below)
//   Inclusive fees OFF → AMM_SELL shows gross above FLOOR_NET_THRESHOLD_SOL,
//                        seller-net (actual proceeds) at/under it
//
// All other saleTypes (LIST_BUY / AMM_BUY) keep their current
// behaviour, and BID_SELL is hard-pinned to gross regardless of the
// toggle (per spec — bid acceptances always show full bid amount).
//
// Why floor-gated: seller-net is only ever available for the split
// second a tab is live-connected via SSE at the exact moment of the
// sale (it's never persisted — see src/models/sale-event.ts) — so
// showing it unconditionally means the SAME historical sale can render
// two different prices depending on pure browser-reconnect luck, with
// no way to tell which one is "right" after the fact. Above the
// threshold, fee/royalty deductions are a small fraction of a
// meaningful price, so pinning to the always-available, always-
// reproducible gross price removes that flakiness entirely. Below the
// threshold the deduction is proportionally large enough that net is
// worth showing despite the flakiness — this is a deliberate trade
// the user chose, not an oversight.
//
// Storage:
//   localStorage['vl.priceMode.inclusiveFees'] = '1' | '0'
//   Default: OFF.
//
// Cross-component sync via a custom 'vl:priceMode' event so multiple
// instances of useInclusiveFees() stay in step without prop drilling.

/** Collection floor (SOL) at/under which the OFF state prefers seller-net
 *  over gross for a pool-sell. Above this, gross wins unconditionally. */
export const FLOOR_NET_THRESHOLD_SOL = 0.05;

import { useEffect, useState } from 'react';
import type { FeedEvent } from './mock-data';

const STORAGE_KEY  = 'vl.priceMode.inclusiveFees';
const CHANGE_EVENT = 'vl:priceMode';

export function readInclusiveFees(): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
}

export function writeInclusiveFees(on: boolean): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* quota / private mode */ }
  window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, { detail: on }));
}

/** React hook — current value + setter. Keeps every mounted instance
 *  in sync via the custom event so toggling in the bottom bar updates
 *  the live feed cards immediately without reload. */
export function useInclusiveFees(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(false);
  useEffect(() => {
    setOn(readInclusiveFees());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') setOn(detail);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return [on, writeInclusiveFees];
}

/** Resolve the single price to render for a feed event, given the current
 *  toggle and (when known) the collection's floor. The only saleType that
 *  branches on either is AMM_SELL (`pool_sale`); BID_SELL is pinned to
 *  gross; other types keep the existing `event.price` behaviour
 *  (sellerNet ?? gross).
 *
 *  `slugFloor` is optional/nullable (fallback-cache sourced, same as the
 *  FloorChip's own fallback) — when unknown, falls back to the pre-floor-
 *  rule behaviour (net preferred when available) rather than guessing. */
export function displayPrice(event: FeedEvent, inclusiveFees: boolean, slugFloor?: number | null): number {
  const saleType = event.saleTypeRaw;
  if (saleType === 'pool_sale') {
    if (inclusiveFees) return event.grossPrice;
    const floorAboveThreshold = slugFloor != null && slugFloor > FLOOR_NET_THRESHOLD_SOL;
    if (floorAboveThreshold) return event.grossPrice;
    return event.sellerNetPrice ?? event.price;
  }
  if (saleType === 'bid_sell') {
    return event.grossPrice;
  }
  return event.price;
}
