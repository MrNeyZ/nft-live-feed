-- Persist the Magic Eden collection slug so REST snapshot rows can link to
-- the collection marketplace page (magiceden.io/marketplace/<slug>) instead
-- of falling back to /item-details/<mint>.
ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS me_collection_slug TEXT;
