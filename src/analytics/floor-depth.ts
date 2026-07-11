/**
 * Floor Depth / Liquidity Analytics — pure, deterministic core.
 *
 * Consumes the SAME unified `Listing[]` snapshot listings-store.ts already
 * builds from ME + MMM + Tensor (see src/server/listings-store.ts, in
 * particular `getByCollection(slug)`). Makes NO network / DB / RPC calls of
 * its own — the caller is responsible for producing a fresh `Listing[]`.
 * Never mutates its input; output does not depend on input array order.
 *
 * ── Listing semantics this module relies on (verified against
 *    listings-store.ts, not assumed) ─────────────────────────────────────
 *
 *  - `priceSol` is always the GROSS, buyer-facing ask — what a buyer would
 *    pay to execute at that price — never a seller-net figure, for all
 *    three sources. Marketplace fees / creator royalties are NOT included
 *    anywhere upstream (MMM's own `mmmPriceLamports` comment is explicit:
 *    "Fees ... are intentionally excluded — this is the raw pool quote").
 *    `costSol` fields below are therefore sums of quoted ask prices, not
 *    all-in buyer cost.
 *
 *  - The SAME on-chain NFT can appear as MULTIPLE rows for one collection:
 *    ME's own `/listings` endpoint already includes pool-hosted mints
 *    (`source:'ME'`, `auctionHouse:''`) AND `fetchMmmPools` independently
 *    re-derives that same pool's inventory via the bonding-curve formula
 *    (`source:'MMM'`, `type:'pool'`). These land under different ids
 *    (`ME:{mint}:{seller}` vs `MMM:{poolKey}:{mint}`) and are NOT deduped
 *    anywhere upstream — this is the primary duplicate-mint case this
 *    module resolves, not merely "listed on ME and Tensor both" (Tensor's
 *    own fetch already drops rows whose `listing.source` starts with
 *    `MAGIC`, so ME-vs-Tensor overlap is largely pre-filtered before this
 *    module ever sees it; ME-vs-MMM overlap is not).
 *
 *  - `type: 'pool'` rows already carry an individually-computed per-mint
 *    price (k = index in the pool's mint array, ascending curve). They are
 *    genuinely usable as individual asks — not one blended pool price
 *    repeated per mint — provided they're consumed in ascending-price
 *    order, which is exactly what a floor/depth computation already does.
 *    The standing caveat (never fully resolvable from this data alone):
 *    that price assumes sequential draining with nothing else touching the
 *    pool between snapshot and execution, and excludes fees/royalties.
 *
 *  - `Listing` carries NO `isStale` / `expiresAt` / `status` field.
 *    Staleness is enforced upstream inside listings-store.ts's own
 *    suppression map (recently sold/delisted mints are withheld from
 *    re-entering the store for a TTL window) — by the time a row reaches
 *    this module, the store already believes it is live. This module
 *    cannot and does not attempt to (re-)detect staleness; it only defends
 *    against structurally invalid rows (bad price, missing mint identity).
 *    Note also: MMM pool `expiry` exists on ME's raw `/v2/mmm/pools`
 *    payload but is dropped during normalization — `Listing` has no field
 *    for it, so a per-pool expired-order cannot be detected here either.
 */

import type { Listing } from '../server/listings-store';

export interface FloorDepthBand {
  count:   number;
  costSol: number;
}

export interface MoveFloorBand {
  listingsToBuy: number;
  costSol:       number;
}

export interface FloorDepthResult {
  floorSol:          number | null;
  secondListingSol:  number | null;
  spreadPct:         number | null;

  listingCount:      number;
  uniqueMintCount:   number;

  depth: {
    within1Pct:  FloorDepthBand;
    within2Pct:  FloorDepthBand;
    within5Pct:  FloorDepthBand;
    within10Pct: FloorDepthBand;
  };

  moveFloor: {
    toPlus1Pct:  MoveFloorBand;
    toPlus2Pct:  MoveFloorBand;
    toPlus5Pct:  MoveFloorBand;
    toPlus10Pct: MoveFloorBand;
  };

  sourceBreakdown: {
    magicEden:  number;
    tensor:     number;
    mmmPool:    number;
    tensorPool: number;
    other:      number;
  };

  confidence: 'high' | 'medium' | 'low';
  warnings:   string[];
}

const BANDS = [1, 2, 5, 10] as const;
type BandPct = (typeof BANDS)[number];

// Absorbs floating-point representation error at exact percentage
// boundaries (e.g. 100 * 1.05 can evaluate to 105.00000000000001 in IEEE
// 754 double arithmetic) so a listing priced at EXACTLY floor * (1 + X%)
// is reliably included on the inclusive side of the boundary, matching the
// documented definition: "depth within X% = valid asks priced
// <= floorSol * (1 + X)".
const EPSILON = 1e-9;

// Sums of floating-point SOL prices accumulate representation noise over
// many additions; round to lamport precision (1 lamport = 1e-9 SOL) so
// output is display-stable and doesn't leak arithmetic artifacts.
function roundSol(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function isValidPrice(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isValidMint(m: unknown): m is string {
  return typeof m === 'string' && m.length > 0;
}

function emptyBand(): FloorDepthBand { return { count: 0, costSol: 0 }; }
function emptyMoveBand(): MoveFloorBand { return { listingsToBuy: 0, costSol: 0 }; }

/**
 * Pure, deterministic floor-depth / liquidity analysis over a single
 * collection's already-fetched `Listing[]`. Makes no network/DB/RPC calls,
 * never mutates `listings`, and its result does not depend on input order.
 */
export function computeFloorDepth(listings: readonly Listing[]): FloorDepthResult {
  const warnings: string[] = [];

  // ── Step 1: structural validity filter ──────────────────────────────────
  // Excludes: non-positive/NaN/non-finite prices, and rows with no
  // resolvable mint identity (deduplication would be unsafe without one).
  // There is nothing else to exclude here — staleness/expiry has no
  // representable field on `Listing` (see module doc comment above); the
  // store has already withheld anything it considers dead before this
  // function ever sees a row.
  let droppedForPrice = 0;
  let droppedForMint  = 0;
  const valid: Listing[] = [];
  for (const l of listings) {
    if (!isValidMint(l.mint))    { droppedForMint++;  continue; }
    if (!isValidPrice(l.priceSol)) { droppedForPrice++; continue; }
    valid.push(l);
  }
  if (droppedForMint > 0) {
    warnings.push(`${droppedForMint} raw listing(s) excluded for missing mint identity`);
  }
  if (droppedForPrice > 0) {
    warnings.push(`${droppedForPrice} raw listing(s) excluded for invalid (non-positive/NaN) price`);
  }

  // ── Step 2: source breakdown over ALL valid (pre-dedup) rows ────────────
  // Deliberately counted BEFORE dedup: this reports raw marketplace
  // presence ("60 ME rows, 12 MMM pool rows"), which is a distinct fact
  // from ask-depth math (which only ever uses the cheapest row per mint).
  // `tensorPool` is part of the shape for forward-compatibility with a
  // future Tensor AMM/TAMM integration — no current fetcher in
  // listings-store.ts ever produces `source:'TENSOR', type:'pool'`, so it
  // is always 0 today.
  const sourceBreakdown = { magicEden: 0, tensor: 0, mmmPool: 0, tensorPool: 0, other: 0 };
  let poolRowCount = 0;
  for (const l of valid) {
    if (l.type === 'pool') poolRowCount++;
    if (l.source === 'ME' && l.type === 'listing')          sourceBreakdown.magicEden++;
    else if (l.source === 'TENSOR' && l.type === 'listing') sourceBreakdown.tensor++;
    else if (l.source === 'MMM' && l.type === 'pool')       sourceBreakdown.mmmPool++;
    else if (l.source === 'TENSOR' && l.type === 'pool')    sourceBreakdown.tensorPool++;
    else sourceBreakdown.other++;
  }
  if (poolRowCount > 0) {
    warnings.push(
      'pool-hosted asks included — bonding-curve prices assume sequential fills at ' +
      'snapshot time and exclude marketplace fees/royalties',
    );
  }

  // ── Step 3: dedupe same mint across marketplaces — cheapest wins ───────
  // Order-independent by construction (keeps replacing on any strictly
  // cheaper find), so shuffling the input cannot change the result.
  const cheapestByMint = new Map<string, Listing>();
  for (const l of valid) {
    const existing = cheapestByMint.get(l.mint);
    if (!existing || l.priceSol < existing.priceSol) cheapestByMint.set(l.mint, l);
  }
  const duplicateMintCount = valid.length - cheapestByMint.size;
  if (duplicateMintCount > 0) {
    warnings.push(`${duplicateMintCount} duplicate row(s) collapsed across marketplaces for the same mint`);
  }

  // ── Step 4: sort a FRESH array ascending by price — never sorts the
  // caller's `listings` (or `valid`) in place. ────────────────────────────
  const asks = Array.from(cheapestByMint.values()).sort((a, b) => a.priceSol - b.priceSol);
  const listingCount    = valid.length;
  const uniqueMintCount = asks.length;

  if (listingCount === 0) {
    warnings.push('no valid listings for this collection');
  } else if (uniqueMintCount < 2) {
    warnings.push('fewer than 2 unique mints — spread/depth are not meaningful');
  }

  const floorSol = asks.length > 0 ? asks[0].priceSol : null;
  const secondListingSol = asks.length > 1 ? asks[1].priceSol : null;
  const spreadPct = (floorSol != null && secondListingSol != null && floorSol > 0)
    ? (secondListingSol - floorSol) / floorSol
    : null;

  // ── Step 5: depth bands + move-floor bands ──────────────────────────────
  // Both use the SAME inclusive-boundary comparison (`<= threshold + EPSILON`
  // for "within the band" / `> threshold + EPSILON` for "beyond it") so an
  // ask priced at EXACTLY floor*(1+X%) is treated consistently in both
  // directions: it counts toward `depth.withinXPct` AND it must still be
  // bought (not skipped) before `moveFloor.toPlusXPct` reports a surviving
  // ask genuinely above the threshold.
  const depthByPct: Record<BandPct, FloorDepthBand> = { 1: emptyBand(), 2: emptyBand(), 5: emptyBand(), 10: emptyBand() };
  const moveByPct:  Record<BandPct, MoveFloorBand>  = { 1: emptyMoveBand(), 2: emptyMoveBand(), 5: emptyMoveBand(), 10: emptyMoveBand() };
  let anyMoveFloorExhausted = false;

  if (floorSol != null) {
    for (const pct of BANDS) {
      const threshold = floorSol * (1 + pct / 100);

      let count = 0, cost = 0;
      for (const a of asks) {
        if (a.priceSol <= threshold + EPSILON) { count++; cost += a.priceSol; }
      }
      depthByPct[pct] = { count, costSol: roundSol(cost) };

      let listingsToBuy = 0, moveCost = 0, foundBeyond = false;
      for (const a of asks) {
        if (a.priceSol > threshold + EPSILON) { foundBeyond = true; break; }
        listingsToBuy++;
        moveCost += a.priceSol;
      }
      if (!foundBeyond) {
        anyMoveFloorExhausted = true;
        warnings.push(
          `moveFloor.toPlus${pct}Pct exhausted all listed asks without finding one above +${pct}%`,
        );
      }
      moveByPct[pct] = { listingsToBuy, costSol: roundSol(moveCost) };
    }
  }

  const depth = {
    within1Pct:  depthByPct[1],
    within2Pct:  depthByPct[2],
    within5Pct:  depthByPct[5],
    within10Pct: depthByPct[10],
  };
  const moveFloor = {
    toPlus1Pct:  moveByPct[1],
    toPlus2Pct:  moveByPct[2],
    toPlus5Pct:  moveByPct[5],
    toPlus10Pct: moveByPct[10],
  };

  // ── Step 6: confidence ───────────────────────────────────────────────────
  // 'low'    — no floor at all, or too few unique mints for spread/depth to
  //            mean anything (0 or 1).
  // 'high'   — a healthy sample (>=5 unique mints) AND every move-floor band
  //            found a genuinely-surviving ask beyond it (i.e. observed
  //            depth wasn't exhausted just describing the visible orderbook).
  // 'medium' — everything in between: some real data, but thin or bounded
  //            by what's currently listed.
  let confidence: FloorDepthResult['confidence'];
  if (floorSol == null || uniqueMintCount < 2) confidence = 'low';
  else if (uniqueMintCount >= 5 && !anyMoveFloorExhausted) confidence = 'high';
  else confidence = 'medium';

  return {
    floorSol,
    secondListingSol,
    spreadPct,
    listingCount,
    uniqueMintCount,
    depth,
    moveFloor,
    sourceBreakdown,
    confidence,
    warnings,
  };
}
