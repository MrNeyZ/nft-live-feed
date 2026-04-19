import { RawSolanaTx, RawTokenBalance } from './types';
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
 * - For AMM trades, the "seller" may be the pool escrow rather than the
 *   human owner — verify in live testing and override at the call site
 *   if account positions are known for a specific instruction.
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
