import { Router, Request, Response } from 'express';
import {
  saleEventBus,
  MetaUpdate,
  RawPatch,
  ListingRemoveDelta,
  ListingSnapshotDelta,
  type SourceStatusWire,
  type MintEventWire,
  type MintStatusWire,
} from '../events/emitter';
import { SaleEvent } from '../models/sale-event';
import { saleTypeFromEvent } from '../domain/sale-event-adapters';
import { currentStatuses } from '../health/source-health';
import { currentMintStatuses } from '../mints/accumulator';
import { getSellerCollectionCount, resolveCollectionForMint } from '../enrichment/seller-collection-count';

/**
 * GET /events/stream — Server-Sent Events endpoint.
 *
 * Each connected client receives a `sale` event as JSON whenever a new
 * NFT sale is ingested (from webhook or poller). A heartbeat comment is
 * sent every 25 s to keep the connection alive through proxies and load
 * balancers.
 *
 * Architecture: per-event-type bus listeners are registered ONCE at module
 * init and broadcast a pre-built SSE frame to every connected client. This
 * replaces the previous "one closure per client per event" pattern, where
 * the same payload was JSON.stringify'd N times for N clients on every
 * emit. With ~50 clients × 50 sales/min that was ~2 500 redundant
 * stringifications per minute.
 *
 * Wire format unchanged.
 */

const sseClients = new Set<Response>();

/** Send a pre-built SSE frame (e.g. `event: sale\ndata: …\n\n`) to every
 *  connected client. Disconnected clients are removed silently — the
 *  per-client teardown still runs from req/res close listeners. */
function broadcast(frame: string): void {
  if (sseClients.size === 0) return;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      // Client disconnected mid-write. Drop quietly; teardown handles the rest.
      sseClients.delete(res);
    }
  }
}

function buildSaleFrame(event: SaleEvent): string {
  const parser = event.rawData._parser as string | undefined;
  const source = parser ? 'me_raw' : 'helius';
  const payload = JSON.stringify({
    signature:         event.signature,
    blockTime:         event.blockTime.toISOString(),
    marketplace:       event.marketplace,
    nftType:           event.nftType,
    saleType:          saleTypeFromEvent(event),
    mintAddress:       event.mintAddress,
    collectionAddress: event.collectionAddress,
    seller:            event.seller,
    buyer:             event.buyer,
    priceSol:          event.priceSol,
    sellerNetPriceSol: event.sellerNetPriceSol ?? null,
    currency:          event.currency,
    nftName:           event.nftName,
    imageUrl:          event.imageUrl,
    collectionName:    event.collectionName,
    magicEdenUrl:      event.magicEdenUrl,
    meCollectionSlug:  event.meCollectionSlug ?? null,
    floorDelta:        event.floorDelta        ?? null,
    offerDelta:        event.offerDelta        ?? null,
    source,
  });
  return `event: sale\ndata: ${payload}\n\n`;
}

function buildStatusFrame(s: SourceStatusWire): string {
  return `event: status\ndata: ${JSON.stringify({
    type:   'status',
    source: s.source,
    state:  s.state,
  })}\n\n`;
}

function buildMintFrame(m: MintEventWire): string {
  return `event: mint\ndata: ${JSON.stringify(m)}\n\n`;
}
function buildMintStatusFrame(s: MintStatusWire): string {
  return `event: mint_status\ndata: ${JSON.stringify(s)}\n\n`;
}

// Sell-type sale_types we surface a "seller still holds N" badge for.
// Authoritative list comes from `deriveSaleType` (src/domain/sale-type.ts):
//   bid_sell  ← UI: SELL / BID SELL  (instant sell into a collection bid)
//   pool_sale ← UI: AMM (red, sell side)  (seller dumped into an AMM/pool)
// `pool_sell` / `amm_sell` are kept for forward-compat with `mapSide` in
// from-backend.ts — `deriveSaleType` does not currently emit them, so
// they're harmless extras here.
const SELL_TYPES_FOR_BADGE = new Set(['bid_sell', 'pool_sale', 'pool_sell', 'amm_sell']);

// Startup confirmation — proves this module loaded and the seller-count
// onSale listener is attached. Look for this exact line in `pm2 logs
// nft-backend` immediately after restart to verify the binary in use
// includes the seller-count diagnostic.
console.log('[seller-count-init] listener attached');

// One bus listener per event type, registered once at module load. The
// frame is built once per emit and broadcast to all clients in the Set.
saleEventBus.onSale(           (event)  => {
  broadcast(buildSaleFrame(event));
  // Async, fire-and-forget: for sell-type sales with a known
  // collectionAddress, look up the seller's remaining holdings via DAS
  // (cached + deduped) and broadcast a `seller_count` patch frame so
  // the FeedCard can render a small badge. Failures (no API key, DAS
  // miss, no collection address) silently skip — the card just renders
  // without the badge, which matches the spec ("if count unknown, do
  // not show badge").
  const saleType = saleTypeFromEvent(event);
  // TEMPORARY hard diagnostic: UNSAMPLED log of EVERY sale before the
  // sell-type gate. Confirms onSale is firing for every live event and
  // exposes the saleType / seller / collection fields the gate reads.
  // Remove once the seller-count badge is verified working in prod.
  {
    const isSellKind = SELL_TYPES_FOR_BADGE.has(saleType);
    const parser = (event.rawData as Record<string, unknown> | null | undefined)?._parser
      ? String((event.rawData as Record<string, unknown>)._parser)
      : 'helius';
    console.log(
      `[seller-count-debug] sig=${event.signature.slice(0,12)}… ` +
      `saleType=${saleType} kind=${isSellKind ? 'sell' : 'buy/other'} ` +
      `source=${parser} ` +
      `seller=${event.seller ? event.seller.slice(0,8) + '…' : '—'} ` +
      `buyer=${event.buyer ? event.buyer.slice(0,8) + '…' : '—'} ` +
      `mintAddress=${event.mintAddress ? event.mintAddress.slice(0,8) + '…' : '—'} ` +
      `collectionAddress=${event.collectionAddress ? event.collectionAddress.slice(0,8) + '…' : '—'}`,
    );
  }
  if (!SELL_TYPES_FOR_BADGE.has(saleType))   return;
  if (!event.seller) {
    if (Math.random() < 0.20) {
      console.log(`[seller-count-miss] reason=missing_seller sig=${event.signature.slice(0,12)}… saleType=${saleType}`);
    }
    return;
  }
  const seller    = event.seller;
  const signature = event.signature;
  const mint      = event.mintAddress;
  const initialCollection = event.collectionAddress;
  // Async path — never blocks the sale SSE frame.
  // Step 1: resolve collection. Use parser-provided value when present;
  //         otherwise fall back to a cached DAS getAsset(mintAddress)
  //         lookup. Both paths return string | null and never throw.
  // Step 2: with a real collection, run the cached owner-count lookup.
  // Step 3: broadcast `seller_count` SSE patch on success; log + skip
  //         on null at any step (badge simply doesn't render).
  void (async () => {
    let collection: string | null = initialCollection;
    if (!collection) {
      if (!mint) {
        if (Math.random() < 0.20) {
          console.log(
            `[seller-count-miss] reason=missing_collection_and_mint sig=${signature.slice(0,12)}… saleType=${saleType}`,
          );
        }
        return;
      }
      collection = await resolveCollectionForMint(mint);
      if (!collection) {
        if (Math.random() < 0.20) {
          console.log(
            `[seller-count-miss] reason=missing_collection_after_das sig=${signature.slice(0,12)}… ` +
            `saleType=${saleType} mint=${mint.slice(0,8)}…`,
          );
        }
        return;
      }
      console.log(`[seller-count-resolve] mint=${mint.slice(0,8)}… collection=${collection.slice(0,8)}…`);
    }
    const count = await getSellerCollectionCount(seller, collection);
    if (count == null) {
      if (Math.random() < 0.05) {
        console.log(`[seller-count-miss] reason=lookup_null seller=${seller.slice(0,8)}… coll=${collection.slice(0,8)}…`);
      }
      return;
    }
    if (Math.random() < 0.05) {
      console.log(`[seller-count] seller=${seller.slice(0,8)}… collection=${collection.slice(0,8)}… count=${count}`);
    }
    broadcast(`event: seller_count\ndata: ${JSON.stringify({ signature, count })}\n\n`);
  })();
});
saleEventBus.onMetaUpdate(     (update) => broadcast(`event: meta\ndata: ${JSON.stringify(update)}\n\n`));
saleEventBus.onRemove(         (sig)    => broadcast(`event: remove\ndata: ${JSON.stringify({ signature: sig })}\n\n`));
saleEventBus.onRawPatch(       (patch)  => broadcast(`event: rawpatch\ndata: ${JSON.stringify(patch)}\n\n`));
saleEventBus.onListingRemove(  (delta)  => broadcast(`event: listing_remove\ndata: ${JSON.stringify(delta)}\n\n`));
saleEventBus.onListingSnapshot((delta)  => broadcast(`event: listing_snapshot\ndata: ${JSON.stringify(delta)}\n\n`));
saleEventBus.onSourceStatus(   (s)      => broadcast(buildStatusFrame(s)));
saleEventBus.onMint(           (m)      => broadcast(buildMintFrame(m)));
saleEventBus.onMintStatus(     (s)      => broadcast(buildMintStatusFrame(s)));

export function createSseRouter(): Router {
  const router = Router();

  router.get('/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
    res.flushHeaders();

    // Initial comment so the client knows the connection is live.
    res.write(': connected\n\n');

    // Send the current source-health snapshot so a freshly-mounted client
    // doesn't have to wait for the next state flip to know whether ME or
    // Tensor is stale.
    for (const s of currentStatuses()) {
      try { res.write(buildStatusFrame(s)); } catch { /* client gone */ }
    }

    // Same for the mint-tracker trending snapshot — populates the
    // /mints page on connect without per-client polling.
    for (const ms of currentMintStatuses()) {
      try { res.write(buildMintStatusFrame(ms)); } catch { /* client gone */ }
    }

    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); }
      catch {
        // Heartbeat write failed — client gone. Cleanup runs via the close
        // listeners below; we just stop emitting heartbeats from here.
        clearInterval(heartbeat);
      }
    }, 25_000);

    // Idempotent teardown — runs on the first of req/res `close`/`error`
    // /`aborted`, with subsequent triggers no-op. The previous code only
    // listened on req.close; certain proxy timeouts where the socket
    // half-closes never fire that, leaking the heartbeat interval and the
    // entry in sseClients.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      sseClients.delete(res);
    };
    req.on('close',   cleanup);
    req.on('error',   cleanup);
    req.on('aborted', cleanup);
    res.on('close',   cleanup);
    res.on('error',   cleanup);
  });

  return router;
}
