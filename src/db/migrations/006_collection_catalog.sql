-- Local catalog of Magic Eden verified collections. Powers /api/collections/search
-- so results don't depend on ingestion history. Refreshed from ME's paginated
-- /v2/collections list; only rows where isBadged=true (ME's verified badge) land
-- here. Upserts by slug; refreshes keep updated_at current.
CREATE TABLE IF NOT EXISTS collection_catalog (
  slug        TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  image       TEXT,
  verified_me BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_catalog_name_lower
  ON collection_catalog (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_collection_catalog_verified
  ON collection_catalog (verified_me);
