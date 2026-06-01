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

// ── Tensor-style rarity tiers + per-tier price (floor-delta) caps ────────────
// A rare item legitimately commands a premium that scales with rarity, so the
// price gate is per-tier instead of a single flat near-floor cap. Below EPIC
// (percentile > 15%) is excluded entirely — old strict behavior preserved.
//   MYTHIC    ≤ 1%  → up to +300% above floor (sale ≤ floor × 4.0)
//   LEGENDARY ≤ 5%  → up to +150% above floor (sale ≤ floor × 2.5)
//   EPIC      ≤ 15% → up to  +50% above floor (sale ≤ floor × 1.5)
export const TIER_MYTHIC_PCT    = 0.01;
export const TIER_LEGENDARY_PCT = 0.05;
export const TIER_EPIC_PCT      = 0.15;
const TIER_MAX_FLOOR_DELTA: Record<'MYTHIC' | 'LEGENDARY' | 'EPIC', number> = {
  MYTHIC:    3.0,
  LEGENDARY: 1.5,
  EPIC:      0.5,
};
/** Floor on the final score for a QUALIFYING sale, so a rare-but-above-floor
 *  sale (small/zero price boost) still clears the default min-score gate (40)
 *  and is actually visible. */
const MIN_QUALIFY_SCORE = 40;

function tierFor(percentile: number): 'MYTHIC' | 'LEGENDARY' | 'EPIC' | null {
  if (percentile <= TIER_MYTHIC_PCT)    return 'MYTHIC';
  if (percentile <= TIER_LEGENDARY_PCT) return 'LEGENDARY';
  if (percentile <= TIER_EPIC_PCT)      return 'EPIC';
  return null;                            // below EPIC → not rare enough
}
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

/** Explicit "1/1" markers: "1/1", "1 / 1", "1 of 1", "one of one",
 *  "one-of-one". Deliberately NOT matching bare "unique"/"legendary" — those
 *  are too common as ordinary traits and would create false positives. */
const ONE_OF_ONE_RE = /\b(?:1\s*\/\s*1|1\s+of\s+1|one[-\s]of[-\s]one)\b/i;

/** Synthetic score for a force-included true 1/1 — sits at the top of the feed
 *  and clears any min-score gate. */
export const ONE_OF_ONE_SCORE = 100;

/**
 * Conservative true-1/1 detector (pure; no I/O). Returns true ONLY when:
 *   • an explicit 1/1 marker is present in the NFT name OR an attribute
 *     (trait value or trait_type), AND
 *   • the collection is multi-item (totalSupply > 1), AND
 *   • the rarity system actually RANKS this collection (rarityRank != null).
 *
 * The rank guard is what prevents a flood from "every item is unique art"
 * collections: those carry no generative ranks (rarityRank null), so they are
 * excluded here. This catches the real target — a genuine 1/1 sitting inside a
 * larger generative collection, which the percentile gate would wrongly reject
 * because its generative rank (e.g. 3227) looks common.
 */
export function isTrueOneOfOne(
  traits: unknown,
  nftName: string | null | undefined,
  totalSupply: number | null,
  rarityRank: number | null,
): boolean {
  if (rarityRank == null) return false;
  if (totalSupply == null || totalSupply <= 1) return false;

  if (nftName && ONE_OF_ONE_RE.test(nftName)) return true;

  if (Array.isArray(traits)) {
    for (const t of traits) {
      if (!t || typeof t !== 'object') continue;
      // Match the 1/1 marker ONLY in the trait VALUE — never the trait_type/key.
      // Collections like y00ts / MidEvil / The Seven Seas use a trait_type of
      // "1/1" or "1/1 Status" with value "None"/"False"/"No" to mean "this is
      // NOT a 1/1"; matching the key turned those into false positives. A real
      // 1/1 (e.g. Liminal #10) carries the marker in the VALUE: value "1/1"
      // with trait_type "Special".
      const value = String((t as Record<string, unknown>).value ?? '');
      if (ONE_OF_ONE_RE.test(value)) return true;
    }
  }
  return false;
}

/** Evaluate a candidate. Caller guarantees rank/supply/floor are present and
 *  positive — this function does not fetch anything and never throws. */
export function scoreSale(input: ScoreInput): ScoreResult {
  const { rarityRank, totalSupply, salePrice, floorPrice } = input;

  const rarityPercentile = rarityRank / totalSupply;
  const floorDeltaPct    = (salePrice - floorPrice) / floorPrice;

  // Gate. Rarity tier first; below EPIC (>15%) is excluded. Then a per-tier
  // price cap that lets higher tiers command a larger above-floor premium.
  const tier       = tierFor(rarityPercentile);
  const rareEnough = tier != null;
  const priceOk    = tier != null && floorDeltaPct <= TIER_MAX_FLOOR_DELTA[tier];
  const qualifies  = rareEnough && priceOk;
  const rejectReason: 'rarity' | 'price' | null =
    !rareEnough ? 'rarity' : !priceOk ? 'price' : null;

  // Score. Rarity-led (unchanged formula) with a price boost/penalty; a
  // qualifying sale is floored at MIN_QUALIFY_SCORE so an above-floor rare
  // sale still clears the default min-score gate and is visible.
  const rarityScore = clamp(40 + (TOP_10 - rarityPercentile) / TOP_10 * 60, 40, 100);
  const discountPct = (floorPrice - salePrice) / floorPrice;   // +0.20 = 20% below floor
  const priceBoost  = clamp(discountPct * 100 * 0.6, -8, 30);
  let   score       = clamp(rarityScore + priceBoost, 0, 100);
  if (qualifies) score = Math.max(score, MIN_QUALIFY_SCORE);

  const belowFloor = salePrice <= floorPrice * BELOW_FLOOR_RATIO;

  const reasonTags: string[] = [];
  // Backward-compatible TOP_* tags (drive the UI rarity tabs).
  if (rarityPercentile <= TOP_10) reasonTags.push('TOP_10');
  if (rarityPercentile <= TOP_5)  reasonTags.push('TOP_5');
  if (rarityPercentile <= TOP_1)  reasonTags.push('TOP_1');
  // Tier tag (MYTHIC / LEGENDARY / EPIC) for qualifying sales.
  if (qualifies && tier) reasonTags.push(tier);
  // Price-position tag: only label BELOW/NEAR floor when actually so — an
  // above-floor tier premium gets neither (the tier tag conveys it).
  if (qualifies && belowFloor)                              reasonTags.push('BELOW_FLOOR');
  else if (qualifies && salePrice <= floorPrice * NEAR_FLOOR_RATIO) reasonTags.push('NEAR_FLOOR');

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
