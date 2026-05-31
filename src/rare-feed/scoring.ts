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
      const rec = t as Record<string, unknown>;
      const value = String(rec.value ?? '');
      const key   = String(rec.trait_type ?? rec.traitType ?? '');
      if (ONE_OF_ONE_RE.test(value) || ONE_OF_ONE_RE.test(key)) return true;
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
