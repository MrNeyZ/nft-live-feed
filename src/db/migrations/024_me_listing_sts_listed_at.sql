-- Listing time for a cached ME SellerTradeState: blockTime of the latest
-- successful tx touching the STS (the list, or a later reprice), or the
-- listing stream's receive time. Keyed to `sts` — a relist by someone else
-- is a different STS and resets it.
ALTER TABLE me_listing_sts ADD COLUMN IF NOT EXISTS listed_at_ms BIGINT;
