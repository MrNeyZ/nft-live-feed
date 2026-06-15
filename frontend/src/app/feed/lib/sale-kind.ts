// VictoryLabs — Feed: sale-type classification + badge style table.
// Extracted verbatim from page.tsx. Pure mappers from raw wire
// `sale_type` → display SaleKind + per-kind badge style. The 🍀 /
// 🃏 emoji markers stay at the FeedCard render site (they read the
// raw `saleTypeRaw` literal directly, not via these constants).

import type { SaleKind, KindStyle } from './types';

/** Canonical backend `sale_type` values, derived in src/domain/sale-type.ts.
 *  Listings is intentionally absent — the backend does not yet emit listing
 *  events, so the Listings filter is wired but renders empty. */
export const SALE_TYPE_BUY      = 'normal_sale'; // default buy / list buy
export const SALE_TYPE_SELL     = 'bid_sell';    // sell into bid
export const SALE_TYPE_BUY_AMM  = 'pool_buy';    // buy from AMM/pool
export const SALE_TYPE_SELL_AMM = 'pool_sale';   // sell into AMM/pool
export const SALE_TYPE_LUCKY    = 'lucky_buy';   // ME Lucky Buy raffle settlement
export const SALE_TYPE_PACK     = 'pack_open';   // ME Packs — buyer opened a pack


// Direction-first palette with subtle AMM glow.
//
// Direction (BUY / SELL): green / red — trader convention preserved.
//   BUY  → rgb(64,212,168) bg α 0.18 — calm soft emerald.
//   SELL → rgb(245,88,102) bg α 0.16 — cool-leaning red matching
//          Hyperliquid #F6465D / Binance #F84960 / TradingView #F23645.
//          Bg lightened from the previous near-opaque burgundy
//          (rgba(36,14,20,0.85)) to a translucent red so SELL pills
//          share BUY's chip paradigm: matching visual weight, same
//          glassy inset chrome, only the hue differs.
//
// AMM (buyAmm / sellAmm): direction-coloured pill identical to its
// BUY / SELL sibling — visual sidedness comes first. The "pool route"
// distinction is carried by a soft outer halo at the same hue, added
// in the pill render (see page.tsx). The prior violet AMM treatment
// was reverted because it over-separated routing from direction:
// sellAmm pills no longer read as sell-side pressure at a glance.
// New convention: hue carries direction, halo carries route.
//
// The card's left/right edge stripe stays direction-driven via
// `borderTone` (.buy-card / .sell-card CSS classes) — unchanged.
export const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: 'rgb(64,212,168)',  bg: 'rgba(64,212,168,0.18)',  borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: 'rgb(245,88,102)',  bg: 'rgba(245,88,102,0.16)',  borderTone: 'sell' },
  // AMM siblings match their direction parent for fg+bg; pill render
  // appends a faint outer halo at the same hue when kind is buyAmm /
  // sellAmm so the route distinction is a "lean in to spot" signal,
  // not a hue swap. Same `borderTone` values keep the card edge
  // direction-consistent.
  buyAmm:  { label: 'AMM',  fg: 'rgb(64,212,168)',  bg: 'rgba(64,212,168,0.18)',  borderTone: 'buy'  },
  sellAmm: { label: 'AMM',  fg: 'rgb(245,88,102)',  bg: 'rgba(245,88,102,0.16)',  borderTone: 'sell' },
  unknown: { label: '—',    fg: '#9a9ab4',          bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
};

export function saleKind(saleTypeRaw: string | null): SaleKind {
  switch (saleTypeRaw) {
    case SALE_TYPE_BUY:      return 'buy';
    case SALE_TYPE_SELL:     return 'sell';
    case SALE_TYPE_BUY_AMM:  return 'buyAmm';
    case SALE_TYPE_SELL_AMM: return 'sellAmm';
    // Lucky Buy is still a buy from the seller's perspective; the
    // 🍀 marker rendered next to the NFT name communicates the
    // raffle origin separately.
    case SALE_TYPE_LUCKY:    return 'buy';
    // Pack open is a buy from the user's perspective — they paid for
    // a pack and received this NFT. The 🃏 marker next to the NFT
    // name communicates the pack-origin separately.
    case SALE_TYPE_PACK:     return 'buy';
    default:                 return 'unknown';
  }
}

/**
 * NFT-type → thin border color for the card thumbnail. Backend values:
 *   legacy / pnft        → pale yellow
 *   metaplex_core / core → pale pink
 *   cnft                 → pale purple (visibly distinct from pink)
 *   anything else        → null (no border)
 */
export function getNftBorderColor(nftType: string): string | null {
  // Full-opacity colors — the inset dark ring (applied at the call site)
  // gives contrast against light NFTs, so we don't need translucency to
  // soften the colored line; full saturation keeps it readable on dark
  // NFTs and against the feed background.
  switch (nftType) {
    case 'legacy':
    case 'pnft':          return '#ffe082';  // pale yellow
    case 'metaplex_core':
    case 'core':          return '#ff9eb8';  // pale pink
    case 'cnft':          return '#ba8aff';  // pale purple — clearly cooler than pink
    default:              return null;
  }
}
