-- Add sale_type classification column.
--
-- ⚠ LEGACY / DEAD COLUMN — do not trust it. The column is NOT NULL DEFAULT
-- 'list_buy' and is NEVER written by insertSaleEvent / patchSaleEventRaw, so
-- every persisted row reads 'list_buy'. The canonical sale type is DERIVED at
-- read time from raw_data via deriveSaleType (see src/domain/sale-type.ts and
-- db/queries.ts applySaleType); no query SELECTs this column. Kept only because
-- dropping a NOT NULL column is a riskier migration than leaving it inert — do
-- NOT backfill it or use it for analytics.
ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'list_buy';
