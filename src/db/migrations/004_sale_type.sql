-- Add sale_type classification column.
-- Default 'list_buy' back-fills all existing rows safely.
ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'list_buy';
