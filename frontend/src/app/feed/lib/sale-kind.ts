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


// Direction palette — asymmetric tuning so SELL reads sharper than BUY
// (trader-UI semantics: profit calm, exit urgent). The previous SELL
// at rgb(255,90,90) bg 0.10 still read as burgundy because G = B = 90
// means 35 % of the red channel was neutral grey, which mixed into the
// dark purple bg as red-grey-purple = burgundy. Fixing it required
// dropping G aggressively (not bumping R further):
//   BUY  → unchanged: rgb(64,212,168) bg 0.18 — calm soft emerald.
//   SELL → rgb(255,70,86) bg 0.14 — G dropped 90 → 70 cuts grey
//          washout ~22 %, so red dominates instead of red+grey.
//          B = 86 (slightly > G) gives a subtle cool lean matching
//          Hyperliquid #F6465D / Binance #F84960 / TradingView
//          #F23645 — modern perp terminal reds all live at G ≤ 73.
//          bg α nudged 0.10 → 0.14: with the cooler/sharper hue, the
//          bg can be visibly present without re-introducing the
//          burgundy mud.
// Pill chrome is asymmetric (see pill JSX below): BUY keeps the
// glassy inset highlight + bottom shadow; SELL replaces it with a
// crisp 1 px inset ring. Same geometry, different emotional weight.
export const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: 'rgb(64,212,168)',  bg: 'rgba(64,212,168,0.18)',  borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: 'rgb(245,88,102)',  bg: 'rgba(36,14,20,0.85)',    borderTone: 'sell' },
  buyAmm:  { label: 'AMM',  fg: 'rgb(64,212,168)',  bg: 'rgba(64,212,168,0.18)',  borderTone: 'buy'  },
  // sellAmm fg darkened 245→215 (~12 %) to differentiate "direct sell"
  // (SELL pill) from "pool sell" (AMM pill). Same scarlet family, same
  // cool lean (B − G = 15), just slightly lower contrast — the pill
  // reads "in family but secondary" without leaving the unified red
  // palette.
  sellAmm: { label: 'AMM',  fg: 'rgb(215,80,95)',   bg: 'rgba(36,14,20,0.85)',    borderTone: 'sell' },
  unknown: { label: '—',    fg: '#8f8fa8',          bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
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
