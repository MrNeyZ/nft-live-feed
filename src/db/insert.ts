import { getPool } from './client';
import { SaleEvent } from '../models/sale-event';
import { saleEventBus } from '../events/emitter';
import { enrich } from '../enrichment/enrich';
import { COLLECTION_BLACKLIST, SLUG_BLACKLIST } from './blacklist';
import { checkPricingAlerts } from '../alerts/alerts';


// ─── Raw-data patch (fast-path → raw-parse correction) ────────────────────────

const PATCH_RAW_SQL = `
  UPDATE sale_events
  SET seller = $2, buyer = $3, marketplace = $4, nft_type = $5, raw_data = $6,
      price_lamports = $7, price_sol = $8
  WHERE signature = $1
`;

/**
 * Derive the display saleType for a raw-parser event.
 * Mirrors SALE_TYPE_EXPR in queries.ts — raw-parser cases only
 * (Helius path not needed here; fast-path events are always replaced by raw data).
 */
function deriveSaleTypeFromRaw(rawData: Record<string, unknown>): string {
  const parser = rawData._parser as string | undefined;
  const dir    = rawData._direction as string | undefined;
  if (parser === 'me_v2_raw')  return 'normal_sale';
  if (parser === 'mmm_raw') {
    if (dir === 'fulfillSell') return 'pool_buy';
    if (dir === 'takeBid')     return 'bid_sell';
    return 'pool_sale';
  }
  if (parser === 'tensor_raw') return dir === 'takeBid' ? 'bid_sell' : 'normal_sale';
  if (parser === 'tamm_raw')   return dir === 'takeBid' ? 'bid_sell' : 'pool_sale';
  return 'normal_sale';
}

/**
 * Update a previously fast-path-inserted event with corrected raw-parser data.
 * Emits a `rawpatch` SSE event so connected clients update their cards.
 */
export async function patchSaleEventRaw(event: SaleEvent): Promise<void> {
  const pool = getPool();
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
    saleType:    deriveSaleTypeFromRaw(event.rawData as Record<string, unknown>),
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
  SET nft_name = $2, image_url = $3, collection_name = $4, collection_address = $5
  WHERE signature = $1
`;

export async function insertSaleEvent(event: SaleEvent): Promise<string | null> {
  const magicEdenUrl = `https://magiceden.io/item-details/${event.mintAddress}`;
  const pool = getPool();

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
  if (!id) return null;   // duplicate signature — already processed

  // Emit immediately so the frontend card appears at once.
  const blockAgeSec = ((Date.now() - event.blockTime.getTime()) / 1000).toFixed(1);
  console.log(`[sse] emit  sig=${event.signature.slice(0, 12)}  blockAge=${blockAgeSec}s`);
  saleEventBus.emitSale({ ...event, nftName: null, imageUrl: null, collectionName: null, magicEdenUrl });

  // ── Background enrichment ────────────────────────────────────────────────────
  // Fire-and-forget: never awaited, never delays INSERTs or SSE.
  // Write semaphore (MAX_BG_WRITES=3) prevents burst-completing enriches from
  // simultaneously saturating the pool and blocking hot-path INSERTs.
  enrich(event)
    .then(async (enriched) => {
      const isBlacklisted =
        (enriched.collectionAddress && COLLECTION_BLACKLIST.has(enriched.collectionAddress)) ||
        (enriched.meCollectionSlug  && SLUG_BLACKLIST.has(enriched.meCollectionSlug));

      if (isBlacklisted) {
        await pool.query('DELETE FROM sale_events WHERE signature = $1', [event.signature]);
        saleEventBus.emitRemove(event.signature);
        console.log(
          `[blacklist] removed ${(enriched.collectionAddress ?? enriched.meCollectionSlug ?? '?').slice(0, 12)}` +
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
