/**
 * Cross-Market Divergence — pure comparison core + a thin I/O wrapper.
 *
 * Extracted from `src/server/tools-me-tensor-arb.ts`, which today computes
 * "which ME/MMM listings are cheaper than Tensor's floor" inline, ad hoc,
 * per request. This module is the SAME comparison, generalized into a
 * reusable shape so it can also power passive divergence detection and
 * Mispriced NFT scoring later — neither of which is implemented here.
 *
 * `computeCrossMarketGap()` makes NO network/DB/RPC calls — see the module
 * doc on `computeFloorDepth` (floor-depth.ts) for the full `Listing`
 * semantics this shares (gross buyer-facing price, no staleness field,
 * ME-vs-MMM duplicate-mint risk, pool asks are individually-priced). This
 * file reuses that module's exact validation/rounding primitives
 * (`isValidPrice`, `isValidMint`, `roundSol`, `EPSILON`) rather than
 * re-implementing them, so "what counts as a valid ask" never drifts
 * between the two analytics modules.
 *
 * ── Why ME direct floor and MMM executable floor are kept separate ───────
 *
 * `meDirectFloorSol` answers "what does ME's own order book say the
 * cheapest ask is" — the same question `getDerivedFloorLamports()`
 * (listings-store.ts) answers, and deliberately excludes MMM/pool rows for
 * the same reason that function documents: a bonding-curve quote can sit
 * below or above the real order-book floor and moves on its own schedule,
 * so blending it into "the ME floor" makes a single collection's floor
 * silently jump between reads. `mmmExecutableFloorSol` is the answer to a
 * DIFFERENT question — "what's the cheapest pool-hosted ask right now" —
 * kept as its own field so a caller can tell whether a cheap
 * `executableFloorAnySol` came from a real listing or a curve quote.
 *
 * ── How pool asks are treated ─────────────────────────────────────────────
 *
 * Identically to floor-depth.ts: a `type:'pool'` row already carries an
 * individually-computed per-mint price and is treated as a genuine,
 * individually-executable ask — never blended into one pool-wide number.
 * It can win the per-mint dedup, can set `mmmExecutableFloorSol`, and can
 * appear as the `listingSource` of an opportunity exactly like an ME or
 * Tensor row can.
 *
 * ── How duplicate mints are handled ────────────────────────────────────────
 *
 * Same principle as floor-depth.ts: group by mint, keep the row with the
 * strictly lowest `priceSol` for every aggregate calculation and for the
 * opportunities list. A mint listed on both ME and Tensor, or ME-scraped
 * AND independently MMM-pool-fetched, contributes exactly ONE entry —
 * unlike the current `tools-me-tensor-arb.ts`, which does not dedupe (see
 * that file's own comment on why its `listings` field is deliberately NOT
 * rebuilt from this module's `opportunities`).
 *
 * ── Which floor definition a future Mispriced NFT scorer should use ──────
 *
 *  - Reference comparison ("is this ask underpriced relative to the wider
 *    market"): use `opportunities` directly, or `tensorDirectFloorSol` /
 *    `meDirectFloorSol` as the reference — these are order-book floors,
 *    the number a market actually trades around.
 *  - Executable corroboration ("if I wanted to buy the cheapest thing right
 *    now, regardless of source, what would it cost"): use
 *    `executableFloorAnySol` / `perMintFloors`, which include pool asks.
 *  Conflating the two would let a curve-quote pool price silently become
 *  the "market reference," which is exactly the bug `getDerivedFloorLamports()`
 *  already guards against for the single-market floor case.
 */

import type { Listing } from '../server/listings-store';
import { ensureFresh, getByCollection } from '../server/listings-store';
import { isValidPrice, isValidMint, roundSol, EPSILON } from './floor-depth';

export type MarketSource = 'ME' | 'MMM' | 'TENSOR';
export type MarketType   = 'listing' | 'pool';

export interface MarketFloor {
  source:   MarketSource;
  type:     MarketType;
  priceSol: number;
  mint:     string;
}

export interface CrossMarketOpportunity {
  mint:            string;
  listingSource:   MarketSource;
  listingType:     MarketType;
  listingPriceSol: number;

  /** The market this listing undercuts. Never equal to `listingSource`'s
   *  own market — comparing a market against itself is meaningless and is
   *  explicitly excluded (an ME/MMM ask is only ever compared to Tensor's
   *  floor; a Tensor ask is only ever compared to ME's direct floor). */
  referenceSource:   'ME' | 'TENSOR';
  referenceFloorSol: number;

  gapSol: number;
  gapPct: number;
}

export interface CrossMarketResult {
  meDirectFloorSol:      number | null;
  mmmExecutableFloorSol: number | null;
  tensorDirectFloorSol:  number | null;
  executableFloorAnySol: number | null;

  /** One entry per unique mint — the cheapest executable listing for that
   *  mint across every source, with the winning row's source/type
   *  preserved. This is the substrate `opportunities` is built from; a
   *  future Mispriced-NFT scorer should read per-mint prices from here
   *  rather than re-deriving its own dedup over raw `Listing[]`. */
  perMintFloors: MarketFloor[];

  rawListingCount: number;
  uniqueMintCount: number;

  opportunities: CrossMarketOpportunity[];

  warnings:   string[];
  confidence: 'high' | 'medium' | 'low';
}

function isDirectListing(l: Listing): boolean {
  return l.type === 'listing';
}

/**
 * Pure, deterministic cross-market comparison over a single collection's
 * already-fetched `Listing[]` (ME + MMM + Tensor, as `listings-store.ts`
 * unifies them). Makes no network/DB/RPC calls, never mutates `listings`,
 * and its result does not depend on input array order.
 */
export function computeCrossMarketGap(listings: readonly Listing[]): CrossMarketResult {
  const warnings: string[] = [];

  // ── Step 1: structural validity filter — identical rule to floor-depth ──
  let droppedForMint  = 0;
  let droppedForPrice = 0;
  const valid: Listing[] = [];
  for (const l of listings) {
    if (!isValidMint(l.mint))      { droppedForMint++;  continue; }
    if (!isValidPrice(l.priceSol)) { droppedForPrice++; continue; }
    valid.push(l);
  }
  if (droppedForMint > 0) {
    warnings.push(`${droppedForMint} raw listing(s) excluded for missing mint identity`);
  }
  if (droppedForPrice > 0) {
    warnings.push(`${droppedForPrice} raw listing(s) excluded for invalid (non-positive/NaN) price`);
  }

  const poolRowCount = valid.filter(l => l.type === 'pool').length;
  if (poolRowCount > 0) {
    warnings.push(
      'pool-hosted asks included — bonding-curve prices assume sequential fills at ' +
      'snapshot time and exclude marketplace fees/royalties',
    );
  }

  // ── Step 2: per-source direct/executable floors ─────────────────────────
  // Computed directly over the valid rows for THAT source — never derived
  // from the cross-source dedup below. "ME's own floor" must reflect ME's
  // own cheapest ask even when a different source is cheaper for the same
  // mint (see module doc: this is a deliberately different question from
  // `executableFloorAnySol`).
  let meDirectFloorSol: number | null = null;
  let mmmExecutableFloorSol: number | null = null;
  let tensorDirectFloorSol: number | null = null;
  for (const l of valid) {
    if (l.source === 'ME' && isDirectListing(l)) {
      if (meDirectFloorSol === null || l.priceSol < meDirectFloorSol) meDirectFloorSol = l.priceSol;
    } else if (l.source === 'MMM' && l.type === 'pool') {
      if (mmmExecutableFloorSol === null || l.priceSol < mmmExecutableFloorSol) mmmExecutableFloorSol = l.priceSol;
    } else if (l.source === 'TENSOR' && isDirectListing(l)) {
      if (tensorDirectFloorSol === null || l.priceSol < tensorDirectFloorSol) tensorDirectFloorSol = l.priceSol;
    }
  }
  if (meDirectFloorSol === null) {
    warnings.push('no ME direct listings — cannot compute Tensor-vs-ME opportunities');
  }
  if (tensorDirectFloorSol === null) {
    warnings.push('no Tensor direct listings — cannot compute ME/MMM-vs-Tensor opportunities');
  }

  // ── Step 3: dedupe same mint across ALL sources — cheapest wins ────────
  // Identical principle to floor-depth.ts's `cheapestByMint`. Order-
  // independent by construction (keeps replacing on any strictly cheaper
  // find), so shuffling the input cannot change the result.
  const cheapestByMint = new Map<string, Listing>();
  for (const l of valid) {
    const existing = cheapestByMint.get(l.mint);
    if (!existing || l.priceSol < existing.priceSol) cheapestByMint.set(l.mint, l);
  }
  const duplicateMintCount = valid.length - cheapestByMint.size;
  if (duplicateMintCount > 0) {
    warnings.push(`${duplicateMintCount} duplicate row(s) collapsed across marketplaces for the same mint`);
  }

  const perMintFloors: MarketFloor[] = Array.from(cheapestByMint.values())
    .sort((a, b) => a.priceSol - b.priceSol)
    .map(l => ({ source: l.source, type: l.type, priceSol: l.priceSol, mint: l.mint }));

  const rawListingCount = valid.length;
  const uniqueMintCount  = perMintFloors.length;

  const executableFloorAnySol = perMintFloors.length > 0 ? perMintFloors[0].priceSol : null;

  if (rawListingCount === 0) {
    warnings.push('no valid listings for this collection');
  } else if (uniqueMintCount < 2) {
    warnings.push('fewer than 2 unique mints — cross-market comparison is not meaningful');
  }

  // ── Step 4: opportunities — exactly two comparison directions ───────────
  // A) ME/MMM's cheapest-for-that-mint ask, priced below Tensor's direct
  //    floor.
  // B) Tensor's cheapest-for-that-mint ask, priced below ME's direct floor.
  // Never compares a market against itself; never compares against a null
  // reference floor (both guarded explicitly, not just "happens to skip").
  const opportunities: CrossMarketOpportunity[] = [];
  for (const l of perMintFloors) {
    if (l.source !== 'TENSOR' && tensorDirectFloorSol !== null) {
      if (l.priceSol < tensorDirectFloorSol - EPSILON) {
        const gapSol = tensorDirectFloorSol - l.priceSol;
        opportunities.push({
          mint: l.mint,
          listingSource: l.source,
          listingType: l.type,
          listingPriceSol: l.priceSol,
          referenceSource: 'TENSOR',
          referenceFloorSol: tensorDirectFloorSol,
          gapSol: roundSol(gapSol),
          gapPct: gapSol / tensorDirectFloorSol,
        });
      }
    } else if (l.source === 'TENSOR' && meDirectFloorSol !== null) {
      if (l.priceSol < meDirectFloorSol - EPSILON) {
        const gapSol = meDirectFloorSol - l.priceSol;
        opportunities.push({
          mint: l.mint,
          listingSource: l.source,
          listingType: l.type,
          listingPriceSol: l.priceSol,
          referenceSource: 'ME',
          referenceFloorSol: meDirectFloorSol,
          gapSol: roundSol(gapSol),
          gapPct: gapSol / meDirectFloorSol,
        });
      }
    }
  }
  // Strongest gap first (biggest % discount), tie-broken by absolute SOL
  // gap, then mint for full determinism regardless of input/Map iteration
  // order.
  opportunities.sort((a, b) => {
    if (b.gapPct !== a.gapPct) return b.gapPct - a.gapPct;
    if (b.gapSol !== a.gapSol) return b.gapSol - a.gapSol;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });

  // ── Step 5: confidence ───────────────────────────────────────────────────
  // 'low'    — no executable floor at all, or too few unique mints.
  // 'high'   — a healthy sample (>=5 unique mints) AND both ME and Tensor
  //            are represented, so both comparison directions are actually
  //            possible (not just one side of the market).
  // 'medium' — everything in between.
  let confidence: CrossMarketResult['confidence'];
  if (executableFloorAnySol === null || uniqueMintCount < 2) confidence = 'low';
  else if (uniqueMintCount >= 5 && meDirectFloorSol !== null && tensorDirectFloorSol !== null) confidence = 'high';
  else confidence = 'medium';

  return {
    meDirectFloorSol,
    mmmExecutableFloorSol,
    tensorDirectFloorSol,
    executableFloorAnySol,
    perMintFloors,
    rawListingCount,
    uniqueMintCount,
    opportunities,
    warnings,
    confidence,
  };
}

/**
 * I/O wrapper — reuses the EXISTING listings-store.ts snapshot machinery
 * (`ensureFresh` + `getByCollection`). No new fetch path, no new cache; this
 * is the same data `tools-me-tensor-arb.ts` and the collection page already
 * read.
 */
export async function getCrossMarketGap(slug: string): Promise<CrossMarketResult> {
  await ensureFresh(slug);
  const listings = getByCollection(slug);
  return computeCrossMarketGap(listings);
}
