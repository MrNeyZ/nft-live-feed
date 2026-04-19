-- Stores polling cursors so the poller survives restarts without gaps.
-- Key is "{programAddress}:{transactionType}" (e.g. "M2mx93....:NFT_SALE").
CREATE TABLE IF NOT EXISTS poller_state (
  cursor_key   TEXT        PRIMARY KEY,
  last_sig     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
