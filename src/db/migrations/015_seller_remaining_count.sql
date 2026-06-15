-- Durable seller-remaining-count for the Live Feed SELL badge.
--
-- Previously sellerRemainingCount existed ONLY as a transient live SSE
-- signal (`event: seller_count`), cached per-browser in localStorage. A
-- device that did not witness the live frame could never reconstruct it,
-- so the same sale showed the badge on one machine but not another.
--
-- This column persists the resolved count server-side so /api/events/latest
-- (and by-collection) can return it on every device/reload. Written
-- fire-and-forget from the seller_count resolution path in src/server/sse.ts
-- when the DAS lookup yields a finite count for a known signature. NULL when
-- never resolved (buy-side rows, unresolved collections, DAS misses) — the
-- frontend renders the badge only for finite counts >= 3, so NULL is safe.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so the run-all migration runner can
-- re-apply without error.

ALTER TABLE sale_events
  ADD COLUMN IF NOT EXISTS seller_remaining_count INT;
