/**
 * Rare Feed — pure scoring + filter logic. No I/O, no side effects, so the
 * thresholds and formulas can be unit-reasoned and validated in isolation
 * (see the inline VALIDATION cases in src/rare-feed/evaluator.ts).
 *
 * Spec (MVP, deliberately simple):
 *
 *   rarity_percentile = rarity_rank / total_supply   (0 = rarest)
 *
 *   A sale QUALIFIES when it has rank + supply + floor AND either:
 *     (A) below-floor value play
 *           percentile <= 0.10  AND  salePrice <= floor * 0.95
 *     (B) special high-rarity rule
 *           percentile <= 0.01  AND  salePrice <= floor * 1.05
 *
 *   Score (0–100):
 *     rarityScore = clamp((0.10 - percentile) / 0.10 * 100, 0, 100)
 *     priceScore  = clamp(((floor - sale) / floor) * 100, 0, 100)
 *     score       = rarityScore * 0.65 + priceScore * 0.35
 *
 *   Reason tags (cumulative on rarity so the frontend Top-1/5/10 toggle is a
 *   simple `tags.includes(...)`):
 *     TOP_1 / TOP_5 / TOP_10   — percentile <= 0.01 / 0.05 / 0.10
 *     BELOW_FLOOR              — rule (A) matched (sale <= floor * 0.95)
 *     NEAR_FLOOR_TOP_1         — rule (B) matched (top 1% within 5% of floor)
 */

export const TOP_10 = 0.10;
export const TOP_5  = 0.05;
export const TOP_1  = 0.01;
/** Rule (A): at least 5% below floor. */
export const BELOW_FLOOR_RATIO = 0.95;
/** Rule (B): within 5% above floor for top-1% rarity. */
export const NEAR_FLOOR_RATIO  = 1.05;

export interface ScoreInput {
  rarityRank:  number;
  totalSupply: number;
  salePrice:   number;   // SOL
  floorPrice:  number;   // SOL
}

export interface ScoreResult {
  qualifies:        boolean;
  rarityPercentile: number;
  rarityScore:      number;
  priceScore:       number;
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

  const rarityScore = clamp((TOP_10 - rarityPercentile) / TOP_10 * 100, 0, 100);
  const priceScore  = clamp(((floorPrice - salePrice) / floorPrice) * 100, 0, 100);
  const score       = rarityScore * 0.65 + priceScore * 0.35;

  const belowFloor = rarityPercentile <= TOP_10 && salePrice <= floorPrice * BELOW_FLOOR_RATIO;
  const nearFloor  = rarityPercentile <= TOP_1  && salePrice <= floorPrice * NEAR_FLOOR_RATIO;
  const qualifies  = belowFloor || nearFloor;

  const reasonTags: string[] = [];
  if (rarityPercentile <= TOP_10) reasonTags.push('TOP_10');
  if (rarityPercentile <= TOP_5)  reasonTags.push('TOP_5');
  if (rarityPercentile <= TOP_1)  reasonTags.push('TOP_1');
  if (belowFloor)                 reasonTags.push('BELOW_FLOOR');
  if (nearFloor)                  reasonTags.push('NEAR_FLOOR_TOP_1');

  return {
    qualifies,
    rarityPercentile,
    rarityScore,
    priceScore,
    score: Math.round(score * 100) / 100,
    floorDeltaPct,
    reasonTags,
  };
}
