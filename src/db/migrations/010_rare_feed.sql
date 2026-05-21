-- Rare Feed MVP — per-mint rarity cache + accepted rare-sale events.
--
-- Rare Feed is NOT a new ingestion source. It consumes the existing live NFT
-- sale events (via the in-process sale event bus — see src/rare-feed/), enriches
-- them with rarity data from Magic Eden's v2 tokens API, scores/filters them,
-- and persists the accepted ones here for a small Tools page to display.
--
-- Two tables:
--   mint_rarity_cache  — DB-backed cache of ME rarity lookups per mint, so a
--                        repeat sale of the same mint never re-hits ME. Holds
--                        both positive (rank found) and negative (no rank)
--                        results; the application layer applies separate TTLs
--                        (RARE_FEED_RARITY_TTL_MS / RARE_FEED_NEGATIVE_TTL_MS).
--   rare_feed_events   — accepted rare sales, bounded by a retention window
--                        (RARE_FEED_RETENTION_DAYS, default 7).

CREATE TABLE IF NOT EXISTS mint_rarity_cache (
  mint_address       TEXT PRIMARY KEY,
  collection_symbol  TEXT,
  rarity_rank        INTEGER,
  total_supply       INTEGER,
  rarity_percentile  NUMERIC,
  rarity_source      TEXT NOT NULL DEFAULT 'magiceden',
  traits             JSONB,
  raw                JSONB,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mint_rarity_cache_fetched_at_idx
  ON mint_rarity_cache (fetched_at);

CREATE TABLE IF NOT EXISTS rare_feed_events (
  id                 BIGSERIAL PRIMARY KEY,
  sale_signature     TEXT NOT NULL,
  mint_address       TEXT NOT NULL,
  collection_slug    TEXT,
  collection_name    TEXT,
  nft_name           TEXT,
  image_url          TEXT,
  source             TEXT,                 -- marketplace / sale source
  sale_price_sol     NUMERIC NOT NULL,
  floor_price_sol    NUMERIC,
  floor_delta_pct    NUMERIC,              -- (salePrice - floor) / floor
  rarity_rank        INTEGER,
  total_supply       INTEGER,
  rarity_percentile  NUMERIC,
  rarity_source      TEXT,
  rare_score         NUMERIC NOT NULL,
  reason_tags        TEXT[] NOT NULL DEFAULT '{}',
  sale_time          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One rare row per sale. Dedupe on signature so a re-ingested / re-emitted
-- sale (AMM gap-healer, SSE reconnect replays, double meta updates) can never
-- create a duplicate rare event.
CREATE UNIQUE INDEX IF NOT EXISTS rare_feed_events_sig_uq
  ON rare_feed_events (sale_signature);
CREATE INDEX IF NOT EXISTS rare_feed_events_sale_time_idx
  ON rare_feed_events (sale_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS rare_feed_events_created_at_idx
  ON rare_feed_events (created_at);
