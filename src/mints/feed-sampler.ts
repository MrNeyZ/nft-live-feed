/**
 * Live Mint Feed card sampler.
 *
 * Decides — AFTER a mint has already been counted into the collection
 * accumulator — whether the individual NFT card is emitted into the
 * Live Mint Feed (SSE `mint` frame + recent-mint replay buffer + per-NFT
 * DAS enrichment).
 *
 * HARD RULE: this module NEVER affects mint counting, MINTS column,
 * ACTIVE/RECENT ranking, supply, or `mint_status` frames. Those are the
 * source of truth and always reflect 100% of accepted mints. We only thin
 * the *visual* per-NFT cards under high mint velocity, while still letting
 * every collection periodically surface so users see minting is happening.
 *
 * Sampling is VELOCITY-based, never supply-based: a 5000-supply collection
 * that drips a few mints every few minutes stays fully visible; a hype mint
 * doing hundreds/minute gets thinned. Velocity is read from the
 * accumulator's existing rolling 5-minute window (`events5m.length`), so we
 * add no new bookkeeping for the rate itself.
 */

/** Velocity tiers → keep roughly 1 of every `keepEvery` cards.
 *  `keepEvery === 1` means emit all. Thresholds are mints-per-5-minutes. */
interface Tier { maxPer5m: number; keepEvery: number; label: string; }
const TIERS: Tier[] = [
  { maxPer5m: 10,       keepEvery: 1,  label: '<=10/5m'    }, // show all
  { maxPer5m: 50,       keepEvery: 1,  label: '10-50/5m'   }, // all / nearly all
  { maxPer5m: 200,      keepEvery: 3,  label: '50-200/5m'  }, // ~1 of 3
  { maxPer5m: 500,      keepEvery: 8,  label: '200-500/5m' }, // ~1 of 8
  { maxPer5m: Infinity, keepEvery: 22, label: '500+/5m'    }, // ~1 of 22
];

function tierFor(velocity5m: number): Tier {
  for (const t of TIERS) if (velocity5m <= t.maxPer5m) return t;
  return TIERS[TIERS.length - 1];
}

interface CollStat {
  seq: number;            // running count of mints seen for the decision
  emitted: number;        // feed cards emitted (this collection, lifetime)
  sampledOut: number;     // feed cards suppressed (this collection, lifetime)
  lastVelocity: number;   // last observed mints/5m
  lastKeepEvery: number;  // last applied sampling factor
}

const stats = new Map<string, CollStat>();

/**
 * @param groupingKey  per-collection bucket (e.g. `collection:ABC…`).
 * @param velocity5m   mints in the rolling 5-minute window for this group.
 * @returns true → emit the individual NFT card + enrich; false → sample out
 *          the card only (the mint is already counted by the caller).
 */
export function shouldEmitFeedCard(groupingKey: string, velocity5m: number): boolean {
  const { keepEvery, label } = tierFor(velocity5m);
  let s = stats.get(groupingKey);
  if (!s) {
    s = { seq: 0, emitted: 0, sampledOut: 0, lastVelocity: velocity5m, lastKeepEvery: keepEvery };
    stats.set(groupingKey, s);
  }
  s.lastVelocity  = velocity5m;
  s.lastKeepEvery = keepEvery;

  // Deterministic 1-of-N: emit when seq aligns to the window start. seq=0
  // (first mint of a collection) always emits, so a collection is never
  // fully hidden and always periodically resurfaces under heavy sampling.
  const emit = (s.seq % keepEvery) === 0;
  s.seq++;
  if (emit) s.emitted++; else s.sampledOut++;

  if (MINTS_SAMPLE_DEBUG && keepEvery > 1 && (s.emitted + s.sampledOut) % 25 === 0) {
    console.log(
      `[mints/sample] ${groupingKey.slice(0, 32)}… tier=${label} ` +
      `v5m=${velocity5m} keepEvery=${keepEvery} ` +
      `emitted=${s.emitted} sampledOut=${s.sampledOut} ` +
      `ratio=${ratio(s)}`,
    );
  }
  return emit;
}

function ratio(s: CollStat): string {
  const total = s.emitted + s.sampledOut;
  return total ? (s.emitted / total).toFixed(3) : '1.000';
}

const MINTS_SAMPLE_DEBUG = process.env.MINTS_SAMPLE_DEBUG === '1';

/** Periodic metrics: one summary line per actively-sampled collection.
 *  Logs nothing for collections that emitted everything (keepEvery===1),
 *  so a quiet board produces no noise. */
const METRICS_INTERVAL_MS = 60_000;
const metricsTimer = setInterval(() => {
  for (const [key, s] of stats) {
    const total = s.emitted + s.sampledOut;
    if (s.lastKeepEvery <= 1 || total === 0) continue;
    console.log(
      `[mints/sample-metrics] ${key.slice(0, 40)}… ` +
      `v5m=${s.lastVelocity} keepEvery=${s.lastKeepEvery} ` +
      `emitted=${s.emitted} sampledOut=${s.sampledOut} ratio=${ratio(s)}`,
    );
  }
}, METRICS_INTERVAL_MS);
if (typeof metricsTimer.unref === 'function') metricsTimer.unref();

/** Drop per-collection sampling state when the accumulator evicts a group,
 *  so the Map can't grow unbounded across the process lifetime. */
export function forgetFeedSampling(groupingKey: string): void {
  stats.delete(groupingKey);
}

/** Read-only per-collection sampling counts for the mint_status wire.
 *  `emitted` = feed cards displayed; `sampledOut` = cards suppressed under
 *  velocity sampling (both session-local, same scope as observedMints).
 *  Returns null when the group has no sampling state yet. No side effects,
 *  no behaviour change. */
export function getFeedSampling(groupingKey: string): { emitted: number; sampledOut: number } | null {
  const s = stats.get(groupingKey);
  return s ? { emitted: s.emitted, sampledOut: s.sampledOut } : null;
}
