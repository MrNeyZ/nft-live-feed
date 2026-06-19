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


// Solid-capsule action palette (live-feed-final.html reference).
//
// Each direction is a vertical gradient fill with dark text, rendered
// as a solid capsule in the pill render (see feed-card.tsx). `bg` is a
// `linear-gradient(...)` string and `fg` is the dark on-fill text:
//   BUY  → green gradient rgb(52,172,136) → rgb(25,116,86), text #04140e.
//   SELL → red   gradient rgb(199,71,83)  → rgb(144,48,65), text #1c0307.
// Hues are VictoryLabs' direction colors at ~81 % intensity — the
// full-strength stops (buy rgb(64,212,168)→rgb(31,143,106), sell
// rgb(245,88,102)→rgb(178,59,80)) read too loud against the price, so
// every channel is scaled ×0.9 twice (hue preserved, intensity dialled
// back so the capsule reads as a calm Bloomberg-style tag, never a CTA
// button). Trader convention preserved: green buy / red sell, SELL in
// the Hyperliquid / Binance / TradingView red family.
//
// AMM (buyAmm / sellAmm): the SAME capsule as its BUY / SELL sibling —
// identical solid fill, no transparency, no halo. The pool-route
// distinction is carried entirely by symmetric triangles framing the
// label in the pill render (▲ AMM ▲ buy-side / ▼ AMM ▼ sell-side), so
// AMM reads with the same weight as a direct buy/sell, never weaker.
//
// The card's left/right edge stripe stays direction-driven via
// `borderTone` (.buy-card / .sell-card CSS classes) — unchanged.
export const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: '#04140e', bg: 'linear-gradient(180deg,rgb(52,172,136),rgb(25,116,86))', borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: '#1c0307', bg: 'linear-gradient(180deg,rgb(199,71,83),rgb(144,48,65))',  borderTone: 'sell' },
  buyAmm:  { label: 'AMM',  fg: '#04140e', bg: 'linear-gradient(180deg,rgb(52,172,136),rgb(25,116,86))', borderTone: 'buy'  },
  sellAmm: { label: 'AMM',  fg: '#1c0307', bg: 'linear-gradient(180deg,rgb(199,71,83),rgb(144,48,65))',  borderTone: 'sell' },
  unknown: { label: '—',    fg: '#9a9ab4', bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
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
