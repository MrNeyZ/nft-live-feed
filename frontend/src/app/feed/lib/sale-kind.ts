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


// Direction + routing palette.
//
// Direction (BUY / SELL): green / red — trader convention preserved.
//   BUY  → rgb(64,212,168) bg 0.18 — calm soft emerald.
//   SELL → rgb(255,70,86)  bg 0.14 — cool-leaning red matching
//          Hyperliquid #F6465D / Binance #F84960 / TradingView #F23645.
// Pill chrome is asymmetric (see pill JSX in page.tsx): BUY keeps a
// glassy inset highlight + bottom shadow; SELL replaces it with a
// crisp 1 px red inset ring. Same geometry, different emotional weight.
//
// Routing (AMM): violet, decoupled from direction. v2 audit H-03 fix:
// when both buyAmm and sellAmm shared the green/red palette, AMM read
// as a direction signal — particularly sellAmm, which was visually
// indistinguishable from SELL at a glance, conflating "pool route"
// with "exit". AMM is a routing CLASS, not a direction, so both
// buyAmm and sellAmm now wear the project's canonical lilac accent
// (#a890e8) as an outlined chip. The card's left/right edge stripe
// stays direction-driven via `borderTone` (the .buy-card / .sell-card
// CSS classes) — so a sellAmm tx still has a red side accent at the
// card level, only the pill itself reads neutral-route.
//
// Why this specific violet: `rgb(168,144,232)` matches the rest of
// the VictoryLabs accent family (Metaplex Core source badge, COLL
// marker, tools-row hover ring). Reusing the same hex keeps the AMM
// pill in the same colour-family as every other "this is a class
// tag, not a direction" cue in the product.
export const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: 'rgb(64,212,168)',   bg: 'rgba(64,212,168,0.18)',   borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: 'rgb(245,88,102)',   bg: 'rgba(36,14,20,0.85)',     borderTone: 'sell' },
  // AMM badges now share one routing palette regardless of side.
  // `borderTone` still tracks direction so the card edge keeps the
  // buy/sell colour signal (audit H-03 explicitly preserves this:
  // direction lives on the card, routing lives on the pill).
  buyAmm:  { label: 'AMM',  fg: 'rgb(168,144,232)',  bg: 'rgba(168,144,232,0.12)',  borderTone: 'buy'  },
  sellAmm: { label: 'AMM',  fg: 'rgb(168,144,232)',  bg: 'rgba(168,144,232,0.12)',  borderTone: 'sell' },
  unknown: { label: '—',    fg: '#8f8fa8',           bg: 'rgba(255,255,255,0.05)',  borderTone: 'neutral' },
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
