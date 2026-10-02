-- Persistent cache of DAS getAsset responses for the sale-enrich path.
-- The in-memory 4h cache dies on every restart and most sales are unique
-- mints; ~20% of a day's sold mints already sold in the prior 30 days, so
-- reusing the stored response saves a 10-credit DAS call per resale.
CREATE TABLE IF NOT EXISTS das_asset_cache (
  mint_address TEXT PRIMARY KEY,
  asset        JSONB NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS das_asset_cache_fetched_at_idx ON das_asset_cache (fetched_at);
