import { getPool } from './client';
import { SaleEvent, CNFT_MIN_PRICE_LAMPORTS } from '../models/sale-event';
import { saleEventBus } from '../events/emitter';
import { enrich } from '../enrichment/enrich';
import { scheduleImageRetry } from '../enrichment/image-retry';
import { isBlacklistedCollection } from './blacklist';
import { isMintBlocked, markMintBlocked } from './blocked-mint-cache';
import { checkPricingAlerts } from '../alerts/alerts';
import { trace } from '../trace';
import { saleTypeFromEvent } from '../domain/sale-event-adapters';
import { logSellerNetDiff, logSellerNetAudit, logAmmSellPriceMode } from '../ingestion/seller-net';
import { slugForMint } from '../server/listings-store';
import { getSseClientCount } from '../server/sse';

/** Sentinel: an event whose price is below the cNFT floor — used by both
 *  insert and patchSaleEventRaw to gate emission and remove already-emitted
 *  rows when later raw-parsing reveals the true nft_type. */
function isCnftBelowMin(event: SaleEvent): boolean {
  return event.nftType === 'cnft' && event.priceLamports <= CNFT_MIN_PRICE_LAMPORTS;
}


// ─── Raw-data patch (fast-path → raw-parse correction) ────────────────────────

const PATCH_RAW_SQL = `
  UPDATE sale_events
  SET seller = $2, buyer = $3, marketplace = $4, nft_type = $5, raw_data = $6,
      price_lamports = $7, price_sol = $8
  WHERE signature = $1
`;

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
  SET nft_name = $2, image_url = $3, collection_name = $4, collection_address = $5, mint_address = $6, me_collection_slug = $7
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
  if (isBlacklistedCollection({
    collectionAddress: event.collectionAddress,
    meCollectionSlug:  preEmitSlug,
    collectionName:    null,
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
  saleEventBus.emitSale({
    ...event,
    nftName: null,
    imageUrl: null,
    collectionName: null,
    magicEdenUrl,
    meCollectionSlug: resolvedSlug,
  });

  // Step 6 — SSE event on the wire to all connected clients.
  trace(event.signature, 'sse:emitted', `blockAge=${blockAgeSec}s`);

  // ── Background enrichment ────────────────────────────────────────────────────
  // Fire-and-forget: never awaited, never delays INSERTs or SSE.
  // Hard guarantee: enrichment is never invoked with an empty mintAddress —
  // cNFT resolve is done synchronously above, so reaching here with '' means
  // Helius didn't index the tx yet and downstream DAS / ME lookups would be
  // wasted calls.
  if (!event.mintAddress) {
    return id;
  }
  enrich(event)
    .then(async (enriched) => {
      if (isBlacklistedCollection({
        collectionAddress: enriched.collectionAddress,
        meCollectionSlug:  enriched.meCollectionSlug,
        collectionName:    enriched.collectionName,
        signature:         event.signature,
        mintAddress:       event.mintAddress,
      })) {
        await pool.query('DELETE FROM sale_events WHERE signature = $1', [event.signature]);
        saleEventBus.emitRemove(event.signature);
        // Stash mint → blocked so the next sale of this asset short-circuits
        // at the pre-emit gate without flashing in the feed. cNFT mintAddress
        // is stable per asset, so this is a clean key. The shared mint→slug
        // index also gets updated organically via the meta-update bus when
        // enrichment populates a slug, but that path doesn't fire for
        // blacklisted rows (we DELETE before emitting `meta`), so we record
        // here explicitly.
        markMintBlocked(event.mintAddress, 'collection_match');
        console.log(
          `[feed/blacklist-learn] reason=collection_match ` +
          `mint=${event.mintAddress} ` +
          `slug=${enriched.meCollectionSlug ?? 'null'} ` +
          `collection=${enriched.collectionName ?? enriched.collectionAddress ?? 'null'} ` +
          `sig=${event.signature.slice(0, 12)}...`,
        );
        return;
      }

      await pool.query(UPDATE_META_SQL, [
        event.signature,
        enriched.nftName,
        enriched.imageUrl,
        enriched.collectionName,
        enriched.collectionAddress,
        enriched.mintAddress,        // backfills cNFT asset id when tensor-raw emitted ''
        enriched.meCollectionSlug,   // persisted so REST snapshot rows can render collection-page links
      ]);

      checkPricingAlerts(enriched);
      saleEventBus.emitMetaUpdate({
        mintAddress:       enriched.mintAddress,
        signature:         enriched.signature,
        nftName:           enriched.nftName,
        imageUrl:          enriched.imageUrl,
        collectionName:    enriched.collectionName,
        collectionAddress: enriched.collectionAddress,
        meCollectionSlug:  enriched.meCollectionSlug ?? null,
        floorDelta:        enriched.floorDelta        ?? null,
        offerDelta:        enriched.offerDelta        ?? null,
      });

      // Late image-resolution path. The synchronous enrich pipeline
      // above can leave imageUrl null when DAS hasn't yet indexed a
      // freshly-minted asset (common for first-of-collection sales).
      // Schedule background DAS retries at 15 s / 60 s / 180 s; if the
      // image resolves, a follow-up `MetaUpdate` patches the card. The
      // frontend reducer uses `patch.imageUrl ?? ev.imageUrl`, so a
      // null here can never overwrite an already-resolved image. Per-
      // mint dedup + 20 min backoff bound RPC.
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
    })
    .catch((err) =>
      console.error(`[enrich] background failed  sig=${event.signature.slice(0, 12)}...`, err),
    );

  return id;
}
