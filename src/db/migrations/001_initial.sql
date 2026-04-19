CREATE TABLE IF NOT EXISTS sale_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signature         TEXT        NOT NULL UNIQUE,
  block_time        TIMESTAMPTZ NOT NULL,
  marketplace       TEXT        NOT NULL,
  nft_type          TEXT        NOT NULL,
  mint_address      TEXT        NOT NULL,
  collection_address TEXT,
  seller            TEXT        NOT NULL,
  buyer             TEXT        NOT NULL,
  price_lamports    BIGINT      NOT NULL,
  price_sol         NUMERIC(20, 9) NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'SOL',
  raw_data          JSONB,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sale_events_block_time_idx     ON sale_events (block_time DESC);
CREATE INDEX IF NOT EXISTS sale_events_mint_address_idx   ON sale_events (mint_address);
CREATE INDEX IF NOT EXISTS sale_events_collection_idx     ON sale_events (collection_address);
CREATE INDEX IF NOT EXISTS sale_events_marketplace_idx    ON sale_events (marketplace);
CREATE INDEX IF NOT EXISTS sale_events_nft_type_idx       ON sale_events (nft_type);
