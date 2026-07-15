// VictoryLabs — Feed: sale-type classification + badge style table.
// Extracted verbatim from page.tsx. Pure mappers from raw wire
// `sale_type` → display SaleKind + per-kind badge style. The 🍀 /
// 🃏 emoji markers stay at the FeedCard render site (they read the
// raw `saleTypeRaw` literal directly, not via these constants).

import type { SaleKind, KindStyle } from './types';
import { VL, VLText, rgb, alpha, ALPHA } from '@/lib/palette';

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
// AMM (buyAmm / sellAmm): a normal BUY / SELL that happens to route
// through a pool — NOT a special event type. The SAME capsule as its
// direction sibling: identical size, typography, fill opacity, radius,
// colours AND border (solid). The ONLY differentiator is a subtle wave
// glyph prefixing the label (∿ AMM), set in the pill render. No
// triangles, glow, or decorations; AMM must never read heavier than a
// direct buy/sell.
//
// The card's left/right edge stripe stays direction-driven via
// `borderTone` (.buy-card / .sell-card CSS classes) — unchanged.
export const KIND_STYLES: Record<SaleKind, KindStyle> = {
  // Tint-tag treatment: the solid gradient capsule read as a loud
  // colour block no matter how far we de-saturated it, and opacity/size
  // were exhausted as levers. So the fill is now a QUIET translucent
  // tint of the direction hue (α 0.13) and the *text* carries the
  // signal — the direction colour at heavy weight (set at the render
  // site). A thin direction-tinted border (added in the render from
  // `borderTone`) gives the tag its edge. Net: calm container, bold
  // instantly-readable label. AMM = same tint + text + border; its pool
  // route is shown only by a subtle wave glyph (∿) before the label.
  //
  // Colour = the direction tokens from the palette: green-strong (BUY) /
  // red-strong (SELL) — the exact hues of the .buy-card/.sell-card card
  // edge stripes — so fill, border and text are all one
  // site-canonical direction colour. Drawn from VL.* (src/lib/palette.ts)
  // so no one-off shade is introduced. Green buy / red sell.
  buy:     { label: 'BUY',  fg: rgb(VL.greenStrong), bg: alpha(VL.greenStrong, ALPHA.tint), borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: rgb(VL.redStrong),   bg: alpha(VL.redStrong, ALPHA.tint),   borderTone: 'sell' },
  buyAmm:  { label: 'AMM',  fg: rgb(VL.greenStrong), bg: alpha(VL.greenStrong, ALPHA.tint), borderTone: 'buy'  },
  sellAmm: { label: 'AMM',  fg: rgb(VL.redStrong),   bg: alpha(VL.redStrong, ALPHA.tint),   borderTone: 'sell' },
  unknown: { label: '—',    fg: VLText.muted, bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
};

/** AMM classification for the pool a sale routed through, normalized
 *  backend-side from Magic Eden's raw poolType — see SaleEvent.poolType. */
export type PoolType = 'buy' | 'sell' | 'two_sided';

/**
 * `isPoolMarketplace` mirrors the same disambiguation `price-mode.ts`'s
 * `displayPrice()` already applies: a pool's `takeBid` (MMM `SolFulfillBuy` /
 * Tensor AMM take-bid) is emitted as `sale_type: 'bid_sell'` — same as a real
 * ME/Tensor collection-bid acceptance from another wallet — but on a pool
 * marketplace (`magic_eden_amm` / `tensor_amm`) it may be an AMM pool sale
 * rather than a plain peer-to-peer sell.
 *
 * Canonical AMM-badge precedence rule (2026-07-15, supersedes the
 * 2026-07-11 poolType-only rule): the ∿ AMM glyph renders when
 *
 *   isPoolMarketplace && (
 *     ammFill === true ||
 *     (ammFill == null && poolType === 'two_sided')
 *   )
 *
 * `ammFill` is the authoritative, transaction-time signal — set
 * synchronously at parse time from the MMM `lp_fee` program log (see
 * `src/ingestion/me-raw/parser.ts`'s "Synchronous AMM-fill classification"
 * block) and PERSISTED (survives REST reads / reloads / collection
 * drill-downs), unlike `poolType`. It is tri-state: `true` (confirmed AMM
 * fill), `false` (confirmed lp_fee===0 ordinary bid acceptance), or
 * `undefined`/`null` (no evidence — e.g. non-MMM sale, MMM fulfillSell
 * direction, an unverified instruction variant, or a pre-existing row).
 *
 * `ammFill === false` is NOT the same as "unknown" and must NEVER fall
 * through to the `poolType` check — that was the exact bug this rule
 * fixes: a stale/wrong ME `poolType` lookup could contradict evidence
 * already confirmed on-chain. `poolType` (resolved out-of-band, async,
 * live/recent sales only — see `src/ingestion/mmm-pool-type-resolver.ts`)
 * is corroboration/fallback ONLY, used exclusively when `ammFill` carries
 * no evidence at all. `'buy'`, `'sell'`, and `undefined`/`null` poolType
 * values (unresolved, lookup failed, or a historical/REST row that never
 * carried it) all still render the plain BUY/SELL in the fallback branch.
 */
export function saleKind(
  saleTypeRaw: string | null,
  isPoolMarketplace = false,
  poolType?: PoolType | null,
  ammFill?: boolean | null,
): SaleKind {
  const showAmm = isPoolMarketplace
    && (ammFill === true || (ammFill == null && poolType === 'two_sided'));
  switch (saleTypeRaw) {
    case SALE_TYPE_BUY:      return 'buy';
    case SALE_TYPE_SELL:     return showAmm ? 'sellAmm' : 'sell';
    case SALE_TYPE_BUY_AMM:  return showAmm ? 'buyAmm'  : 'buy';
    case SALE_TYPE_SELL_AMM: return showAmm ? 'sellAmm' : 'sell';
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
