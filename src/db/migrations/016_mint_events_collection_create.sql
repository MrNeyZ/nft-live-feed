-- Distinguish collection-CREATE events (mpl-core CreateCollection /
-- CreateCollectionV1) from normal NFT mints in the Live Mint Feed.
-- Set by the mint-raw parser from the matched instruction needle (exact
-- on-chain evidence — NOT a name heuristic). Default false, so every existing
-- row and every real NFT mint is unaffected.
ALTER TABLE mint_events
  ADD COLUMN IF NOT EXISTS collection_create BOOLEAN NOT NULL DEFAULT false;
