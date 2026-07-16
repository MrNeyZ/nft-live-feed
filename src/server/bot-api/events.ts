/**
 * Bot API v1 event stream — sequencing, bounded replay buffer, and mapping
 * from the existing internal `saleEventBus` (src/events/emitter.ts) onto
 * the small, explicit `BotEventType` allowlist.
 *
 * No new ingestion, no new detector, no new polling — this module only
 * SUBSCRIBES to bus events the backend already produces for the public
 * Live Feed and re-emits an explicit, field-limited subset. See
 * bot-api-types.ts's `BotEventType` doc for exactly which events are wired
 * and why (`sale`, `listing_change` — nothing fabricated).
 */

import { saleEventBus } from '../../events/emitter';
import { BOT_API_VERSION } from '../../domain/bot-api-types';
import type {
  BotEventEnvelope,
  BotEventType,
  BotEventSalePayload,
  BotEventSalePatchPayload,
  BotEventListingChangePayload,
} from '../../domain/bot-api-types';
import {
  saleTypeFromEvent,
  ammFillFromEvent,
  isMerkleTreeCollectionAddress,
  resolveCollectionIdentity,
} from '../../domain/sale-event-adapters';
import type { SaleEvent } from '../../models/sale-event';
import type { BotIdentityPatch, BotSellerCountPatch, ResizeStatusPatch } from '../../events/emitter';

/** Bounded so a burst of sales/listing changes can never grow memory
 *  without limit — same "small bounded ring" shape as the mint_meta replay
 *  buffer in emitter.ts (MINT_META_REPLAY_MAX), sized smaller here since a
 *  bot reconnect gap this buffer can't cover just gets a `resync_required`
 *  (cheap — a snapshot refetch — not a correctness problem). */
const REPLAY_MAX = 500;

interface RingEntry {
  sequence: number;
  envelope: BotEventEnvelope;
  frame:    string;
}

const ring: RingEntry[] = [];
const ringBySequence = new Map<number, number>(); // sequence → index in `ring`

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function buildEnvelope<T>(eventType: BotEventType, payload: T): BotEventEnvelope<T> {
  const seq = nextSequence();
  const generatedAt = new Date().toISOString();
  return {
    apiVersion:  BOT_API_VERSION,
    eventId:     `bot-${seq}`,
    eventType,
    sequence:    seq,
    generatedAt,
    dataVersion: generatedAt,
    payload,
  };
}

function frameFor(envelope: BotEventEnvelope): string {
  return `id: ${envelope.eventId}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

type Listener = (frame: string, envelope: BotEventEnvelope) => void;
const listeners = new Set<Listener>();

/** Push a fully-built envelope into the ring buffer, then fan it out to
 *  every currently-subscribed SSE client. Ring eviction is FIFO — the
 *  index map is rebuilt on overflow (identical bounded-buffer shape to
 *  emitter.ts's `rememberRecentMintMeta`; cheap at REPLAY_MAX=500). */
function publish<T>(eventType: BotEventType, payload: T): void {
  const envelope = buildEnvelope(eventType, payload);
  const frame = frameFor(envelope);
  ring.push({ sequence: envelope.sequence, envelope, frame });
  if (ring.length > REPLAY_MAX) {
    ring.shift();
    ringBySequence.clear();
    for (let i = 0; i < ring.length; i++) ringBySequence.set(ring[i].sequence, i);
  } else {
    ringBySequence.set(envelope.sequence, ring.length - 1);
  }
  for (const l of listeners) l(frame, envelope);
}

/** Subscribe a client to newly-published events. Returns an unsubscribe
 *  function — callers MUST call it on disconnect or the listener leaks. */
export function subscribeBotEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type ReplayResult =
  | { ok: true; frames: string[] }
  | { ok: false };

/** Replays every buffered event strictly AFTER `lastEventId`. Returns
 *  `{ok:false}` when `lastEventId` is not present in the ring (evicted by
 *  overflow, from a previous process lifetime, or simply malformed) — the
 *  caller must then emit `resync_required` rather than silently resuming
 *  from "now", which would let the bot miss everything in between. */
export function replaySince(lastEventId: string): ReplayResult {
  const m = /^bot-(\d+)$/.exec(lastEventId.trim());
  if (!m) return { ok: false };
  const seq = Number(m[1]);
  const idx = ringBySequence.get(seq);
  if (idx === undefined) return { ok: false };
  return { ok: true, frames: ring.slice(idx + 1).map((e) => e.frame) };
}

export function buildResyncFrame(requestedLastEventId: string | null): string {
  const envelope = buildEnvelope('resync_required', {
    reason: 'replay_unavailable' as const,
    requestedLastEventId,
  });
  // resync_required is per-client (not a broadcast fact worth replaying to
  // everyone else), so it deliberately does NOT go through publish()/the
  // shared ring — it still consumes a sequence number so the numbering
  // stays globally monotonic and unambiguous in logs.
  return frameFor(envelope);
}

export function currentSequence(): number { return sequence; }
export function subscriberCount(): number { return listeners.size; }

// ─── Bus → Bot API mapping ──────────────────────────────────────────────

function toSalePayload(event: SaleEvent): BotEventSalePayload {
  // Merkle-tree guard: me_cnft_raw stores the Bubblegum tree in
  // collectionAddress as a stable per-sale placeholder — never a real
  // collection identity (see isMerkleTreeCollectionAddress's doc comment).
  const trustedCollectionAddress = isMerkleTreeCollectionAddress(event)
    ? null
    : (event.collectionAddress ?? null);
  const identity = resolveCollectionIdentity(
    trustedCollectionAddress,
    event.meCollectionSlug ?? null,
    event.tensorCollectionSlug ?? null,
  );
  return {
    signature:   event.signature,
    mint:        event.mintAddress,
    slug:        event.meCollectionSlug ?? null,
    priceSol:    Number.isFinite(event.priceSol) ? event.priceSol : 0,
    marketplace: event.marketplace,
    saleType:    saleTypeFromEvent(event),
    blockTime:   event.blockTime.toISOString(),
    seller: event.seller ?? null,
    buyer:  event.buyer  ?? null,
    collectionId:              identity.collectionId,
    collectionSlug:            identity.collectionSlug,
    collectionAddress:         identity.collectionAddress,
    collectionIdentitySource:  identity.collectionIdentitySource,
    ammFill: ammFillFromEvent(event) ?? null,
    // Always null on the initial frame — see the field's doc comment on
    // BotEventSalePayload. Resolved later via a `sale_patch` event.
    sellerRemainingCount: null,
    // MMM pool sniper fields (2026-07-16) — direct passthroughs of the
    // verified parser output. `poolAddress` in particular must NEVER fall
    // back to `buyer` — a pool owner wallet can run multiple pools, so
    // guessing would silently point a bot at the wrong pool. `event
    // .poolAddress` is already exactly "verified parser output or null,
    // never guessed" (see its doc comment on SaleEvent) — passed through
    // unchanged, not re-derived here.
    poolAddress:       event.poolAddress ?? null,
    priceLamports:     event.priceLamports.toString(),
    nftType:           event.nftType ?? null,
    resizeStatus:      event.resizeStatus ?? null,
    parserReceivedAt:  event.parserReceivedAt ? event.parserReceivedAt.toISOString() : null,
    // Generated here, immediately before this payload is handed to
    // publish() for envelope/frame serialization (see the field's doc
    // comment on BotEventSalePayload) — no work happens on this payload
    // between this line and JSON.stringify in events.ts's frameFor().
    emittedAt:         new Date().toISOString(),
  };
}

/** Builds a `sale_patch` from a resolved collection identity. Returns null
 *  (never published) when nothing authoritative resolved — avoids sending
 *  an empty/no-op patch for the common case where enrichment simply found
 *  no collection identity for this sale. */
function toIdentityPatchPayload(p: BotIdentityPatch): BotEventSalePatchPayload | null {
  const identity = resolveCollectionIdentity(p.collectionAddress, p.meCollectionSlug, p.tensorCollectionSlug);
  if (identity.collectionId === null) return null;
  return {
    signature: p.signature,
    patch: {
      collectionId:             identity.collectionId,
      collectionSlug:           identity.collectionSlug,
      collectionAddress:        identity.collectionAddress,
      collectionIdentitySource: identity.collectionIdentitySource,
    },
  };
}

/** Builds a `sale_patch` from a resolved seller-remaining-count. Returns
 *  null (never published) when the lookup came back with no count — a
 *  null count means "genuinely unresolved", not "zero holdings left", and
 *  publishing it would let a bot wrongly treat "unknown" as "confirmed
 *  zero". */
function toSellerCountPatchPayload(p: BotSellerCountPatch): BotEventSalePatchPayload | null {
  if (p.count === null) return null;
  return { signature: p.signature, patch: { sellerRemainingCount: p.count } };
}

/** Builds a `sale_patch` from a resolved resize-status lookup. Reuses the
 *  EXISTING `ResizeStatusPatch` bus event (`resize-status-resolver.ts`) —
 *  the same one the public `resize_status` SSE channel already consumes —
 *  no new resolver, no new bus event. Always carries a signature (the
 *  resolver only enqueues a lookup when one is known — see
 *  `enqueueResizeLookup`'s call site in insert.ts), so unlike the seller-
 *  count "fast path" caveat, there's no unsignatured variant to omit here. */
function toResizeStatusPatchPayload(p: ResizeStatusPatch): BotEventSalePatchPayload {
  return { signature: p.signature, patch: { resizeStatus: p.resizeStatus } };
}

let wired = false;

/** Attach the bus listeners exactly once per process. Idempotent — a
 *  second call is a no-op. Not auto-attached at module load (unlike
 *  emitter.ts's own internal listeners) so tests can import this module
 *  without silently subscribing to the live process-wide bus. */
export function wireBotEventSources(): void {
  if (wired) return;
  wired = true;

  saleEventBus.onSale((event: SaleEvent) => {
    if (!event.mintAddress) return;
    publish<BotEventSalePayload>('sale', toSalePayload(event));
  });

  saleEventBus.onListingSnapshot(({ slug }) => {
    publish<BotEventListingChangePayload>('listing_change', { slug, kind: 'snapshot' });
  });

  saleEventBus.onListingRemove(({ slug, id }) => {
    publish<BotEventListingChangePayload>('listing_change', { slug, kind: 'remove', id });
  });

  // Collection-identity patch — fires once per non-blacklisted, mint-bearing
  // sale, right alongside the existing (public, untouched) `meta` update.
  // See BotIdentityPatch's doc comment in src/events/emitter.ts.
  saleEventBus.onBotIdentityPatch((p) => {
    const payload = toIdentityPatchPayload(p);
    if (payload) publish<BotEventSalePatchPayload>('sale_patch', payload);
  });

  // Seller-remaining-count patch — fast (signature-correlatable) path only.
  // The late exact-scan refinement has no signature and is intentionally
  // not wired here — see BotSellerCountPatch's doc comment.
  saleEventBus.onBotSellerCountPatch((p) => {
    const payload = toSellerCountPatchPayload(p);
    if (payload) publish<BotEventSalePatchPayload>('sale_patch', payload);
  });

  // Resize-status patch — reuses the existing public ResizeStatusPatch bus
  // event (resize-status-resolver.ts) directly; no Bot-API-specific patch
  // type needed since it's already signature-correlated and carries no
  // fields that need filtering/guarding the way collection identity does.
  saleEventBus.onResizeStatusPatch((p: ResizeStatusPatch) => {
    publish<BotEventSalePatchPayload>('sale_patch', toResizeStatusPatchPayload(p));
  });
}

/** Test-only escape hatch — publish an arbitrary event through the same
 *  ring/sequence/fan-out path the real bus listeners use, without needing
 *  a live saleEventBus emission. Exported (not test-file-local) so the
 *  ring/sequence machinery under test is the exact one production uses. */
export function __publishForTest<T>(eventType: BotEventType, payload: T): void {
  publish(eventType, payload);
}

/** Test-only — resets all module-level state (ring, sequence, listeners,
 *  wired flag) so successive test cases don't leak sequence numbers or
 *  ring contents into each other. */
export function __resetForTest(): void {
  ring.length = 0;
  ringBySequence.clear();
  listeners.clear();
  sequence = 0;
  wired = false;
}
