-- Index to support per-collection event queries (hover drill-down on /mints).
-- Covers: WHERE grouping_key = $1 ORDER BY block_time DESC LIMIT N
CREATE INDEX IF NOT EXISTS mint_events_grouping_key_idx
  ON mint_events (grouping_key, block_time DESC NULLS LAST);
