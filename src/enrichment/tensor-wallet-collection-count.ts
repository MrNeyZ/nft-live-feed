/**
 * Owner holdings count for a Tensor collection slug (`slugDisplay`), via
 * `GET /api/v1/user/portfolio?wallet={owner}`.
 *
 * Scan primitive for `seller-holdings.ts`'s (seed / reconcile) machinery —
 * see `getOwnerCollectionCountCombined` there for how this is wired in as
 * the primary source, ahead of the DAS `getAssetsByOwner` deep scan.
 *
 * Why this exists: a plain DAS `getAssetsByOwner` scan only sees NFTs
 * sitting bare in the wallet. An NFT the owner has actively listed on
 * Tensor OR Magic Eden gets its on-chain `ownership.owner` moved to that
 * marketplace's escrow/listing PDA — invisible to `getAssetsByOwner(owner)`
 * — so a seller who keeps most of their stock listed (the common case for
 * an active flipper) reads as holding ~0-1 even when they hold dozens.
 * Verified live 2026-09-02 on wallet HyHc7g…kVtE + collection
 * critters_multipliers: DAS free count 3, Tensor `active_listings` showed
 * 8 MAGICEDEN_V2 + 3 TCOMP listings for that wallet (11 total), and this
 * endpoint's `mintCount` for the same wallet+collection was 14 — i.e.
 * `mintCount` already equals DAS-free + listed-on-BOTH-marketplaces. So a
 * single wallet-scoped call here, with no separate Magic Eden listings
 * scan needed, covers both marketplaces at once.
 *
 * `mintCount` is Tensor's own tracking, not necessarily a superset of the
 * DAS-free count in every edge case (e.g. a wallet Tensor has never seen
 * activity from) — callers must still fall back to the DAS scan when this
 * returns null.
 *
 * One call returns EVERY collection the wallet holds, so the whole
 * response is cached per-wallet (not per seller+collection) and reused
 * across every (seller, collection) pair that shares a wallet within the
 * TTL — cheaper in aggregate than the 5-page DAS deep scan it replaces.
 */

import { TtlCache } from './cache';

const PORTFOLIO_TIMEOUT_MS = 6_000;
// A wallet's Tensor-tracked holdings change slowly relative to this
// cache's purpose (only consulted right before a fresh scan would
// otherwise run) — mirrors me-wallet-collection-count.ts's hit/miss split.
const HIT_TTL_MS  = 90_000;
const MISS_TTL_MS = 60_000;

interface TensorPortfolioEntry {
  slugDisplay?: string;
  mintCount?: number;
}

const portfolioCache = new TtlCache<string, TensorPortfolioEntry[]>(HIT_TTL_MS, 30_000);
const missCache       = new TtlCache<string, true>(MISS_TTL_MS, 30_000);
const inflight        = new Map<string, Promise<TensorPortfolioEntry[] | null>>();

async function fetchPortfolio(owner: string): Promise<TensorPortfolioEntry[] | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.mainnet.tensordev.io/api/v1/user/portfolio?wallet=${encodeURIComponent(owner)}&includeUnverified=true`,
      { headers: { 'x-tensor-api-key': key }, signal: AbortSignal.timeout(PORTFOLIO_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const json = await res.json() as unknown;
    return Array.isArray(json) ? json as TensorPortfolioEntry[] : null;
  } catch {
    return null;
  }
}

async function getWalletPortfolio(owner: string): Promise<TensorPortfolioEntry[] | null> {
  const hit = portfolioCache.get(owner);
  if (hit !== undefined) return hit;
  if (missCache.has(owner)) return null;
  const live = inflight.get(owner);
  if (live) return live;

  const p = (async (): Promise<TensorPortfolioEntry[] | null> => {
    try {
      const list = await fetchPortfolio(owner);
      if (list) portfolioCache.set(owner, list);
      else missCache.set(owner, true);
      return list;
    } finally {
      inflight.delete(owner);
    }
  })();
  inflight.set(owner, p);
  return p;
}

/**
 * Owner's current holdings count for a Tensor collection slug
 * (`slugDisplay`), already inclusive of anything listed on Tensor or
 * Magic Eden. Cached (whole-wallet, hit + miss), in-flight-deduped, never
 * throws. Matches `getOwnerCollectionDeepCount`'s `{ count }` shape so it
 * can be passed as `seller-holdings.ts`'s pluggable scan function.
 * Returns `{ count: null }` when no TENSOR_API_KEY, the wallet isn't
 * Tensor-indexed, or the slug isn't in the wallet's portfolio — callers
 * must fall back to the DAS scan in that case.
 */
export async function getOwnerCollectionCountViaTensor(
  owner: string,
  tensorSlug: string,
): Promise<{ count: number | null }> {
  if (!owner || !tensorSlug) return { count: null };
  const list = await getWalletPortfolio(owner);
  if (!list) return { count: null };
  const entry = list.find((c) => c.slugDisplay === tensorSlug);
  const count = typeof entry?.mintCount === 'number' ? entry.mintCount : null;
  return { count };
}
