// Per-user "Inclusive fees" toggle. Affects only AMM_SELL display.
//
//   Inclusive fees ON  → AMM_SELL shows gross / pool price
//   Inclusive fees OFF → AMM_SELL shows seller-net (actual proceeds)
//
// All other saleTypes (LIST_BUY / AMM_BUY) keep their current
// behaviour, and BID_SELL is hard-pinned to gross regardless of the
// toggle (per spec — bid acceptances always show full bid amount).
//
// Storage:
//   localStorage['vl.priceMode.inclusiveFees'] = '1' | '0'
//   Default: OFF.
//
// Cross-component sync via a custom 'vl:priceMode' event so multiple
// instances of useInclusiveFees() stay in step without prop drilling.

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

/** Resolve the single price to render for a feed event, given the
 *  current toggle. The only saleType that branches on the toggle is
 *  AMM_SELL (`pool_sale`); BID_SELL is pinned to gross; other types
 *  keep the existing `event.price` behaviour (sellerNet ?? gross). */
export function displayPrice(event: FeedEvent, inclusiveFees: boolean): number {
  const saleType = event.saleTypeRaw;
  if (saleType === 'pool_sale') {
    if (inclusiveFees) return event.grossPrice;
    return event.sellerNetPrice ?? event.price;
  }
  if (saleType === 'bid_sell') {
    return event.grossPrice;
  }
  return event.price;
}
