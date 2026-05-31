/**
 * Rare Feed — evaluator. Subscribes to the EXISTING in-process sale event bus
 * (no new ingestion, no new Helius calls, no parser changes) and turns the
 * stream of normal sales into the much smaller stream of rare/value sales.
 *
 * Why two bus events:
 *   • `sale` (insertSaleEvent → emitSale) fires first and carries the sale
 *     price, marketplace and block time, but NOT the enriched floor.
 *   • `meta` (background enrich → emitMetaUpdate) fires later and carries the
 *     floor delta + NFT name/image/slug, but NOT the sale price.
 * We capture the sale in a small bounded map keyed by signature, then evaluate
 * when its `meta` arrives. This keeps Rare Feed entirely downstream of the
 * existing write path — it never blocks or mutates normal feed rendering.
 *
 * Evaluation is async + fail-soft: any error (ME down, DB blip) just means the
 * sale doesn't appear in Rare Feed; the live feed is unaffected.
 */
import { saleEventBus, type MetaUpdate } from '../events/emitter';
import type { SaleEvent } from '../models/sale-event';
import { getPool } from '../db/client';
import { getRarity } from './rarity';
import { scoreSale, isTrueOneOfOne, ONE_OF_ONE_SCORE } from './scoring';
import { insertRareEvent } from './store';

/** Captured sale awaiting its enrichment `meta` event. */
interface PendingSale {
  priceSol:    number;
  marketplace: string;
  blockTime:   Date;
  mintAddress: string;
  slug:        string | null;
  at:          number;   // capture time for TTL eviction
}

// Bounded correlation buffer. A sale's `meta` normally lands within a few
// seconds; we keep entries ~5 min and cap the map so a burst can't grow it
// without bound. Insertion-ordered Map → oldest entries are at the front.
const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_MAX    = 5_000;
const pending = new Map<string, PendingSale>();

// Signatures we've already reached a terminal decision on (accepted, or
// rejected for a reason that won't change). Bounded FIFO so repeat `meta`
// events (image-retry patches, reconnect replays) don't re-run rarity work.
const decided = new Set<string>();
const DECIDED_MAX = 20_000;

function markDecided(sig: string): void {
  decided.add(sig);
  if (decided.size > DECIDED_MAX) {
    // Drop the oldest ~10% in one pass.
    let drop = DECIDED_MAX / 10;
    for (const s of decided) { decided.delete(s); if (--drop <= 0) break; }
  }
}

function evictPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  // Map preserves insertion order, so the front entries are the oldest.
  // Drop anything past its TTL, then keep dropping the oldest until we're
  // back under the size cap.
  for (const [sig, p] of pending) {
    if (p.at >= cutoff && pending.size <= PENDING_MAX) break;
    pending.delete(sig);
  }
}

// Diagnostics — cumulative counters since boot, logged on a periodic
// summary so the accept/reject funnel is observable without grepping every
// per-event line. `evaluated` counts candidates that reached the rarity
// stage (had a captured sale + floor + mint).
const stat = { evaluated: 0, missingRarity: 0, rejRarity: 0, rejPrice: 0, accepted: 0, oneOfOne: 0 };

// Per-slug true-1/1 flood guard: cap force-includes per collection per rolling
// hour, so a collection that tags many items as "1/1" can't dominate the feed
// even if it slips past isTrueOneOfOne's rank guard.
const ONE_OF_ONE_SLUG_CAP   = 8;
const ONE_OF_ONE_WINDOW_MS  = 60 * 60 * 1000;
const oneOfOneBySlug = new Map<string, { count: number; windowStart: number }>();
function allowOneOfOne(slug: string | null): boolean {
  const key = slug ?? '?';
  const now = Date.now();
  const e = oneOfOneBySlug.get(key);
  if (!e || now - e.windowStart > ONE_OF_ONE_WINDOW_MS) {
    oneOfOneBySlug.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= ONE_OF_ONE_SLUG_CAP) return false;
  e.count++;
  return true;
}

function onSale(event: SaleEvent): void {
  if (!event.mintAddress) return;            // can't fetch rarity without a mint
  pending.set(event.signature, {
    priceSol:    event.priceSol,
    marketplace: event.marketplace,
    blockTime:   event.blockTime,
    mintAddress: event.mintAddress,
    slug:        event.meCollectionSlug ?? null,
    at:          Date.now(),
  });
  if (pending.size > PENDING_MAX) evictPending();
}

/** Inputs for one evaluation, sourced either from a live sale+meta pair or
 *  from a boot-replay DB row. `floorDelta` is null when no floor is available
 *  (boot replay has no live `meta`), in which case only the 1/1 path can pass. */
interface CandidateInput {
  signature:      string;
  mintAddress:    string;
  slug:           string | null;
  salePrice:      number;
  marketplace:    string;
  blockTime:      Date;
  nftName:        string | null;
  imageUrl:       string | null;
  collectionName: string | null;
  floorDelta:     number | null;
}

/** Discriminated result so callers (live vs replay) own their own
 *  decided/pending bookkeeping, stat counters and logging. `no_floor` is the
 *  only NON-terminal outcome — a non-1/1 with no floor may still be evaluated
 *  later when a floor-bearing `meta` arrives. */
type EvalOutcome =
  | { kind: 'one_of_one'; wrote: boolean; rank: number | null; supply: number | null; source: string }
  | { kind: 'flood' }
  | { kind: 'no_floor' }
  | { kind: 'no_rarity' }
  | { kind: 'rejected'; reason: 'rarity' | 'price'; pct: number; floorDeltaPct: number }
  | { kind: 'accepted'; wrote: boolean; score: number; tags: string[]; rank: number; supply: number };

/**
 * Shared evaluation core for the live `meta` path AND boot replay. Resolves
 * rarity (traits-bearing), applies the conservative true-1/1 exception, else
 * the unchanged percentile + price/floor gate. Performs the insert; does NOT
 * touch the decided/pending maps or stat counters — that's the caller's job.
 */
async function evaluateCandidate(c: CandidateInput): Promise<EvalOutcome> {
  const hasFloor   = c.floorDelta != null && c.floorDelta > -1;
  const floorPrice = hasFloor ? c.salePrice / (1 + (c.floorDelta as number)) : null;
  const rarity     = await getRarity(c.mintAddress, c.slug);

  // ── True 1/1 exception: force-include regardless of floor / percentile /
  //    near-floor price. Keeps the provider's REAL rank; score is synthetic.
  if (isTrueOneOfOne(rarity.traits, c.nftName, rarity.totalSupply, rarity.rarityRank)) {
    if (!allowOneOfOne(c.slug)) return { kind: 'flood' };
    const pct = rarity.totalSupply ? (rarity.rarityRank as number) / rarity.totalSupply : null;
    const wrote = await insertRareEvent({
      saleSignature:    c.signature,
      mintAddress:      c.mintAddress,
      collectionSlug:   c.slug,
      collectionName:   c.collectionName,
      nftName:          c.nftName,
      imageUrl:         c.imageUrl,
      source:           c.marketplace,
      salePriceSol:     c.salePrice,
      floorPriceSol:    floorPrice,
      floorDeltaPct:    hasFloor ? c.floorDelta : null,
      rarityRank:       rarity.rarityRank,
      totalSupply:      rarity.totalSupply,
      rarityPercentile: pct,
      raritySource:     rarity.source,
      rareScore:        ONE_OF_ONE_SCORE,
      reasonTags:       ['ONE_OF_ONE'],
      saleTime:         c.blockTime,
    });
    return { kind: 'one_of_one', wrote, rank: rarity.rarityRank, supply: rarity.totalSupply, source: rarity.source };
  }

  // ── Normal path: requires a floor. Without it, NON-terminal (caller waits).
  if (!hasFloor || floorPrice == null || floorPrice <= 0) return { kind: 'no_floor' };
  if (rarity.rarityRank == null || rarity.totalSupply == null || rarity.totalSupply <= 0) {
    return { kind: 'no_rarity' };
  }

  const result = scoreSale({
    rarityRank:  rarity.rarityRank,
    totalSupply: rarity.totalSupply,
    salePrice:   c.salePrice,
    floorPrice,
  });
  if (!result.qualifies) {
    return { kind: 'rejected', reason: result.rejectReason ?? 'rarity', pct: result.rarityPercentile, floorDeltaPct: result.floorDeltaPct };
  }

  const wrote = await insertRareEvent({
    saleSignature:    c.signature,
    mintAddress:      c.mintAddress,
    collectionSlug:   c.slug,
    collectionName:   c.collectionName,
    nftName:          c.nftName,
    imageUrl:         c.imageUrl,
    source:           c.marketplace,
    salePriceSol:     c.salePrice,
    floorPriceSol:    floorPrice,
    floorDeltaPct:    result.floorDeltaPct,
    rarityRank:       rarity.rarityRank,
    totalSupply:      rarity.totalSupply,
    rarityPercentile: result.rarityPercentile,
    raritySource:     rarity.source,
    rareScore:        result.score,
    reasonTags:       result.reasonTags,
    saleTime:         c.blockTime,
  });
  return { kind: 'accepted', wrote, score: result.score, tags: result.reasonTags, rank: rarity.rarityRank, supply: rarity.totalSupply };
}

function onMeta(update: MetaUpdate): void {
  const sig = update.signature;
  if (decided.has(sig)) return;
  const sale = pending.get(sig);
  if (!sale) return;                          // sale not captured (pre-restart / empty mint)
  const slug = update.meCollectionSlug ?? sale.slug;

  // Async, fire-and-forget — never blocks the bus / SSE fan-out.
  void (async () => {
    try {
      if (decided.has(sig)) return;
      stat.evaluated++;
      const outcome = await evaluateCandidate({
        signature:      sig,
        mintAddress:    sale.mintAddress,
        slug,
        salePrice:      sale.priceSol,
        marketplace:    sale.marketplace,
        blockTime:      sale.blockTime,
        nftName:        update.nftName,
        imageUrl:       update.imageUrl,
        collectionName: update.collectionName,
        floorDelta:     update.floorDelta ?? null,
      });

      // Non-1/1 with no floor: leave un-decided so a later `meta` carrying the
      // floor can still evaluate it. Every other outcome is terminal.
      if (outcome.kind === 'no_floor') return;
      markDecided(sig);
      pending.delete(sig);

      switch (outcome.kind) {
        case 'flood':
          console.log(`[rare/feed] 1of1 skipped sig=${sig.slice(0, 12)}… slug=${slug ?? '?'} reason=slug_cap`);
          break;
        case 'one_of_one':
          if (outcome.wrote) stat.oneOfOne++;
          console.log(
            `[rare/feed] 1of1 accepted sig=${sig.slice(0, 12)}… mint=${sale.mintAddress.slice(0, 8)}… ` +
            `rank=${outcome.rank}/${outcome.supply} src=${outcome.source} ${outcome.wrote ? '' : '(dup)'}`,
          );
          break;
        case 'no_rarity':
          stat.missingRarity++;
          console.log(`[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=no_rarity`);
          break;
        case 'rejected':
          if (outcome.reason === 'rarity') stat.rejRarity++; else stat.rejPrice++;
          console.log(
            `[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=${outcome.reason} ` +
            `pct=${(outcome.pct * 100).toFixed(2)}% floorDelta=${(outcome.floorDeltaPct * 100).toFixed(1)}%`,
          );
          break;
        case 'accepted':
          if (outcome.wrote) stat.accepted++;
          console.log(
            `[rare/feed] accepted sig=${sig.slice(0, 12)}… score=${outcome.score} ` +
            `tags=${outcome.tags.join(',')} rank=${outcome.rank}/${outcome.supply} ${outcome.wrote ? '' : '(dup, skipped)'}`,
          );
          break;
      }
    } catch (err) {
      console.warn(`[rare/feed] eval error sig=${sig.slice(0, 12)}…: ${(err as Error).message}`);
    }
  })();
}

// ─── Boot replay ────────────────────────────────────────────────────────────
// Default 15 min, env-overridable, hard-capped at 60 min so a misconfig can't
// trigger a huge historical replay.
const BOOT_REPLAY_MIN = (() => {
  const raw = parseInt((process.env.RARE_FEED_BOOT_REPLAY_MINUTES ?? '').trim(), 10);
  const n = Number.isFinite(raw) ? raw : 15;
  return Math.max(0, Math.min(60, n));
})();
const BOOT_REPLAY_LIMIT = 500;

/**
 * On startup, replay a small recent window of sales that have no rare_feed row
 * yet, through the shared `evaluateCandidate` path. This recovers sales whose
 * `sale`→`meta` correlation was lost when the process restarted mid-flight —
 * the largest measured Rare-Feed coverage loss.
 *
 * Idempotent + bounded + safe on every restart:
 *   • skips signatures already in rare_feed_events (anti-join) + insert is
 *     ON CONFLICT DO NOTHING, so it never duplicates rows;
 *   • replayed sales have NO live `meta`, so no floor is available — only the
 *     true 1/1 exception can pass (non-1/1 → `no_floor`, left un-decided so a
 *     live meta can still handle a very-recent sale);
 *   • capped to BOOT_REPLAY_MIN minutes and BOOT_REPLAY_LIMIT rows.
 */
async function bootReplay(): Promise<void> {
  if (BOOT_REPLAY_MIN <= 0) return;
  let scanned = 0, evaluated = 0, accepted = 0, oneOfOne = 0, skippedNoFloor = 0;
  try {
    const { rows } = await getPool().query(
      `SELECT se.signature, se.mint_address, se.me_collection_slug, se.price_sol,
              se.marketplace, se.block_time, se.nft_name, se.image_url, se.collection_name
         FROM sale_events se
         LEFT JOIN rare_feed_events rf ON rf.sale_signature = se.signature
        WHERE se.block_time >= now() - ($1 || ' minutes')::interval
          AND se.mint_address IS NOT NULL AND se.mint_address <> ''
          AND rf.sale_signature IS NULL
        ORDER BY se.block_time DESC
        LIMIT $2`,
      [String(BOOT_REPLAY_MIN), BOOT_REPLAY_LIMIT],
    );
    scanned = rows.length;
    for (const r of rows) {
      if (decided.has(r.signature)) continue;
      evaluated++;
      const outcome = await evaluateCandidate({
        signature:      r.signature,
        mintAddress:    r.mint_address,
        slug:           r.me_collection_slug ?? null,
        salePrice:      Number(r.price_sol),
        marketplace:    r.marketplace,
        blockTime:      new Date(r.block_time),
        nftName:        r.nft_name ?? null,
        imageUrl:       r.image_url ?? null,
        collectionName: r.collection_name ?? null,
        floorDelta:     null,   // no live meta on replay → 1/1 exception only
      });
      // Mark terminal outcomes decided so a concurrent/late live meta skips
      // them; leave `no_floor` un-decided so a very-recent sale's live meta can
      // still evaluate it with a real floor.
      if (outcome.kind !== 'no_floor') markDecided(r.signature);
      if (outcome.kind === 'one_of_one') { if (outcome.wrote) { accepted++; oneOfOne++; } }
      else if (outcome.kind === 'accepted') { if (outcome.wrote) accepted++; }
      else if (outcome.kind === 'no_floor') skippedNoFloor++;
    }
  } catch (err) {
    console.warn(`[rare/feed/replay] error: ${(err as Error).message}`);
  }
  console.log(
    `[rare/feed/replay] window=${BOOT_REPLAY_MIN}m scanned=${scanned} evaluated=${evaluated} ` +
    `accepted=${accepted} oneOfOne=${oneOfOne} skippedNoFloor=${skippedNoFloor}`,
  );
}

let started = false;
/** Register the bus listeners. Idempotent. */
export function startRareFeedEvaluator(): void {
  if (started) return;
  started = true;
  saleEventBus.onSale(onSale);
  saleEventBus.onMetaUpdate(onMeta);
  console.log('[rare/feed] evaluator attached (sale + meta bus listeners)');
  // Recover sales lost to a mid-flight restart (sale captured, meta wiped).
  // Fire-and-forget AFTER listeners attach, so live sales are never missed.
  void bootReplay();
  // Periodic funnel summary (cumulative since boot) every 5 min.
  const summary = setInterval(() => {
    console.log(
      `[rare/feed] summary evaluated=${stat.evaluated} missingRarity=${stat.missingRarity} ` +
      `rejRarity=${stat.rejRarity} rejPrice=${stat.rejPrice} accepted=${stat.accepted} oneOfOne=${stat.oneOfOne}`,
    );
  }, 5 * 60 * 1000);
  summary.unref?.();
}
