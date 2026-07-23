// Per-user "Inclusive fees" toggle.
//
// Two sale categories, one fixed rule each:
//   - Instant sells (pool takeBid / direct bid acceptance — `pool_sale` and
//     `bid_sell`): the buyer's bid includes fees/royalty the seller doesn't
//     keep, so default to what the seller actually received. "Inclusive
//     fees" ON shows the full bid amount instead.
//   - Normal sales (by listing — everything else): always the full listed
//     price. No fee ambiguity here, so the toggle doesn't apply.
//
// Previously this branched further on a collection-floor threshold to
// avoid the SAME sale rendering two different prices depending on whether
// seller-net (SSE-only, never persisted) happened to be available at
// render time. That flakiness is real, but the user chose consistency
// (always net for instant sells, always gross for listing sells) over the
// floor-gated compromise — see conversation 2026-07-23.
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

/** Resolve the single price to render for a feed event, given the current
 *  "Inclusive fees" toggle. Instant sells (`pool_sale`, `bid_sell` — pool
 *  takeBid or a direct bid acceptance) default to seller-net; every other
 *  saleType (normal sale by listing) always shows the full gross price. */
export function displayPrice(event: FeedEvent, inclusiveFees: boolean): number {
  const saleType = event.saleTypeRaw;
  if (saleType === 'pool_sale' || saleType === 'bid_sell') {
    if (inclusiveFees) return event.grossPrice;
    return event.sellerNetPrice ?? event.grossPrice;
  }
  return event.grossPrice;
}
