/**
 * In-memory per-(buyer, collection) repeat-near-floor-buy cache. Mirrors the
 * shape of `recent-sell-tracker.ts` (same wallet+collection ring-buffer
 * pattern, same window-trim mechanics), applied to the buy side instead of
 * the sell side.
 *
 * This is a plain factual derived signal — "same buyer + same collection +
 * repeated near-floor buys" — not a claim of whale behavior or intentional
 * floor defense. Deliberately narrow:
 *   - AMM/pool marketplaces (magic_eden_amm, tensor_amm) excluded. A pool's
 *     bonding-curve buying is mechanical, not a discretionary wallet pattern
 *     (same reasoning as the ownership-loop cache).
 *   - Buyer+collection-scoped only. No wallet-wide graph, no collection-level
 *     aggregate, no cross-collection view.
 *   - Depends on `floorDelta`, which is only known after enrich.ts's async
 *     floor lookup resolves — so this check runs at the END of `_enrich()`,
 *     not up front like the ownership-loop check (see enrich.ts wiring).
 *   - floorDelta itself can be stale/manipulated (see discovery); "near
 *     floor" inherits whatever noise the floor cache has.
 */
import { getPool } from '../db/client';
import { RepeatFloorBuyerSignal } from '../models/sale-event';

const WINDOW_MS           = 7 * 24 * 60 * 60 * 1000; // 7d lookback
const HIGH_CONFIDENCE_MS  = 24 * 60 * 60 * 1000;      // 24h — closes faster => higher confidence
const NEAR_FLOOR_MAX      = 0.05;                     // sale price <= floor * 1.05
const MIN_BUY_COUNT       = 3;
const MIN_TOTAL_SPENT_SOL = 1.0;

// Total distinct (buyer, collection) keys tracked — same operational
// safeguard as recent-sell-tracker.ts's MAX_KEYS, oldest insertion-order
// entry dropped when the map would grow past the cap.
const MAX_KEYS = 50_000;

const AMM_MARKETPLACES = new Set(['magic_eden_amm', 'tensor_amm']);

interface Entry { ts: number; priceSol: number; }

// `${buyer}|${collectionAddress}` -> chronological (oldest-first) near-floor buys.
const ring = new Map<string, Entry[]>();

function key(buyer: string, collectionAddress: string): string {
  return `${buyer}|${collectionAddress}`;
}

/** Drop entries older than the window (relative to `referenceTs`). Assumes
 *  `entries` is already oldest-first — true for both the hydration query
 *  (ORDER BY block_time ASC) and the live path (sales normally arrive in
 *  order); a rare out-of-order backfill just makes the window cutoff
 *  approximate, acceptable for this MVP. No count cap — only a time window,
 *  per spec (unlike the ownership-loop cache's 5-hop cap). */
function trim(entries: Entry[], referenceTs: number): Entry[] {
  const cutoff = referenceTs - WINDOW_MS;
  let start = 0;
  while (start < entries.length && entries[start].ts < cutoff) start++;
  return start > 0 ? entries.slice(start) : entries;
}

/**
 * Check + record one sale against the repeat-near-floor-buyer formula.
 * Must be called exactly once per live sale, after `floorDelta` is known.
 *
 * Returns null (no-op or not-yet-detected) when: collection/buyer missing,
 * AMM marketplace, floorDelta null/above the near-floor threshold, price not
 * positive, or the accumulated ring doesn't yet meet buyCount/totalSpentSol.
 */
export function checkAndRecordRepeatFloorBuyer(
  collectionAddress: string | null | undefined,
  buyer: string | null | undefined,
  marketplace: string,
  floorDelta: number | null | undefined,
  priceSol: number,
  blockTimeMs: number,
): RepeatFloorBuyerSignal | null {
  if (!collectionAddress || !buyer) return null;
  if (AMM_MARKETPLACES.has(marketplace)) return null;
  if (floorDelta == null || floorDelta > NEAR_FLOOR_MAX) return null;
  if (!(priceSol > 0)) return null;
  if (!Number.isFinite(blockTimeMs)) return null;

  const k = key(buyer, collectionAddress);
  const existing = trim(ring.get(k) ?? [], blockTimeMs);

  if (!ring.has(k) && ring.size >= MAX_KEYS) {
    const it = ring.keys();
    const r = it.next();
    if (!r.done) ring.delete(r.value);
  }

  existing.push({ ts: blockTimeMs, priceSol });
  const trimmed = trim(existing, blockTimeMs);
  ring.set(k, trimmed);

  const buyCount = trimmed.length;
  const totalSpentSol = trimmed.reduce((sum, e) => sum + e.priceSol, 0);
  if (buyCount < MIN_BUY_COUNT || totalSpentSol < MIN_TOTAL_SPENT_SOL) return null;

  const spanMs = trimmed[trimmed.length - 1].ts - trimmed[0].ts;
  return {
    detected: true,
    confidence: spanMs <= HIGH_CONFIDENCE_MS ? 'high' : 'low',
    buyCount,
    totalSpentSol,
    spanMs,
  };
}

/**
 * One-time boot hydration: seeds `ring` from recent qualifying non-AMM,
 * near-floor sale_events so the cache is correct immediately after a
 * restart, without a live query per sale. Never runs the detection check —
 * hydration only seeds history so the NEXT live sale can be checked against it.
 */
export async function hydrateRepeatFloorBuyerCache(): Promise<number> {
  const { rows } = await getPool().query<{ buyer: string; collection_address: string; price_sol: number; block_time: string }>(
    `SELECT buyer, collection_address, price_sol::float8 AS price_sol, block_time
       FROM sale_events
      WHERE block_time >= now() - ($1 || ' milliseconds')::interval
        AND marketplace NOT IN ('magic_eden_amm', 'tensor_amm')
        AND collection_address IS NOT NULL AND collection_address <> ''
        AND buyer <> ''
        AND floor_delta IS NOT NULL AND floor_delta <= $2
        AND price_sol > 0
      ORDER BY block_time ASC`,
    [String(WINDOW_MS), NEAR_FLOOR_MAX],
  );
  const now = Date.now();
  for (const r of rows) {
    const k = key(r.buyer, r.collection_address);
    const existing = ring.get(k) ?? [];
    existing.push({ ts: new Date(r.block_time).getTime(), priceSol: r.price_sol });
    ring.set(k, trim(existing, now));
  }
  return rows.length;
}
