/**
 * Rare Feed — pure scoring + filter logic. No I/O, no side effects.
 *
 *   rarity_percentile = rarity_rank / total_supply   (0 = rarest)
 *
 *   A sale QUALIFIES when it has rank + supply + floor AND:
 *     rarity:  percentile <= 0.10            (top-10% — excludes the common 90%)
 *     price:   salePrice  <= floor * (1 + NEAR_FLOOR_PCT)   (at/near/below floor)
 *
 *   So below-floor AND near-floor rare sales both qualify; overpays for rare
 *   items are excluded. NEAR_FLOOR_PCT is env-tunable (RARE_FEED_NEAR_FLOOR_PCT,
 *   default 0.10 = within 10% above floor).
 *
 *   Score (0–100) — rarity-led with a price boost:
 *     rarityScore = clamp(40 + (0.10 - pct)/0.10 * 60, 40, 100)
 *                   → top-10%≈40, top-5%≈70, top-1%≈94, rarest=100
 *     priceBoost  = clamp(((floor - sale)/floor) * 100 * 0.6, -8, +30)
 *                   → below-floor boosts up to +30; near-floor (above) small penalty
 *     score       = clamp(rarityScore + priceBoost, 0, 100)
 *
 *   (The previous formula put rarityScore at 0 on the 10% boundary, collapsing
 *   most qualifying sales to single-digit scores — see git history.)
 *
 *   Reason tags (cumulative rarity so the UI Top-1/5/10 toggle is a simple
 *   includes()):  TOP_1 / TOP_5 / TOP_10, plus BELOW_FLOOR (sale<=floor*0.95)
 *   or NEAR_FLOOR (qualifying but at/above floor).
 */

export const TOP_10 = 0.10;
export const TOP_5  = 0.05;
export const TOP_1  = 0.01;
/** "BELOW_FLOOR" tag threshold: at least 5% under floor. */
export const BELOW_FLOOR_RATIO = 0.95;
/** Legacy export (kept for back-compat); the live gate uses NEAR_FLOOR_MAX_RATIO. */
export const NEAR_FLOOR_RATIO  = 1.05;

/** How far above floor a rare sale may still qualify (env-tunable). */
const NEAR_FLOOR_PCT = (() => {
  const raw = parseFloat(process.env.RARE_FEED_NEAR_FLOOR_PCT ?? '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.10;
})();
/** Max sale/floor ratio that still qualifies (default 1.10). */
export const NEAR_FLOOR_MAX_RATIO = 1 + NEAR_FLOOR_PCT;

export interface ScoreInput {
  rarityRank:  number;
  totalSupply: number;
  salePrice:   number;   // SOL
  floorPrice:  number;   // SOL
}

export interface ScoreResult {
  qualifies:        boolean;
  /** Why it was rejected (null when it qualifies) — drives evaluator counters. */
  rejectReason:     'rarity' | 'price' | null;
  rarityPercentile: number;
  rarityScore:      number;
  priceScore:       number;   // the price boost component (may be negative)
  score:            number;
  floorDeltaPct:    number;   // (sale - floor) / floor
  reasonTags:       string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Evaluate a candidate. Caller guarantees rank/supply/floor are present and
 *  positive — this function does not fetch anything and never throws. */
export function scoreSale(input: ScoreInput): ScoreResult {
  const { rarityRank, totalSupply, salePrice, floorPrice } = input;

  const rarityPercentile = rarityRank / totalSupply;
  const floorDeltaPct    = (salePrice - floorPrice) / floorPrice;

  // Gate.
  const rareEnough = rarityPercentile <= TOP_10;
  const priceOk    = salePrice <= floorPrice * NEAR_FLOOR_MAX_RATIO;
  const qualifies  = rareEnough && priceOk;
  const rejectReason: 'rarity' | 'price' | null =
    !rareEnough ? 'rarity' : !priceOk ? 'price' : null;

  // Score.
  const rarityScore = clamp(40 + (TOP_10 - rarityPercentile) / TOP_10 * 60, 40, 100);
  const discountPct = (floorPrice - salePrice) / floorPrice;   // +0.20 = 20% below floor
  const priceBoost  = clamp(discountPct * 100 * 0.6, -8, 30);
  const score       = clamp(rarityScore + priceBoost, 0, 100);

  const belowFloor = salePrice <= floorPrice * BELOW_FLOOR_RATIO;

  const reasonTags: string[] = [];
  if (rarityPercentile <= TOP_10) reasonTags.push('TOP_10');
  if (rarityPercentile <= TOP_5)  reasonTags.push('TOP_5');
  if (rarityPercentile <= TOP_1)  reasonTags.push('TOP_1');
  if (qualifies && belowFloor)    reasonTags.push('BELOW_FLOOR');
  else if (qualifies)             reasonTags.push('NEAR_FLOOR');

  return {
    qualifies,
    rejectReason,
    rarityPercentile,
    rarityScore,
    priceScore: priceBoost,
    score: Math.round(score * 100) / 100,
    floorDeltaPct,
    reasonTags,
  };
}
