-- Add Tensor-native collection slug (slugDisplay from find_collection API).
-- Used to build /trade/<slug> links on tensor.trade for the Live Feed badge.
-- Populated by enrichment for Tensor/TAMM sales when TENSOR_API_KEY is set.
ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS tensor_collection_slug TEXT;
