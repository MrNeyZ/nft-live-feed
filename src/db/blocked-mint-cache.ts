/**
 * In-memory mint→blocked-reason cache.
 *
 * Why this exists:
 *   The pre-insert blacklist gate in `insertSaleEvent` only fires when the
 *   parser already knows collectionAddress / slug / name. cNFT and many
 *   Tensor paths leave all three null at parse time, so blacklisted
 *   collections (e.g. DRiP) flash as "Unknown #?" cards on the live feed
 *   for ~10 s until enrichment resolves the collection identity and the
 *   row is DELETE'd + a `remove` SSE fans out.
 *
 *   When that post-enrichment block fires we now ALSO stash mintAddress →
 *   reason here. On the next sale of the same asset (cNFT mintAddress is
 *   stable), the pre-insert path consults this cache and short-circuits
 *   the emit before any SSE fans out.
 *
 * Bounds:
 *   - max 50 000 entries (FIFO eviction by insertion order)
 *   - 24 h per-entry TTL (lazy eviction on access; oldest expired entries
 *     are not actively swept — they fall off via FIFO once new entries
 *     push them past the size cap)
 *
 * What this CANNOT block:
 *   The very first sale of a brand-new mintAddress in a blacklisted
 *   collection that the parser couldn't resolve. That sale still emits;
 *   enrichment runs ~5 s later, fires the post-enrichment gate, marks
 *   the mint here, and emits `remove`. Next sale of the same mint is
 *   pre-blocked. Caller of `markMintBlocked` is the post-enrichment
 *   blacklist hit in `insertSaleEvent`.
 */

import type { Pool } from 'pg';
import {
  COLLECTION_BLACKLIST,
  SLUG_BLACKLIST,
  NAME_BLACKLIST,
  NAME_SUBSTRING_BLACKLIST,
} from './blacklist';

const MAX_ENTRIES = 50_000;
const TTL_MS      = 24 * 60 * 60_000;

interface BlockedEntry {
  reason:    string;
  expiresAt: number;
}

const blockedMint = new Map<string, BlockedEntry>();

/** Mark a mint as blocked. Idempotent — re-marking refreshes the TTL and
 *  bumps the entry to MRU position so frequently-rejected mints don't
 *  fall off the cache under FIFO pressure. */
export function markMintBlocked(mint: string | null | undefined, reason: string): void {
  if (!mint) return;
  // Delete-then-set moves the entry to the end of insertion order so
  // FIFO eviction below targets the genuinely-oldest entry, not the
  // just-refreshed one.
  blockedMint.delete(mint);
  blockedMint.set(mint, { reason, expiresAt: Date.now() + TTL_MS });
  if (blockedMint.size > MAX_ENTRIES) {
    // Map preserves insertion order — `.keys().next().value` is the oldest.
    const oldest = blockedMint.keys().next().value;
    if (typeof oldest === 'string') blockedMint.delete(oldest);
  }
}

/** Returns the stored reason if mint is currently blocked, null otherwise.
 *  Lazily evicts expired entries on access. */
export function isMintBlocked(mint: string | null | undefined): string | null {
  if (!mint) return null;
  const entry = blockedMint.get(mint);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    blockedMint.delete(mint);
    return null;
  }
  return entry.reason;
}

/** Diagnostic accessor — current cache size. Used by ops checks; not the
 *  hot path. */
export function blockedMintCacheSize(): number {
  return blockedMint.size;
}

/**
 * One-shot startup preload: scans `sale_events` for every mint whose row
 * already matches any blacklist signal (collection_address, ME slug,
 * collection_name exact or substring) and pre-populates the blocked-mint
 * cache. Without this, every restart wipes the cache and each previously-
 * blacklisted mint flashes once again at its next sale until the post-
 * enrichment gate re-learns it.
 *
 * Single query, single pass. Failures are non-fatal: a startup hiccup just
 * means we revert to the pre-existing behaviour (post-enrichment delete +
 * remove SSE).
 */
export async function preloadBlockedMintsFromDb(pool: Pool): Promise<number> {
  try {
    const collectionAddrs = [...COLLECTION_BLACKLIST];
    const slugs           = [...SLUG_BLACKLIST];
    const names           = [...NAME_BLACKLIST];
    const substringLike   = NAME_SUBSTRING_BLACKLIST.map((s) => `%${s.toLowerCase()}%`);
    const res = await pool.query<{ mint_address: string }>(
      `
        SELECT DISTINCT mint_address
        FROM sale_events
        WHERE mint_address IS NOT NULL
          AND mint_address <> ''
          AND (
                collection_address = ANY($1::text[])
             OR LOWER(collection_name) = ANY($2::text[])
             OR (raw_data->>'meCollectionSlug') = ANY($3::text[])
             OR LOWER(collection_name) ILIKE ANY($4::text[])
          )
      `,
      [collectionAddrs, names, slugs, substringLike],
    );
    for (const row of res.rows) {
      markMintBlocked(row.mint_address, 'preload_blocked_collection');
    }
    console.log(`[feed/blacklist-preload] cached=${res.rows.length} mints from sale_events`);
    return res.rows.length;
  } catch (err) {
    console.warn('[feed/blacklist-preload] failed (non-fatal)', err);
    return 0;
  }
}
