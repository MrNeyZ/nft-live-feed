import { getPool } from './client';
import { SaleEvent, CNFT_MIN_PRICE_LAMPORTS } from '../models/sale-event';
import { saleEventBus } from '../events/emitter';
import { enrich } from '../enrichment/enrich';
import { isBlacklistedCollection } from './blacklist';
import { checkPricingAlerts } from '../alerts/alerts';
import { trace } from '../trace';
import { saleTypeFromEvent } from '../domain/sale-event-adapters';
import { slugForMint } from '../server/listings-store';

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
  console.log(`[sse] emit  sig=${event.signature.slice(0, 12)}  blockAge=${blockAgeSec}s  slug=${resolvedSlug ?? 'null'}`);
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
      })) {
        await pool.query('DELETE FROM sale_events WHERE signature = $1', [event.signature]);
        saleEventBus.emitRemove(event.signature);
        console.log(
          `[blacklist] removed ${(enriched.collectionAddress ?? enriched.meCollectionSlug ?? enriched.collectionName ?? '?').slice(0, 24)}` +
          `  sig=${event.signature.slice(0, 12)}...`,
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
    })
    .catch((err) =>
      console.error(`[enrich] background failed  sig=${event.signature.slice(0, 12)}...`, err),
    );

  return id;
}
