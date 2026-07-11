/**
 * Mint Lifecycle analytics — pure derivation core + I/O query layer +
 * durable first-listing recording.
 *
 * Correlates: Mint -> First Listing -> First Sale -> Flip Speed, per
 * individual NFT (not per collection). Does NOT implement First Offer —
 * that requires new per-mint ME polling and is explicitly a later,
 * separately-scoped stage.
 *
 * ── Why `firstListedAt` needs its OWN durable storage ─────────────────────
 *
 * It cannot be reliably derived from what's already persisted. Two
 * independent reasons:
 *
 *  1. `listings-store.ts` is a pure in-memory, TTL-evicted snapshot store —
 *     `replaceCollection()` wipes and replaces every row for a slug on each
 *     refresh (see that file's own module doc). Nothing about "the first
 *     time we ever saw this mint listed" survives a restart, or even
 *     survives the NEXT snapshot.
 *
 *  2. Even when a `listedAt` value IS available and precise (ME's
 *     `/activities?type=list`, Tensor's `listing.txAt`), it is defined as
 *     the MOST RECENT list event per mint — listings-store's own
 *     `fetchMeListedAtMap` comment: "Keep the most recent list event per
 *     mint (covers list -> delist -> list cycles)". That answers "when was
 *     this last listed", not "when was this first listed since mint" —  a
 *     genuinely different question this module needs answered monotonically.
 *
 * So `firstListedAt` is recorded HERE, the first time a trustworthy
 * `listedAt` observation for a mint passes through the existing
 * listings-store snapshot pipeline (see `recordFirstListedAtObservation`,
 * wired from `listings-store.ts`'s `add()`), and is persisted with
 * LEAST()-based upsert semantics so no later observation can move it later.
 *
 * ── cNFT identifier compatibility (audited, not assumed) ──────────────────
 *
 * | Path                                   | mint_address value           |
 * |-----------------------------------------|-------------------------------|
 * | mint_events (any standard, via mint-raw) | real per-asset ID (Bubblegum  |
 * |                                           | PDA-derived for cNFT) or ''   |
 * |                                           | on failed derivation — NEVER  |
 * |                                           | the merkle tree.              |
 * | sale_events via Tensor TCOMP (any type)  | real mint / real Core asset   |
 * |                                           | ID / real Bubblegum-derived   |
 * |                                           | cNFT asset ID, or '' on       |
 * |                                           | failure — never the tree.     |
 * | sale_events via ME v2 / MMM, Legacy/pNFT/Core | real mint or asset ID.   |
 * | sale_events via ME's standalone cNFT      | **the MERKLE TREE address**,  |
 * | program (`M3mxk5W2…`) or MMM's            | used as a deliberate "stable, |
 * | `cnftFulfillBuy`                          | dedup-friendly placeholder"   |
 * |                                           | (see me-raw/parser.ts's own   |
 * |                                           | comment) — NOT the per-asset  |
 * |                                           | ID.                            |
 *
 * Consequence: a cNFT sold via ME's standalone cNFT program or an MMM pool
 * will silently fail to correlate against its own `mint_events` row (the
 * real asset ID never matches the tree address) — `firstSoldAt` comes back
 * null for that mint, which is the SAFE failure mode (a miss, not a wrong
 * answer). A cNFT sold via Tensor TCOMP correlates correctly.
 *
 * Two hard rules enforced by this module, not just documented:
 *   1. NEVER treat an empty/falsy mint_address as a real identifier — every
 *      query function fails closed (returns null / skips) rather than
 *      running a lookup keyed on '', which IS shared across every mint
 *      whose per-asset-ID derivation failed and would otherwise silently
 *      cross-attribute unrelated NFTs' events to each other.
 *   2. NEVER fall back to `collection_address` to approximate a missing
 *      per-NFT event. `collection_address` is the merkle tree for cNFTs —
 *      shared by every NFT in the drop — so "recovering" a lifecycle event
 *      via collection_address would attribute one NFT's listing/sale to a
 *      DIFFERENT NFT in the same collection. This module does not do that
 *      under any circumstance.
 */

import { getPool } from '../db/client';

// ─── Pure derivation ─────────────────────────────────────────────────────────

export type ListingTimeQuality = 'exact' | 'approximate' | 'unknown';
export type FlipSpeedLabel = 'instant' | 'fast' | 'normal' | 'slow';

export interface MintLifecycle {
  mintAddress: string;

  mintedAtMs:       number;
  firstListedAtMs:  number | null;
  firstSoldAtMs:    number | null;

  mintToFirstListingMs: number | null;
  mintToFirstSaleMs:    number | null;
  listingToFirstSaleMs: number | null;

  listingTimeQuality: ListingTimeQuality;

  nftType?:           string | null;
  collectionAddress?: string | null;

  warnings: string[];
}

export interface MintLifecycleInput {
  mintAddress:        string;
  mintedAtMs:         number;
  firstListedAtMs?:   number | null;
  firstListedQuality?: ListingTimeQuality | null;
  firstSoldAtMs?:     number | null;
  nftType?:           string | null;
  collectionAddress?: string | null;
}

/** Duration from `end` to `start`. Returns null (never clamps to 0) when
 *  either endpoint is missing, OR when the result would be negative —
 *  negative means the two timestamps are inconsistent/stale (e.g. a sale
 *  block_time older than a since-corrected mint timestamp), and silently
 *  reporting 0 would misrepresent that as "instant" rather than "unknown/
 *  bad data". */
function safeDurationMs(startMs: number | null, endMs: number | null): number | null {
  if (startMs == null || endMs == null) return null;
  const d = endMs - startMs;
  return d >= 0 ? d : null;
}

/**
 * Pure, deterministic derivation from already-resolved timestamps. Makes no
 * network/DB/RPC calls, never mutates its input.
 */
export function deriveMintLifecycle(input: MintLifecycleInput): MintLifecycle {
  const warnings: string[] = [];
  const {
    mintAddress, mintedAtMs,
    firstListedAtMs = null, firstListedQuality = null,
    firstSoldAtMs = null,
    nftType = null, collectionAddress = null,
  } = input;

  const mintToFirstListingMs = safeDurationMs(mintedAtMs, firstListedAtMs);
  if (firstListedAtMs != null && mintToFirstListingMs === null) {
    warnings.push('firstListedAtMs is earlier than mintedAtMs — ignoring (negative duration, not clamped)');
  }

  const mintToFirstSaleMs = safeDurationMs(mintedAtMs, firstSoldAtMs);
  if (firstSoldAtMs != null && mintToFirstSaleMs === null) {
    warnings.push('firstSoldAtMs is earlier than mintedAtMs — ignoring (negative duration, not clamped)');
  }

  const listingToFirstSaleMs = safeDurationMs(firstListedAtMs, firstSoldAtMs);
  if (firstListedAtMs != null && firstSoldAtMs != null && listingToFirstSaleMs === null) {
    warnings.push('firstSoldAtMs is earlier than firstListedAtMs — sale-before-listing, ignoring (negative duration, not clamped)');
  }

  const listingTimeQuality: ListingTimeQuality =
    firstListedAtMs == null ? 'unknown' : (firstListedQuality ?? 'unknown');

  return {
    mintAddress,
    mintedAtMs,
    firstListedAtMs,
    firstSoldAtMs,
    mintToFirstListingMs,
    mintToFirstSaleMs,
    listingToFirstSaleMs,
    listingTimeQuality,
    nftType,
    collectionAddress,
    warnings,
  };
}

// ─── Flip Speed classification (pure, no UI coupling) ───────────────────────
//
// Conservative fixed bands as an internal starting point ONLY — the label
// is secondary to the raw duration and is meant to be replaced later by
// collection-relative percentiles once real distributions are validated.
// No user-facing badge/copy is wired to this; it exists so a later stage
// doesn't have to invent the boundary semantics from scratch.

const FLIP_INSTANT_MAX_MS = 5   * 60_000;         // <= 5 min
const FLIP_FAST_MAX_MS    = 30  * 60_000;         // <= 30 min
const FLIP_NORMAL_MAX_MS  = 4   * 60 * 60_000;    // <= 4 h

/** Returns null when there's no duration to classify (mirrors the
 *  "raw duration is the primary truth, label is secondary" rule — a null
 *  duration must never coerce into a fake label). */
export function classifyFlipSpeed(durationMs: number | null): FlipSpeedLabel | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs <= FLIP_INSTANT_MAX_MS) return 'instant';
  if (durationMs <= FLIP_FAST_MAX_MS)    return 'fast';
  if (durationMs <= FLIP_NORMAL_MAX_MS)  return 'normal';
  return 'slow';
}

// ─── I/O query layer ─────────────────────────────────────────────────────────

function isRealMint(m: unknown): m is string {
  return typeof m === 'string' && m.trim().length > 0;
}

interface MintedAtRow { minted_at_ms: string | null; program_source: string | null; collection_address: string | null }

/** `mint_events` can have more than one row per mint (its unique key is the
 *  (signature, mint_address) PAIR, not mint_address alone) — MIN() across
 *  all of them, per-row preferring on-chain `block_time` over the backend's
 *  own `created_at` insertion time.
 *
 *  `program_source` ('mpl_core' | 'mpl_token_metadata' | 'bubblegum') is the
 *  NFT-standard-ish classifier on this table — NOT `mint_type`, which is a
 *  payment classifier ('paid' | 'free' | 'unknown', see
 *  src/mints/detector.ts), a naming trap this module deliberately avoids. */
async function fetchMintedAt(mintAddress: string): Promise<{ mintedAtMs: number | null; nftType: string | null; collectionAddress: string | null }> {
  const pool = getPool();
  const { rows } = await pool.query<MintedAtRow>(
    `SELECT
       MIN(EXTRACT(EPOCH FROM COALESCE(block_time, created_at)) * 1000)::bigint AS minted_at_ms,
       (array_agg(program_source ORDER BY COALESCE(block_time, created_at) ASC))[1]  AS program_source,
       (array_agg(collection_address ORDER BY COALESCE(block_time, created_at) ASC))[1] AS collection_address
     FROM mint_events
     WHERE mint_address = $1`,
    [mintAddress],
  );
  const row = rows[0];
  return {
    mintedAtMs:        row?.minted_at_ms != null ? Number(row.minted_at_ms) : null,
    nftType:           row?.program_source ?? null,
    collectionAddress: row?.collection_address ?? null,
  };
}

/** MIN(block_time) across every sale_events row for this exact mint. No
 *  marketplace filtering — every marketplace's sale counts. */
async function fetchFirstSoldAt(mintAddress: string): Promise<number | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ first_sold_at_ms: string | null }>(
    `SELECT MIN(EXTRACT(EPOCH FROM block_time) * 1000)::bigint AS first_sold_at_ms
       FROM sale_events
      WHERE mint_address = $1`,
    [mintAddress],
  );
  const v = rows[0]?.first_sold_at_ms;
  return v != null ? Number(v) : null;
}

async function fetchFirstListedAt(mintAddress: string): Promise<{ firstListedAtMs: number | null; quality: ListingTimeQuality }> {
  const pool = getPool();
  const { rows } = await pool.query<{ first_listed_at_ms: string; quality: string }>(
    `SELECT first_listed_at_ms, quality FROM mint_first_listed WHERE mint_address = $1`,
    [mintAddress],
  );
  const row = rows[0];
  if (!row) return { firstListedAtMs: null, quality: 'unknown' };
  const q = row.quality === 'exact' || row.quality === 'approximate' ? row.quality : 'unknown';
  return { firstListedAtMs: Number(row.first_listed_at_ms), quality: q };
}

/**
 * Full lifecycle for ONE mint. Fails closed (returns null) on an empty/
 * invalid mint address, or when no `mint_events` row exists for it at all
 * (there is no "mintedAt" to anchor the rest of the lifecycle to — per the
 * suggested shape, `mintedAtMs` is required/non-null on `MintLifecycle`).
 */
export async function getMintLifecycle(mintAddress: string): Promise<MintLifecycle | null> {
  if (!isRealMint(mintAddress)) return null;
  const mint = mintAddress.trim();

  const [minted, firstListed, firstSoldAtMs] = await Promise.all([
    fetchMintedAt(mint),
    fetchFirstListedAt(mint),
    fetchFirstSoldAt(mint),
  ]);
  if (minted.mintedAtMs == null) return null;

  return deriveMintLifecycle({
    mintAddress:        mint,
    mintedAtMs:         minted.mintedAtMs,
    firstListedAtMs:    firstListed.firstListedAtMs,
    firstListedQuality: firstListed.quality,
    firstSoldAtMs,
    nftType:            minted.nftType,
    collectionAddress:  minted.collectionAddress,
  });
}

/**
 * Batched lifecycle lookup for many mints (e.g. every mint in one
 * collection). Three batched queries instead of N round-trips. Result is a
 * Map built by iterating `mintAddresses` in order, so key insertion order
 * mirrors the input order regardless of what order Postgres returns rows in
 * — callers that need positional stability can rely on
 * `Array.from(result.keys())` matching `mintAddresses` (minus any
 * empty/invalid/mint-events-less entries, which are simply absent, never
 * reordered).
 */
export async function getMintLifecycleBatch(mintAddresses: readonly string[]): Promise<Map<string, MintLifecycle>> {
  const clean = Array.from(new Set(mintAddresses.filter(isRealMint).map(m => m.trim())));
  const result = new Map<string, MintLifecycle>();
  if (clean.length === 0) return result;

  const pool = getPool();
  const [mintedRows, listedRows, soldRows] = await Promise.all([
    pool.query<{ mint_address: string; minted_at_ms: string | null; program_source: string | null; collection_address: string | null }>(
      `SELECT mint_address,
              MIN(EXTRACT(EPOCH FROM COALESCE(block_time, created_at)) * 1000)::bigint AS minted_at_ms,
              (array_agg(program_source ORDER BY COALESCE(block_time, created_at) ASC))[1] AS program_source,
              (array_agg(collection_address ORDER BY COALESCE(block_time, created_at) ASC))[1] AS collection_address
         FROM mint_events
        WHERE mint_address = ANY($1)
        GROUP BY mint_address`,
      [clean],
    ),
    pool.query<{ mint_address: string; first_listed_at_ms: string; quality: string }>(
      `SELECT mint_address, first_listed_at_ms, quality FROM mint_first_listed WHERE mint_address = ANY($1)`,
      [clean],
    ),
    pool.query<{ mint_address: string; first_sold_at_ms: string | null }>(
      `SELECT mint_address, MIN(EXTRACT(EPOCH FROM block_time) * 1000)::bigint AS first_sold_at_ms
         FROM sale_events
        WHERE mint_address = ANY($1)
        GROUP BY mint_address`,
      [clean],
    ),
  ]);

  const mintedByMint = new Map(mintedRows.rows.map(r => [r.mint_address, r]));
  const listedByMint = new Map(listedRows.rows.map(r => [r.mint_address, r]));
  const soldByMint    = new Map(soldRows.rows.map(r => [r.mint_address, r]));

  for (const mint of clean) {
    const minted = mintedByMint.get(mint);
    if (!minted || minted.minted_at_ms == null) continue; // no mint anchor — fails closed, silently absent
    const listed = listedByMint.get(mint);
    const sold   = soldByMint.get(mint);
    const quality: ListingTimeQuality = listed
      ? (listed.quality === 'exact' || listed.quality === 'approximate' ? listed.quality : 'unknown')
      : 'unknown';

    result.set(mint, deriveMintLifecycle({
      mintAddress:        mint,
      mintedAtMs:         Number(minted.minted_at_ms),
      firstListedAtMs:    listed ? Number(listed.first_listed_at_ms) : null,
      firstListedQuality: quality,
      firstSoldAtMs:      sold?.first_sold_at_ms != null ? Number(sold.first_sold_at_ms) : null,
      nftType:            minted.program_source,
      collectionAddress:  minted.collection_address,
    }));
  }
  return result;
}

// ─── Durable first-listing recording (write path) ───────────────────────────
//
// Wired from listings-store.ts's `add()` — fires once per mint per process
// lifetime (in-memory dedup set below), fail-soft, never awaited on the hot
// path. No new ME/RPC request: this only records a timestamp that
// listings-store already resolved as part of its existing snapshot fetch.

// Best first-listed timestamp THIS PROCESS has successfully written for a
// mint. Used only to skip a redundant, no-op DB round-trip when a new
// observation couldn't possibly improve on what we already wrote — NOT a
// correctness mechanism (that's entirely the DB's LEAST() upsert). A new
// observation that's actually EARLIER than this cached value always falls
// through to the DB write, so an out-of-order/late-arriving earlier
// timestamp is never silently dropped. Empty on process start, so the
// first observation per mint after a restart always attempts a write.
const recordedBest = new Map<string, number>();

/**
 * Record (or tighten) the earliest-known listing moment for `mintAddress`.
 * Safe to call redundantly — `ON CONFLICT ... LEAST()` guarantees the
 * stored timestamp can only move earlier, never later, and `quality`
 * tracks whichever timestamp value is retained. Never throws; failures are
 * logged and swallowed so a DB hiccup can never affect live listings
 * ingestion. Intentionally NOT awaited by callers (fire-and-forget).
 */
export async function recordFirstListedAtObservation(
  mintAddress: string,
  listedAtMs: number,
  quality: ListingTimeQuality,
): Promise<void> {
  if (!isRealMint(mintAddress)) return;
  if (!Number.isFinite(listedAtMs) || listedAtMs <= 0) return;
  const mint = mintAddress.trim();

  // Cheap in-memory short-circuit: skip the DB round-trip only when this
  // observation is NOT earlier than what we already know we successfully
  // wrote — it could not improve the stored value. Anything genuinely
  // earlier always falls through to the upsert below.
  const known = recordedBest.get(mint);
  if (known !== undefined && listedAtMs >= known) return;

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO mint_first_listed (mint_address, first_listed_at_ms, quality)
       VALUES ($1, $2, $3)
       ON CONFLICT (mint_address) DO UPDATE SET
         first_listed_at_ms = LEAST(mint_first_listed.first_listed_at_ms, EXCLUDED.first_listed_at_ms),
         quality = CASE
           WHEN EXCLUDED.first_listed_at_ms <= mint_first_listed.first_listed_at_ms THEN EXCLUDED.quality
           ELSE mint_first_listed.quality
         END`,
      [mint, Math.round(listedAtMs), quality],
    );
    recordedBest.set(mint, Math.min(known ?? Infinity, listedAtMs));
  } catch (err) {
    console.warn(`[mint-lifecycle] recordFirstListedAtObservation failed mint=${mint.slice(0, 8)}… ${(err as Error)?.message ?? err}`);
  }
}
