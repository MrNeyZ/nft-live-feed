-- Persistent cache of on-chain collection creation timestamps.
--
-- Filled by `src/mints/collection-created-resolver.ts` which walks
-- `getSignaturesForAddress` backwards (paginated, MAX_PAGES capped) to
-- find the earliest signature touching the collection address, then
-- records that signature's blockTime. Drives the CREATED column of the
-- Mint Tracker.
--
-- created_at_ms = blockTime * 1000 of the oldest signature found
-- resolved_at_ms = wall-clock time we wrote the row (for telemetry +
--                  potential future re-resolution)
-- source        = which resolver path produced the value ('gsfa' today)

CREATE TABLE IF NOT EXISTS collection_created (
  collection_address TEXT        PRIMARY KEY,
  created_at_ms      BIGINT      NOT NULL,
  resolved_at_ms     BIGINT      NOT NULL,
  source             TEXT        NOT NULL DEFAULT 'gsfa'
);
