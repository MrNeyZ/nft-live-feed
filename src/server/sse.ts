import { Router, Request, Response } from 'express';
import { saleEventBus, MetaUpdate, RawPatch } from '../events/emitter';
import { SaleEvent } from '../models/sale-event';

/**
 * Display-only trade label derived purely from rawData at SSE-emission time.
 * Wrapped in try/catch — NEVER throws, NEVER affects insertion or event flow.
 *
 * Return values:  'listing' | 'pool_buy' | 'pool_sell' | 'bid_sell'
 *
 * rawData fields:
 *   _parser       — which path produced this event
 *   _instruction  — instruction name (ME raw, Tensor raw)
 *   _direction    — semantic direction (Tensor raw)
 *   events.nft.saleType — Helius-supplied hint (Helius path only)
 */
function deriveTradeLabel(event: SaleEvent): string {
  try {
    return _tradeLabel(event);
  } catch {
    return 'listing';  // safe fallback — never breaks the stream
  }
}

function _tradeLabel(event: SaleEvent): string {
  const raw    = event.rawData;
  const parser = raw._parser    as string | undefined;
  const dir    = raw._direction as string | undefined;

  // ── Hard-cut: program address is the source of truth for ME transactions ────
  //   M2mx93...  = Magic Eden V2 fixed-price marketplace  → NORMAL_SALE
  //   mmm3X...   = Magic Eden AMM pool                    → POOL_SALE
  if (parser === 'me_v2_raw') return 'normal_sale';
  if (parser === 'mmm_raw') {
    if (dir === 'fulfillSell') return 'pool_buy';
    if (dir === 'takeBid')    return 'bid_sell'; // individual bid through ME AMM
    return 'pool_sale';
  }

  // ── Tensor paths (direction field is reliable, no complex heuristics) ───────
  if (parser === 'tensor_raw' || parser === 'tamm_raw') {
    if (dir === 'takeBid')              return 'bid_sell';
    if (parser === 'tamm_raw')          return 'pool_sale';  // TAMM is AMM pool
    return 'normal_sale';                                    // TComp = listing
  }

  // ── Helius path: use the saleType hint they already computed ─────────────────
  const heliusNft = ((raw as Record<string, unknown>)?.events as Record<string, unknown>)
    ?.nft as Record<string, unknown> | undefined;
  const st = (heliusNft?.saleType as string | undefined)?.toUpperCase() ?? '';
  // Check bid-specific patterns before the generic AMM check:
  // ME's AMM bid system can produce saleTypes that contain both "AMM" and "BID"
  // (e.g. "AMM_BID_FILL"). Those must resolve to bid_sell, not pool_sale.
  if (st.includes('BID') || st.includes('ACCEPT') || st === 'GLOBAL_SELL')  return 'bid_sell';
  if (st.includes('AMM'))                                                     return 'pool_sale';

  return 'normal_sale';
}

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
          saleType:         deriveTradeLabel(event),
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

    saleEventBus.onSale(onSale);
    saleEventBus.onMetaUpdate(onMetaUpdate);
    saleEventBus.onRemove(onRemove);
    saleEventBus.onRawPatch(onRawPatch);

    req.on('close', () => {
      clearInterval(heartbeat);
      saleEventBus.offSale(onSale);
      saleEventBus.offMetaUpdate(onMetaUpdate);
      saleEventBus.offRemove(onRemove);
      saleEventBus.offRawPatch(onRawPatch);
    });
  });

  return router;
}
