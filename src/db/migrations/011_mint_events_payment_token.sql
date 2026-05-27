-- Custom-token mint payments. When a mint is priced in an SPL / Token-2022
-- token (not SOL), the SOL delta on the signer is just rent for the new
-- asset, not the actual price. These columns persist the real payment so
-- the Mint Tracker can render token amount + symbol + logo beside the
-- SOL-equivalent figure.
--
--   payment_mint     — token mint paid by the signer (NULL = SOL-priced)
--   payment_amount   — raw u64 amount as text (BIGINT is too small for
--                      some Token-2022 supplies; TEXT keeps precision)
--   payment_decimals — decimals for ui-amount conversion
--
-- Symbol / name / image are NOT persisted here — they come from a separate
-- in-process DAS cache (src/mints/payment-token-enricher.ts) keyed by
-- payment_mint and broadcast as `payment_token_meta` events.
ALTER TABLE mint_events
  ADD COLUMN IF NOT EXISTS payment_mint     TEXT,
  ADD COLUMN IF NOT EXISTS payment_amount   TEXT,
  ADD COLUMN IF NOT EXISTS payment_decimals INT;
