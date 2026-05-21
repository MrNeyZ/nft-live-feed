-- Recent Mint Tracker feed events — server-side source of truth.
-- The in-memory recent-mints ring (src/mints/accumulator.ts) is hydrated from
-- this table on boot so the SSE replay survives restarts and is identical for
-- every device; frontend localStorage is fallback-only. Bounded by a periodic
-- retention cleanup (MINT_EVENTS_RETENTION_DAYS, default 7).
CREATE TABLE IF NOT EXISTS mint_events (
  id                   BIGSERIAL PRIMARY KEY,
  signature            TEXT NOT NULL,
  -- mint_address is '' (not NULL) when unknown so the composite unique index
  -- treats those rows as equal and dedupes them (NULLs would be distinct).
  mint_address         TEXT NOT NULL DEFAULT '',
  collection_address   TEXT,
  grouping_key         TEXT NOT NULL,
  grouping_kind        TEXT NOT NULL,
  source_label         TEXT NOT NULL,
  program_source       TEXT NOT NULL,
  mint_type            TEXT NOT NULL,
  price_lamports       BIGINT,
  minter               TEXT,
  block_time           TIMESTAMPTZ,
  nft_name             TEXT,
  nft_image_url        TEXT,
  collection_name      TEXT,
  collection_image_url TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mint_events_sig_mint_uq
  ON mint_events (signature, mint_address);
CREATE INDEX IF NOT EXISTS mint_events_block_time_idx
  ON mint_events (block_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS mint_events_created_at_idx
  ON mint_events (created_at);
