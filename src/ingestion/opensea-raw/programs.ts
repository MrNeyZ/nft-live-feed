/**
 * OpenSea (OS2) marketplace program registry.
 *
 * OS2 is OpenSea's own Solana NFT marketplace program, launched ~2026-08-30
 * (https://x.com/opensea/status/2094547650502631836). NOT a routing/
 * aggregation layer over ME/Tensor/Orbis — reverse-engineered and confirmed
 * 2026-09-01: an NFT literally named "OS2 Test pNFT" (OpenSea's own internal
 * test asset, collection FGngQpEu3QF57dYaMXLFdbuBUJRD18uYLA7SRA5SCXo1) traded
 * through this exact program ID. No published IDL exists yet.
 *
 * Verified from live tx sampling 2026-09-01 (222 txs / ~3h mainnet window,
 * 34 distinct mints across ~10 collections incl. BoDoggos, Claynosaurz,
 * Bulltoshi, Galactic Gecko): instruction names read straight off
 * `Program log: Instruction: <name>` Anchor dispatch logs — same technique
 * as the Tensor/Orbis prefilters, no account-layout knowledge required for
 * instruction identification. Fee split observed on both sale collections:
 * a fixed 1% platform-fee wallet (A9NtWg7cNxhkFdcZNsEHyJnU9pUVZL36DsUruBBEWbG5)
 * off the top, remainder split seller/royalty same as ME/Tensor.
 */

/** OpenSea's Solana (OS2) marketplace program. */
export const OPENSEA_PROGRAM = '7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V';

/** All OpenSea program addresses. Used for the listener WS prefilter. */
export const OPENSEA_PROGRAMS = new Set([OPENSEA_PROGRAM]);

/**
 * OpenSea (OS2) SALE instruction names, lowercased to match the listener's
 * case-folded `Program log: Instruction: <name>` prefilter.
 *
 *   buyCore       ✅ VERIFIED — 10 live Bulltoshi sales (0.15–0.60 SOL),
 *                 cross-checked against Magic Eden's floor for the collection.
 *   buyLegacy     ✅ VERIFIED — 3 live BoDoggos/Cet sales (0.40–1.10 SOL).
 *   buyCoreSpl    ⚠️ UNVERIFIED — only near-zero/test-value examples seen so
 *                 far (SPL/USDC-denominated Core buy). Parser currently prices
 *                 it off the SOL balance delta like every other path, which
 *                 will read near-zero/wrong for a real SPL-priced sale —
 *                 revisit once a real-value example appears.
 *   takeBidLegacy ⚠️ UNVERIFIED — single near-zero/test example (bid accept).
 *
 * NOT sales (parser must ignore): listCore / listLegacy / list / delistCore /
 * delistLegacy / edit / bid / cancelBid / closeExpiredBid / replaceLeaf.
 */
export const OPENSEA_SALE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'buycore',
  'buylegacy',
  'buycorespl',
  'takebidlegacy',
]);
