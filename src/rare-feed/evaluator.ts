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
import { scoreSale } from './scoring';
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

  // Need floor to score. The `meta` floorDelta is (salePrice − floor)/floor;
  // a later meta (image retry) may carry it when the first didn't, so we do
  // NOT mark the signature decided until floor is actually present.
  const floorDelta = update.floorDelta;
  if (floorDelta == null || floorDelta <= -1) return;

  // From here on this signature gets exactly one terminal decision.
  markDecided(sig);
  pending.delete(sig);

  const salePrice  = sale.priceSol;
  const floorPrice = salePrice / (1 + floorDelta);
  const mint       = sale.mintAddress;
  const slug       = update.meCollectionSlug ?? sale.slug;

  console.log(
    `[rare/feed] candidate sig=${sig.slice(0, 12)}… mint=${mint.slice(0, 8)}… ` +
    `price=${salePrice.toFixed(4)} floor=${floorPrice.toFixed(4)} slug=${slug ?? '?'}`,
  );

  // Async, fire-and-forget — never blocks the bus / SSE fan-out.
  void (async () => {
    try {
      const rarity = await getRarity(mint, slug);
      if (rarity.rarityRank == null || rarity.totalSupply == null || rarity.totalSupply <= 0) {
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
        console.log(
          `[rare/feed] rejected sig=${sig.slice(0, 12)}… reason=below_thresholds ` +
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
}
