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

function onMeta(update: MetaUpdate): void {
  const sig = update.signature;
  if (decided.has(sig)) return;
  const sale = pending.get(sig);
  if (!sale) return;                          // sale not captured (pre-restart / empty mint)

  const floorDelta = update.floorDelta;
  const hasFloor   = floorDelta != null && floorDelta > -1;
  const salePrice  = sale.priceSol;
  const floorPrice = hasFloor ? salePrice / (1 + floorDelta) : null;
  const mint       = sale.mintAddress;
  const slug       = update.meCollectionSlug ?? sale.slug;

  // Async, fire-and-forget — never blocks the bus / SSE fan-out.
  //
  // Rarity is resolved FIRST (it carries the traits we need), because the true
  // 1/1 exception must work even when no floor is available — genuine 1/1 drops
  // frequently have no floor yet, and they legitimately sell far above floor.
  // Non-1/1 sales still REQUIRE a floor and, when it's missing, are left
  // un-decided so a later `meta` (floor/image retry) can still evaluate them.
  void (async () => {
    try {
      if (decided.has(sig)) return;
      stat.evaluated++;
      const rarity = await getRarity(mint, slug);

      // ── True 1/1 exception ───────────────────────────────────────────────
      // Force-include regardless of floor / percentile / near-floor price.
      // Keep the provider's REAL rank; only the score is synthetic (for sort +
      // min-score gate). Tagged ONE_OF_ONE so the UI can badge it.
      if (isTrueOneOfOne(rarity.traits, update.nftName, rarity.totalSupply, rarity.rarityRank)) {
        if (decided.has(sig)) return;
        markDecided(sig);
        pending.delete(sig);
        if (!allowOneOfOne(slug)) {
          console.log(`[rare/feed] 1of1 skipped sig=${sig.slice(0, 12)}… slug=${slug ?? '?'} reason=slug_cap`);
          return;
        }
        const pct = rarity.totalSupply ? (rarity.rarityRank as number) / rarity.totalSupply : null;
        const wrote = await insertRareEvent({
          saleSignature:    sig,
          mintAddress:      mint,
          collectionSlug:   slug,
          collectionName:   update.collectionName,
          nftName:          update.nftName,
          imageUrl:         update.imageUrl,
          source:           sale.marketplace,
          salePriceSol:     salePrice,
          floorPriceSol:    floorPrice,
          floorDeltaPct:    hasFloor ? floorDelta : null,
          rarityRank:       rarity.rarityRank,
          totalSupply:      rarity.totalSupply,
          rarityPercentile: pct,
          raritySource:     rarity.source,
          rareScore:        ONE_OF_ONE_SCORE,
          reasonTags:       ['ONE_OF_ONE'],
          saleTime:         sale.blockTime,
        });
        if (wrote) stat.oneOfOne++;
        console.log(
          `[rare/feed] 1of1 accepted sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
          `rank=${rarity.rarityRank}/${rarity.totalSupply} src=${rarity.source} ${wrote ? '' : '(dup)'}`,
        );
        return;
      }

      // ── Normal path: requires a floor. Without it, do NOT mark decided —
      //    a later `meta` may carry the floor.
      if (!hasFloor || floorPrice == null) return;
      if (decided.has(sig)) return;
      markDecided(sig);
      pending.delete(sig);

      if (rarity.rarityRank == null || rarity.totalSupply == null || rarity.totalSupply <= 0) {
        stat.missingRarity++;
        console.log(`[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=no_rarity`);
        return;
      }
      if (floorPrice <= 0) {
        console.log(`[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=no_floor`);
        return;
      }

      const result = scoreSale({
        rarityRank:  rarity.rarityRank,
        totalSupply: rarity.totalSupply,
        salePrice,
        floorPrice,
      });

      if (!result.qualifies) {
        if (result.rejectReason === 'rarity') stat.rejRarity++; else stat.rejPrice++;
        console.log(
          `[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=${result.rejectReason} ` +
          `pct=${(result.rarityPercentile * 100).toFixed(2)}% floorDelta=${(result.floorDeltaPct * 100).toFixed(1)}%`,
        );
        return;
      }

      const wrote = await insertRareEvent({
        saleSignature:    sig,
        mintAddress:      mint,
        collectionSlug:   slug,
        collectionName:   update.collectionName,
        nftName:          update.nftName,
        imageUrl:         update.imageUrl,
        source:           sale.marketplace,
        salePriceSol:     salePrice,
        floorPriceSol:    floorPrice,
        floorDeltaPct:    result.floorDeltaPct,
        rarityRank:       rarity.rarityRank,
        totalSupply:      rarity.totalSupply,
        rarityPercentile: result.rarityPercentile,
        raritySource:     rarity.source,
        rareScore:        result.score,
        reasonTags:       result.reasonTags,
        saleTime:         sale.blockTime,
      });

      if (wrote) stat.accepted++;
      console.log(
        `[rare/feed] accepted sig=${sig.slice(0, 12)}… score=${result.score} ` +
        `tags=${result.reasonTags.join(',')} rank=${rarity.rarityRank}/${rarity.totalSupply} ` +
        `${wrote ? '' : '(dup, skipped)'}`,
      );
    } catch (err) {
      console.warn(`[rare/feed] eval error sig=${sig.slice(0, 12)}…: ${(err as Error).message}`);
    }
  })();
}

let started = false;
/** Register the bus listeners. Idempotent. */
export function startRareFeedEvaluator(): void {
  if (started) return;
  started = true;
  saleEventBus.onSale(onSale);
  saleEventBus.onMetaUpdate(onMeta);
  console.log('[rare/feed] evaluator attached (sale + meta bus listeners)');
  // Periodic funnel summary (cumulative since boot) every 5 min.
  const summary = setInterval(() => {
    console.log(
      `[rare/feed] summary evaluated=${stat.evaluated} missingRarity=${stat.missingRarity} ` +
      `rejRarity=${stat.rejRarity} rejPrice=${stat.rejPrice} accepted=${stat.accepted} oneOfOne=${stat.oneOfOne}`,
    );
  }, 5 * 60 * 1000);
  summary.unref?.();
}
