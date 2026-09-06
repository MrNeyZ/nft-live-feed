-- Per-mint cache for the /feed RENT dot (SIMD-0437 rent-refund availability).
--
-- SIMD-0437 (mainnet, phased from ~2026-09) lowers `lamports_per_byte` for
-- token/mint accounts in five steps. Accounts funded before a step now hold
-- MORE than the new rent-exempt minimum — a skimmable surplus the holder can
-- withdraw (WithdrawExcessLamports, p-token ix 38) WITHOUT closing the account.
--
-- The /feed "RENT" dot flags NFTs whose mint account still carries that
-- un-skimmed surplus (funded pre-reduction, never withdrawn). Detection is a
-- single getAccountInfo on the mint: `lamports - minRentExempt(space) > dust`.
-- Cheap enough that this resolver runs 1 RPC/mint (vs the resize resolver's
-- up-to-11) — no signature history walk needed.
--
-- status:
--   'has_refund' — mint account holds surplus over the CURRENT rent minimum
--   'none'       — no surplus (already skimmed, or minted post-reduction at
--                  the lowered rate)
--
-- Both states are TTL-rechecked (see RECHECK_TTL_MS in the resolver): a
-- 'none' can flip to 'has_refund' as later SIMD steps lower the minimum
-- further; a 'has_refund' can flip to 'none' once the holder skims it.
-- surplus_lamports is the last observed surplus (display/debug only).

CREATE TABLE IF NOT EXISTS mint_rent_refund_status (
  mint             TEXT PRIMARY KEY,
  status           TEXT   NOT NULL,
  surplus_lamports BIGINT NOT NULL DEFAULT 0,
  checked_at_ms    BIGINT NOT NULL
);
