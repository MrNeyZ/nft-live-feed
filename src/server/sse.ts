import { Router, Request, Response } from 'express';
import {
  saleEventBus,
  recentMintMetaSnapshot,
  MetaUpdate,
  RawPatch,
  ListingRemoveDelta,
  ListingSnapshotDelta,
  type SourceStatusWire,
  type MintEventWire,
  type MintStatusWire,
  type MintMetaPatch,
  type PaymentTokenMeta,
  paymentTokenMetaSnapshot,
} from '../events/emitter';
import { SaleEvent } from '../models/sale-event';
import { rarityForMintSync } from './rarity-lookup';
import { saleTypeFromEvent, ammFillFromEvent } from '../domain/sale-event-adapters';
import { currentStatuses } from '../health/source-health';
import { currentMintStatuses, currentRecentMints, getMintAuditCounts } from '../mints/accumulator';
import { getSellerCollectionCountVerbose, resolveCollectionForMint } from '../enrichment/seller-collection-count';
import { noteRecentSell, getRecentSellCount, getRecentSellerCountAny } from '../enrichment/recent-sell-tracker';
import { scheduleExactSellerCount } from '../enrichment/seller-count-exact';
import { updateSellerRemainingCount, updateSellerRemainingCountByCollection } from '../db/insert';

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

// ── Connection caps (H6) ────────────────────────────────────────────────────
// Without limits, an attacker (or an accidental reconnect-storm) can open
// arbitrarily many keep-alive sockets to /events/stream and either exhaust
// the worker's file descriptors or grow each broadcast loop's per-tick cost
// linearly with N clients. The caps below bound both axes.
//   - MAX_SSE_CLIENTS:        process-wide ceiling. Default 2000 leaves
//                              headroom for the Linux soft `nofile` limit
//                              (typically 1024-65535) while bounding the
//                              broadcast loop work-per-emit.
//   - MAX_SSE_CLIENTS_PER_IP: per-IP ceiling. Default 4 covers a normal
//                              user with 2-3 dashboard tabs plus a
//                              feed/multi window; tighter than that breaks
//                              the multi-tab UX.
// Both are env-overridable. Caps are checked BEFORE response headers are
// flushed so an over-cap caller gets a clean 429 instead of a 200-then-
// hang. Per-IP counters live in a Map keyed on req.ip (which the existing
// `app.set('trust proxy', 1)` makes the real client IP, not a forgeable
// XFF header value).
function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MAX_SSE_CLIENTS        = envInt('SSE_MAX_CLIENTS',        2000);
const MAX_SSE_CLIENTS_PER_IP = envInt('SSE_MAX_CLIENTS_PER_IP',  4);
const clientsByIp = new Map<string, number>();

/** Strip an IPv6-mapped IPv4 prefix so `::ffff:1.2.3.4` keys the same bucket
 *  as `1.2.3.4`. */
function normalizeIp(ip: string): string {
  const t = ip.trim();
  return t.startsWith('::ffff:') ? t.slice(7) : t;
}

/** Real client IP for per-IP SSE cap accounting (NOT used for anything else).
 *
 *  The deployment is Client → Cloudflare → nginx → Express, which is TWO proxy
 *  hops; `app.set('trust proxy', 1)` only unwinds one, so `req.ip` resolves to
 *  the Cloudflare EDGE IP (172.68.x.x) — meaning every user behind that edge
 *  shares one per-IP bucket and trips the cap. Priority:
 *    1. CF-Connecting-IP — set by Cloudflare to the true client; the client
 *       cannot spoof it (Cloudflare overwrites the header at the edge).
 *    2. first (left-most) X-Forwarded-For entry — the original client.
 *    3. req.ip / socket — last resort.
 *
 *  Trade-off: #1 is trustworthy ONLY because all ingress is forced through
 *  Cloudflare+nginx (no direct origin exposure). If the origin were ever
 *  reachable directly, CF-Connecting-IP / XFF would be client-forgeable — but
 *  the blast radius is just this rate-limit bucket, never auth/data. */
function clientIpForCap(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return normalizeIp(cf);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket.remoteAddress || 'unknown');
}

// ── Slow-client backpressure ────────────────────────────────────────────────
// res.write() returns false when the kernel send buffer is full and Node is
// queuing the frame in user space. One false return is normal under bursts.
// Repeated falses in a row mean the client isn't draining — keeping that
// res in the broadcast loop grows Node's internal buffer without bound and
// turns one stalled tab into a process-wide memory leak.
//
// Eviction trigger: SSE_MAX_CONSECUTIVE_BACKPRESSURE consecutive false
// returns (default 8). At our normal emit cadence (a handful of frames per
// second during active periods + a 25 s heartbeat) reaching 8 consecutive
// failures means the buffer has been wedged across multiple seconds. We
// reset the counter on every successful write, so transient
// fullness during a burst doesn't trip the gate.
const MAX_CONSECUTIVE_BACKPRESSURE = envInt('SSE_MAX_CONSECUTIVE_BACKPRESSURE', 8);

interface SseStats {
  ip:                       string;
  connectedAt:              number;
  consecutiveBackpressure:  number;
  totalBackpressure:        number;
  lastWriteOkAt:            number;
  evicted:                  boolean;
}

/** Public accessor — exposed so other subsystems (db/insert emit log,
 *  health endpoints) can surface "how many clients are listening right
 *  now" without importing the Set itself. Cheap; no allocation. */
export function getSseClientCount(): number { return sseClients.size; }

/** Send a pre-built SSE frame (e.g. `event: sale\ndata: …\n\n`) to every
 *  connected client. Three failure paths handled inline so a slow / dead
 *  client can never wedge the broadcast loop:
 *    1. write() throws (socket already torn down) → run cleanup.
 *    2. write() returns false (backpressure — Node is buffering for us)
 *       → bump consecutive counter; reset on next true return. If the
 *       counter crosses MAX_CONSECUTIVE_BACKPRESSURE the client is
 *       considered stuck and evicted via the same cleanup() path.
 *    3. normal true return → reset the counter, stamp lastWriteOkAt.
 *  cleanup() is idempotent so concurrent evictions (broadcast + req.close
 *  firing back-to-back) are safe. */
function broadcast(frame: string): void {
  if (sseClients.size === 0) return;
  for (const res of sseClients) {
    const tagged = res as Response & {
      _sseCleanup?: () => void;
      _sseStats?:   SseStats;
    };
    try {
      const ok = res.write(frame);
      const stats = tagged._sseStats;
      if (!stats) continue;
      if (ok) {
        stats.consecutiveBackpressure = 0;
        stats.lastWriteOkAt = Date.now();
      } else {
        stats.consecutiveBackpressure++;
        stats.totalBackpressure++;
        if (stats.consecutiveBackpressure >= MAX_CONSECUTIVE_BACKPRESSURE && !stats.evicted) {
          stats.evicted = true;
          console.warn(
            `[sse] evict reason=slow_client ip=${stats.ip} ` +
            `consecutive=${stats.consecutiveBackpressure} total=${stats.totalBackpressure}`,
          );
          tagged._sseCleanup?.();
        }
      }
    } catch {
      if (tagged._sseCleanup) tagged._sseCleanup();
      else sseClients.delete(res);
    }
  }
}

// ── Micro-batching ──────────────────────────────────────────────────────────
// High-frequency event types (sale, mint, listing_*, meta, rawpatch,
// seller_count) used to call broadcast() once per event — i.e. one write()
// per event per client. Under burst load (mint storms, AMM repricing
// floods) that's hundreds of writes per second across N clients, each
// paying its own syscall + per-write backpressure round-trip.
//
// `enqueue(frame)` appends to a FIFO and schedules a flush ~SSE_BATCH_MS
// (default 50 ms) later. At flush time the queued frames are concatenated
// into one string and shipped through broadcast() — i.e. one write() per
// client per ~50 ms window, regardless of how many events arrived. The
// SSE wire format is unchanged: clients see exactly the same
// `event: X\ndata: …\n\n` frames in the same order; only the TCP chunking
// differs. EventSource parses the stream incrementally, so a single TCP
// write delivering 50 frames is indistinguishable from 50 individual
// writes at the protocol level.
//
// Control / status events (currently `status`) keep using broadcast()
// directly so they don't sit in a 50 ms queue while the operator is
// staring at a "tensor down" indicator.
//
// Overflow: if the queue reaches MAX_BATCH_FRAMES (default 500), flush
// immediately. We never drop frames — drop semantics would risk losing a
// `remove` or `seller_count` patch that downstream UI state depends on.
const BATCH_MS         = envInt('SSE_BATCH_MS',          50);
const MAX_BATCH_FRAMES = envInt('SSE_MAX_BATCH_FRAMES', 500);
let batchQueue: string[] = [];
let batchTimer: NodeJS.Timeout | null = null;
let batchHighWater = 0; // largest queue size we've seen — diagnostic only

function flush(): void {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (batchQueue.length === 0) return;
  if (batchQueue.length > batchHighWater) batchHighWater = batchQueue.length;
  const combined = batchQueue.join('');
  batchQueue = [];
  if (sseClients.size === 0) return;
  broadcast(combined);
}

/** Queue a pre-built SSE frame for the next batch flush. Use for high-
 *  frequency event types (sale / mint / listing_* / meta / rawpatch /
 *  seller_count). Force-flushes when the queue exceeds MAX_BATCH_FRAMES
 *  so a sustained burst can't grow the queue without bound. */
function enqueue(frame: string): void {
  batchQueue.push(frame);
  if (batchQueue.length >= MAX_BATCH_FRAMES) {
    flush();
    return;
  }
  if (batchTimer) return;
  batchTimer = setTimeout(flush, BATCH_MS);
  if (typeof batchTimer.unref === 'function') batchTimer.unref();
}

/** Diagnostic — high-water mark of the batch queue since boot. Exposed
 *  for future health endpoints; unused today. */
export function getSseBatchHighWater(): number { return batchHighWater; }

function buildSaleFrame(event: SaleEvent): string {
  const parser = event.rawData._parser as string | undefined;
  const source = parser ? 'me_raw' : 'helius';
  // Best-effort rarity from the existing in-process cache (no DB/provider call
  // on this hot path). Cold mints get no badge now but prime for next time.
  const rar = rarityForMintSync(event.mintAddress);
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
    meCollectionSlug:      event.meCollectionSlug      ?? null,
    tensorCollectionSlug:  event.tensorCollectionSlug  ?? null,
    floorDelta:            event.floorDelta             ?? null,
    offerDelta:        event.offerDelta        ?? null,
    resizeStatus:      event.resizeStatus      ?? null,
    mintedAtMs:        event.mintedAtMs         ?? null,
    // Authoritative, synchronous AMM-fill signal (see sale-event-adapters.ts) —
    // unlike `poolType` (async, SSE-only, ME-lookup-derived), this is set at
    // parse time from the on-chain lp_fee log and is present on the very
    // first `sale` frame. `poolType` remains fallback/corroboration only —
    // see mmm-pool-type-resolver.ts's module doc and sale-kind.ts's saleKind().
    ammFill:           ammFillFromEvent(event),
    rarityRank:        rar?.rarityRank        ?? null,
    totalSupply:       rar?.totalSupply       ?? null,
    rarityPercentile:  rar?.rarityPercentile  ?? null,
    raritySource:      rar?.raritySource      ?? null,
    oneOfOne:          rar?.oneOfOne          ?? false,
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
function buildMintMetaFrame(p: MintMetaPatch): string {
  return `event: mint_meta\ndata: ${JSON.stringify(p)}\n\n`;
}
function buildPaymentTokenMetaFrame(p: PaymentTokenMeta): string {
  return `event: payment_token_meta\ndata: ${JSON.stringify(p)}\n\n`;
}

// Sell-type sale_types we surface a "seller still holds N" badge for.
// Authoritative list comes from `deriveSaleType` (src/domain/sale-type.ts):
//   bid_sell  ← UI: SELL / BID SELL  (instant sell into a collection bid)
//   pool_sale ← UI: AMM (red, sell side)  (seller dumped into an AMM/pool)
// `pool_sell` / `amm_sell` are kept for forward-compat with `mapSide` in
// from-backend.ts — `deriveSaleType` does not currently emit them, so
// they're harmless extras here.
const SELL_TYPES_FOR_BADGE = new Set(['bid_sell', 'pool_sale', 'pool_sell', 'amm_sell']);

/** Per-sale seller-count log gate. The fast/signal lines were unsampled
 *  per sale; under load that's noisy without telling the operator anything
 *  the audit/result/skip lines don't already say. Set `SELLER_COUNT_DEBUG=1`
 *  (or `=verbose`) when actively investigating to re-enable them. The
 *  exact-fallback trigger/result/skip logs in `seller-count-exact.ts`
 *  remain unsampled regardless — they fire infrequently and matter. */
const SELLER_COUNT_DEBUG = process.env.SELLER_COUNT_DEBUG === '1'
  || process.env.SELLER_COUNT_DEBUG === 'verbose';

// Startup confirmation — proves this module loaded and the seller-count
// onSale listener is attached. Look for this exact line in `pm2 logs
// nft-backend` immediately after restart to verify the binary in use
// includes the seller-count diagnostic.
if (SELLER_COUNT_DEBUG) console.log('[seller-count-init] listener attached');

// One bus listener per event type, registered once at module load. The
// frame is built once per emit and broadcast to all clients in the Set.
// High-frequency types (sale, mint, listing_*, meta, rawpatch,
// seller_count) go through enqueue() for 50 ms micro-batching; control
// types (status) call broadcast() directly so the operator sees
// source-health flips without batch latency.
saleEventBus.onSale(           (event)  => {
  enqueue(buildSaleFrame(event));
  // Async, fire-and-forget: for sell-type sales with a known
  // collectionAddress, look up the seller's remaining holdings via DAS
  // (cached + deduped) and broadcast a `seller_count` patch frame so
  // the FeedCard can render a small badge. Failures (no API key, DAS
  // miss, no collection address) silently skip — the card just renders
  // without the badge, which matches the spec ("if count unknown, do
  // not show badge").
  const saleType = saleTypeFromEvent(event);
  // Per-event debug log — env-gated. Set SELLER_COUNT_DEBUG=1 (or
  // unsampled by setting SELLER_COUNT_DEBUG=verbose) when actively
  // investigating; otherwise this path is silent so the onSale hot
  // loop stays cheap. Default OFF.
  if (process.env.SELLER_COUNT_DEBUG === 'verbose'
      || (process.env.SELLER_COUNT_DEBUG === '1' && Math.random() < 0.05)) {
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
    if (Math.random() < 0.02) {
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
        if (Math.random() < 0.02) {
          console.log(
            `[seller-count-miss] reason=missing_collection_and_mint sig=${signature.slice(0,12)}… saleType=${saleType}`,
          );
        }
        return;
      }
      collection = await resolveCollectionForMint(mint);
      if (!collection) {
        if (Math.random() < 0.02) {
          console.log(
            `[seller-count-miss] reason=missing_collection_after_das sig=${signature.slice(0,12)}… ` +
            `saleType=${saleType} mint=${mint.slice(0,8)}…`,
          );
        }
        return;
      }
      if (process.env.SELLER_COUNT_DEBUG) {
        console.log(`[seller-count-resolve] mint=${mint.slice(0,8)}… collection=${collection.slice(0,8)}…`);
      }
    }
    // Track this sale in the 10-min recent-sells ring for the
    // dumping-signal fallback. Always recorded (cheap, in-memory),
    // even when the DAS lookup below is dropped by the slot limiter.
    noteRecentSell(seller, collection);
    const verdict = await getSellerCollectionCountVerbose(seller, collection);
    const count = verdict.count;
    const sells10m = getRecentSellCount(seller, collection);
    const sellsAny10m = getRecentSellerCountAny(seller);
    if (SELLER_COUNT_DEBUG) {
      console.log(
        `[seller-count-fast] seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}… count=${count ?? 'null'}`,
      );
    }
    // Active-dumper trigger: when fast count is weak (null/0/1/2) AND
    // the wallet shows live dump-y behavior, kick the exact-fallback
    // deep scan. Fire-and-forget — broadcasts a fresh seller_count
    // patch when it lands. Cache + queue + 5 s timeout in the module.
    if ((count == null || count < 3) && (sells10m >= 2 || sellsAny10m >= 3)) {
      console.log(
        `[seller-count-exact-trigger] reason=active_dump ` +
        `seller=${seller.slice(0, 8)}… collection=${collection.slice(0, 8)}… ` +
        `sells10m=${sells10m} sellsAny10m=${sellsAny10m}`,
      );
      scheduleExactSellerCount(seller, collection, sells10m);
    }
    // Dumping signal: when DAS reports too few (or nothing) but the
    // wallet is visibly dumping into the same collection ≥2 times in
    // the last 10 min, broadcast a `multi` signal so the frontend
    // shows a 🔥 badge instead of hiding the row entirely. When DAS
    // returns a real count >=3 the exact number wins.
    const signal: 'multi' | undefined =
      (count == null || count < 3) && sells10m >= 2 ? 'multi' : undefined;
    // Verify / result / mismatch logs — env-gated to keep the hot
    // sale path quiet under load. Set SELLER_COUNT_DEBUG=verbose
    // when actively investigating; SELLER_COUNT_DEBUG=1 samples 5%.
    const verboseLog = process.env.SELLER_COUNT_DEBUG === 'verbose'
      || (process.env.SELLER_COUNT_DEBUG === '1' && Math.random() < 0.05);
    if (verboseLog) {
      console.log(
        `[seller-count-verify] sig=${signature.slice(0,12)}… seller=${seller.slice(0,8)}… ` +
        `soldMint=${mint ? mint.slice(0,8) + '…' : '—'} resolvedCollection=${collection.slice(0,8)}… ` +
        `total=${count ?? 'null'} method=${verdict.method}` +
        (verdict.scanned != null ? ` scanned=${verdict.scanned}` : ''),
      );
    }
    // Per-event signal log — gated by SELLER_COUNT_DEBUG. The
    // exact-fallback trigger log below is the operator-facing surface
    // for whale-dump detection and remains unsampled.
    if (SELLER_COUNT_DEBUG) {
      console.log(
        `[seller-count-signal] seller=${seller.slice(0,8)}… collection=${collection.slice(0,8)}… ` +
        `sells10m=${sells10m} count=${count ?? 'null'}` + (signal ? ` signal=${signal}` : ''),
      );
    }
    // Targeted unsampled diagnostic for the dumper-wallet that lost
    // its badge after Batch B's log-gating. Always logs regardless of
    // SELLER_COUNT_DEBUG so the operator can confirm the wire path
    // is firing for this exact wallet without flipping the env flag.
    // Remove once the badge regression is confirmed fixed.
    const SELLER_COUNT_TARGET_WALLETS = new Set<string>([
      'BMjqDjXVwQVHBkSSxpzX9eKEw3sHmnP9yhn3tjF7T9SA',
    ]);
    if (SELLER_COUNT_TARGET_WALLETS.has(seller)) {
      const exactTriggered =
        (count == null || count < 3) && (sells10m >= 2 || sellsAny10m >= 3);
      console.log(
        `[seller-count-target] seller=${seller.slice(0,8)}… ` +
        `collection=${collection.slice(0,8)}… count=${count ?? 'null'} ` +
        `sells10m=${sells10m} sellsAny10m=${sellsAny10m} ` +
        `signal=${signal ?? '—'} exactTriggered=${exactTriggered ? 'yes' : 'no'} ` +
        `sig=${signature.slice(0,12)}…`,
      );
    }
    // PREVIOUS BUG: when both `count` and `signal` were absent we returned
    // here without broadcasting. That created a class of dumpers (wallets
    // hitting many DIFFERENT collections one-shot — qualifies for the
    // sellsAny10m>=3 exact-scan trigger but NOT for signal='multi' which
    // requires sells10m>=2 in the same collection) where:
    //   1. Initial fast path returns count=null + no signal → return.
    //   2. Frontend row never gets its `collectionAddress` backfilled
    //      via the seller_count signature-match path.
    //   3. Late `seller_count_update` from the exact-scan completion
    //      fires WITHOUT a signature (only seller+collection).
    //   4. Frontend reducer tries to match by seller+collection but
    //      the row's collectionAddress is still null → no match,
    //      badge never appears.
    // Fix: always broadcast for sell-side events with resolved
    // seller+collection. Frontend renders only when `count >= 3`,
    // so a null-count broadcast is harmless — but it backfills
    // `collectionAddress` on the row so the late exact patch can
    // match by seller+collection.
    if (count === 0 && verdict.method === 'getAssetsByOwner' && (verdict.scanned ?? 0) > 0
        && Math.random() < 0.10) {
      console.log(
        `[seller-count-verify-mismatch] reason=owner_holds_assets_but_no_grouping_match ` +
        `sig=${signature.slice(0,12)}… collection=${collection.slice(0,8)}… scanned=${verdict.scanned}`,
      );
    }
    if (verboseLog) {
      console.log(
        `[seller-count-result] sig=${signature.slice(0,12)}… saleType=${saleType} ` +
        `seller=${seller.slice(0,8)}… collection=${collection.slice(0,8)}… ` +
        `count=${count ?? 'null'} method=${verdict.method} signal=${signal ?? '—'}`,
      );
    }
    // Wire payload carries the originating signature + seller+collection
    // (so the same patch fans out to all visible rows from this dump
    // batch and persists in localStorage), the DAS count (may be null),
    // and `sells10m`. `signal` is intentionally OMITTED from the wire —
    // frontend no longer renders the 🔥 multi-sell hint; it shows only
    // the numeric exact remaining count when count >= 3. The backend
    // still computes `signal` internally above to gate the
    // exact-fallback trigger; it just doesn't ship to clients.
    enqueue(`event: seller_count\ndata: ${JSON.stringify({ signature, seller, collection, count, sells10m })}\n\n`);
    // Durable persistence (migration 015): write the resolved count to
    // sale_events so /api/events/latest returns it on every device/reload —
    // fixing the Mac-shows-it / PC-doesn't divergence where the count lived
    // only in the browser that saw this live frame. Fire-and-forget: the
    // helper swallows + warns on DB error and never blocks/breaks the SSE
    // emit above. Only finite counts (the late exact-scan refresh carries no
    // signature, so it can't target a row by signature — it still upgrades
    // the value live; persistence here covers the originating sale).
    if (typeof count === 'number' && Number.isFinite(count)) {
      void updateSellerRemainingCount(signature, count);
    }
    // Avoid 'signal is declared but never read' under strict-unused linting
    // when the env-gated logs above are stripped from a production build.
    void signal;
  })();
});
saleEventBus.onMetaUpdate(     (update) => enqueue(`event: meta\ndata: ${JSON.stringify(update)}\n\n`));
saleEventBus.onRemove(         (sig)    => enqueue(`event: remove\ndata: ${JSON.stringify({ signature: sig })}\n\n`));
saleEventBus.onRawPatch(       (patch)  => enqueue(`event: rawpatch\ndata: ${JSON.stringify(patch)}\n\n`));
saleEventBus.onResizeStatusPatch((patch) => enqueue(`event: resize_status\ndata: ${JSON.stringify(patch)}\n\n`));
// AMM pool-type patch — mmm-pool-type-resolver emits this on a successful
// exact poolKey match. Frontend renders the AMM glyph ONLY when the
// patched value is 'two_sided' (see sale-kind.ts).
saleEventBus.onPoolTypePatch(  (patch)  => enqueue(`event: pool_type\ndata: ${JSON.stringify(patch)}\n\n`));
// Late-resolved rarity (sync-miss → async DB resolve). Forwarded to live
// clients so the Sales rarity badge + Rare Feed appear without a reload. The
// producer only fires this with a finite rank + supply>0 (never null/negative).
saleEventBus.onRarityPatch(    (patch)  => enqueue(`event: rarity\ndata: ${JSON.stringify(patch)}\n\n`));
saleEventBus.onListingRemove(  (delta)  => enqueue(`event: listing_remove\ndata: ${JSON.stringify(delta)}\n\n`));
saleEventBus.onListingSnapshot((delta)  => enqueue(`event: listing_snapshot\ndata: ${JSON.stringify(delta)}\n\n`));
// Source-status flips are operator-relevant — keep them immediate so a
// "tensor down" indicator doesn't sit in a 50 ms queue.
saleEventBus.onSourceStatus(   (s)      => broadcast(buildStatusFrame(s)));
// Audit counter — pairs with the accumulator's accepted/emitted
// counts. A growing gap (`emitted >> sseSent`) means broadcasts are
// failing to write; a healthy stream sees all three move together.
let mintsSseSentCount = 0;
saleEventBus.onMint(           (m)      => {
  enqueue(buildMintFrame(m));
  mintsSseSentCount++;
  // Per-mint `[mints/sse] sent mint sig=…` log removed — under a hot
  // launch (50–200 mints/sec) it drowned every other line and the 60 s
  // `[mints/audit]` rollup below already tracks `sseSent` against
  // `accepted` / `emitted`, which is the metric the operator actually
  // watches. Counter is still incremented so the audit log stays
  // accurate.
  void m;
});
saleEventBus.onMintStatus(     (s)      => enqueue(buildMintStatusFrame(s)));
saleEventBus.onMintMeta(       (p)      => enqueue(buildMintMetaFrame(p)));
saleEventBus.onPaymentTokenMeta((p)     => enqueue(buildPaymentTokenMetaFrame(p)));
// Late seller-count refresh (active-dumper exact-fallback). Re-uses
// the existing `seller_count` SSE event; frontend reducer already
// matches by seller+collection and sticky-merges higher counts.
// `signal` is forwarded only when the producer supplied one — omitting
// it lets the frontend reducer keep any prior 🔥 state intact. When an
// exact `count` is present the frontend will replace the multi badge
// with the exact number regardless of `signal`.
saleEventBus.onSellerCountUpdate((u) => {
  const payload: {
    seller:     string;
    collection: string;
    count:      number;
    sells10m:   number;
    signal?:    'multi';
  } = {
    seller:     u.seller,
    collection: u.collection,
    count:      u.count,
    sells10m:   u.sells10m,
  };
  if (u.signal) payload.signal = u.signal;
  enqueue(`event: seller_count\ndata: ${JSON.stringify(payload)}\n\n`);
  // Eventual consistency: persist the refined exact-scan count too. This frame
  // has no signature, so fan it out by (seller, collection) to that wallet's
  // recent sales — otherwise a reload would read the older fast-count
  // (live 99 → F5 97). Fire-and-forget: never blocks/breaks the emit above;
  // the helper swallows + warns on DB error. Finite counts only.
  if (typeof u.count === 'number' && Number.isFinite(u.count)) {
    void updateSellerRemainingCountByCollection(u.seller, u.collection, u.count);
  }
});

// 60 s audit — cross-checks accumulator's accepted/emitted with
// our broadcast count. Skips when no activity to keep logs quiet.
const _mintAuditTimer = setInterval(() => {
  const { accepted, emitted } = getMintAuditCounts();
  if (accepted === 0 && emitted === 0 && mintsSseSentCount === 0) return;
  console.log(
    `[mints/audit] accepted=${accepted} emitted=${emitted} sseSent=${mintsSseSentCount} clients=${sseClients.size}`,
  );
}, 60_000);
if (typeof _mintAuditTimer.unref === 'function') _mintAuditTimer.unref();

export function createSseRouter(): Router {
  const router = Router();

  router.get('/stream', (req: Request, res: Response) => {
    // ── Connection caps ─────────────────────────────────────────────────
    // Reject BEFORE any setHeader / flushHeaders so the rejection is a
    // clean HTTP/1.1 429 with a JSON body — once we've flushed the
    // 200 OK + text/event-stream headers we can't change status. The
    // Per-IP bucket keys on the REAL client IP (CF-Connecting-IP / XFF), not
    // the Cloudflare edge IP that `req.ip` resolves to behind two proxy hops;
    // global bucket keys on sseClients.size. See clientIpForCap().
    const ip = clientIpForCap(req);
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      console.warn(`[sse] reject reason=global_cap clients=${sseClients.size}/${MAX_SSE_CLIENTS}`);
      res.setHeader('Retry-After', '30');
      res.status(429).json({ error: 'sse_capacity' });
      return;
    }
    const ipCount = clientsByIp.get(ip) ?? 0;
    if (ipCount >= MAX_SSE_CLIENTS_PER_IP) {
      console.warn(`[sse] reject reason=per_ip_cap ip=${ip} count=${ipCount}/${MAX_SSE_CLIENTS_PER_IP}`);
      res.setHeader('Retry-After', '30');
      res.status(429).json({ error: 'sse_per_ip_limit' });
      return;
    }

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
    // Replay the recent per-mint events too — without this the Live
    // Mint Feed pane on /mints stays empty until the next mint lands,
    // even though the collection rows show entries from older mints.
    // Frontend reducer already dedups by signature so a reconnect-
    // during-quiet-window doesn't double-render anything.
    for (const me of currentRecentMints()) {
      try { res.write(buildMintFrame(me)); } catch { /* client gone */ }
    }
    // Replay the recent per-mint metadata patches. Without this, a tab
    // that loads after a mint_meta has already fanned out keeps
    // hydrated localStorage entries on their placeholder shortMint
    // forever — the metadata never re-arrives. Frontend reducer is
    // already idempotent (matches by signature, sticky-merges values),
    // so replaying patches the client may have already seen during a
    // brief disconnect is safe and a no-op. Order matters slightly:
    // ship after the mint_status / mint frames so the events the
    // patches reference are already in the client's buffer.
    let metaReplayed = 0;
    for (const p of recentMintMetaSnapshot()) {
      try {
        res.write(buildMintMetaFrame(p));
        metaReplayed++;
      } catch { /* client gone */ break; }
    }
    console.log(`[mints/sse] replayed mint_meta=${metaReplayed}`);
    // Payment-token metadata snapshot — one entry per unique custom-token
    // mint the backend has ever resolved this process lifetime. Without
    // this, a freshly-loaded tab would render shortMint labels until the
    // next mint priced in that token arrives.
    for (const p of paymentTokenMetaSnapshot()) {
      try { res.write(buildPaymentTokenMetaFrame(p)); } catch { break; }
    }

    sseClients.add(res);
    clientsByIp.set(ip, ipCount + 1);
    console.log(`[sse] open ip=${ip} count=${ipCount + 1}/${MAX_SSE_CLIENTS_PER_IP} clients=${sseClients.size}`);

    // Per-client stats. broadcast() reads/writes this; cleanup nulls the
    // back-reference so a late callback can't resurrect a dead client.
    const stats: SseStats = {
      ip,
      connectedAt:              Date.now(),
      consecutiveBackpressure:  0,
      totalBackpressure:        0,
      lastWriteOkAt:            Date.now(),
      evicted:                  false,
    };
    (res as Response & { _sseStats?: SseStats })._sseStats = stats;

    const heartbeat = setInterval(() => {
      try {
        // Real `ping` SSE event (was a `: heartbeat` comment). A named event is
        // delivered to the EventSource client so the frontend can track
        // last-frame-time and detect a silently half-open connection; it also
        // serves the same transport-keepalive role the comment did. Does not
        // touch sale/mint frames or the event bus.
        const ok = res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
        if (ok) {
          stats.consecutiveBackpressure = 0;
          stats.lastWriteOkAt = Date.now();
        } else {
          stats.consecutiveBackpressure++;
          stats.totalBackpressure++;
          if (stats.consecutiveBackpressure >= MAX_CONSECUTIVE_BACKPRESSURE && !stats.evicted) {
            stats.evicted = true;
            console.warn(
              `[sse] evict reason=slow_client_heartbeat ip=${stats.ip} ` +
              `consecutive=${stats.consecutiveBackpressure}`,
            );
            cleanup();
          }
        }
      }
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
    // entry in sseClients. Per-IP counter decrement is in here so a
    // disconnect (clean OR proxy-half-close caught by broadcast()) frees
    // the slot for a future reconnect from the same address.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      sseClients.delete(res);
      const cur = clientsByIp.get(ip) ?? 0;
      if (cur <= 1) clientsByIp.delete(ip);
      else clientsByIp.set(ip, cur - 1);
      // Drop the back-references so a late broadcast() can't operate on
      // a torn-down response. The actual socket teardown (res.end on a
      // closed stream is a no-op) is handled by Node when the close
      // event fires.
      const tagged = res as Response & { _sseStats?: SseStats; _sseCleanup?: () => void };
      tagged._sseStats = undefined;
      tagged._sseCleanup = undefined;
      try { res.end(); } catch { /* already closed */ }
    };
    // Make the cleanup reachable from broadcast() so a write-fail on a
    // half-closed socket can run it without waiting for the OS to fire
    // the matching close event.
    (res as Response & { _sseCleanup?: () => void })._sseCleanup = cleanup;
    req.on('close',   cleanup);
    req.on('error',   cleanup);
    req.on('aborted', cleanup);
    res.on('close',   cleanup);
    res.on('error',   cleanup);
  });

  return router;
}
