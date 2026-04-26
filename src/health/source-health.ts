/**
 * Per-marketplace data-source health monitor.
 *
 * Watches the in-process sale event bus, tracks the last-seen event time
 * per source ('magiceden' | 'tensor'), and flips to 'stale' when no event
 * has arrived for STALE_AFTER_MS. State changes are emitted on the bus as
 * `source_status` so the SSE layer can fan them out to all clients.
 *
 * Tensor's stream is used as a cross-check: if Tensor is producing events
 * but Magic Eden is silent, that's the degraded-API signal we want
 * surfaced. When neither source has produced anything yet we default to
 * 'ok' so a cold-boot doesn't display a false alert.
 *
 * Lightweight: one onSale listener that does a Date.now() write, plus a
 * single 15 s setInterval that compares timestamps. No I/O, no RPC.
 */

import { saleEventBus } from '../events/emitter';
import type { SaleEvent } from '../models/sale-event';

export type SourceKey   = 'magiceden' | 'tensor';
export type SourceState = 'ok' | 'stale';

export interface SourceStatusWire {
  source: SourceKey;
  state:  SourceState;
}

const SOURCES: ReadonlyArray<SourceKey> = ['magiceden', 'tensor'];
const STALE_AFTER_MS = 90_000;
const TICK_MS        = 15_000;

const lastEventTs = new Map<SourceKey, number>();
const lastState   = new Map<SourceKey, SourceState>();

function classifySource(marketplace: string): SourceKey | null {
  if (marketplace === 'magic_eden' || marketplace === 'magic_eden_amm') return 'magiceden';
  if (marketplace === 'tensor'     || marketplace === 'tensor_amm')     return 'tensor';
  return null;
}

/** Snapshot of every source's current state. Sent to each new SSE client
 *  so a freshly-mounted frontend doesn't have to wait for the next state
 *  flip to know whether a source is stale. */
export function currentStatuses(): SourceStatusWire[] {
  return SOURCES.map((source) => ({ source, state: lastState.get(source) ?? 'ok' }));
}

saleEventBus.onSale((event: SaleEvent) => {
  const k = classifySource(event.marketplace);
  if (!k) return;
  lastEventTs.set(k, Date.now());
});

function fmtAge(ageMs: number): string {
  return ageMs === Infinity ? '∞' : `${Math.round(ageMs / 1000)}s`;
}

function tick(): void {
  const now = Date.now();
  for (const k of SOURCES) {
    const last  = lastEventTs.get(k);
    const ageMs = last != null ? now - last : Infinity;

    const other: SourceKey = k === 'magiceden' ? 'tensor' : 'magiceden';
    const otherLast  = lastEventTs.get(other);
    const otherAgeMs = otherLast != null ? now - otherLast : Infinity;

    // Stale only when (we are silent past the threshold) AND (the other
    // source is actively producing within the same window). The latter
    // half is the quiet-period guard: if BOTH sources are quiet it's the
    // market that's quiet, not Magic Eden that's broken — keep ok.
    const ourSilent  = ageMs      > STALE_AFTER_MS;
    const otherFresh = otherAgeMs < STALE_AFTER_MS;
    const next: SourceState = (ourSilent && otherFresh) ? 'stale' : 'ok';

    const prev = lastState.get(k) ?? 'ok';
    if (prev === next) continue;             // no transition — skip log + emit
    lastState.set(k, next);
    saleEventBus.emitSourceStatus({ source: k, state: next });
    console.log(
      `[source-health] ${k} ${prev} -> ${next}  ` +
      `lastEventAge=${fmtAge(ageMs)}  ${other}Age=${fmtAge(otherAgeMs)}`,
    );
  }
}

const timer = setInterval(tick, TICK_MS);
if (typeof timer.unref === 'function') timer.unref();
