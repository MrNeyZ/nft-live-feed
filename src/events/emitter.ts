import { EventEmitter } from 'events';
import { SaleEvent } from '../models/sale-event';

export interface RawPatch {
  signature:   string;
  seller:      string;
  buyer:       string;
  marketplace: string;
  nftType:     string;
  saleType:    string;
  priceSol:    number;
}

export interface MetaUpdate {
  mintAddress:       string;
  signature:         string;
  nftName:           string | null;
  imageUrl:          string | null;
  collectionName:    string | null;
  collectionAddress: string | null;
  meCollectionSlug:  string | null;
  /** (salePrice − floor) / floor. Null when floor unavailable. */
  floorDelta:        number | null;
  /** salePrice (SOL) − topOffer (SOL). Null when no active offer. */
  offerDelta:        number | null;
}

/**
 * In-process event bus. insertSaleEvent emits 'sale' here;
 * the SSE endpoint subscribes and fans out to connected clients.
 *
 * Single-process only. If multi-process deployment is needed later,
 * replace with Redis pub/sub.
 */
class SaleEventBus extends EventEmitter {
  emitSale(event: SaleEvent): void {
    this.emit('sale', event);
  }
  onSale(listener: (event: SaleEvent) => void): this {
    return this.on('sale', listener);
  }
  offSale(listener: (event: SaleEvent) => void): this {
    return this.off('sale', listener);
  }

  emitMetaUpdate(update: MetaUpdate): void {
    this.emit('meta', update);
  }
  onMetaUpdate(listener: (update: MetaUpdate) => void): this {
    return this.on('meta', listener);
  }
  offMetaUpdate(listener: (update: MetaUpdate) => void): this {
    return this.off('meta', listener);
  }

  /**
   * Emitted when a blacklisted event is detected after enrichment.
   * The SSE endpoint forwards this to all clients so they can drop the card.
   */
  emitRemove(signature: string): void {
    this.emit('remove', signature);
  }
  onRemove(listener: (signature: string) => void): this {
    return this.on('remove', listener);
  }
  offRemove(listener: (signature: string) => void): this {
    return this.off('remove', listener);
  }

  /**
   * Emitted when a fast-path (Helius data) event is later corrected by the
   * raw RPC parser. Lets the frontend update saleType / marketplace / parties
   * without removing and re-adding the card.
   */
  emitRawPatch(patch: RawPatch): void {
    this.emit('rawpatch', patch);
  }
  onRawPatch(listener: (patch: RawPatch) => void): this {
    return this.on('rawpatch', listener);
  }
  offRawPatch(listener: (patch: RawPatch) => void): this {
    return this.off('rawpatch', listener);
  }
}

export const saleEventBus = new SaleEventBus();
// Prevent Node warning when many SSE clients connect simultaneously
saleEventBus.setMaxListeners(500);
