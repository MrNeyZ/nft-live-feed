-- Socials for verified-collection catalog. Harvested during the same
-- paginated `/v2/collections` refresh that populates the catalog, so no
-- extra ME round-trip per slug at read time (the per-slug endpoint is
-- aggressively rate-limited and returns 429 to anonymous clients).
--
-- NULL = "not supplied by source"; empty string would be ambiguous.
ALTER TABLE collection_catalog
  ADD COLUMN IF NOT EXISTS twitter TEXT,
  ADD COLUMN IF NOT EXISTS discord TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT;
