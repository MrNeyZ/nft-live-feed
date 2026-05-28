-- Per-mint resize-status cache for the Live Feed RESIZE badge.
--
-- Populated by src/mints/resize-status-resolver.ts via on-demand,
-- prefilter-gated getSignaturesForAddress + bounded getTransaction
-- walks. NEVER backfilled in bulk — only mints that appear in
-- prefilter-matching live sales get scheduled for a lookup, so the
-- universe is bounded by live operator traffic.
--
-- status enum (TEXT-encoded; UI only acts on 'metaplex_resized_unclaimed'):
--   'none'                          → no signal found
--   'metaplex_resized_unclaimed'    → ResizebfwTEZ-signed TM Resize ix seen,
--                                     no RSZE claim seen   (BADGE)
--   'claimed'                       → Both ResizebfwTEZ resize AND RSZE claim
--                                     seen for this mint
--   'user_resized'                  → RSZE claim seen but no ResizebfwTEZ resize
--                                     (direct/old path)
--
-- resized_sig / resized_at_ms: first Metaplex-resize tx we observed
-- claimed_sig / claimed_at_ms: first RSZE DistributeToLegacyNft tx we observed
-- checked_at_ms: wall-clock at last resolution (for telemetry; we don't
--                re-check positive resolutions, but a future TTL on
--                'none' could use this).

CREATE TABLE IF NOT EXISTS mint_resize_status (
  mint           TEXT       PRIMARY KEY,
  status         TEXT       NOT NULL,
  checked_at_ms  BIGINT     NOT NULL,
  resized_sig    TEXT,
  resized_at_ms  BIGINT,
  claimed_sig    TEXT,
  claimed_at_ms  BIGINT
);
