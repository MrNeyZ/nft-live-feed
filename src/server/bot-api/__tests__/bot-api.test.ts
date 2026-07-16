/**
 * Route-level regression suite for the VictoryLabs Internal Bot API v1.
 *
 * Real HTTP over an ephemeral local port (same pattern as
 * ../../collection-floor-depth.test.ts — no supertest dependency in this
 * repo). Snapshot analytics deps are injected (`SnapshotDeps`) so this
 * suite makes NO network / DB / RPC calls. `BOT_API_KEY` /
 * `BOT_API_ALLOWED_IPS` / heartbeat interval are set per-test via
 * `process.env` — both are read per-request/per-connection by design (see
 * auth.ts / router.ts), not cached at module load, specifically so this
 * suite can flip them between cases without re-importing anything.
 *
 * Run: npx ts-node src/server/bot-api/__tests__/bot-api.test.ts
 */

import http from 'http';
import express from 'express';
import { createBotApiV1Router } from '../router';
import { withTimeout, DependencyTimeoutError, type SnapshotDeps } from '../snapshot';
import { sanitizeForJson } from '../json-safe';
import {
  wireBotEventSources,
  __publishForTest,
  __resetForTest,
  subscriberCount,
} from '../events';
import type { Listing, ListingSource, ListingType } from '../../listings-store';
import type { SaleEventRow } from '../../../db/queries';
import type { CollectionBidPair } from '../../../analytics/normalized-collection-bid';
import { saleEventBus } from '../../../events/emitter';
import type { SaleEvent } from '../../../models/sale-event';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────

let mkSeq = 0;
function mkListing(mint: string, priceSol: number, opts: { source?: ListingSource; type?: ListingType } = {}): Listing {
  mkSeq++;
  const source = opts.source ?? 'ME';
  const type   = opts.type   ?? 'listing';
  return {
    id: `${source}:${type === 'pool' ? `pool${mkSeq}:` : ''}${mint}:seller${mkSeq}`,
    mint, priceSol, source, type,
    seller: `seller${mkSeq}`,
    slug: 'test_collection',
    auctionHouse: source === 'MMM' ? '' : 'AH1',
    tokenAta: '', rank: null, listedAt: null, nftName: null, imageUrl: null,
  };
}

function mkSaleRow(signature: string, mint: string): SaleEventRow {
  return {
    id: signature, signature,
    block_time: '2026-07-14T00:00:00.000Z',
    marketplace: 'magic_eden',
    nft_type: 'legacy',
    sale_type: 'normal_sale',
    mint_address: mint,
    collection_address: null,
    seller: 'sellerA', buyer: 'buyerA',
    price_lamports: '1000000000',
    price_sol: '1',
    currency: 'SOL',
    nft_name: null, image_url: null, collection_name: null, magic_eden_url: null,
    me_collection_slug: 'test_collection', tensor_collection_slug: null,
    ingested_at: '2026-07-14T00:00:00.000Z',
    parser_source: null,
    seller_remaining_count: null,
    amm_fill: null,
  };
}

const EMPTY_BIDS: CollectionBidPair = { bestContextBid: null, bestUsableForValueBid: null };

/** Real SaleEvent fixture builder — same shape the parsers in
 *  src/ingestion/*-raw/parser.ts produce and hand to saleEventBus.emitSale.
 *  Used to drive the actual toSalePayload() mapper (not a hand-rolled
 *  stand-in), so these tests catch a real mapping regression. */
function mkSaleFixture(overrides: Partial<SaleEvent> & { signature: string }): SaleEvent {
  return {
    blockTime: new Date('2026-07-15T00:00:00.000Z'),
    marketplace: 'magic_eden',
    nftType: 'legacy',
    mintAddress: 'Mint11111111111111111111111111111111111',
    collectionAddress: null,
    seller: 'Seller1111111111111111111111111111111111',
    buyer: 'Buyer111111111111111111111111111111111111',
    priceLamports: 1_000_000_000n,
    priceSol: 1,
    currency: 'SOL',
    rawData: { _parser: 'me_v2_raw' },
    nftName: null,
    imageUrl: null,
    collectionName: null,
    magicEdenUrl: null,
    meCollectionSlug: null,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    ensureFresh: async () => {},
    getByCollection: () => [],
    getBestCollectionBids: async () => EMPTY_BIDS,
    getEventsByCollection: async () => [],
    ...overrides,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────

function startServer(deps: SnapshotDeps = fakeDeps()): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.get('/public/health', (_req, res) => res.json({ ok: true })); // sibling public route for regression check
  app.use('/api/internal/bots/v1', createBotApiV1Router(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: unknown; raw: string }> {
  const res = await fetch(url, { headers });
  const raw = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, body, raw };
}

function auth(key = 'test-bot-key'): Record<string, string> { return { Authorization: `Bearer ${key}` }; }

/** Reads SSE text frames off a fetch() streaming body until `predicate`
 *  matches a frame or `timeoutMs` elapses. Returns the matched frame text
 *  (raw, un-parsed) or null on timeout. Leaves the stream open — caller
 *  owns cancellation via the returned `cancel()`. */
function sseClient(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const framesSeen: string[] = [];
  let buf = '';
  let resolveWait: ((v: string | null) => void) | null = null;
  let waitPredicate: ((frame: string) => boolean) | null = null;

  const responsePromise = fetch(url, { headers, signal: controller.signal });

  async function pump() {
    const res = await responsePromise;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          framesSeen.push(frame);
          if (waitPredicate && waitPredicate(frame) && resolveWait) {
            const r = resolveWait;
            resolveWait = null; waitPredicate = null;
            r(frame);
          }
        }
      }
    } catch { /* aborted/closed */ }
  }
  void pump();

  function waitFor(predicate: (frame: string) => boolean, timeoutMs = 2000): Promise<string | null> {
    const already = framesSeen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => {
      waitPredicate = predicate;
      resolveWait = resolve;
      setTimeout(() => {
        if (resolveWait === resolve) { resolveWait = null; waitPredicate = null; resolve(null); }
      }, timeoutMs);
    });
  }

  return {
    waitFor,
    frames: framesSeen,
    cancel: () => controller.abort(),
    responsePromise,
  };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ── Suite ───────────────────────────────────────────────────────────────

async function main() {
  const ORIGINAL_KEY = process.env.BOT_API_KEY;
  const ORIGINAL_IPS = process.env.BOT_API_ALLOWED_IPS;
  const ORIGINAL_HB  = process.env.BOT_API_HEARTBEAT_MS;

  // ── 1. Missing key → 401 (fail closed even when unconfigured) ──────────
  {
    delete process.env.BOT_API_KEY;
    const { base, close } = await startServer();
    const { status: sNoHeader } = await jget(`${base}/api/internal/bots/v1/health`);
    const { status: sWithHeader } = await jget(`${base}/api/internal/bots/v1/health`, auth('anything'));
    await close();
    check('unconfigured BOT_API_KEY: no Authorization header -> 401', sNoHeader === 401, `got ${sNoHeader}`);
    check('unconfigured BOT_API_KEY: WITH a presented key still -> 401 (fail closed, no bypass)', sWithHeader === 401, `got ${sWithHeader}`);
  }

  // ── 2. Wrong key → 401; correct key → 200 ───────────────────────────────
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    const { base, close } = await startServer();
    const { status: sMissing } = await jget(`${base}/api/internal/bots/v1/health`);
    const { status: sWrong }   = await jget(`${base}/api/internal/bots/v1/health`, auth('wrong-key'));
    const { status: sRight, body } = await jget(`${base}/api/internal/bots/v1/health`, auth('test-bot-key'));
    await close();
    check('missing Authorization header -> 401', sMissing === 401, `got ${sMissing}`);
    check('wrong key -> 401', sWrong === 401, `got ${sWrong}`);
    check('correct key -> 200', sRight === 200, `got ${sRight}`);
    check('correct key: health body has apiVersion 1', (body as { apiVersion?: string })?.apiVersion === '1');
    check('correct key: health body has status ok', (body as { status?: string })?.status === 'ok');
  }

  // ── 3. IP allowlist behavior ─────────────────────────────────────────────
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    process.env.BOT_API_ALLOWED_IPS = '10.0.0.1,10.0.0.2'; // deliberately excludes 127.0.0.1
    const { base, close } = await startServer();
    const { status: sBlocked } = await jget(`${base}/api/internal/bots/v1/health`, auth());
    await close();
    check('IP not in allowlist -> 403', sBlocked === 403, `got ${sBlocked}`);

    process.env.BOT_API_ALLOWED_IPS = '127.0.0.1';
    const s2 = await startServer();
    const { status: sAllowed } = await jget(`${s2.base}/api/internal/bots/v1/health`, auth());
    await s2.close();
    check('IP in allowlist -> 200', sAllowed === 200, `got ${sAllowed}`);

    delete process.env.BOT_API_ALLOWED_IPS;
    const s3 = await startServer();
    const { status: sUnset } = await jget(`${s3.base}/api/internal/bots/v1/health`, auth());
    await s3.close();
    check('BOT_API_ALLOWED_IPS unset -> any IP allowed -> 200', sUnset === 200, `got ${sUnset}`);
  }

  // ── 4. Invalid slug → 400 ────────────────────────────────────────────────
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    let touched = false;
    const deps = fakeDeps({ ensureFresh: async () => { touched = true; } });
    const { base, close } = await startServer(deps);
    const { status: s1 } = await jget(`${base}/api/internal/bots/v1/collections/${encodeURIComponent('bad slug!')}/snapshot`, auth());
    await close();
    check('invalid slug -> 400', s1 === 400, `got ${s1}`);
    check('invalid slug: snapshot deps never touched', !touched);
  }

  // ── 5. Snapshot delegates to the real analytics functions — no reimplementation ──
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    const listings = [mkListing('a', 1), mkListing('b', 1.05), mkListing('c', 2)];
    const salesRows = [mkSaleRow('sig1', 'a')];
    const bids: CollectionBidPair = { bestContextBid: null, bestUsableForValueBid: null };
    const deps = fakeDeps({
      getByCollection: () => listings,
      getEventsByCollection: async () => salesRows,
      getBestCollectionBids: async () => bids,
    });
    const { computeFloorDepth } = await import('../../../analytics/floor-depth');
    const { computeCrossMarketGap } = await import('../../../analytics/cross-market');
    const expectedFloor  = computeFloorDepth(listings);
    const expectedCross  = computeCrossMarketGap(listings);

    const { base, close } = await startServer(deps);
    const { status, body } = await jget(`${base}/api/internal/bots/v1/collections/test_collection/snapshot`, auth());
    await close();

    const b = body as { apiVersion: string; generatedAt: string; receivedAt: string; dataVersion: string; stale: boolean; collection: { floorDepth: unknown; crossMarket: unknown; bids: unknown; recentSales: Array<{ signature: string; priceSol: string }> }; warnings: unknown[] };
    check('snapshot: 200 OK', status === 200, `got ${status}`);
    check('snapshot: apiVersion is "1"', b.apiVersion === '1');
    check('snapshot: floorDepth matches computeFloorDepth() exactly (no route-level reimplementation)', JSON.stringify(b.collection.floorDepth) === JSON.stringify(expectedFloor));
    check('snapshot: crossMarket matches computeCrossMarketGap() exactly', JSON.stringify(b.collection.crossMarket) === JSON.stringify(expectedCross));
    check('snapshot: recentSales passed through from getEventsByCollection (1 row)', b.collection.recentSales.length === 1);
    check('snapshot: recentSales priceSol stays a decimal STRING (not a float)', b.collection.recentSales[0].priceSol === '1');
    check('snapshot: stale=false on a fully-healthy fetch', b.stale === false);
    check('snapshot: generatedAt/receivedAt are both present ISO strings', typeof b.generatedAt === 'string' && typeof b.receivedAt === 'string');
  }

  // ── 6. Partial upstream failure stays fail-soft (200 + stale + warnings, never 500) ──
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    const listings = [mkListing('cached', 1)];
    const deps = fakeDeps({
      ensureFresh: async () => { throw new Error('simulated ME/Tensor timeout'); },
      getByCollection: () => listings, // store still serves last-known rows
      getBestCollectionBids: async () => { throw new Error('simulated bid-lookup failure'); },
    });
    const { base, close } = await startServer(deps);
    const { status, body } = await jget(`${base}/api/internal/bots/v1/collections/partial_outage/snapshot`, auth());
    await close();
    const b = body as { stale: boolean; collection: { bids: unknown; floorDepth: { floorSol: number | null } }; warnings: Array<{ code: string }> };
    check('partial failure: still 200, not 500', status === 200, `got ${status}`);
    check('partial failure: stale=true', b.stale === true);
    check('partial failure: floor still computed from cached rows', b.collection.floorDepth.floorSol === 1);
    check('partial failure: bids null (lookup failed, distinct from "no bids")', b.collection.bids === null);
    check('partial failure: warns listings_refresh_failed', b.warnings.some((w) => w.code === 'listings_refresh_failed'));
    check('partial failure: warns bids_lookup_failed', b.warnings.some((w) => w.code === 'bids_lookup_failed'));
  }

  // ── 6b. Timeout cannot occur — a dependency that NEVER resolves still yields a bounded response ──
  // Regression test for the 2026-07-15 hang fix: authenticated snapshot requests used to hang
  // indefinitely because ensureFresh/getBestCollectionBids transitively share unbounded-latency
  // infrastructure (listings-store.ts's global tensorFetch queue; a 90s+2-retry MMM eligibility
  // RPC read). withTimeout() now bounds every dependency individually.
  {
    // withTimeout() unit-level: rejects with DependencyTimeoutError once the deadline passes,
    // resolves normally when the real promise settles first — no false positive on the fast path.
    const neverResolves = new Promise<void>(() => {});
    const timeoutErr = await withTimeout(neverResolves, 30, 'test-dep').catch((e) => e);
    check('withTimeout: a never-resolving promise rejects with DependencyTimeoutError', timeoutErr instanceof DependencyTimeoutError);
    check('withTimeout: error message names the dependency and the deadline', (timeoutErr as Error).message.includes('test-dep') && (timeoutErr as Error).message.includes('30ms'));

    const fastResolve = withTimeout(Promise.resolve('ok'), 5_000, 'fast-dep');
    check('withTimeout: a promise that settles before the deadline resolves normally (no false-positive timeout)', await fastResolve === 'ok');

    // End-to-end through the REAL router: getEventsByCollection (cheapest budget, 8s) never
    // resolves. The whole HTTP response must still land well under that deadline plus overhead —
    // proving the fix is wired all the way from buildCollectionSnapshot up through the route
    // handler, not just reachable in isolation.
    process.env.BOT_API_KEY = 'test-bot-key';
    const listings = [mkListing('a', 1)];
    const deps = fakeDeps({
      getByCollection: () => listings,
      getEventsByCollection: () => new Promise(() => { /* never resolves — the bug's shape */ }),
    });
    const { base, close } = await startServer(deps);
    const start = Date.now();
    const { status, body } = await jget(`${base}/api/internal/bots/v1/collections/hung_dependency/snapshot`, auth());
    const elapsed = Date.now() - start;
    await close();
    const b = body as { stale: boolean; collection: { floorDepth: { floorSol: number | null } } }; const warnings = (body as { warnings: Array<{ code: string }> }).warnings;
    check('timeout: request still returns 200 (never hangs the connection)', status === 200, `got ${status}`);
    check('timeout: bounded well under the 8s recentSales deadline + overhead (elapsed < 12000ms)', elapsed < 12_000, `elapsed=${elapsed}ms`);
    check('timeout: other sections (floorDepth from the still-fast getByCollection) are unaffected', b.collection.floorDepth.floorSol === 1);
    // recentSales failures never flip `stale` (pre-existing behavior, unchanged by this fix) —
    // it's supplementary data, not core to the snapshot's primary floorDepth/crossMarket purpose.
    check('timeout: stale stays false (recentSales alone is supplementary, matches pre-existing non-timeout failure behavior)', b.stale === false);
    check('timeout: recent_sales_timeout code is present', warnings.some((w) => w.code === 'recent_sales_timeout'));
  }

  // ── 7. No NaN/Infinity / bigint serialization (json-safe.ts unit tests) ──
  {
    const dirty = { a: NaN, b: Infinity, c: -Infinity, d: 1.5, e: null, f: [NaN, 2, Infinity] };
    const safe = sanitizeForJson(dirty) as Record<string, unknown>;
    check('json-safe: NaN -> null', safe.a === null);
    check('json-safe: Infinity -> null', safe.b === null);
    check('json-safe: -Infinity -> null', safe.c === null);
    check('json-safe: finite number untouched', safe.d === 1.5);
    check('json-safe: null stays null', safe.e === null);
    check('json-safe: NaN/Infinity inside arrays also sanitized', JSON.stringify(safe.f) === JSON.stringify([null, 2, null]));

    const withBigint = { amountLamports: 123456789012345678901234567890n, nested: { x: 5n } };
    const safeBig = sanitizeForJson(withBigint) as { amountLamports: unknown; nested: { x: unknown } };
    check('json-safe: top-level bigint -> decimal string', safeBig.amountLamports === '123456789012345678901234567890');
    check('json-safe: nested bigint -> decimal string', safeBig.nested.x === '5');
    let threw = false;
    try { JSON.stringify(safeBig); } catch { threw = true; }
    check('json-safe: sanitized bigint payload JSON.stringifies without throwing', !threw);
    let rawThrew = false;
    try { JSON.stringify(withBigint); } catch { rawThrew = true; }
    check('json-safe: (control) the RAW bigint payload does throw on plain JSON.stringify — proves the sanitizer is load-bearing', rawThrew);
  }

  // ── 8+9+10+11+12. SSE: heartbeat, event delivery, disconnect cleanup, replay, resync ──
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    process.env.BOT_API_HEARTBEAT_MS = '150'; // fast heartbeat for the test
    __resetForTest();
    wireBotEventSources();

    const { base, close } = await startServer();
    const url = `${base}/api/internal/bots/v1/events`;

    // -- heartbeat --
    const c1 = sseClient(url, auth());
    const hb = await c1.waitFor((f) => f.includes('event: heartbeat'), 2000);
    check('SSE: heartbeat frame arrives within 2s of a 150ms interval', hb !== null);

    // -- event delivery --
    __publishForTest('sale', { signature: 'sigLive', mint: 'mintLive', slug: 'test_collection', priceSol: 1, marketplace: 'magic_eden', saleType: 'normal_sale', blockTime: new Date().toISOString() });
    const saleFrame = await c1.waitFor((f) => f.includes('event: sale') && f.includes('sigLive'), 2000);
    check('SSE: a published sale event is delivered to a connected client', saleFrame !== null);
    check('SSE: sale frame carries a monotonic sequence + eventId', /"sequence":\d+/.test(saleFrame ?? '') && /"eventId":"bot-\d+"/.test(saleFrame ?? ''));

    // -- disconnect cleanup --
    const beforeDisconnect = subscriberCount();
    c1.cancel();
    await sleep(200); // let the abort propagate through req/res 'close'
    const afterDisconnect = subscriberCount();
    check('SSE: subscriberCount before disconnect includes the connected client', beforeDisconnect >= 1, `got ${beforeDisconnect}`);
    check('SSE: subscriberCount drops after disconnect (listener unsubscribed, no leak)', afterDisconnect < beforeDisconnect, `before=${beforeDisconnect} after=${afterDisconnect}`);

    // -- replay with Last-Event-ID --
    const c2 = sseClient(url, auth());
    await c2.waitFor((f) => f.includes('event: heartbeat'), 2000); // ensure connected
    const lastId = /id: (bot-\d+)/.exec(saleFrame ?? '')?.[1] ?? null;
    check('replay setup: captured a real eventId from the earlier sale frame', lastId !== null, `saleFrame=${saleFrame}`);
    c2.cancel();

    __publishForTest('sale', { signature: 'sigDuringGap', mint: 'mintGap', slug: 'test_collection', priceSol: 2, marketplace: 'magic_eden', saleType: 'normal_sale', blockTime: new Date().toISOString() });

    const c3 = sseClient(`${url}?lastEventId=${encodeURIComponent(lastId ?? '')}`, auth());
    const replayed = await c3.waitFor((f) => f.includes('sigDuringGap'), 2000);
    check('SSE: reconnect with Last-Event-ID replays events published during the gap', replayed !== null);
    c3.cancel();

    // -- resync_required when replay is unavailable --
    const c4 = sseClient(`${url}?lastEventId=bot-999999`, auth());
    const resync = await c4.waitFor((f) => f.includes('event: resync_required'), 2000);
    check('SSE: an unresolvable Last-Event-ID triggers resync_required', resync !== null);
    check('SSE: resync_required payload carries the requested (unresolvable) id', (resync ?? '').includes('bot-999999'));
    c4.cancel();

    // ── 12b. v1-additive identity fields (whale-liquidation bot support) ──
    // Reuses this block's still-open server/bus wiring (wireBotEventSources()
    // was called once above) — a fresh client just for these checks.
    const c5 = sseClient(url, auth());
    await c5.waitFor((f) => f.includes('event: heartbeat'), 2000);

    type SalePayload = {
      signature: string; mint: string; slug: string | null; priceSol: number;
      marketplace: string; saleType: string; blockTime: string;
      seller: string | null; buyer: string | null;
      collectionId: string | null; collectionSlug: string | null;
      collectionAddress: string | null; collectionIdentitySource: string | null;
      ammFill: boolean | null; sellerRemainingCount: number | null;
      poolAddress: string | null; priceLamports: string; nftType: string | null;
      resizeStatus: string | null; parserReceivedAt: string | null; emittedAt: string;
    };
    type PatchPayload = { signature: string; patch: Record<string, unknown> };

    async function emitAndCapture(event: SaleEvent): Promise<SalePayload> {
      saleEventBus.emitSale(event);
      // 'event: sale\n' (not just 'event: sale') — 'sale_patch' frames would
      // otherwise also match the bare substring.
      const frame = await c5.waitFor((f) => f.includes('event: sale\n') && f.includes(event.signature), 2000);
      check(`fixture ${event.signature}: sale frame delivered`, frame !== null);
      const envelope = JSON.parse((frame ?? '').split('\ndata: ')[1] ?? '{}') as { payload: SalePayload };
      return envelope.payload;
    }

    // Tensor bid_sell with seller.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigTensorBidSell', marketplace: 'tensor',
        rawData: { _parser: 'tensor_raw', _direction: 'takeBid' },
        seller: 'TSeller1111111111111111111111111111111111', buyer: 'TBuyer111111111111111111111111111111111111',
      }));
      check('Tensor bid_sell: saleType is bid_sell', p.saleType === 'bid_sell', p.saleType);
      check('Tensor bid_sell: seller exposed', p.seller === 'TSeller1111111111111111111111111111111111');
      check('Tensor bid_sell: buyer exposed', p.buyer === 'TBuyer111111111111111111111111111111111111');
      check('Tensor bid_sell: collection unresolved on initial frame (async-only)', p.collectionId === null && p.collectionIdentitySource === null);
    }

    // Tensor Core / cNFT — seller/buyer still resolved, no merkle placeholder involved.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigTensorCnft', marketplace: 'tensor', nftType: 'cnft',
        mintAddress: 'RealCnftAssetId111111111111111111111111111',
        rawData: { _parser: 'tensor_raw', _direction: 'buy' },
      }));
      check('Tensor cNFT: seller/buyer resolved', p.seller !== null && p.buyer !== null);
      check('Tensor cNFT: mint is the real asset id, not a placeholder collection', p.mint === 'RealCnftAssetId111111111111111111111111111');
    }

    // MMM bid_sell with ammFill=false (confirmed ordinary bid acceptance).
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigMmmBidSell', marketplace: 'magic_eden_amm',
        rawData: { _parser: 'mmm_raw', _direction: 'takeBid', _ammFill: false, _ammEvidence: 'lp_fee', _lpFeeLamports: '0' },
      }));
      check('MMM bid_sell: saleType is bid_sell', p.saleType === 'bid_sell', p.saleType);
      check('MMM bid_sell: ammFill is exactly false (not null)', p.ammFill === false);
    }

    // MMM AMM pool_sale with ammFill=true (confirmed pool-inventory fill).
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigMmmPoolSale', marketplace: 'magic_eden_amm',
        rawData: { _parser: 'mmm_raw', _direction: 'fulfillBuy', _ammFill: true, _ammEvidence: 'lp_fee', _lpFeeLamports: '50000' },
      }));
      check('MMM pool_sale: saleType is pool_sale', p.saleType === 'pool_sale', p.saleType);
      check('MMM AMM pool_sale: ammFill is exactly true', p.ammFill === true);
    }

    // Normal ME sale, slug already known synchronously (mint→slug cache hit) —
    // exercises the me_slug identity tier, and doubles as the "old client
    // reading only the original 7 fields" compatibility check.
    let normalMeSig = 'sigNormalMe';
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: normalMeSig, meCollectionSlug: 'test_collection',
      }));
      check('normal ME sale: saleType is normal_sale', p.saleType === 'normal_sale', p.saleType);
      check('normal ME sale: collectionId resolves via me_slug tier (no address known yet)',
        p.collectionId === 'test_collection' && p.collectionIdentitySource === 'me_slug');
      check('normal ME sale: collectionAddress still null (never fabricated)', p.collectionAddress === null);
      const legacyOk = typeof p.signature === 'string' && typeof p.mint === 'string'
        && (typeof p.slug === 'string' || p.slug === null) && typeof p.priceSol === 'number'
        && typeof p.marketplace === 'string' && typeof p.saleType === 'string' && typeof p.blockTime === 'string';
      check('old-client compat: all 7 original v1 fields still present with original types', legacyOk);
    }

    // Initial event followed by an identity patch (async enrichment resolves
    // an on-chain collection address after the sale frame already went out).
    {
      saleEventBus.emitBotIdentityPatch({
        signature: normalMeSig, collectionAddress: 'CollAddr1111111111111111111111111111111111',
        meCollectionSlug: 'test_collection', tensorCollectionSlug: null,
      });
      const frame = await c5.waitFor((f) => f.includes('event: sale_patch') && f.includes(normalMeSig), 2000);
      check('identity patch: sale_patch frame delivered, correlated by signature', frame !== null);
      const envelope = JSON.parse((frame ?? '').split('\ndata: ')[1] ?? '{}') as { eventType: string; payload: PatchPayload };
      check('identity patch: eventType is sale_patch', envelope.eventType === 'sale_patch');
      check('identity patch: address wins over slug (onchain_collection_address precedence)',
        envelope.payload?.patch?.collectionAddress === 'CollAddr1111111111111111111111111111111111'
        && envelope.payload?.patch?.collectionIdentitySource === 'onchain_collection_address'
        && envelope.payload?.patch?.collectionId === 'CollAddr1111111111111111111111111111111111');
    }

    // Seller-remaining-count patch (fast, signature-correlatable path).
    {
      saleEventBus.emitBotSellerCountPatch({ signature: normalMeSig, count: 7 });
      const frame = await c5.waitFor((f) => f.includes('event: sale_patch') && f.includes('sellerRemainingCount'), 2000);
      check('seller-count patch: delivered with correct count', frame !== null && frame.includes('"sellerRemainingCount":7'));
    }

    // Genuinely unresolved identity — no address/slug resolved at all.
    // Must NOT publish a no-op sale_patch (would waste a bot's bandwidth /
    // falsely imply something changed).
    {
      const before = /"sequence":(\d+)/.exec(c5.frames[c5.frames.length - 1] ?? '')?.[1];
      saleEventBus.emitBotIdentityPatch({ signature: 'sigNeverResolved', collectionAddress: null, meCollectionSlug: null, tensorCollectionSlug: null });
      saleEventBus.emitBotSellerCountPatch({ signature: 'sigNeverResolved', count: null });
      const frame = await c5.waitFor((f) => f.includes('sigNeverResolved'), 500);
      check('genuinely unresolved identity: no sale_patch published for an all-null resolution', frame === null, `before seq=${before}`);
    }

    // No merkle-tree misattribution — me_cnft_raw's collectionAddress is a
    // Bubblegum tree, not a real collection group, and must never surface.
    {
      const merkleTree = 'MerkleTree11111111111111111111111111111111';
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigMeCnftMerkle', nftType: 'cnft',
        mintAddress: merkleTree, collectionAddress: merkleTree,
        rawData: { _parser: 'me_cnft_raw', _instruction: 'buy_now' },
      }));
      check('no merkle-tree misattribution: collectionAddress excluded despite event.collectionAddress being set',
        p.collectionAddress === null);
      check('no merkle-tree misattribution: collectionId excluded too', p.collectionId === null);
    }

    // ── MMM pool sniper fields (2026-07-16) ─────────────────────────────
    // verified solFulfillBuy with poolAddress.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigSolFulfillBuyPool', marketplace: 'magic_eden_amm',
        buyer: 'PoolOwner11111111111111111111111111111111',
        poolAddress: 'PoolAccount111111111111111111111111111111',
        rawData: { _parser: 'mmm_raw', _instruction: 'solFulfillBuy', _direction: 'fulfillBuy' },
      }));
      check('solFulfillBuy: poolAddress passed through', p.poolAddress === 'PoolAccount111111111111111111111111111111');
    }

    // verified solMip1FulfillBuy with poolAddress.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigSolMip1FulfillBuyPool', marketplace: 'magic_eden_amm', nftType: 'pnft',
        poolAddress: 'PoolAccount222222222222222222222222222222',
        rawData: { _parser: 'mmm_raw', _instruction: 'solMip1FulfillBuy', _direction: 'fulfillBuy' },
      }));
      check('solMip1FulfillBuy: poolAddress passed through', p.poolAddress === 'PoolAccount222222222222222222222222222222');
    }

    // verified coreFulfillBuy with poolAddress.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigCoreFulfillBuyPool', marketplace: 'magic_eden_amm', nftType: 'core',
        poolAddress: 'PoolAccount333333333333333333333333333333',
        rawData: { _parser: 'mmm_raw', _instruction: 'coreFulfillBuy', _direction: 'fulfillBuy' },
      }));
      check('coreFulfillBuy: poolAddress passed through', p.poolAddress === 'PoolAccount333333333333333333333333333333');
    }

    // unsupported coreFulfillBuyV2 — parser leaves SaleEvent.poolAddress
    // null/undefined for this variant (see pool-address-coverage.test.ts
    // for why); this checks the MAPPER doesn't fabricate one either, and
    // critically that it does NOT fall back to buyer even though buyer is
    // a real, non-null value on this same event.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigCoreFulfillBuyV2NoPool', marketplace: 'magic_eden_amm', nftType: 'core',
        buyer: 'PoolOwner44444444444444444444444444444444',
        poolAddress: null,
        rawData: { _parser: 'mmm_raw', _instruction: 'coreFulfillBuyV2', _direction: 'fulfillBuy' },
      }));
      check('coreFulfillBuyV2 (unsupported): poolAddress is null', p.poolAddress === null);
      check('no buyer→poolAddress fallback: poolAddress is NOT the buyer wallet even though buyer is set',
        p.poolAddress !== 'PoolOwner44444444444444444444444444444444' && p.buyer === 'PoolOwner44444444444444444444444444444444');
    }

    // exact priceLamports string, including a value unsafe for JS integer
    // precision (> Number.MAX_SAFE_INTEGER).
    {
      const unsafeLamports = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2, odd (float would round it)
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigUnsafeLamports',
        priceLamports: unsafeLamports, priceSol: Number(unsafeLamports) / 1e9,
      }));
      check('priceLamports: exact bigint decimal string', p.priceLamports === '9007199254740993', p.priceLamports);
      check('priceLamports: precision survives beyond Number.MAX_SAFE_INTEGER (would corrupt as a JS number)',
        p.priceLamports === unsafeLamports.toString());
    }

    // nftType mapping — exact wire casing for each SaleEvent.nftType value.
    {
      for (const nftType of ['legacy', 'pnft', 'core', 'metaplex_core', 'cnft'] as const) {
        const p = await emitAndCapture(mkSaleFixture({ signature: `sigNftType_${nftType}`, nftType }));
        check(`nftType mapping: '${nftType}' passed through verbatim`, p.nftType === nftType, p.nftType ?? 'null');
      }
    }

    // resizeStatus — initial frame already resolved (synchronous cache hit,
    // e.g. second sale of the same mint — see insert.ts's getCachedResizeStatus).
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigResizeKnown', resizeStatus: 'metaplex_resized_unclaimed',
      }));
      check('resizeStatus: already-known value included on the initial frame', p.resizeStatus === 'metaplex_resized_unclaimed');
    }

    // resizeStatus — unresolved on the initial frame, arrives later via
    // sale_patch (existing signature-correlated architecture, reusing the
    // same ResizeStatusPatch bus event the public resize_status SSE uses).
    {
      const p = await emitAndCapture(mkSaleFixture({ signature: 'sigResizePending' }));
      check('resizeStatus: null on initial frame when unresolved', p.resizeStatus === null);
      saleEventBus.emitResizeStatusPatch({
        signature: 'sigResizePending', mint: 'Mint11111111111111111111111111111111111',
        resizeStatus: 'metaplex_resized_unclaimed',
      });
      const frame = await c5.waitFor((f) => f.includes('event: sale_patch') && f.includes('sigResizePending'), 2000);
      check('resizeStatus patch: sale_patch frame delivered, correlated by signature', frame !== null);
      check('resizeStatus patch: carries the resolved value', (frame ?? '').includes('"resizeStatus":"metaplex_resized_unclaimed"'));
    }

    // Timestamps — ISO strings, and emittedAt is not earlier than
    // parserReceivedAt when both exist (parserReceivedAt happens strictly
    // before the Bot API mapper runs, which is where emittedAt is stamped).
    {
      const parserReceivedAt = new Date(Date.now() - 1500); // simulate 1.5s parse-to-emit gap
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigTimestamps', parserReceivedAt,
        rawData: { _parser: 'mmm_raw', _instruction: 'solFulfillBuy', _direction: 'fulfillBuy' },
      }));
      const parserReceivedAtValid = p.parserReceivedAt !== null && !Number.isNaN(Date.parse(p.parserReceivedAt));
      const emittedAtValid = !Number.isNaN(Date.parse(p.emittedAt));
      check('parserReceivedAt is a valid ISO string', parserReceivedAtValid, p.parserReceivedAt ?? 'null');
      check('emittedAt is a valid ISO string', emittedAtValid, p.emittedAt);
      check('emittedAt is not earlier than parserReceivedAt',
        parserReceivedAtValid && emittedAtValid && Date.parse(p.emittedAt) >= Date.parse(p.parserReceivedAt as string));
    }

    // parserReceivedAt null for a sale that never went through me-raw/parser.ts.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigNoParserTimestamp', marketplace: 'tensor',
        rawData: { _parser: 'tensor_raw', _direction: 'buy' },
      }));
      check('parserReceivedAt is null for a non-me-raw sale', p.parserReceivedAt === null);
    }

    // old clients reading only the original fields remain compatible — the
    // 6 new fields are pure additions, verified by re-checking the exact
    // same 7-field legacy contract this suite already asserts above still
    // holds on an event that ALSO carries every new field.
    {
      const p = await emitAndCapture(mkSaleFixture({
        signature: 'sigOldClientCompatV2', poolAddress: 'PoolAccount555555555555555555555555555555',
        resizeStatus: 'none',
        rawData: { _parser: 'mmm_raw', _instruction: 'solFulfillBuy', _direction: 'fulfillBuy' },
      }));
      const legacyOk = typeof p.signature === 'string' && typeof p.mint === 'string'
        && (typeof p.slug === 'string' || p.slug === null) && typeof p.priceSol === 'number'
        && typeof p.marketplace === 'string' && typeof p.saleType === 'string' && typeof p.blockTime === 'string';
      check('old-client compat (v2 fields present): original 7 fields unaffected', legacyOk);
    }

    c5.cancel();
    await close();
    __resetForTest();
  }

  // ── 13. Rate limiting (own limiter, own budget) ─────────────────────────
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    const { base, close } = await startServer();
    let sawLimitHeader = false;
    let saw429 = false;
    for (let i = 0; i < 130 && !saw429; i++) {
      const { status, headers } = await jget(`${base}/api/internal/bots/v1/health`, auth());
      if (headers.get('x-ratelimit-limit') === '120') sawLimitHeader = true;
      if (status === 429) saw429 = true;
    }
    await close();
    check('rate limit: X-RateLimit-Limit=120 header present (own budget, matches router config)', sawLimitHeader);
    check('rate limit: exceeding the budget within the window eventually yields 429', saw429);
  }

  // ── 14. No public route regression — sibling route on the same app is unaffected ──
  {
    process.env.BOT_API_KEY = 'test-bot-key';
    const { base, close } = await startServer();
    const { status: pubStatus, body: pubBody } = await jget(`${base}/public/health`); // no auth header at all
    await close();
    check('public route: unauthenticated request to a sibling route still succeeds (bot auth is router-scoped, not global)', pubStatus === 200, `got ${pubStatus}`);
    check('public route: body unaffected', (pubBody as { ok?: boolean })?.ok === true);
  }

  if (ORIGINAL_KEY === undefined) delete process.env.BOT_API_KEY; else process.env.BOT_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_IPS === undefined) delete process.env.BOT_API_ALLOWED_IPS; else process.env.BOT_API_ALLOWED_IPS = ORIGINAL_IPS;
  if (ORIGINAL_HB === undefined) delete process.env.BOT_API_HEARTBEAT_MS; else process.env.BOT_API_HEARTBEAT_MS = ORIGINAL_HB;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
