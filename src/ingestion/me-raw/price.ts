import { RawSolanaTx, RawTokenBalance } from './types';
import { Currency } from '../../models/sale-event';
import {
  ME_V2_PROGRAM,
  ME_AMM_PROGRAM,
  SYSTEM_PROGRAM,
  SPL_TOKEN_PROGRAM,
  ATA_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  MPL_CORE_PROGRAM,
  TOKEN_AUTH_RULES_PROGRAM,
} from './programs';

// Program addresses whose balance changes are not buyer/seller SOL flows
const IGNORE_PROGRAMS = new Set([
  ME_V2_PROGRAM,
  ME_AMM_PROGRAM,
  SYSTEM_PROGRAM,
  SPL_TOKEN_PROGRAM,
  ATA_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  MPL_CORE_PROGRAM,
  TOKEN_AUTH_RULES_PROGRAM,
]);

// ─── SOL balance helpers ──────────────────────────────────────────────────────

export interface BalanceDelta {
  pubkey: string;
  pre: number;
  post: number;
  delta: number; // post - pre (negative = paid out, positive = received)
}

export function balanceDeltas(tx: RawSolanaTx): BalanceDelta[] {
  const keys = tx.transaction.message.accountKeys;
  const pre  = tx.meta?.preBalances  ?? [];
  const post = tx.meta?.postBalances ?? [];

  return keys.map((k, i) => ({
    pubkey: k.pubkey,
    pre:    pre[i]  ?? 0,
    post:   post[i] ?? 0,
    delta:  (post[i] ?? 0) - (pre[i] ?? 0),
  }));
}

/** Filter out program-owned and well-known infrastructure accounts. */
function isUserAccount(pubkey: string): boolean {
  return !IGNORE_PROGRAMS.has(pubkey);
}

// ─── Buyer / seller from SOL flow ────────────────────────────────────────────

export interface PaymentInfo {
  /** Account that paid the most SOL (largest decrease). Likely the buyer. */
  buyer: string;
  /** Account that received the most SOL (largest increase, excluding programs). Likely the seller. */
  seller: string;
  /**
   * Total SOL paid by the buyer in lamports.
   * Includes ME fee + royalties — this is what the buyer actually spent.
   */
  priceLamports: bigint;
}

/**
 * Infer buyer, seller, and price from SOL balance changes.
 *
 * This approach does not require knowledge of instruction account layouts,
 * making it robust across ME v2 and MMM even without a published IDL.
 *
 * Limitations:
 * - Cannot distinguish ME fee + royalty breakdown (fine for v1)
 * - CONFIRMED 2026-07-15 (not just theoretical): for MMM AMM `fulfillSell`
 *   trades (buyer pulls an NFT from a sell-side pool), the largest SOL
 *   recipient is the pool's SOL-payout wallet, NOT the human who deposited
 *   the specific NFT that sold — those are different accounts whenever the
 *   pool aggregates listings from more than one depositor. Verified against
 *   Magic Eden's own `/v2/tokens/{mint}/activities` API across 10+ live
 *   transactions spanning coreFulfillSell / solFulfillSell /
 *   solMip1FulfillSell / solExtFulfillSell — the real seller was always at
 *   a fixed instruction-account index (accounts[1]), never the largest SOL
 *   gainer. See the `sellerAcctIdx` overrides + comments on those four
 *   instructions in programs.ts. This function's `seller` field must NOT be
 *   used as a fallback for MMM `fulfillSell` — parser.ts's
 *   `poolSellAmbiguous` guard enforces that for any variant that hasn't had
 *   its seller position independently confirmed this way (currently just
 *   `solOcpFulfillSell`).
 */
export function extractPaymentInfo(tx: RawSolanaTx): PaymentInfo | null {
  const deltas = balanceDeltas(tx).filter((d) => isUserAccount(d.pubkey));
  if (deltas.length === 0) return null;

  // Largest SOL decrease → buyer
  const buyer = deltas.reduce((a, b) => (a.delta < b.delta ? a : b));
  // Largest SOL increase → seller (net recipient, e.g. seller after royalty split)
  const seller = deltas.reduce((a, b) => (a.delta > b.delta ? a : b));

  if (buyer.delta >= 0) return null; // nobody paid SOL
  const priceLamports = BigInt(Math.abs(buyer.delta));

  return {
    buyer:  buyer.pubkey,
    seller: seller.pubkey,
    priceLamports,
  };
}

// ─── NFT mint from token balance changes ─────────────────────────────────────

/**
 * Find the NFT mint that changed hands in this transaction.
 *
 * Strategy: find a token account in postTokenBalances with amount="1"
 * whose corresponding preTokenBalance has amount="0" (or is absent).
 * That token is the NFT being transferred.
 *
 * Works for legacy and pNFT (SPL token, decimals=0, supply=1).
 * Does NOT work for MPL Core assets (no SPL token involved).
 */
/**
 * Collect every NFT-like mint that appears with amount=1 in pre- or
 * post-token-balances. Intentionally permissive — covers sale (owner → buyer),
 * cancel/delist (escrow → owner), pool deposit (owner → pool PDA), pool
 * withdraw (pool PDA → owner). Direction-agnostic by design: the listings
 * store uses this only to flag potentially-affected collections for
 * debounced reconciliation, so false positives (an NFT sitting in a wallet
 * untouched by this tx but appearing in its accounts) are cheap — byMint
 * lookup is O(1) and no-op when the mint isn't tracked.
 */
export function extractNftMintsInvolved(tx: RawSolanaTx): string[] {
  const seen = new Set<string>();
  const entries = [
    ...(tx.meta?.preTokenBalances  ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ];
  for (const b of entries) {
    if (b.uiTokenAmount.decimals !== 0) continue;
    if (b.uiTokenAmount.amount !== '1') continue;
    seen.add(b.mint);
  }
  return Array.from(seen);
}

export function extractNftMint(tx: RawSolanaTx): string | null {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // Index pre-balances by accountIndex for fast lookup
  const preByIdx = new Map<number, RawTokenBalance>(pre.map((b) => [b.accountIndex, b]));

  for (const postBal of post) {
    if (postBal.uiTokenAmount.amount !== '1') continue;
    if (postBal.uiTokenAmount.decimals !== 0)  continue;

    const preBal = preByIdx.get(postBal.accountIndex);
    const preAmt = preBal?.uiTokenAmount.amount ?? '0';
    if (preAmt !== '0') continue; // wasn't zero before — not the transferred NFT

    return postBal.mint;
  }

  return null;
}

/**
 * Attempt to extract seller and buyer from token balance ownership changes.
 *
 * The token account that held the NFT before (amount=1) → seller's account → seller.
 * The token account that holds the NFT after  (amount=1) → buyer's account  → buyer.
 *
 * More precise than SOL flow for identifying parties, but requires `owner`
 * to be present in token balance entries (it is when using confirmed commitment).
 */
// ─── Currency detection ───────────────────────────────────────────────────────

/** USDC mint on Solana mainnet. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Detect whether an ME sale was priced in USDC rather than native SOL.
 *
 * ME v2's M2mx93ekt1fm… program supports SPL-token-denominated fixed-price
 * sales (`Deposit` → `BuyV2` → `ExecuteSaleV2`) alongside the far more common
 * SOL path — those carry a USDC token-balance leg instead of a System
 * transfer for the price. Detected by: any USDC entry present in
 * pre/postTokenBalances at all (the NFT itself never uses the USDC mint, so
 * no exclusion needed).
 *
 * The parser's `priceLamports` is read from the program's own settlement log
 * (`readMeV2PriceFromLogs`) regardless of currency — it's already the correct
 * raw base-unit amount, it just needs the right decimal count to display
 * (`currencyDecimals` below). Ported from the equivalent Helius-enhanced-path
 * check in `ingestion/helius/parser.ts`'s `detectCurrency`, which only the
 * (currently standby) webhook path had.
 *
 * Verified on sig 4XZCKv11yiP8ZStvK3UsiUg7xA5Zdr5UWo5ETgUTq8BTke9guYs2wQD6zNZQbeZJqZasjbVzoZVdcg7Wqmem9BLk:
 * 99_800_000 raw ÷ 10^6 = 99.8 USDC (was showing as 0.0998 SOL — wrong
 * currency AND ~150x off).
 */
export function detectSaleCurrency(tx: RawSolanaTx): Currency {
  const entries = [
    ...(tx.meta?.preTokenBalances  ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ];
  return entries.some((b) => b.mint === USDC_MINT) ? 'USDC' : 'SOL';
}

/** Decimal count for converting a currency's raw base-unit amount to its
 *  display value. SOL/lamports = 9, USDC = 6. */
export function currencyDecimals(currency: Currency): number {
  return currency === 'USDC' ? 6 : 9;
}

export function extractPartiesFromTokenFlow(
  tx: RawSolanaTx,
  mint: string
): { seller: string | null; buyer: string | null } {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const preHolder  = pre .find((b) => b.mint === mint && b.uiTokenAmount.amount === '1');
  const postHolder = post.find((b) => b.mint === mint && b.uiTokenAmount.amount === '1');

  return {
    seller: preHolder?.owner  ?? null,
    buyer:  postHolder?.owner ?? null,
  };
}
