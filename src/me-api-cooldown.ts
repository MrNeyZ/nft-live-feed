/**
 * Process-wide Magic Eden API cooldown + shared auth headers.
 *
 * ME rate-limits per IP — a 429 from one caller (enrichment slug resolve,
 * rare-feed rarity, retardio offer scanner) means ALL ME calls from this
 * server share the same exhausted quota. Each component previously tracked
 * its own independent cooldown, so one component hitting 429 didn't stop
 * the others from hammering ME further. This module is the single source
 * of truth: any 429 sets the cooldown here; every caller checks here before
 * making a request.
 *
 * `meAuthHeaders()` is the same single-source-of-truth idea applied to the
 * API key: keyless ME calls hit Cloudflare's per-IP limiter (HTTP 429 /
 * "error code: 1015") much sooner than authed ones (see enrich.ts's own
 * original comment on this, where the key was first wired in). Every ME
 * fetch call site in the project should spread this into its headers
 * rather than re-reading `process.env.ME_API_KEY` locally.
 */

let cooldownUntil = 0;

const ME_API_KEY = process.env.ME_API_KEY ?? process.env.MAGIC_EDEN_API_KEY ?? '';

/** Spread into a fetch `headers` object. Empty object when no key is set
 *  (keyless behaviour, unchanged from before any key existed). Never
 *  throws — a missing key is a valid, supported state, not an error. */
export function meAuthHeaders(): Record<string, string> {
  return ME_API_KEY ? { Authorization: `Bearer ${ME_API_KEY}` } : {};
}

/** True when a key is configured. The single source of truth for any
 *  "is ME auth available?" check (route enable/disable flags, hard gates
 *  that must 503 without a key) — callers should use this instead of
 *  re-reading `process.env.ME_API_KEY` directly. */
export function hasMeApiKey(): boolean {
  return ME_API_KEY.length > 0;
}

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
