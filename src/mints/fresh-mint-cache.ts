/**
 * In-memory NFT-level cache powering the FRESH MINT badge: mint_address →
 * earliest-observed mintedAt (ms since epoch). A plain Map lookup at sale
 * enrichment time — no DB query, no RPC, nothing on the sale hot path.
 *
 * Populated by:
 *   - the live mint bus (wired in `src/mints/event-store.ts`), in real time
 *   - one-time boot hydration from `mint_events` (in `event-store.ts`), so
 *     the cache survives a backend restart without a live query per sale
 *
 * NFT-level join only — keyed by mint_address, never collection_address or
 * slug. MVP intentionally ships with a direct mint_address === mint_address
 * join and no ME/MMM cNFT asset-ID derivation: those marketplaces store the
 * merkle tree (not the per-asset ID) in sale_events.mint_address for cNFT
 * sales, so those rows simply never match here and get no badge. That's a
 * missed badge, not a false positive — acceptable for MVP, not fixed here.
 */
import { TtlCache } from '../enrichment/cache';

export const FRESH_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h

const cache = new TtlCache<string, number>(FRESH_WINDOW_MS, 15 * 60_000);

/**
 * Record a mint's first-observed timestamp. No-op for empty/missing mint
 * addresses (unresolved cNFT asset IDs default to '' upstream) — those must
 * never occupy a cache slot that a later unrelated event could match.
 * First-write-wins: keeps the earliest mintedAt if called more than once
 * for the same mint (re-ingest / duplicate launchpad leg).
 */
export function recordMintedAt(mintAddress: string | null | undefined, mintedAtMs: number): void {
  if (!mintAddress) return;
  if (cache.has(mintAddress)) return;
  cache.set(mintAddress, mintedAtMs);
}

/**
 * Returns the mint's mintedAt (ms) if it is still within the freshness
 * window, else null. Re-checks age against the actual mintedAt value rather
 * than trusting TtlCache's own (insertion-time-relative) expiry alone —
 * boot hydration can insert a mintedAt that was already hours old, and that
 * entry must stop matching at the 4h mark regardless of when it was cached.
 */
export function getMintedAt(mintAddress: string | null | undefined): number | null {
  if (!mintAddress) return null;
  const ts = cache.get(mintAddress);
  if (ts == null) return null;
  return Date.now() - ts <= FRESH_WINDOW_MS ? ts : null;
}
