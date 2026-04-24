import { Router, Request, Response } from 'express';
import {
  saleEventBus,
  MetaUpdate,
  RawPatch,
  ListingRemoveDelta,
  ListingSnapshotDelta,
} from '../events/emitter';
import { SaleEvent } from '../models/sale-event';
import { saleTypeFromEvent } from '../domain/sale-event-adapters';

/**
 * GET /events/stream — Server-Sent Events endpoint.
 *
 * Each connected client receives a `sale` event as JSON whenever a new
 * NFT sale is ingested (from webhook or poller).
 *
 * Clients reconnect automatically via the EventSource API.
 * A heartbeat comment is sent every 25s to keep the connection alive
 * through proxies and load balancers.
 *
 * Usage (browser):
 *   const es = new EventSource('/events/stream');
 *   es.addEventListener('sale', e => console.log(JSON.parse(e.data)));
 */
export function createSseRouter(): Router {
  const router = Router();

  router.get('/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
    res.flushHeaders();

    // Send initial comment so client knows the connection is live
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25_000);

    function onSale(event: SaleEvent) {
      // Guard: if the client already disconnected, res.write throws — catch it so
      // the error cannot propagate back through EventEmitter into insertSaleEvent.
      try {
        const parser = event.rawData._parser as string | undefined;
        const source = parser ? 'me_raw' : 'helius';

        const payload = JSON.stringify({
          signature:        event.signature,
          blockTime:        event.blockTime.toISOString(),
          marketplace:      event.marketplace,
          nftType:          event.nftType,
          saleType:         saleTypeFromEvent(event),
          mintAddress:      event.mintAddress,
          collectionAddress: event.collectionAddress,
          seller:           event.seller,
          buyer:            event.buyer,
          priceSol:         event.priceSol,
          currency:         event.currency,
          nftName:          event.nftName,
          imageUrl:         event.imageUrl,
          collectionName:   event.collectionName,
          magicEdenUrl:     event.magicEdenUrl,
          meCollectionSlug: event.meCollectionSlug ?? null,
          floorDelta:       event.floorDelta        ?? null,
          offerDelta:       event.offerDelta        ?? null,
          source,
        });
        res.write(`event: sale\ndata: ${payload}\n\n`);
      } catch {
        // Client disconnected between heartbeat and this write — ignore silently.
      }
    }

    function onMetaUpdate(update: MetaUpdate) {
      try {
        res.write(`event: meta\ndata: ${JSON.stringify(update)}\n\n`);
      } catch {
        // Client disconnected — ignore silently.
      }
    }

    function onRemove(signature: string) {
      try {
        res.write(`event: remove\ndata: ${JSON.stringify({ signature })}\n\n`);
      } catch {
        // Client disconnected — ignore silently.
      }
    }

    function onRawPatch(patch: RawPatch) {
      try {
        res.write(`event: rawpatch\ndata: ${JSON.stringify(patch)}\n\n`);
      } catch {
        // Client disconnected — ignore silently.
      }
    }

    function onListingRemove(delta: ListingRemoveDelta) {
      try {
        res.write(`event: listing_remove\ndata: ${JSON.stringify(delta)}\n\n`);
      } catch { /* disconnected */ }
    }

    function onListingSnapshot(delta: ListingSnapshotDelta) {
      try {
        res.write(`event: listing_snapshot\ndata: ${JSON.stringify(delta)}\n\n`);
      } catch { /* disconnected */ }
    }

    saleEventBus.onSale(onSale);
    saleEventBus.onMetaUpdate(onMetaUpdate);
    saleEventBus.onRemove(onRemove);
    saleEventBus.onRawPatch(onRawPatch);
    saleEventBus.onListingRemove(onListingRemove);
    saleEventBus.onListingSnapshot(onListingSnapshot);

    req.on('close', () => {
      clearInterval(heartbeat);
      saleEventBus.offSale(onSale);
      saleEventBus.offMetaUpdate(onMetaUpdate);
      saleEventBus.offRemove(onRemove);
      saleEventBus.offRawPatch(onRawPatch);
      saleEventBus.offListingRemove(onListingRemove);
      saleEventBus.offListingSnapshot(onListingSnapshot);
    });
  });

  return router;
}
