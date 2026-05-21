-- Visual subtype marker for the live feed: Core Candy Machine v3 / Core Candy
-- Guard launchpad mints. Semantics stay CORE; the frontend tints the CORE badge
-- pink. Persisted so the feed replay (hydrated from this table on boot) keeps
-- the subtype across restarts.
ALTER TABLE mint_events
  ADD COLUMN IF NOT EXISTS core_launchpad BOOLEAN NOT NULL DEFAULT false;
