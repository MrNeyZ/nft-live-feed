/**
 * Process-wide Magic Eden API cooldown.
 *
 * ME rate-limits per IP — a 429 from one caller (enrichment slug resolve,
 * rare-feed rarity, retardio offer scanner) means ALL ME calls from this
 * server share the same exhausted quota. Each component previously tracked
 * its own independent cooldown, so one component hitting 429 didn't stop
 * the others from hammering ME further. This module is the single source
 * of truth: any 429 sets the cooldown here; every caller checks here before
 * making a request.
 */

let cooldownUntil = 0;

/** True while ME is in a 429 cooldown. */
export function meCooldownActive(): boolean {
  return Date.now() < cooldownUntil;
}

/**
 * Record a ME 429. Extends the cooldown by `ms` (default 60 s).
 * Uses Math.max so back-to-back 429s don't shorten an already-set window.
 */
export function setMeCooldown(ms = 60_000): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

/** Remaining cooldown milliseconds (0 when not cooling). */
export function meCooldownRemainMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}
