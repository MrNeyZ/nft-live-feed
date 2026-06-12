// Pure decision for the Live Feed Sales "below floor" deep-discount SOUND alert.
// Extracted from feed/page.tsx so the eligibility rules are testable in
// isolation (no React / SSE / audio deps — just numbers in, boolean out).
//
// Floor source contract: callers MUST pass the TRUSTED collection floor — the
// Magic Eden /collections/{slug}/stats floor cached in `floorBySlug` — NOT the
// wire `floorDelta`, whose backend floor is the listings-store "min observed
// listing" and can be polluted to a few thousandths of a SOL by an MMM/AMM pool
// sale or a lowball relist. See the audit note in feed/page.tsx.

/** Minimum collection floor (SOL) for the below-floor alert to be eligible.
 *  A sub-0.02-SOL floor isn't a meaningful flip even at a large negative %, so
 *  those collections never play the sound. The gate is on the FLOOR, never the
 *  sale price — a 0.1-floor collection selling at 0.004 must still alert. */
export const MIN_BELOW_FLOOR_ALERT_FLOOR_SOL = 0.02;

/** Alert fires when the sale is at or below this fraction of floor
 *  (delta = price/floor − 1). −0.5 ⇒ price ≤ 50% of floor. */
export const BELOW_FLOOR_ALERT_DELTA = -0.5;

/**
 * Whether a live sale should play the below-floor deep-discount alert.
 *
 * @param floorSol  trusted collection floor in SOL (ME /stats). null/0/NaN ⇒ no alert.
 * @param priceSol  sale price in SOL. Any positive value is allowed — the
 *                  tiny-floor gate is on the floor, not the price.
 */
export function shouldPlayBelowFloorAlert(
  floorSol: number | null | undefined,
  priceSol: number | null | undefined,
): boolean {
  // Rule 1: floor missing / null / 0 / non-finite → can't trust the delta.
  if (typeof floorSol !== 'number' || !Number.isFinite(floorSol)) return false;
  // Rule 2: tiny-floor suppression — sub-0.02-SOL floors are value noise.
  if (floorSol <= MIN_BELOW_FLOOR_ALERT_FLOOR_SOL) return false;
  // Price must be a real positive number to form a meaningful delta.
  if (typeof priceSol !== 'number' || !Number.isFinite(priceSol) || priceSol <= 0) return false;
  const delta = (priceSol - floorSol) / floorSol;
  return delta <= BELOW_FLOOR_ALERT_DELTA;
}
