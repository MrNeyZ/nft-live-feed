/**
 * Orbis marketplace program registry.
 *
 * Orbis is an MPL-Core-first Solana NFT marketplace. Listings are
 * delegate-mode (the asset is frozen in the seller's wallet with the
 * marketplace PDA approved as freeze + transfer delegate) — there is NO
 * escrow and NO separate "collect"/settlement step. The buy instruction
 * (`BuyCoreV2` for Core, `BuyNft` for legacy SPL) atomically thaws,
 * transfers seller→buyer, and pays out seller + royalty + platform fee in a
 * single transaction. That buy tx is therefore the canonical SALE event.
 *
 * Verified 2026-06-10 from live txs (reference buy
 * 4SJAFxSVcidGkJQj2VvEKPEzBEbpP5w8vfcNVXXPNJ5ZYFRLaGHNcy2ZgLWUhehfTNLkvprUzAncnquwt5AqFESw):
 *   - program id confirmed present in every Orbis list/buy/delist/offer tx.
 *   - BuyCoreV2 + BuyNft both emit a deterministic settlement log:
 *       "Core NFT <mint> sold for <lamports> lamports (delegate mode). Seller: <s>, Buyer: <b>"
 *       "NFT <mint> sold for <lamports> lamports. Seller: <s>, Buyer: <b>"
 *     Sale-instruction count matched the "sold for" log count exactly (8/8).
 *
 * NOT sales (parser must ignore): ListCoreV2 / ListNft / DelistCoreV2 /
 * DelistNft / UpdatePrice / MakeCollectionOfferV2 / CancelCollectionOfferV2.
 * Offer-acceptance (bid settlement) is NOT implemented — no verified on-chain
 * example was observed; add it only once a real tx is captured.
 */

/** Orbis marketplace program. */
export const ORBIS_PROGRAM = '2kmsyJ3oZHpk1Qwp4U5X4nm7KPBJrbaXdKyZYc166s6Q';

/** All Orbis program addresses. Used for the listener WS prefilter. */
export const ORBIS_PROGRAMS = new Set([ORBIS_PROGRAM]);

/**
 * Verified Orbis SALE instruction names, lowercased to match the listener's
 * case-folded `Program log: Instruction: <name>` prefilter. Only the two
 * confirmed buy paths — everything else is a non-sale (list/delist/offer/etc.)
 * and must not reach the parser as a sale.
 */
export const ORBIS_SALE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'buycorev2', // MPL Core listing purchase  → nftType 'core'
  'buynft',    // legacy SPL listing purchase → nftType 'legacy'
]);
