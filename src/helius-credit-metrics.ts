/**
 * Per-source Helius credit attribution telemetry.
 *
 * Tracks getAsset (10 cr), getTransaction (1 cr), searchAssets (10 cr),
 * and getAssetsByOwner (10 cr/page) calls by named source.
 * Emits two log lines every 60 s:
 *   [helius/credits]     — raw per-source call counts (reset each window)
 *   [helius/credits-est] — estimated credit cost at Helius published rates
 *
 * Zero behavior changes: pure counter increments, no delays, no caches, no retries.
 */

export type GetAssetSource =
  | 'collection_confirm'
  | 'mint_enricher_verify'
  | 'sale_enrich'
  | 'image_retry'
  | 'seller_collection_count'
  | 'launchpad_collection_meta'
  | 'collection_owner'
  | 'name_backfill'
  | 'payment_token_enrich'
  | 'manual_tools'
  | 'unknown';

export type SearchAssetsSource =
  | 'seller_count_fast'
  | 'minted_count';

export type GetAssetsByOwnerSource =
  | 'seller_count_deep';

export type GetTxSource =
  | 'mint_ws'
  | 'mint_poller'
  | 'mint_reconcile'
  | 'sale_ws'
  | 'sale_poller'
  | 'manual_tools'
  | 'unknown';

type NullTxSource =
  | 'null_mint_ws'
  | 'null_mint_poller'
  | 'null_mint_reconcile'
  | 'null_sale_ws'
  | 'null_sale_poller';

const CREDITS_PER_GET_ASSET          = 10;
const CREDITS_PER_GET_TX             =  1;
const CREDITS_PER_SEARCH_ASSETS      = 10;
const CREDITS_PER_GET_ASSETS_BY_OWNER = 10; // per page

const GET_ASSET_SOURCES: readonly GetAssetSource[] = [
  'collection_confirm',
  'mint_enricher_verify',
  'sale_enrich',
  'image_retry',
  'seller_collection_count',
  'launchpad_collection_meta',
  'collection_owner',
  'name_backfill',
  'payment_token_enrich',
  'manual_tools',
  'unknown',
];

const SEARCH_ASSETS_SOURCES: readonly SearchAssetsSource[] = [
  'seller_count_fast',
  'minted_count',
];

const GET_ASSETS_BY_OWNER_SOURCES: readonly GetAssetsByOwnerSource[] = [
  'seller_count_deep',
];

const GET_TX_SOURCES: readonly GetTxSource[] = [
  'mint_ws',
  'mint_poller',
  'mint_reconcile',
  'sale_ws',
  'sale_poller',
  'manual_tools',
  'unknown',
];

const NULL_TX_SOURCES: readonly NullTxSource[] = [
  'null_mint_ws',
  'null_mint_poller',
  'null_mint_reconcile',
  'null_sale_ws',
  'null_sale_poller',
];

// Counters reset after each 60 s emission.
const getAssetCounts: Record<GetAssetSource, number> = Object.fromEntries(
  GET_ASSET_SOURCES.map(s => [s, 0]),
) as Record<GetAssetSource, number>;

const searchAssetsCounts: Record<SearchAssetsSource, number> = Object.fromEntries(
  SEARCH_ASSETS_SOURCES.map(s => [s, 0]),
) as Record<SearchAssetsSource, number>;

const getAssetsByOwnerCounts: Record<GetAssetsByOwnerSource, number> = Object.fromEntries(
  GET_ASSETS_BY_OWNER_SOURCES.map(s => [s, 0]),
) as Record<GetAssetsByOwnerSource, number>;

const getTxCounts: Record<GetTxSource, number> = Object.fromEntries(
  GET_TX_SOURCES.map(s => [s, 0]),
) as Record<GetTxSource, number>;

const nullTxCounts: Record<NullTxSource, number> = Object.fromEntries(
  NULL_TX_SOURCES.map(s => [s, 0]),
) as Record<NullTxSource, number>;

// Hourly and daily accumulators — NOT reset on each 60 s tick.
// Hourly resets every 60 min; daily resets every 24 h.
const getAssetHour: Record<GetAssetSource, number> = Object.fromEntries(
  GET_ASSET_SOURCES.map(s => [s, 0]),
) as Record<GetAssetSource, number>;
const getAssetDay: Record<GetAssetSource, number> = Object.fromEntries(
  GET_ASSET_SOURCES.map(s => [s, 0]),
) as Record<GetAssetSource, number>;

const searchAssetsHour: Record<SearchAssetsSource, number> = Object.fromEntries(
  SEARCH_ASSETS_SOURCES.map(s => [s, 0]),
) as Record<SearchAssetsSource, number>;
const searchAssetsDay: Record<SearchAssetsSource, number> = Object.fromEntries(
  SEARCH_ASSETS_SOURCES.map(s => [s, 0]),
) as Record<SearchAssetsSource, number>;

const getAssetsByOwnerHour: Record<GetAssetsByOwnerSource, number> = Object.fromEntries(
  GET_ASSETS_BY_OWNER_SOURCES.map(s => [s, 0]),
) as Record<GetAssetsByOwnerSource, number>;
const getAssetsByOwnerDay: Record<GetAssetsByOwnerSource, number> = Object.fromEntries(
  GET_ASSETS_BY_OWNER_SOURCES.map(s => [s, 0]),
) as Record<GetAssetsByOwnerSource, number>;

export function incGetAsset(source: GetAssetSource): void {
  getAssetCounts[source]++;
}

export function incSearchAssets(source: SearchAssetsSource): void {
  searchAssetsCounts[source]++;
}

/** Call once per page fetched (each page = one Helius getAssetsByOwner HTTP request). */
export function incGetAssetsByOwner(source: GetAssetsByOwnerSource): void {
  getAssetsByOwnerCounts[source]++;
}

export function incGetTx(source: GetTxSource): void {
  getTxCounts[source]++;
}

export function incNullGetTx(source: GetTxSource): void {
  const nullKey = `null_${source}` as NullTxSource;
  if (Object.prototype.hasOwnProperty.call(nullTxCounts, nullKey)) {
    nullTxCounts[nullKey]++;
  }
}

const EMIT_INTERVAL_MS = 60_000;

const _timer = setInterval(() => {
  const getAssetParts = GET_ASSET_SOURCES
    .map(s => `getAsset.${s}=${getAssetCounts[s]}`)
    .join(' ');

  const getTxParts = GET_TX_SOURCES
    .map(s => `getTx.${s}=${getTxCounts[s]}`)
    .join(' ');

  // Strip the "null_" prefix in the log key to match the spec format.
  const nullTxParts = NULL_TX_SOURCES
    .map(s => `nullTx.${s.slice('null_'.length)}=${nullTxCounts[s]}`)
    .join(' ');

  const searchAssetsParts = SEARCH_ASSETS_SOURCES
    .map(s => `searchAssets.${s}=${searchAssetsCounts[s]}`)
    .join(' ');

  const getAssetsByOwnerParts = GET_ASSETS_BY_OWNER_SOURCES
    .map(s => `getAssetsByOwner.${s}=${getAssetsByOwnerCounts[s]}`)
    .join(' ');

  console.log(`[helius/credits] ${getAssetParts} ${getTxParts} ${nullTxParts} ${searchAssetsParts} ${getAssetsByOwnerParts}`);

  const totalGetAsset        = GET_ASSET_SOURCES         .reduce((n, s) => n + getAssetCounts[s],         0);
  const totalGetTx           = GET_TX_SOURCES            .reduce((n, s) => n + getTxCounts[s],             0);
  const totalSearchAssets    = SEARCH_ASSETS_SOURCES     .reduce((n, s) => n + searchAssetsCounts[s],      0);
  const totalGetAssetsByOwner = GET_ASSETS_BY_OWNER_SOURCES.reduce((n, s) => n + getAssetsByOwnerCounts[s], 0);

  const getAssetCredits          = totalGetAsset         * CREDITS_PER_GET_ASSET;
  const getTransactionCredits    = totalGetTx            * CREDITS_PER_GET_TX;
  const searchAssetsCredits      = totalSearchAssets     * CREDITS_PER_SEARCH_ASSETS;
  const getAssetsByOwnerCredits  = totalGetAssetsByOwner * CREDITS_PER_GET_ASSETS_BY_OWNER;
  const total = getAssetCredits + getTransactionCredits + searchAssetsCredits + getAssetsByOwnerCredits;

  console.log(
    `[helius/credits-est] getAssetCredits=${getAssetCredits}` +
    ` getTransactionCredits=${getTransactionCredits}` +
    ` searchAssetsCredits=${searchAssetsCredits}` +
    ` getAssetsByOwnerCredits=${getAssetsByOwnerCredits}` +
    ` total=${total}`,
  );

  // Accumulate into hourly/daily before resetting the minute window.
  for (const s of GET_ASSET_SOURCES)          { getAssetHour[s]          += getAssetCounts[s];          getAssetDay[s]          += getAssetCounts[s]; }
  for (const s of SEARCH_ASSETS_SOURCES)      { searchAssetsHour[s]      += searchAssetsCounts[s];      searchAssetsDay[s]      += searchAssetsCounts[s]; }
  for (const s of GET_ASSETS_BY_OWNER_SOURCES){ getAssetsByOwnerHour[s]  += getAssetsByOwnerCounts[s];  getAssetsByOwnerDay[s]  += getAssetsByOwnerCounts[s]; }

  // Reset for the next window.
  for (const s of GET_ASSET_SOURCES)           getAssetCounts[s]          = 0;
  for (const s of GET_TX_SOURCES)              getTxCounts[s]             = 0;
  for (const s of NULL_TX_SOURCES)             nullTxCounts[s]            = 0;
  for (const s of SEARCH_ASSETS_SOURCES)       searchAssetsCounts[s]      = 0;
  for (const s of GET_ASSETS_BY_OWNER_SOURCES) getAssetsByOwnerCounts[s]  = 0;
}, EMIT_INTERVAL_MS);
if (typeof _timer.unref === 'function') _timer.unref();

// ── Hourly rollup ───────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60_000;
const _hourTimer = setInterval(() => {
  const hourParts = GET_ASSET_SOURCES
    .map(s => `getAsset.${s}=${getAssetHour[s]}`)
    .join(' ');
  const searchHourParts = SEARCH_ASSETS_SOURCES
    .map(s => `searchAssets.${s}=${searchAssetsHour[s]}`)
    .join(' ');
  const ownerHourParts = GET_ASSETS_BY_OWNER_SOURCES
    .map(s => `getAssetsByOwner.${s}=${getAssetsByOwnerHour[s]}`)
    .join(' ');
  const hourTotal = GET_ASSET_SOURCES.reduce((n, s) => n + getAssetHour[s], 0);
  const searchHourTotal   = SEARCH_ASSETS_SOURCES     .reduce((n, s) => n + searchAssetsHour[s],      0);
  const ownerHourTotal    = GET_ASSETS_BY_OWNER_SOURCES.reduce((n, s) => n + getAssetsByOwnerHour[s], 0);
  const hourCredits = hourTotal * CREDITS_PER_GET_ASSET + searchHourTotal * CREDITS_PER_SEARCH_ASSETS + ownerHourTotal * CREDITS_PER_GET_ASSETS_BY_OWNER;
  console.log(`[helius/credits-hour] total=${hourTotal + searchHourTotal + ownerHourTotal} credits_est=${hourCredits} ${hourParts} ${searchHourParts} ${ownerHourParts}`);
  for (const s of GET_ASSET_SOURCES)           getAssetHour[s]         = 0;
  for (const s of SEARCH_ASSETS_SOURCES)       searchAssetsHour[s]     = 0;
  for (const s of GET_ASSETS_BY_OWNER_SOURCES) getAssetsByOwnerHour[s] = 0;
}, HOUR_MS);
if (typeof _hourTimer.unref === 'function') _hourTimer.unref();

// ── Daily rollup ────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60_000;
const _dayTimer = setInterval(() => {
  const dayParts = GET_ASSET_SOURCES
    .map(s => `getAsset.${s}=${getAssetDay[s]}`)
    .join(' ');
  const searchDayParts = SEARCH_ASSETS_SOURCES
    .map(s => `searchAssets.${s}=${searchAssetsDay[s]}`)
    .join(' ');
  const ownerDayParts = GET_ASSETS_BY_OWNER_SOURCES
    .map(s => `getAssetsByOwner.${s}=${getAssetsByOwnerDay[s]}`)
    .join(' ');
  const dayTotal      = GET_ASSET_SOURCES          .reduce((n, s) => n + getAssetDay[s],          0);
  const searchDayTotal = SEARCH_ASSETS_SOURCES     .reduce((n, s) => n + searchAssetsDay[s],      0);
  const ownerDayTotal  = GET_ASSETS_BY_OWNER_SOURCES.reduce((n, s) => n + getAssetsByOwnerDay[s], 0);
  const dayCredits = dayTotal * CREDITS_PER_GET_ASSET + searchDayTotal * CREDITS_PER_SEARCH_ASSETS + ownerDayTotal * CREDITS_PER_GET_ASSETS_BY_OWNER;
  console.log(`[helius/credits-day] total=${dayTotal + searchDayTotal + ownerDayTotal} credits_est=${dayCredits} ${dayParts} ${searchDayParts} ${ownerDayParts}`);
  for (const s of GET_ASSET_SOURCES)           getAssetDay[s]          = 0;
  for (const s of SEARCH_ASSETS_SOURCES)       searchAssetsDay[s]      = 0;
  for (const s of GET_ASSETS_BY_OWNER_SOURCES) getAssetsByOwnerDay[s]  = 0;
}, DAY_MS);
if (typeof _dayTimer.unref === 'function') _dayTimer.unref();
