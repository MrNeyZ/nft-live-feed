/**
 * Mint detection — MVP.
 *
 * Cheap path: reuses the existing in-process sale event bus. Every parsed
 * tx that flows through ingestion already passes a `_parser` tag and raw
 * data; for cNFT (Bubblegum) the rare case of a `MintToCollectionV1` /
 * `MintV1` instruction shows up alongside the regular sale parsers as a
 * non-sale transfer. Rather than adding a new program subscription
 * (Bubblegum direct sub) — which would add `getSignaturesForAddress` /
 * `getTransaction` cost — this MVP listens to the existing bus and
 * recognises mint-shaped raw_data when it appears.
 *
 * Token Metadata + MPL Core direct subscriptions are deliberately
 * deferred to a follow-up: they require their own listener targets and
 * bring real RPC cost. This MVP delivers the accumulator + SSE channel +
 * frontend without touching the listener at all, so RPC stays inside the
 * existing 800–1000/5min envelope.
 */

import { saleEventBus } from '../events/emitter';
import type { SaleEvent } from '../models/sale-event';
import { recordMint } from './accumulator';

let started = false;

/** True once startMintDetector() has registered its bus listeners. */
export function isMintDetectorStarted(): boolean { return started; }

/** Idempotent: subsequent calls are no-ops. Mirrors startListener /
 *  startAmmPoller singleton-guard pattern. */
export function startMintDetector(): void {
  if (started) {
    console.log('[mints] detector already running — skip');
    return;
  }
  started = true;
  console.log('[mints] detector started (bus-listener path)');

  saleEventBus.onSale((event: SaleEvent) => {
    // Heuristic: detect first-mint-shaped events from raw_data hints.
    // For the MVP we tag any cNFT event whose raw parser flagged a
    // bubblegum mint discriminator. The actual parser doesn't yet emit
    // those flags — until it does, this branch is dormant and the
    // detector quietly forwards nothing. Extending the cNFT parser to
    // surface `_isMint: true` + `_mintCollection` is a small follow-up.
    const raw = event.rawData as Record<string, unknown> | undefined;
    if (!raw || raw._isMint !== true) return;

    const mintCollection = (raw._mintCollection as string | undefined) ?? null;
    const merkleTree     = (raw._merkleTree     as string | undefined) ?? null;

    const groupingKey = mintCollection
      ? `collection:${mintCollection}`
      : merkleTree
      ? `tree:${merkleTree}`
      : `program:bubblegum`;
    const groupingKind: 'collection' | 'merkleTree' | 'programSource' =
      mintCollection ? 'collection' : merkleTree ? 'merkleTree' : 'programSource';

    recordMint({
      signature:         event.signature,
      blockTime:         event.blockTime.toISOString(),
      programSource:     'bubblegum',
      mintAddress:       event.mintAddress || null,
      collectionAddress: mintCollection,
      groupingKey,
      groupingKind,
      mintType:          event.priceLamports === 0n ? 'free'
                          : event.priceLamports >= 1_000_000n ? 'paid'
                          : 'unknown',
      priceLamports:     Number(event.priceLamports),
      minter:            event.buyer || null,
      sourceLabel:       'Bubblegum',
    });
  });
}
