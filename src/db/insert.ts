import { getPool } from './client';
import { SaleEvent, CNFT_MIN_PRICE_LAMPORTS } from '../models/sale-event';
import { saleEventBus } from '../events/emitter';
import { enrich } from '../enrichment/enrich';
import { scheduleImageRetry } from '../enrichment/image-retry';
import { isBlacklistedCollection } from './blacklist';
import { isMintBlocked, markMintBlocked } from './blocked-mint-cache';
import { checkPricingAlerts } from '../alerts/alerts';
import { trace } from '../trace';
import { saleTypeFromEvent, isMerkleTreeCollectionAddress } from '../domain/sale-event-adapters';
import { logSellerNetDiff, logSellerNetAudit, logAmmSellPriceMode } from '../ingestion/seller-net';
import { slugForMint, nameForMint } from '../server/listings-store';
import { getSseClientCount } from '../server/sse';
import { enqueueResizeLookup, getCachedResizeStatus } from '../mints/resize-status-resolver';
import { enqueuePoolTypeLookup, getCachedPoolType } from '../ingestion/mmm-pool-type-resolver';
import { getMintedAt } from '../mints/fresh-mint-cache';

/** Sentinel: an event whose price is below the cNFT floor — used by both
 *  insert and patchSaleEventRaw to gate emission and remove already-emitted
 *  rows when later raw-parsing reveals the true nft_type. */
function isCnftBelowMin(event: SaleEvent): boolean {
  return event.nftType === 'cnft' && event.priceLamports <= CNFT_MIN_PRICE_LAMPORTS;
}

// ─── Frame-identity debug (flash investigation) ───────────────────────────────
// Proves whether the FIRST `sale` frame carries collection identity by
// correlating it against the later `meta` frame for a target collection.
// Needles (lowercased, matched against collectionName/slug) come from
// FEED_FRAME_DEBUG (comma-list). Default targets "The Misfits Order" so the
// active test captures with no config. Empty env disables. Bounded ring.
const FRAME_DEBUG_NEEDLES = (process.env.FEED_FRAME_DEBUG ?? 'misfits')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
interface EmitFrameSnapshot { collectionAddress: string | null; meCollectionSlug: string | null; mintAddress: string; }
const recentEmitFrames = new Map<string, EmitFrameSnapshot>();
const FRAME_DEBUG_MAX = 800;
function recordEmitFrame(sig: string, snap: EmitFrameSnapshot): void {
  if (FRAME_DEBUG_NEEDLES.length === 0) return;
  recentEmitFrames.set(sig, snap);
  if (recentEmitFrames.size > FRAME_DEBUG_MAX) {
    const drop = recentEmitFrames.size - FRAME_DEBUG_MAX;
    const it = recentEmitFrames.keys();
    for (let i = 0; i < drop; i++) { const k = it.next().value; if (k) recentEmitFrames.delete(k); }
  }
}
function logFrameDebugOnMeta(meta: {
  signature: string; collectionName: string | null; meCollectionSlug: string | null;
  mintAddress: string; nftName: string | null; collectionAddress: string | null;
}): void {
  if (FRAME_DEBUG_NEEDLES.length === 0) return;
  const hay = `${meta.collectionName ?? ''} ${meta.meCollectionSlug ?? ''}`.toLowerCase();
  if (!FRAME_DEBUG_NEEDLES.some(n => hay.includes(n))) return;
  const f = recentEmitFrames.get(meta.signature);
  console.log(
    `[feed/frame-debug] sig=${meta.signature.slice(0, 16)} ` +
    `SALE_FRAME{ collName=null collAddr=${f?.collectionAddress ?? 'null'} ` +
    `slug=${f?.meCollectionSlug ?? 'null'} mint=${f?.mintAddress ?? '?'} nftName=null } ` +
    `META_FRAME{ collName=${JSON.stringify(meta.collectionName)} ` +
    `collAddr=${meta.collectionAddress ?? 'null'} slug=${meta.meCollectionSlug ?? 'null'} ` +
    `mint=${meta.mintAddress} nftName=${JSON.stringify(meta.nftName)} } ` +
    `=> first_frame_had_identity=${!!(f?.collectionAddress || f?.meCollectionSlug)}`,
  );
  recentEmitFrames.delete(meta.signature);
}

// ─── Deferred-emit config (blacklist first-sighting flash) ────────────────────
// OFF by default: when FEED_DEFER_BLACKLIST is not 'true'/'1', the emit path is
// byte-identical to immediate emit and adds zero latency. When ON, a sale whose
// FIRST frame has no collection identity (never-seen mint: nameForMint AND
// slugForMint both null) is held up to FEED_DEFER_BUDGET_MS while the EXISTING
// enrich(event) call (no new RPC) races a timeout — long enough to drop a
// permanent-blacklisted collection before it ever paints, or to emit an
// already-named frame the frontend FEED blacklist can filter. Timeout / cap /
// error all fall back to today's immediate emit (fail-soft).
const DEFER_ENABLED  = process.env.FEED_DEFER_BLACKLIST === 'true' || process.env.FEED_DEFER_BLACKLIST === '1';
const DEFER_BUDGET_MS = Math.min(700, Math.max(300, Number(process.env.FEED_DEFER_BUDGET_MS) || 500));
const DEFER_MAX_INFLIGHT = Math.max(1, Number(process.env.FEED_DEFER_MAX_INFLIGHT) || 24);
const DEFER_DEBUG = process.env.FEED_DEFER_DEBUG === '1';
let deferInflight = 0;
let deferSkipLog  = 0;
/** Per-event lifecycle log — silent unless FEED_DEFER_DEBUG=1 (avoids spam). */
function dlog(msg: string): void { if (DEFER_DEBUG) console.log(msg); }


// ─── Raw-data patch (fast-path → raw-parse correction) ────────────────────────

const PATCH_RAW_SQL = `
  UPDATE sale_events
  SET seller = $2, buyer = $3, marketplace = $4, nft_type = $5, raw_data = $6,
      price_lamports = $7, price_sol = $8
  WHERE signature = $1
`;

/**
 * Persist the resolved seller-remaining-count for a sale (migration 015,
 * column `seller_remaining_count`). Called fire-and-forget from the
 * seller_count SSE resolution path so the SELL badge is server-authoritative
 * and consistent across devices/reloads — not just the browser that happened
 * to see the live frame.
 *
 * MUST NOT throw or block: the caller `void`s this and the SSE emit proceeds
 * regardless. DB errors are swallowed with a warn (the live SSE frame + the
 * per-browser localStorage fallback still cover the immediate render). No-op
 * for non-finite counts or a missing signature.
 */
export async function updateSellerRemainingCount(
  signature: string,
  count: number,
): Promise<void> {
  if (!signature || typeof count !== 'number' || !Number.isFinite(count)) return;
  try {
    await getPool().query(
      'UPDATE sale_events SET seller_remaining_count = $1 WHERE signature = $2',
      [count, signature],
    );
  } catch (err) {
    console.warn(
      `[seller-count-persist] UPDATE failed sig=${signature.slice(0, 12)}… count=${count}:`,
      err,
    );
  }
}

/**
 * Running-holdings counter DB primitives (migration 021, table
 * `seller_holdings`). All three are atomic single-statement SQL operations
 * — no read-then-write race window, no explicit transaction/row-lock
 * needed, and safe even if this backend were ever scaled to multiple
 * processes (currently it isn't — see CLAUDE.md "Single-process SSE" —
 * but these don't depend on that fact for correctness).
 *
 * Semantics owned by the caller (`seller-holdings.ts`):
 *   - `atomicDecrementSellerHolding` is the hot path: one row-locked
 *     UPDATE, no RPC. Concurrent calls for the SAME (seller, collection)
 *     are serialized by Postgres at the row level, so concurrent sales
 *     each get a distinct, correctly-descending `count`.
 *   - `seedSellerHolding` is used exactly once per (seller, collection) —
 *     the first sale ever observed for that pair. `ON CONFLICT DO NOTHING`
 *     means at most one concurrent caller "wins" the seed; everyone else
 *     gets 0 rows back and must fall through to a real decrement instead
 *     (see seller-holdings.ts's `firstSightScanAndSeed`) so their sale
 *     doesn't reuse the winner's exact number.
 *   - `overwriteSellerHolding` is the reconciliation write: an
 *     authoritative absolute value from a fresh DAS scan, used to correct
 *     drift (see seller-holdings.ts's reconciliation policy). Resets
 *     `decrements_since_scan` to 0.
 */
export interface SellerHoldingRow {
  count:               number;
  decrementsSinceScan: number;
  /** Timestamp the row carried BEFORE this decrement (i.e. how long it had
   *  been sitting since its last write) — used for TTL staleness checks.
   *  NOT the post-decrement `now()` this same statement just set. */
  prevUpdatedAtMs:      number;
}

export async function atomicDecrementSellerHolding(
  seller: string,
  collection: string,
): Promise<SellerHoldingRow | null> {
  try {
    // The `old` CTE takes the row lock and captures its PRE-update
    // `updated_at` in the same statement/transaction as the UPDATE that
    // follows — `RETURNING` on an UPDATE always reflects POST-update
    // values, so reading `updated_at` directly off the UPDATE (instead of
    // via this CTE) would return the `now()` this very statement just
    // wrote, making any TTL-staleness check against it always false.
    const res = await getPool().query<{ count: number; decrements_since_scan: number; prev_updated_at: Date }>(
      `WITH old AS (
         SELECT updated_at FROM seller_holdings
          WHERE seller = $1 AND collection_address = $2
          FOR UPDATE
       )
       UPDATE seller_holdings AS sh
          SET count = GREATEST(sh.count - 1, 0),
              decrements_since_scan = sh.decrements_since_scan + 1,
              updated_at = now()
         FROM old
        WHERE sh.seller = $1 AND sh.collection_address = $2
        RETURNING sh.count, sh.decrements_since_scan, old.updated_at AS prev_updated_at`,
      [seller, collection],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      count:               row.count,
      decrementsSinceScan: row.decrements_since_scan,
      prevUpdatedAtMs:     row.prev_updated_at.getTime(),
    };
  } catch (err) {
    console.warn(`[seller-holdings-persist] atomic decrement failed seller=${seller.slice(0, 8)}…:`, err);
    return null;
  }
}

export async function seedSellerHolding(
  seller: string,
  collection: string,
  count: number,
): Promise<number | null> {
  try {
    const res = await getPool().query<{ count: number }>(
      `INSERT INTO seller_holdings (seller, collection_address, count, decrements_since_scan, updated_at)
       VALUES ($1, $2, $3, 0, now())
       ON CONFLICT (seller, collection_address) DO NOTHING
       RETURNING count`,
      [seller, collection, count],
    );
    return res.rows[0]?.count ?? null;
  } catch (err) {
    console.warn(`[seller-holdings-persist] seed failed seller=${seller.slice(0, 8)}… count=${count}:`, err);
    return null;
  }
}

export async function overwriteSellerHolding(
  seller: string,
  collection: string,
  count: number,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO seller_holdings (seller, collection_address, count, decrements_since_scan, updated_at)
       VALUES ($1, $2, $3, 0, now())
       ON CONFLICT (seller, collection_address)
       DO UPDATE SET count = $3, decrements_since_scan = 0, updated_at = now()`,
      [seller, collection, count],
    );
  } catch (err) {
    console.warn(`[seller-holdings-persist] reconcile overwrite failed seller=${seller.slice(0, 8)}… count=${count}:`, err);
  }
}

/**
 * Update a previously fast-path-inserted event with corrected raw-parser data.
 * Emits a `rawpatch` SSE event so connected clients update their cards.
 *
 * Late cNFT discard: the helius/transfer fast paths label everything as
 * 'legacy', so a cNFT sale below the 0.002 SOL floor slips through the
 * parse-time filter and only gets its true nftType assigned here. When that
 * happens we delete the row and emit `remove` so any client that already
 * rendered the card drops it.
 */
export async function patchSaleEventRaw(event: SaleEvent): Promise<void> {
  const pool = getPool();
  if (isCnftBelowMin(event)) {
    await pool.query('DELETE FROM sale_events WHERE signature = $1', [event.signature]);
    saleEventBus.emitRemove(event.signature);
    console.log(`[cnft-min] removed (post-patch)  price=${event.priceSol} sig=${event.signature.slice(0, 12)}...`);
    return;
  }
  await pool.query(PATCH_RAW_SQL, [
    event.signature,
    event.seller,
    event.buyer,
    event.marketplace,
    event.nftType,
    JSON.stringify(event.rawData),
    event.priceLamports.toString(),
    event.priceSol,
  ]);
  saleEventBus.emitRawPatch({
    signature:   event.signature,
    seller:      event.seller,
    buyer:       event.buyer,
    marketplace: event.marketplace,
    nftType:     event.nftType,
    saleType:    saleTypeFromEvent(event),
    priceSol:    event.priceSol,
  });
}

// NOTE: `sale_type` is deliberately NOT in this column list. Classification is
// derived at read time from raw_data via deriveSaleType (db/queries.ts
// applySaleType / sse.ts) so it always matches live SSE; the raw column stays at
// its legacy DEFAULT 'list_buy' and is never read. Don't start writing it here
// without updating every reader (they currently ignore the column).
const INSERT_SQL = `
  INSERT INTO sale_events
    (signature, block_time, marketplace, nft_type, mint_address, collection_address,
     seller, buyer, price_lamports, price_sol, currency, raw_data,
     nft_name, image_url, collection_name, magic_eden_url)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (signature) DO NOTHING
  RETURNING id
`;

const UPDATE_META_SQL = `
  UPDATE sale_events
  SET nft_name = $2, image_url = $3, collection_name = $4, collection_address = $5,
      mint_address = $6, me_collection_slug = $7, floor_delta = $8,
      tensor_collection_slug = $9,
      -- Freezes the FRESH MINT badge fact at enrichment time (± a few
      -- seconds of the sale), same permanence contract as floor_delta above.
      -- Stored in raw_data (no migration) under a reserved '_mintedAtMs' key
      -- so a later re-read never re-evaluates "is it still <4h old" against
      -- the CURRENT time — see fresh-mint-cache.ts / events-router.ts.
      raw_data = raw_data || jsonb_build_object('_mintedAtMs', $10::bigint)
  WHERE signature = $1
`;

export async function insertSaleEvent(event: SaleEvent): Promise<string | null> {
  // Defensive cNFT-floor gate. Parsers in helius/parser.ts and
  // tensor-raw/parser.ts (TComp branch) already enforce this, but the fast
  // paths (tensor_helius_fast / me_helius_fast / *_xfer_fast) build SaleEvents
  // directly without a parse-time check. Catching it here guarantees no row is
  // ever written with nftType='cnft' below the floor.
  if (isCnftBelowMin(event)) {
    console.log(`[cnft-min] dropped at insert  price=${event.priceSol} sig=${event.signature.slice(0, 12)}...`);
    return null;
  }

  // Pre-emit blacklist gate. Three layers, cheapest first — none of these
  // require an RPC call. The aim is to avoid the ~10 s "Unknown #?" flash
  // for sales whose collection identity is knowable at parse time:
  //
  //   1. Repeat-sale cache hit — `blocked-mint-cache.ts` was populated by
  //      the post-enrichment gate on a prior sale of THIS mintAddress.
  //   2. Per-mint slug already learned — `slugForMint(mintAddress)` returns
  //      the slug from the in-process mint→slug index (populated from
  //      DB preload + live `meta` updates) so blacklisted slugs/substrings
  //      are caught for any mint we've seen before.
  //   3. Parser-supplied identifiers — same as before: collectionAddress
  //      or meCollectionSlug provided directly by the parser.
  //
  // Brand-new mints in a brand-new blacklisted collection are NOT covered
  // here (no prior data exists); the existing post-enrichment gate still
  // catches them ~5 s later via DAS/ME and seeds layers 1 + 2 for next time.
  const cachedReason = isMintBlocked(event.mintAddress);
  if (cachedReason) {
    console.log(
      `[feed/blacklist-preemit] reason=${cachedReason} ` +
      `mint=${event.mintAddress} sig=${event.signature.slice(0, 12)}...`,
    );
    return null;
  }
  const preEmitSlug = event.meCollectionSlug ?? slugForMint(event.mintAddress);
  // Name learned from a prior enrichment of THIS mint — lets the name-based
  // blacklist (NAME_BLACKLIST / substring) drop a known collection pre-emit,
  // not just the slug/address layers. Null for never-seen mints.
  const preEmitName = nameForMint(event.mintAddress);
  if (isBlacklistedCollection({
    collectionAddress: event.collectionAddress,
    meCollectionSlug:  preEmitSlug,
    collectionName:    preEmitName,
    signature:         event.signature,
    mintAddress:       event.mintAddress,
  })) {
    console.log(
      `[feed/blacklist-preemit] reason=collection_match ` +
      `mint=${event.mintAddress} sig=${event.signature.slice(0, 12)}... ` +
      `addr=${(event.collectionAddress ?? preEmitSlug ?? '?').slice(0, 24)}`,
    );
    // Seed the cache too so subsequent re-sales of this mint short-circuit
    // at layer 1 even if the mint→slug index ever evicts the entry.
    markMintBlocked(event.mintAddress, 'collection_match');
    return null;
  }

  // Tensor cNFT sales have their assetId derived locally in the tensor-raw
  // parser from the Bubblegum `transfer` inner CPI (see extractCnftAssetId).
  // When that derivation fails, mintAddress stays '' — enrichment's empty-mint
  // short-circuit skips downstream lookups for that row, same as before.
  const magicEdenUrl = `https://magiceden.io/item-details/${event.mintAddress}`;
  const pool = getPool();

  console.log(`INSERT_DEBUG_BEFORE_DB ${event.signature}`);

  // Insert immediately with null metadata so we can emit SSE without waiting for enrichment.
  const result = await pool.query(INSERT_SQL, [
    event.signature,
    event.blockTime,
    event.marketplace,
    event.nftType,
    event.mintAddress,
    event.collectionAddress,   // parser-level value; may be null for raw paths
    event.seller,
    event.buyer,
    event.priceLamports.toString(),
    event.priceSol,
    event.currency,
    JSON.stringify(event.rawData),
    null,           // nft_name  — filled in by background enrichment
    null,           // image_url — filled in by background enrichment
    null,           // collection_name
    magicEdenUrl,
  ]);

  const id = result.rows[0]?.id ?? null;
  if (!id) {
    console.log(`INSERT_DEBUG_SKIPPED ${event.signature} duplicate_signature`);
    console.log(`DEDUPE_DEBUG_SKIP ${event.signature} duplicate_signature`);
    return null;   // duplicate signature — already processed
  }

  console.log(`INSERT_DEBUG_AFTER_DB ${event.signature}`);

  // Step 5 — row inserted into sale_events.
  trace(event.signature, 'db:inserted', `id=${id}`);

  // Emit immediately so the frontend card appears at once.
  // Fill `meCollectionSlug` synchronously from the in-process mintToSlug map
  // when available — otherwise the frontend's Collection page filter
  // (`b.meCollectionSlug !== slug`) drops every live sale until enrichment
  // catches up via `meta`. Falls back to the event's own slug (usually
  // undefined) then null.
  const resolvedSlug = event.meCollectionSlug ?? slugForMint(event.mintAddress);
  // Stamp the collection name from cache (mint seen before) onto the FIRST
  // frame so the render-layer blacklist — the user FEED list is keyed by
  // NAME — can drop a known blacklisted collection with no flash. Stays null
  // for never-seen mints (enrichment fills it via the later `meta` frame).
  const resolvedName = nameForMint(event.mintAddress);
  const blockAgeSec = ((Date.now() - event.blockTime.getTime()) / 1000).toFixed(1);
  console.log(`[sse] emit  sig=${event.signature.slice(0, 12)}  blockAge=${blockAgeSec}s  slug=${resolvedSlug ?? 'null'}  clients=${getSseClientCount()}`);
  // Sampled debug: log when seller-net differs from gross (1st + every 25th).
  // Includes mint + seller so the operator can paste these into ME's UI
  // (item page / wallet activities) for direct ground-truth verification.
  logSellerNetDiff({
    signature:         event.signature,
    marketplace:       event.marketplace,
    priceLamports:     event.priceLamports,
    sellerNetLamports: event.sellerNetLamports,
    mint:              event.mintAddress,
    seller:            event.seller,
  });
  // Per-saleType audit so each path's behaviour is visible independently
  // (fixes the "LIST_BUY shows gross" investigation — if those rows show
  // fallback=true the seller wallet isn't in accountKeys and we need to
  // patch seller detection on the parser side; if fallback=false but
  // net == gross, the auction-house simply didn't deduct from the seller).
  logSellerNetAudit({
    signature:         event.signature,
    saleType:          saleTypeFromEvent(event),
    marketplace:       event.marketplace,
    priceLamports:     event.priceLamports,
    sellerNetLamports: event.sellerNetLamports,
    mint:              event.mintAddress,
    seller:            event.seller,
  });
  // AMM_SELL only — sampled mirror of what the per-user "Inclusive fees"
  // toggle will surface in the UI. Useful for spot-checking pool-sale
  // gross vs. seller-net realism across MMM and TAMM.
  if (saleTypeFromEvent(event) === 'pool_sale') {
    logAmmSellPriceMode({
      signature:         event.signature,
      priceLamports:     event.priceLamports,
      sellerNetLamports: event.sellerNetLamports,
      mint:              event.mintAddress,
      seller:            event.seller,
    });
  }
  // Targeted one-shot debug for a specific signature under investigation
  // (price mismatch: UI showed ~0.018 vs listing 0.0125 — see
  // src/ingestion/me-raw/parser.ts "Price selection" block for the fix).
  // Always logs both the OFF (default) and ON branches of the inclusive-fees
  // toggle so the displayed value can be eyeballed against the listing.
  if (event.signature === '5xh4fVqsq5ErmsHz9a9HqJBkWKpWYCWjK4nnPwMTPRjktUbni5v9fUC7Z7jLH2wssvzqydbsizPHectAM1Y4FbeP') {
    const saleType  = saleTypeFromEvent(event);
    const grossSol  = Number(event.priceLamports) / 1e9;
    const netSol    = event.sellerNetLamports != null ? Number(event.sellerNetLamports) / 1e9 : null;
    // Mirror frontend `displayPrice()` semantics in price-mode.ts:
    //   pool_sale + ON  → gross
    //   pool_sale + OFF → sellerNet ?? gross
    //   bid_sell        → gross
    //   anything else   → sellerNet ?? gross   (= event.priceSol effectively)
    const dpOff = saleType === 'pool_sale'
      ? (netSol ?? grossSol)
      : saleType === 'bid_sell'
        ? grossSol
        : (netSol ?? grossSol);
    const dpOn  = saleType === 'pool_sale' ? grossSol : dpOff;
    console.log(
      `[price-trace/5xh4] sig=${event.signature}  saleType=${saleType}  ` +
      `marketplace=${event.marketplace}  ` +
      `grossSol=${grossSol.toFixed(6)}  netSol=${netSol != null ? netSol.toFixed(6) : 'null'}  ` +
      `displayPriceOFF=${dpOff.toFixed(6)}  displayPriceON=${dpOn.toFixed(6)}  ` +
      `seller=${event.seller}  buyer=${event.buyer}  mint=${event.mintAddress}`,
    );
  }
  // Stamp the sale frame with any already-cached resize-status — covers
  // the second-sale-of-same-mint case where the resolver has already
  // resolved this mint. Misses still go out as undefined and are
  // patched later via the `resize_status` SSE event.
  const cachedResize = event.mintAddress ? getCachedResizeStatus(event.mintAddress) : null;
  // AMM badge classification — fresh cache hit only (stale/missing stays
  // null and is patched later via the `pool_type` SSE event, same
  // sync-hit/async-patch shape as resize-status above).
  const cachedPoolType = event.poolAddress ? getCachedPoolType(event.poolAddress) : null;

  // Emits the first `sale` frame. The immediate/timeout paths pass the cached
  // name/slug (often null); the deferred enrich-win path passes the resolved
  // identity + image so the very first frame is already filterable/named.
  const emitSaleFrame = (frameName: string | null, frameSlug: string | null, frameImage: string | null): void => {
    recordEmitFrame(event.signature, {
      collectionAddress: event.collectionAddress,
      meCollectionSlug:  frameSlug,
      mintAddress:       event.mintAddress,
    });
    saleEventBus.emitSale({
      ...event,
      nftName: null,
      imageUrl: frameImage,
      collectionName: frameName,
      magicEdenUrl,
      meCollectionSlug: frameSlug,
      resizeStatus: cachedResize ?? undefined,
      poolType: cachedPoolType ?? undefined,
      // FRESH-badge timestamp — a plain in-memory Map lookup (no I/O), so
      // it's correct on the very first frame rather than waiting for the
      // async enrich() patch below. See fresh-mint-cache.ts.
      mintedAtMs: getMintedAt(event.mintAddress),
    });
    trace(event.signature, 'sse:emitted', `blockAge=${blockAgeSec}s`);
  };

  // Applies a resolved enrichment result. Self-contained + fail-soft: never
  // throws. `alreadyEmitted` controls whether a blacklist hit must also tell
  // clients to drop an already-painted card (immediate/timeout paths) vs. a
  // deferred suppression where the frame was never emitted.
  const applyEnrichment = async (enriched: SaleEvent, alreadyEmitted: boolean): Promise<void> => {
    try {
      if (isBlacklistedCollection({
        collectionAddress: enriched.collectionAddress,
        meCollectionSlug:  enriched.meCollectionSlug,
        collectionName:    enriched.collectionName,
        verifiedCreators:  enriched.verifiedCreators,
        nftName:           enriched.nftName,
        nftType:           enriched.nftType,
        saleCollectionAddress: event.collectionAddress,
        hasArtistAttribute: enriched.hasArtistAttribute,
        signature:         event.signature,
        mintAddress:       event.mintAddress,
      })) {
        await pool.query('DELETE FROM sale_events WHERE signature = $1', [event.signature]);
        if (alreadyEmitted) saleEventBus.emitRemove(event.signature);
        // Stash mint → blocked so the next sale of this asset short-circuits at
        // the pre-emit gate. The mint→slug index updates organically via the
        // meta bus, but that doesn't fire for blacklisted rows (we DELETE
        // before `meta`), so record here explicitly.
        markMintBlocked(event.mintAddress, 'collection_match');
        console.log(
          `[feed/blacklist-learn] reason=collection_match ` +
          `mint=${event.mintAddress} slug=${enriched.meCollectionSlug ?? 'null'} ` +
          `collection=${enriched.collectionName ?? enriched.collectionAddress ?? 'null'} ` +
          `sig=${event.signature.slice(0, 12)}... emitted=${alreadyEmitted}`,
        );
        return;
      }
      await pool.query(UPDATE_META_SQL, [
        event.signature,
        enriched.nftName,
        enriched.imageUrl,
        enriched.collectionName,
        enriched.collectionAddress,
        enriched.mintAddress,                 // backfills cNFT asset id when tensor-raw emitted ''
        enriched.meCollectionSlug,            // persisted so REST snapshot rows can render collection-page links
        enriched.floorDelta ?? null,          // persisted so FloorChip badge survives page reloads
        enriched.tensorCollectionSlug ?? null,
        getMintedAt(enriched.mintAddress),    // frozen FRESH MINT fact — see UPDATE_META_SQL comment
      ]);
      checkPricingAlerts(enriched);
      logFrameDebugOnMeta({
        signature:         enriched.signature,
        collectionName:    enriched.collectionName,
        meCollectionSlug:  enriched.meCollectionSlug ?? null,
        mintAddress:       enriched.mintAddress,
        nftName:           enriched.nftName,
        collectionAddress: enriched.collectionAddress,
      });
      saleEventBus.emitMetaUpdate({
        mintAddress:           enriched.mintAddress,
        signature:             enriched.signature,
        nftName:               enriched.nftName,
        imageUrl:              enriched.imageUrl,
        collectionName:        enriched.collectionName,
        collectionAddress:     enriched.collectionAddress,
        meCollectionSlug:      enriched.meCollectionSlug      ?? null,
        tensorCollectionSlug:  enriched.tensorCollectionSlug  ?? null,
        floorDelta:            enriched.floorDelta             ?? null,
        offerDelta:            enriched.offerDelta             ?? null,
        mintedAtMs:            enriched.mintedAtMs             ?? null,
      });
      // Bot API v1 identity patch — see BotIdentityPatch's doc comment
      // (src/events/emitter.ts). Separate from emitMetaUpdate above so the
      // public `meta` SSE payload is never touched by this. Excludes the
      // me_cnft_raw merkle-tree placeholder from collectionAddress.
      saleEventBus.emitBotIdentityPatch({
        signature:            enriched.signature,
        collectionAddress:    isMerkleTreeCollectionAddress(enriched) ? null : (enriched.collectionAddress ?? null),
        meCollectionSlug:     enriched.meCollectionSlug     ?? null,
        tensorCollectionSlug: enriched.tensorCollectionSlug ?? null,
      });
      // Late image-resolution path. enrich can leave imageUrl null when DAS
      // hasn't indexed a freshly-minted asset; retries at 15/60/180 s patch
      // the card via a follow-up MetaUpdate. Per-mint dedup + 20 min backoff.
      if (!enriched.imageUrl && enriched.mintAddress) {
        scheduleImageRetry({
          mintAddress:       enriched.mintAddress,
          signature:         enriched.signature,
          collectionName:    enriched.collectionName,
          collectionAddress: enriched.collectionAddress,
          meCollectionSlug:  enriched.meCollectionSlug ?? null,
          nftName:           enriched.nftName,
        });
      }
    } catch (err) {
      console.error(`[enrich] apply failed  sig=${event.signature.slice(0, 12)}...`, err);
    }
  };

  // No mintAddress → enrichment impossible; emit immediately as today, done.
  if (!event.mintAddress) {
    emitSaleFrame(resolvedName, resolvedSlug, null);
    return id;
  }

  // ── Resize-status lookup (Live Feed RESIZE badge) ────────────────────────────
  // Prefilter is RPC-saving only — NOT proof of resize. cNFT / Core never
  // qualify. Threshold 0.03 SOL covers the rent-reclaim sale zone. Independent
  // of the emit path — scheduled the same in immediate and deferred branches.
  if ((event.nftType === 'legacy' || event.nftType === 'pnft')
      && event.priceLamports <= 30_000_000n) {
    enqueueResizeLookup(event.mintAddress, event.signature);
  }

  // ── AMM pool-type lookup (Live Feed AMM badge) ────────────────────────────
  // Only MMM sales carry a poolAddress (captured at parse time for
  // independently-verified instruction variants only — see programs.ts).
  // `owner` is whichever party the parser already resolved as the pool
  // controller for this instruction's direction; a wrong guess here is
  // harmless (resolver's exact poolKey match just yields "unresolved").
  if (event.poolAddress) {
    const direction = (event.rawData as { _direction?: string } | undefined)?._direction;
    const owner = (direction === 'fulfillBuy' || direction === 'takeBid') ? event.buyer : event.seller;
    enqueuePoolTypeLookup(event.poolAddress, owner, event.signature);
  }

  // Deferral gate: ONLY a never-seen mint (no cached name AND no cached slug)
  // can flash, because its first frame has no identity to filter on. Cached /
  // slug-bearing / name-bearing sales are emitted immediately (zero latency).
  const needsDeferral = DEFER_ENABLED && resolvedName == null && resolvedSlug == null;

  if (!needsDeferral || deferInflight >= DEFER_MAX_INFLIGHT) {
    if (needsDeferral && deferInflight >= DEFER_MAX_INFLIGHT && deferSkipLog++ % 50 === 0) {
      console.log(`[feed/defer] skipped (inflight cap ${DEFER_MAX_INFLIGHT} reached, count=${deferSkipLog}) — emitting immediately`);
    }
    // ── Immediate path (today's behavior) ──
    emitSaleFrame(resolvedName, resolvedSlug, null);
    enrich(event)
      .then((enriched) => applyEnrichment(enriched, true))
      .catch((err) => console.error(`[enrich] background failed  sig=${event.signature.slice(0, 12)}...`, err));
    return id;
  }

  // ── Deferred path (FEED_DEFER_BLACKLIST=1, first-sighting only) ──
  // Race the EXISTING enrich(event) (no new RPC) against the budget. Detached:
  // we return `id` now, so neither the DB insert nor the parser pipeline waits.
  deferInflight++;
  dlog(`[feed/defer] started sig=${event.signature.slice(0, 12)}... mint=${event.mintAddress} budget=${DEFER_BUDGET_MS}ms inflight=${deferInflight}`);
  const enrichP = enrich(event);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), DEFER_BUDGET_MS); });
  let decided = false;
  Promise.race([
    enrichP.then((e) => ({ kind: 'enrich' as const, e })),
    timeoutP.then(() => ({ kind: 'timeout' as const })),
  ])
    .then(async (outcome) => {
      if (outcome.kind === 'enrich') {
        if (timer) clearTimeout(timer);
        const enriched = outcome.e;
        const blacklisted = isBlacklistedCollection({
          collectionAddress: enriched.collectionAddress,
          meCollectionSlug:  enriched.meCollectionSlug,
          collectionName:    enriched.collectionName,
          verifiedCreators:  enriched.verifiedCreators,
          nftName:           enriched.nftName,
          nftType:           enriched.nftType,
          saleCollectionAddress: event.collectionAddress,
          hasArtistAttribute: enriched.hasArtistAttribute,
          signature:         event.signature,
          mintAddress:       event.mintAddress,
        });
        if (blacklisted) {
          decided = true;
          console.log(`[feed/defer-suppress] sig=${event.signature.slice(0, 12)}... collection=${enriched.collectionName ?? enriched.meCollectionSlug ?? enriched.collectionAddress ?? '?'} — dropped before emit`);
          await applyEnrichment(enriched, false);   // delete row, NO emit, NO remove
        } else {
          dlog(`[feed/defer] resolved before timeout sig=${event.signature.slice(0, 12)}... name=${enriched.collectionName ?? 'null'} slug=${enriched.meCollectionSlug ?? 'null'}`);
          emitSaleFrame(enriched.collectionName ?? resolvedName, enriched.meCollectionSlug ?? resolvedSlug, enriched.imageUrl ?? null);
          decided = true;
          await applyEnrichment(enriched, true);    // UPDATE + meta (not blacklisted → no remove)
        }
      } else {
        // Timeout won → emit as today, let the (still-running) enrich apply
        // normal meta/remove behavior when it resolves.
        dlog(`[feed/defer] timeout fallback sig=${event.signature.slice(0, 12)}... — emitting now`);
        emitSaleFrame(resolvedName, resolvedSlug, null);
        decided = true;
        enrichP
          .then((enriched) => applyEnrichment(enriched, true))
          .catch((err) => console.error(`[enrich] background failed  sig=${event.signature.slice(0, 12)}...`, err));
      }
    })
    .catch((err) => {
      // Fail-soft: never drop a sale on an unexpected error. Only emit if no
      // terminal action was taken (avoids a double frame).
      if (timer) clearTimeout(timer);
      console.error(`[feed/defer] error sig=${event.signature.slice(0, 12)}... — fail-soft immediate emit`, err);
      if (!decided) {
        emitSaleFrame(resolvedName, resolvedSlug, null);
        enrichP.then((e) => applyEnrichment(e, true)).catch(() => { /* already logged */ });
      }
    })
    .finally(() => { deferInflight--; });

  return id;
}
