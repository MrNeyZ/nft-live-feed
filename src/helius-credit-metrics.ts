/**
 * Per-source Helius credit attribution telemetry.
 *
 * Tracks getAsset (10 cr) and getTransaction (1 cr) calls by named source.
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
  | 'manual_tools'
  | 'unknown';

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

const CREDITS_PER_GET_ASSET = 10;
const CREDITS_PER_GET_TX    =  1;

const GET_ASSET_SOURCES: readonly GetAssetSource[] = [
  'collection_confirm',
  'mint_enricher_verify',
  'sale_enrich',
  'image_retry',
  'seller_collection_count',
  'launchpad_collection_meta',
  'collection_owner',
  'manual_tools',
  'unknown',
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

const getTxCounts: Record<GetTxSource, number> = Object.fromEntries(
  GET_TX_SOURCES.map(s => [s, 0]),
) as Record<GetTxSource, number>;

const nullTxCounts: Record<NullTxSource, number> = Object.fromEntries(
  NULL_TX_SOURCES.map(s => [s, 0]),
) as Record<NullTxSource, number>;

export function incGetAsset(source: GetAssetSource): void {
  getAssetCounts[source]++;
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

  console.log(`[helius/credits] ${getAssetParts} ${getTxParts} ${nullTxParts}`);

  const totalGetAsset = GET_ASSET_SOURCES.reduce((n, s) => n + getAssetCounts[s], 0);
  const totalGetTx    = GET_TX_SOURCES   .reduce((n, s) => n + getTxCounts[s],    0);
  const getAssetCredits       = totalGetAsset * CREDITS_PER_GET_ASSET;
  const getTransactionCredits = totalGetTx    * CREDITS_PER_GET_TX;
  const total = getAssetCredits + getTransactionCredits;

  console.log(
    `[helius/credits-est] getAssetCredits=${getAssetCredits}` +
    ` getTransactionCredits=${getTransactionCredits} total=${total}`,
  );

  // Reset for the next window.
  for (const s of GET_ASSET_SOURCES) getAssetCounts[s] = 0;
  for (const s of GET_TX_SOURCES)    getTxCounts[s]    = 0;
  for (const s of NULL_TX_SOURCES)   nullTxCounts[s]   = 0;
}, EMIT_INTERVAL_MS);
if (typeof _timer.unref === 'function') _timer.unref();
