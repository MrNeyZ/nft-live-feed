-- Running-counter cache for the /feed SELL badge (fixes the disappearing
-- / non-decrementing seller_remaining_count badge).
--
-- Root cause (2026-07-15): the badge's "fast path" resolved a fresh count
-- on EVERY sale via Helius `searchAssets(grouping=[collection,<addr>],
-- tokenType:'all')`'s aggregate `total` field. That field is unreliable
-- for MPL Core collections — confirmed live returning `1` for a wallet
-- that `getAssetsByOwner` (paginated, client-side grouping match) verified
-- held 29. The bad value got 4-min TTL-cached and reused across every sale
-- in that window (why the badge looked "frozen"), then a fresh (still
-- wrong) lookup on cache expiry dropped below the >=3 render threshold
-- (why it "disappeared").
--
-- Fix: scan a seller+collection's real holdings ONCE (via the reliable
-- `getAssetsByOwner` path, already used elsewhere as the exact-count
-- fallback) the first time we see a sale for that pair, then decrement it
-- by 1 in place on every subsequent sale via an atomic SQL UPDATE (see
-- `getAndDecrementSellerHolding` in seller-holdings.ts) — no further DAS
-- calls needed for that pair until a bounded reconciliation trigger
-- (TTL / suspicious-low-count / decrement-count — see that file). Single
-- source of truth for "how many of this collection does this wallet hold
-- right now," independent of `sale_events` (which stays a per-sale
-- historical log) and NOT authoritative between reconciliations — see
-- seller-holdings.ts's module doc comment for the drift limitations this
-- implies (missed sales, buys, transfers, DAS index lag).
--
-- decrements_since_scan: count of atomic decrements applied since the
-- last authoritative scan (reset to 0 whenever a scan seeds/corrects the
-- row). Drives the "reconcile after N decrements" policy without needing
-- a separate table or in-memory state that wouldn't survive a restart.

CREATE TABLE IF NOT EXISTS seller_holdings (
  seller                TEXT NOT NULL,
  collection_address    TEXT NOT NULL,
  count                 INT  NOT NULL,
  decrements_since_scan INT  NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seller, collection_address)
);
