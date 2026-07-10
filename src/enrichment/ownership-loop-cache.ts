/**
 * In-memory per-mint ownership-loop cache — a floor-level wash/self-dealing
 * signal, NOT comprehensive wash detection. Tracks the last 5 non-AMM sellers
 * for each mint_address within a 7-day window and flags when the CURRENT
 * sale's buyer matches an earlier seller of the SAME mint — i.e. the wallet
 * buying right now previously owned and sold this exact NFT before.
 *
 * Checking buyer-vs-prior-sellers (not seller-vs-prior-buyers) matters: the
 * buyer of sale N is *always* the seller of the next sale N+1 in any normal
 * resale chain — that's plain ownership continuity, not suspicious. Checking
 * "does this seller match an earlier buyer" would fire on literally every
 * back-to-back resale. The real signal is a wallet *reappearing* as a seller
 * after already having sold — caught by watching for the CURRENT buyer
 * showing up in the SELLER history, since that only happens if this wallet
 * held the NFT and sold it at some earlier point too.
 *
 * Deliberately narrow, matching the discovery scope:
 *   - AMM/pool marketplaces (magic_eden_amm, tensor_amm) are excluded. Pools
 *     legitimately buy-then-resell the same NFT out of inventory as normal
 *     business — the single biggest false-positive source if included.
 *   - Mint-scoped only. No wallet-wide graph, no collection aggregates, no
 *     multi-hop path reconstruction — just "has this exact buyer appeared
 *     as a seller of this exact mint before, within the window."
 *   - Order-sensitive: correct only when computed at LIVE enrichment time.
 *     Never re-derive this for an older row from the CURRENT cache state —
 *     the cache by then also holds sales that happened AFTER that row, which
 *     would answer a different (and wrong) question. This is why there is
 *     no REST-snapshot re-stamp for this signal (unlike floor/resize/fresh-
 *     mint, which aren't history-order-dependent).
 *   - `sale_events` only captures marketplace trades, not off-marketplace
 *     transfers (gifts, custody moves, staking). A wash-trader routing
 *     through one extra off-chain-invisible wallet hop is invisible here.
 */
import { getPool } from '../db/client';
import { OwnershipLoopSignal } from '../models/sale-event';

const WINDOW_MS           = 7 * 24 * 60 * 60 * 1000; // 7d lookback
const MAX_HOPS            = 5;                        // last N non-AMM sales tracked per mint
const HIGH_CONFIDENCE_MS  = 72 * 60 * 60 * 1000;      // 72h — closes faster => higher confidence

// Total distinct mint_address keys tracked — same operational safeguard as
// recent-sell-tracker.ts / repeat-floor-buyer-cache.ts's MAX_KEYS, oldest
// insertion-order entry dropped when the map would grow past the cap.
const MAX_KEYS = 50_000;

const AMM_MARKETPLACES = new Set(['magic_eden_amm', 'tensor_amm']);

interface Entry { wallet: string; ts: number; }

// mint_address -> chronological (oldest-first) seller history, non-AMM only.
const history = new Map<string, Entry[]>();

/** Drop entries older than the window (relative to `referenceTs`) and cap to
 *  the last MAX_HOPS. Assumes `entries` is already oldest-first — true for
 *  both the hydration query (ORDER BY block_time ASC) and the live path
 *  (sales normally arrive in order); a rare out-of-order backfill just means
 *  the window cutoff is approximate, which is acceptable for this MVP. */
function trim(entries: Entry[], referenceTs: number): Entry[] {
  const cutoff = referenceTs - WINDOW_MS;
  let start = 0;
  while (start < entries.length && entries[start].ts < cutoff) start++;
  const windowed = start > 0 ? entries.slice(start) : entries;
  return windowed.length > MAX_HOPS ? windowed.slice(windowed.length - MAX_HOPS) : windowed;
}

/**
 * Check whether `buyer` matches an earlier seller of `mintAddress` (or is the
 * same wallet as `seller` in this very sale — the strongest, cheapest signal),
 * then record `seller` for future checks. Must run exactly once per live
 * sale, in order: a check with no matching record (or vice versa) would
 * silently break future detections for this mint.
 *
 * Returns null (no-op, cache untouched) for: empty/missing mint address,
 * AMM/pool marketplaces, or empty seller/buyer.
 */
export function checkAndRecordOwnership(
  mintAddress: string | null | undefined,
  seller: string,
  buyer: string,
  marketplace: string,
  blockTimeMs: number,
): OwnershipLoopSignal | null {
  if (!mintAddress) return null;
  if (AMM_MARKETPLACES.has(marketplace)) return null;
  if (!seller || !buyer) return null;
  if (!Number.isFinite(blockTimeMs)) return null;

  const existing = trim(history.get(mintAddress) ?? [], blockTimeMs);

  let signal: OwnershipLoopSignal | null = null;

  if (buyer === seller) {
    // Same-transaction self-deal — separate, strongest signal. Skip the
    // history scan entirely; this is a stronger claim than any multi-hop loop.
    signal = { detected: true, confidence: 'high', closedAfterMs: 0, hopsAgo: 0 };
  } else {
    // Most-recent-first so hopsAgo/closedAfterMs reflect the CLOSEST prior
    // match — the tightest, most-suspicious closing of the loop.
    for (let i = existing.length - 1; i >= 0; i--) {
      const entry = existing[i];
      if (entry.wallet !== buyer) continue;
      const closedAfterMs = blockTimeMs - entry.ts;
      if (closedAfterMs < 0) continue; // defensive: out-of-order block_time
      signal = {
        detected: true,
        confidence: closedAfterMs <= HIGH_CONFIDENCE_MS ? 'high' : 'low',
        closedAfterMs,
        hopsAgo: existing.length - i,
      };
      break;
    }
  }

  if (!history.has(mintAddress) && history.size >= MAX_KEYS) {
    const it = history.keys();
    const r = it.next();
    if (!r.done) history.delete(r.value);
  }

  existing.push({ wallet: seller, ts: blockTimeMs });
  history.set(mintAddress, trim(existing, blockTimeMs));

  return signal;
}

/**
 * One-time boot hydration: seeds `history` from recent non-AMM sale_events
 * so the cache is correct immediately after a restart, without a live query
 * per sale. Never runs the loop CHECK — hydration only seeds history so the
 * NEXT live sale can be checked against it.
 */
export async function hydrateOwnershipLoopCache(): Promise<number> {
  const { rows } = await getPool().query<{ mint_address: string; seller: string; block_time: string }>(
    `SELECT mint_address, seller, block_time
       FROM sale_events
      WHERE block_time >= now() - ($1 || ' milliseconds')::interval
        AND mint_address <> ''
        AND seller <> ''
        AND marketplace NOT IN ('magic_eden_amm', 'tensor_amm')
      ORDER BY mint_address, block_time ASC`,
    [String(WINDOW_MS)],
  );
  const now = Date.now();
  for (const r of rows) {
    const existing = history.get(r.mint_address) ?? [];
    existing.push({ wallet: r.seller, ts: new Date(r.block_time).getTime() });
    history.set(r.mint_address, trim(existing, now));
  }
  return rows.length;
}
