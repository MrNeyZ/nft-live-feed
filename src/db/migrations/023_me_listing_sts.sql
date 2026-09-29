-- ME (M2) listing index: mint → SellerTradeStateV2 address + seller.
--
-- The STS PDA is ["m2", seller, auctionHouse, tokenAccount, mint] and the
-- seller is not recoverable from DAS (a listed NFT is owned by ME's escrow
-- 1BWutm…). Once learned (ME /listings row, listing stream, or a per-mint
-- getProgramAccounts), the address lets every later collection open read
-- live prices with one getMultipleAccounts per 100 listings.
CREATE TABLE IF NOT EXISTS me_listing_sts (
  mint       TEXT PRIMARY KEY,
  sts        TEXT NOT NULL,
  seller     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
