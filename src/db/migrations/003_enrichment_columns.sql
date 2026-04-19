ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS nft_name       TEXT,
  ADD COLUMN IF NOT EXISTS image_url      TEXT,
  ADD COLUMN IF NOT EXISTS collection_name TEXT,
  ADD COLUMN IF NOT EXISTS magic_eden_url TEXT;
