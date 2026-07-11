/**
 * Stage 4.5 — normalized, trustworthy collection best-bid model.
 *
 * Produces ONE `NormalizedCollectionBid` per venue (MMM, TENSOR) that future
 * Offer Jump / Mispriced NFT code can consume without re-deriving the
 * eligibility/funding audit from the Jul 2026 discovery report:
 *
 *   - MMM: a pool's quoted `spotPrice` is only real if its escrowed
 *     `buysidePaymentAmount` actually covers it (see collection-bids.ts's
 *     `classifyFunding` doc) — NOT merely "some SOL is on hand". Confirmed
 *     live: mad_lads (57.67 SOL quote / 2.30 SOL escrow) and okay_bears
 *     (6.00 SOL / 0.067 SOL) both fail this check across their ENTIRE pool
 *     list, not just the top pool.
 *   - MMM eligibility: every observed buy-side pool (funded or not) carries
 *     an allowlist matching its own collection (FVCA/MCC/core_collection) —
 *     MMM's on-chain `AllowlistKind` enum has no trait/attribute-level
 *     restriction at all. Only `mint`-type allowlists are narrower than the
 *     whole collection (`exact_mint`); everything else recognized
 *     (FVCA/MCC/metadata/group/core_collection/any) is `collection_wide`.
 *     Requires one on-chain `getAccountInfo` read per candidate top pool —
 *     cached (long TTL, in-flight-deduped by poolAddress) since a pool's
 *     allowlist never changes after creation.
 *   - TENSOR: `sellNowPrice` is a single collection-wide aggregate with no
 *     per-NFT/trait executability signal — always `eligibility: 'unknown'`,
 *     `funding: 'reported'`. Confirmed live it is GROSS, with a separate
 *     `sellNowPriceNetFees` net figure (see collection-bids.ts). Tensor may
 *     corroborate a signal but must never independently trigger VALUE.
 *   - ME_COLLECTION is NOT modeled here — `GET /v2/collections/{slug}/offers`
 *     is permanently dead (HTTP 400, no replacement — see the Jul 2026
 *     discovery audit). See enrich.ts / offer-history.ts for the removal.
 *
 * `usableForValueSignal` is the single gate future scoring code should
 * check — true only for a MMM bid that is BOTH collection-wide AND
 * escrow-verified. Nothing from Tensor, and no ME_COLLECTION bid (there is
 * none), may set it true.
 */

import { TtlCache } from '../enrichment/cache';
import {
  fetchMmmBidSnapshot,
  fetchTensorTopBidDetailed,
  type MmmBidCandidate,
  type MmmFundingState,
} from '../server/collection-bids';
import { parsePool, rpcPost, type Allowlist } from '../server/tools-mmm-pools';

export type BidVenue = 'MMM' | 'TENSOR';

export type BidEligibility =
  | 'collection_wide'
  | 'exact_mint'
  | 'restricted'
  | 'unknown';

export type BidFunding =
  | 'verified'
  | 'insufficient'
  | 'reported'
  | 'unknown';

export interface NormalizedCollectionBid {
  venue: BidVenue;

  grossAmountSol: number;
  netAmountSol:   number | null;

  poolAddress?: string | null;
  owner?:       string | null;

  eligibility: BidEligibility;
  funding:     BidFunding;

  executableForCollection: boolean;
  usableForValueSignal:    boolean;

  warnings: string[];
}

// ─── MMM pool allowlist → eligibility (on-chain, cached) ────────────────────

const KNOWN_COLLECTION_ALLOWLIST_TYPES = new Set([
  'FVCA', 'MCC', 'metadata', 'group', 'core_collection', 'any',
]);

/** Pure classifier. `allowlists` is the fully-decoded array from parsePool;
 *  an empty array (pool has no allowlist entries at all — MMM's own `empty`
 *  type is filtered out by parsePool) is fully open, same as `any`. */
export function classifyMmmEligibility(allowlists: readonly Allowlist[]): BidEligibility {
  if (allowlists.length === 0) return 'collection_wide';
  if (allowlists.some(al => al.type === 'mint')) return 'exact_mint';
  if (allowlists.every(al => KNOWN_COLLECTION_ALLOWLIST_TYPES.has(al.type))) return 'collection_wide';
  return 'unknown'; // unparseable/unexpected allowlist type — fail closed, never assume collection_wide
}

interface EligibilityResult { eligibility: BidEligibility; allowlists: Allowlist[] }

const ELIGIBILITY_HIT_TTL_MS  = 24 * 60 * 60 * 1000; // pool allowlist is fixed at creation — long TTL is safe
const ELIGIBILITY_MISS_TTL_MS = 5 * 60 * 1000;       // transient RPC failure — retry sooner
const eligibilityHitCache  = new TtlCache<string, EligibilityResult>(ELIGIBILITY_HIT_TTL_MS, 60 * 60 * 1000);
const eligibilityMissCache = new TtlCache<string, true>(ELIGIBILITY_MISS_TTL_MS, 60_000);
const eligibilityInflight  = new Map<string, Promise<EligibilityResult>>();

const UNKNOWN_RESULT: EligibilityResult = { eligibility: 'unknown', allowlists: [] };

/**
 * One cached on-chain account read per pool, ever (modulo TTL) — in-flight
 * deduped so concurrent observations of the same pool never double-fetch.
 * Fails soft and fails CLOSED: any RPC error, missing account, or unparsed
 * layout resolves to `{eligibility: 'unknown', allowlists: []}`, which
 * `usableForValueSignal` treats as never-usable — never silently upgraded
 * to `collection_wide`.
 */
export async function getMmmPoolEligibility(poolAddress: string): Promise<EligibilityResult> {
  const hit = eligibilityHitCache.get(poolAddress);
  if (hit) return hit;
  if (eligibilityMissCache.has(poolAddress)) return UNKNOWN_RESULT;
  const inflight = eligibilityInflight.get(poolAddress);
  if (inflight) return inflight;

  const p = (async (): Promise<EligibilityResult> => {
    try {
      const result = await rpcPost('getAccountInfo', [
        poolAddress,
        { encoding: 'base64', commitment: 'confirmed' },
      ]) as { value: { data: [string, string] } | null };
      const b64 = result?.value?.data?.[0];
      if (!b64) { eligibilityMissCache.set(poolAddress, true); return UNKNOWN_RESULT; }
      const pool = parsePool(poolAddress, b64);
      if (!pool) { eligibilityMissCache.set(poolAddress, true); return UNKNOWN_RESULT; }
      const out: EligibilityResult = { eligibility: classifyMmmEligibility(pool.allowlists), allowlists: pool.allowlists };
      eligibilityHitCache.set(poolAddress, out);
      return out;
    } catch {
      eligibilityMissCache.set(poolAddress, true);
      return UNKNOWN_RESULT;
    } finally {
      eligibilityInflight.delete(poolAddress);
    }
  })();
  eligibilityInflight.set(poolAddress, p);
  return p;
}

// ─── Pure builders ───────────────────────────────────────────────────────────

function fundingWarning(candidate: MmmBidCandidate): string | null {
  if (candidate.funding === 'insufficient') {
    return `pool escrow (${(candidate.buysidePaymentAmountLamports / 1e9).toFixed(4)} SOL) is below its own `
      + `quoted spot price (${(candidate.spotPriceLamports / 1e9).toFixed(4)} SOL) — not executable at this price`;
  }
  if (candidate.funding === 'unknown') return 'pool funding state could not be determined from available data';
  return null;
}

function eligibilityWarning(eligibility: BidEligibility): string | null {
  if (eligibility === 'exact_mint') return 'pool allowlist restricts fills to one exact mint — not a collection-wide bid';
  if (eligibility === 'restricted') return 'pool allowlist is narrower than the whole collection';
  if (eligibility === 'unknown') return 'pool allowlist type could not be decoded — eligibility unknown, treated as non-collection-wide';
  return null;
}

/** Pure: given an already-classified MMM candidate and its (already looked
 *  up) eligibility, builds the normalized bid. No I/O. */
export function buildNormalizedMmmBid(
  candidate:   MmmBidCandidate,
  eligibility: BidEligibility,
): NormalizedCollectionBid {
  const grossAmountSol = candidate.spotPriceLamports / 1e9;
  const funding: BidFunding = candidate.funding;
  const usable = eligibility === 'collection_wide'
    && funding === 'verified'
    && Number.isFinite(grossAmountSol) && grossAmountSol > 0;

  const warnings = [fundingWarning(candidate), eligibilityWarning(eligibility)]
    .filter((w): w is string => w != null);

  return {
    venue: 'MMM',
    grossAmountSol,
    netAmountSol: null, // MMM spotPrice has no documented net-of-fees counterpart
    poolAddress: candidate.poolAddress,
    owner:       candidate.owner,
    eligibility,
    funding,
    executableForCollection: usable,
    usableForValueSignal:    usable,
    warnings,
  };
}

/** Pure: Tensor is always corroboration-only — a single aggregate stat with
 *  no per-NFT/trait executability signal, so eligibility is always
 *  'unknown' and funding always 'reported'. Returns null only when there is
 *  no positive gross amount to report at all. */
export function buildNormalizedTensorBid(
  grossLamports: number | null | undefined,
  netLamports:   number | null | undefined,
): NormalizedCollectionBid | null {
  if (typeof grossLamports !== 'number' || !Number.isFinite(grossLamports) || grossLamports <= 0) return null;
  const grossAmountSol = grossLamports / 1e9;
  const netAmountSol = typeof netLamports === 'number' && Number.isFinite(netLamports) && netLamports > 0
    ? netLamports / 1e9
    : null;
  return {
    venue: 'TENSOR',
    grossAmountSol,
    netAmountSol,
    poolAddress: null,
    owner:       null,
    eligibility: 'unknown',
    funding:     'reported',
    executableForCollection: false,
    usableForValueSignal:    false,
    warnings: [
      'Tensor collection-wide bid is a single aggregate stat — no per-NFT/trait executability signal exists at '
      + 'this endpoint; corroboration only, never sufficient to trigger VALUE on its own',
    ],
  };
}

// ─── Cross-venue best-bid selection ─────────────────────────────────────────

export interface CollectionBidPair {
  /** Highest-amount bid across ALL venues, usable or not — market context
   *  only (may be a phantom/underfunded MMM quote, or Tensor's always-
   *  corroboration-only aggregate). Never treat as executable. */
  bestContextBid: NormalizedCollectionBid | null;
  /** Highest-amount bid among ONLY bids where `usableForValueSignal` is
   *  true. Null when nothing on any venue is currently usable (this is the
   *  common case — Tensor never qualifies, MMM only when collection-wide +
   *  escrow-verified). The single entry point a VALUE-signal caller should
   *  use instead of re-deriving this filter itself. */
  bestUsableForValueBid: NormalizedCollectionBid | null;
}

/** Pure: pick both flavors of "best" from an already-fetched set of
 *  normalized bids (nulls allowed — a venue with no live quote). */
export function pickBestCollectionBids(
  bids: readonly (NormalizedCollectionBid | null)[],
): CollectionBidPair {
  const real = bids.filter((b): b is NormalizedCollectionBid => b != null);
  const highest = (pool: NormalizedCollectionBid[]): NormalizedCollectionBid | null =>
    pool.reduce<NormalizedCollectionBid | null>(
      (best, b) => (!best || b.grossAmountSol > best.grossAmountSol) ? b : best,
      null,
    );
  return {
    bestContextBid:         highest(real),
    bestUsableForValueBid:  highest(real.filter(b => b.usableForValueSignal)),
  };
}

/** I/O: fetches + normalizes MMM and Tensor for `slug`, then applies
 *  `pickBestCollectionBids`. Prefer this over calling `getNormalizedMmmBid`/
 *  `getNormalizedTensorBid` separately and re-deriving best-selection. */
export async function getBestCollectionBids(slug: string): Promise<CollectionBidPair> {
  const [mmm, tensor] = await Promise.all([
    getNormalizedMmmBid(slug),
    getNormalizedTensorBid(slug),
  ]);
  return pickBestCollectionBids([mmm, tensor]);
}

// ─── I/O wrappers ────────────────────────────────────────────────────────────

/**
 * Highest-spotPrice MMM candidate for `slug` (funded or not — see
 * fetchMmmBidSnapshot's `topOverall` doc), annotated with its on-chain
 * eligibility. Returns null only when there is no buy/two_sided pool at all
 * for this collection (e.g. claynosaurz). An underfunded or exact-mint pool
 * still returns a real object — with `usableForValueSignal: false` — never
 * silently dropped, so market-context display stays possible.
 */
export async function getNormalizedMmmBid(slug: string): Promise<NormalizedCollectionBid | null> {
  const { topOverall } = await fetchMmmBidSnapshot(slug);
  if (!topOverall) return null;
  const { eligibility } = await getMmmPoolEligibility(topOverall.poolAddress);
  return buildNormalizedMmmBid(topOverall, eligibility);
}

/** Tensor normalized bid — null when TENSOR_API_KEY is unset or no positive
 *  quote exists. Always corroboration-only (see buildNormalizedTensorBid). */
export async function getNormalizedTensorBid(slug: string): Promise<NormalizedCollectionBid | null> {
  const detail = await fetchTensorTopBidDetailed(slug);
  if (!detail) return null;
  return buildNormalizedTensorBid(detail.grossLamports, detail.netLamports);
}

export type { MmmFundingState };
