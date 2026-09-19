/**
 * Isolated ME-API cooldown for the operator TRADE tools (tools-me-bids.ts,
 * tools-me-sell.ts) — decoupled from the shared, process-wide
 * `me-api-cooldown.ts` window that every BACKGROUND ME consumer draws from
 * (rare-feed rarity, retardio/solanart offer scanners, mmm-pool-type
 * resolver, per-sale enrichment token/collection caches, me-stats).
 *
 * WHY (same reasoning as me-stats.ts's own isolation comment):
 *   The background consumers fan out dozens of ME calls per minute off the
 *   live listener and dashboard polls. Any one of them hitting a 429 on the
 *   shared IP quota trips `meCooldownActive()` for 60s. The trade tools make
 *   near-zero ME traffic (a handful of hand-driven calls when the operator
 *   is actively accepting/placing one offer) but were gated by that SAME
 *   shared window — so a background mmm-pool-type scan getting throttled
 *   made `/tools/me-sell` refuse with `me_api_cooldown_active` before it
 *   even tried its own request. Confirmed live 2026-09-09.
 *
 * The trade tools are the highest-value, most latency-sensitive, lowest-
 * volume ME consumers in the project — they should not compete with
 * background scanners for the same cooldown state. This window is set ONLY
 * when a trade tool's OWN request comes back 429, and is short: a real
 * authed-key 429 is rare and usually transient.
 *
 * On a real 429 the trade tools still ALSO bump the shared window (courtesy:
 * if our authed key is being throttled, the keyless background callers
 * should back off too) — see the providers in tools-me-bids.ts /
 * tools-me-sell.ts. The asymmetry is deliberate: shared 429 → trade tools
 * unaffected; trade 429 → everyone backs off.
 */

let cooldownUntil = 0;

/** True while a trade tool's own ME request 429'd within the last window. */
export function meTradeCooldownActive(): boolean {
  return Date.now() < cooldownUntil;
}

/** Record a 429 from a trade tool's own ME call. Default 30s — short,
 *  because an authed-key 429 is rare and transient. Math.max so back-to-back
 *  429s never shorten an already-set window. */
export function setMeTradeCooldown(ms = 30_000): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

/** Remaining cooldown milliseconds (0 when not cooling). */
export function meTradeCooldownRemainMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}
