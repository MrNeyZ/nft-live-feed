import { EventEmitter } from 'events';
import { SaleEvent } from '../models/sale-event';

// ── Config ────────────────────────────────────────────────────────────────────

export interface AlertConfig {
  /**
   * Fire UNDER_FLOOR when floorDelta ≤ −threshold.
   * e.g. 0.10 = sale must be at least 10% below floor.
   */
  underFloorThreshold: number;
  /**
   * Fire ABOVE_OFFER when (−offerDelta / priceSol) ≥ threshold.
   * e.g. 0.10 = top offer must be at least 10% above the sale price.
   */
  aboveOfferThreshold: number;
  /**
   * Minimum milliseconds between alerts for the same collection + type.
   * Prevents spam when a collection trades heavily at depressed prices.
   * Default: 5 minutes.
   */
  debounceMs: number;
}

export const alertConfig: AlertConfig = {
  underFloorThreshold: parseFloat(process.env.ALERT_UNDER_FLOOR_THRESHOLD ?? '0.10'),
  aboveOfferThreshold: parseFloat(process.env.ALERT_ABOVE_OFFER_THRESHOLD ?? '0.10'),
  debounceMs:          parseInt(process.env.ALERT_DEBOUNCE_MS             ?? '300000', 10),
};

// ── Alert types ───────────────────────────────────────────────────────────────

export type AlertType = 'under_floor' | 'above_offer';

export interface PricingAlert {
  type:              AlertType;
  signature:         string;
  mintAddress:       string;
  collectionAddress: string | null;
  meCollectionSlug:  string | null;
  marketplace:       string;
  priceSol:          number;
  /** (salePrice − floor) / floor — negative means below floor. */
  floorDelta:        number | null;
  /** salePrice (SOL) − topOffer (SOL) — negative means below best offer. */
  offerDelta:        number | null;
  triggeredAt:       Date;
}

// ── Event bus ─────────────────────────────────────────────────────────────────

class AlertBus extends EventEmitter {
  fire(alert: PricingAlert): void { this.emit('alert', alert); }
  onAlert(listener:  (alert: PricingAlert) => void): this { return this.on('alert',  listener); }
  offAlert(listener: (alert: PricingAlert) => void): this { return this.off('alert', listener); }
}

/** Subscribe to receive PricingAlert objects as they fire. */
export const alertBus = new AlertBus();
alertBus.setMaxListeners(100);

// ── Debounce state ────────────────────────────────────────────────────────────

/**
 * Tracks the last time each (collection, alertType) pair fired.
 * Key: `${collectionKey}:${alertType}`
 */
const lastFiredAt = new Map<string, number>();

/**
 * Stable key for a collection. Preference order:
 *   ME slug (human-readable, stable) > on-chain address > mint fallback
 */
function collectionKey(event: SaleEvent): string {
  return event.meCollectionSlug ?? event.collectionAddress ?? event.mintAddress;
}

function isDebounced(colKey: string, type: AlertType): boolean {
  const last = lastFiredAt.get(`${colKey}:${type}`);
  return last != null && Date.now() - last < alertConfig.debounceMs;
}

function markFired(colKey: string, type: AlertType): void {
  lastFiredAt.set(`${colKey}:${type}`, Date.now());
}

// ── Main check ────────────────────────────────────────────────────────────────

/**
 * Evaluates a freshly enriched SaleEvent against configured thresholds.
 * Fires at most once per (collection, type) within the debounce window.
 * Never throws.
 */
export function checkPricingAlerts(event: SaleEvent): void {
  try {
    _check(event);
  } catch (err) {
    console.error('[alerts] unexpected error', err);
  }
}

function _check(event: SaleEvent): void {
  const { floorDelta, offerDelta, priceSol, signature } = event;
  const colKey = collectionKey(event);
  const colLabel = event.meCollectionSlug ?? event.collectionAddress?.slice(0, 8) ?? 'unknown';
  const sigShort  = signature.slice(0, 12);

  // ── UNDER_FLOOR ────────────────────────────────────────────────────────────
  if (
    floorDelta != null &&
    floorDelta <= -alertConfig.underFloorThreshold &&
    !isDebounced(colKey, 'under_floor')
  ) {
    const alert: PricingAlert = {
      type:              'under_floor',
      signature,
      mintAddress:       event.mintAddress,
      collectionAddress: event.collectionAddress,
      meCollectionSlug:  event.meCollectionSlug ?? null,
      marketplace:       event.marketplace,
      priceSol,
      floorDelta,
      offerDelta:        offerDelta ?? null,
      triggeredAt:       new Date(),
    };
    markFired(colKey, 'under_floor');
    alertBus.fire(alert);
    console.log(
      `[alert] UNDER_FLOOR  ${(floorDelta * 100).toFixed(1)}% below floor` +
      `  price=${priceSol.toFixed(3)} SOL` +
      `  collection=${colLabel}` +
      `  sig=${sigShort}...`,
    );
  }

  // ── ABOVE_OFFER ────────────────────────────────────────────────────────────
  if (
    offerDelta != null &&
    priceSol > 0 &&
    (-offerDelta / priceSol) >= alertConfig.aboveOfferThreshold &&
    !isDebounced(colKey, 'above_offer')
  ) {
    const offerAbovePct = (-offerDelta / priceSol) * 100;
    const topOfferSol   = priceSol - offerDelta;   // offerDelta = sale − offer → offer = sale − delta
    const alert: PricingAlert = {
      type:              'above_offer',
      signature,
      mintAddress:       event.mintAddress,
      collectionAddress: event.collectionAddress,
      meCollectionSlug:  event.meCollectionSlug ?? null,
      marketplace:       event.marketplace,
      priceSol,
      floorDelta:        floorDelta ?? null,
      offerDelta,
      triggeredAt:       new Date(),
    };
    markFired(colKey, 'above_offer');
    alertBus.fire(alert);
    console.log(
      `[alert] ABOVE_OFFER  offer ${offerAbovePct.toFixed(1)}% above sale` +
      `  sale=${priceSol.toFixed(3)} SOL  offer≈${topOfferSol.toFixed(3)} SOL` +
      `  collection=${colLabel}` +
      `  sig=${sigShort}...`,
    );
  }
}
