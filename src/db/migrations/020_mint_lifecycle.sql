-- Stage 3 (Mint Lifecycle analytics): efficient per-mint lookups against
-- mint_events, and durable storage for the earliest-observed listing
-- moment — something nothing in the existing schema captures. The
-- listings-store snapshot is replaced wholesale on every refresh, and even
-- ME/Tensor's own "listedAt" reflects the MOST RECENT list event per mint
-- (list -> delist -> relist cycles collapse to the latest), not the first
-- one since mint. Neither source is a substitute for a monotonic record.

-- mint_events' only existing index touching mint_address is the composite
-- UNIQUE (signature, mint_address) (mint_events_sig_mint_uq) — signature-
-- leading, so it cannot serve a `WHERE mint_address = $1` lookup
-- efficiently (Postgres cannot use a signature-first B-tree to seek by the
-- second column alone; it degrades to a full index/table scan). A
-- dedicated index makes the mint-lifecycle correlation lookup cheap.
CREATE INDEX IF NOT EXISTS mint_events_mint_address_idx
  ON mint_events (mint_address);

-- Earliest-observed "this mint is listed" moment, keyed by mint_address.
-- A small companion table, NOT additive columns on mint_events — mint_events
-- does not guarantee one row per mint (its unique key is the (signature,
-- mint_address) PAIR), so a per-mint fact does not belong on that table.
-- `first_listed_at_ms` only ever moves EARLIER, via the LEAST()-based
-- upsert in src/analytics/mint-lifecycle.ts (recordFirstListedAtObservation)
-- — later observations can never overwrite an earlier timestamp. Derived
-- durations (mint->listing, mint->sale, listing->sale) are intentionally
-- NOT stored anywhere; they're computed on read from this table plus
-- mint_events/sale_events timestamps.
CREATE TABLE IF NOT EXISTS mint_first_listed (
  mint_address       TEXT        PRIMARY KEY,
  first_listed_at_ms BIGINT      NOT NULL,
  -- 'exact' (a real list-transaction timestamp — ME /activities?type=list
  -- or Tensor listing.txAt) vs 'approximate' (ME's buyNow-fallback
  -- surrogate for pool-hosted listings, which has no per-mint list event
  -- of its own) vs 'unknown' (defensive default; the write path always
  -- passes an explicit quality, so this should not occur in practice).
  quality            TEXT        NOT NULL DEFAULT 'unknown',
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
