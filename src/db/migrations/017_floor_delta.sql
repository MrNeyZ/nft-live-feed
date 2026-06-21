-- Persist floor_delta alongside the sale event so the FloorChip badge
-- survives page reloads without depending on the in-process floor cache.
-- floor_delta = (price_lamports - floor_lamports) / floor_lamports
-- NULL when floor was unavailable at enrichment time.
ALTER TABLE sale_events ADD COLUMN IF NOT EXISTS floor_delta NUMERIC;
