/**
 * Price and party extraction for Tensor transactions.
 *
 * ⚠️ ALL extraction logic here is unverified against live Tensor transactions.
 * The SOL-balance-delta approach is the same technique used in the ME raw parser
 * and should generalise, but the specific account indices and fee-account filters
 * need confirmation from ground-truth signatures.
 *
 * Key open questions (annotated where relevant):
 *   1. What is Tensor's fee / treasury account address?
 *      (placeholder: '' — will never accidentally match)
 *   2. For cNFTs: how is the asset ID encoded in TComp instructions?
 *      (merkle tree + leaf index → asset ID derivation, or direct account reference)
 *   3. For TSwap pool buys: is price the total SOL out, or is there a royalty split?
 */
import { RawSolanaTx } from './types';
import { TENSOR_FEE_ACCOUNT } from './programs';

// ─── SOL balance delta ────────────────────────────────────────────────────────

interface PaymentInfo {
  priceLamports: bigint;
  /** Account that received the largest net SOL increase (candidate seller). */
  seller: string | null;
  /** Account that had the largest net SOL decrease (candidate buyer). */
  buyer: string | null;
}

/**
 * Derive sale price and candidate buyer/seller from SOL balance changes.
 *
 * Strategy: same as ME raw parser — find the account with the largest net SOL
 * *decrease* (buyer paid) and the largest net SOL *increase* (seller received).
 * The Tensor fee account (if known) is excluded from consideration.
 *
 * ⚠️ UNVERIFIED: TENSOR_FEE_ACCOUNT is currently empty-string placeholder.
 *    Until it's populated, all accounts are candidates — which may cause the
 *    fee account to be incorrectly identified as the seller on some transactions.
 *    Confirm the fee address from a live tx and update programs.ts.
 *
 * ⚠️ UNVERIFIED: For TSwap pool buys, the "seller" in SOL-flow terms is likely
 *    the pool vault PDA (receives SOL from buyer), not the pool owner wallet.
 *    The pool owner wallet may be a different account. This will need per-
 *    instruction account-layout verification once ground-truth txs are available.
 */
export function extractPaymentInfo(tx: RawSolanaTx): PaymentInfo | null {
  const pre  = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  const keys = tx.transaction.message.accountKeys;

  if (!pre || !post || pre.length !== post.length) return null;

  // Compute net SOL delta per account
  const deltas: Array<{ pubkey: string; delta: bigint }> = [];
  for (let i = 0; i < pre.length; i++) {
    const pubkey = keys[i]?.pubkey;
    if (!pubkey) continue;
    if (pubkey === TENSOR_FEE_ACCOUNT) continue; // exclude fee account once known
    deltas.push({ pubkey, delta: BigInt(post[i]) - BigInt(pre[i]) });
  }

  const decreases = deltas.filter((d) => d.delta < 0n).sort((a, b) =>
    a.delta < b.delta ? -1 : 1 // most negative first
  );
  const increases = deltas.filter((d) => d.delta > 0n).sort((a, b) =>
    b.delta > a.delta ? 1 : -1 // largest first
  );

  const buyer  = decreases[0]?.pubkey ?? null;
  const seller = increases[0]?.pubkey ?? null;

  // Price = absolute value of the largest decrease (what the buyer paid out)
  const priceLamports = decreases[0] ? -decreases[0].delta : 0n;

  if (priceLamports <= 0n) return null;
  return { priceLamports, buyer, seller };
}

// ─── Standard SPL NFT mint extraction ────────────────────────────────────────

/**
 * Find the NFT mint from SPL token balance changes.
 *
 * Looks for a token account whose balance changes between 0→1 (buyer receives)
 * or 1→0 (seller sends), with decimals=0 — the SPL token standard for NFTs.
 *
 * ⚠️ Works for legacy and pNFT TSwap trades.
 * Does NOT work for cNFTs — they have no SPL token balance.
 * Does NOT work for MPL Core — no SPL token balance either.
 */
export function extractNftMint(tx: RawSolanaTx): string | null {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // Find mints that changed from 1→0 (send) or 0→1 (receive)
  const allMints = new Set([...pre.map((b) => b.mint), ...post.map((b) => b.mint)]);

  for (const mint of allMints) {
    const preBal  = pre.find((b)  => b.mint === mint);
    const postBal = post.find((b) => b.mint === mint);

    const preAmt  = parseInt(preBal?.uiTokenAmount.amount  ?? '0', 10);
    const postAmt = parseInt(postBal?.uiTokenAmount.amount ?? '0', 10);
    const dec = preBal?.uiTokenAmount.decimals ?? postBal?.uiTokenAmount.decimals ?? -1;

    if (dec !== 0) continue; // not an NFT token (fungible tokens have decimals > 0)
    if (Math.abs(postAmt - preAmt) === 1) return mint;
  }

  return null;
}

/**
 * Find buyer and seller from SPL token balance changes for a given mint.
 *
 * ⚠️ Same caveat as extractNftMint: SPL-only, does not cover cNFTs or Core.
 */
export function extractPartiesFromTokenFlow(
  tx: RawSolanaTx,
  mint: string
): { seller: string | null; buyer: string | null } {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  let seller: string | null = null;
  let buyer:  string | null = null;

  for (const postBal of post) {
    if (postBal.mint !== mint) continue;
    const preBal = pre.find(
      (b) => b.mint === mint && b.accountIndex === postBal.accountIndex
    );
    const preAmt  = parseInt(preBal?.uiTokenAmount.amount  ?? '0', 10);
    const postAmt = parseInt(postBal.uiTokenAmount.amount  ?? '0', 10);

    if (preAmt === 0 && postAmt === 1) buyer  = postBal.owner ?? null;
    if (preAmt === 1 && postAmt === 0) seller = postBal.owner ?? null;
  }

  return { seller, buyer };
}

// ─── cNFT asset ID extraction ─────────────────────────────────────────────────

/**
 * Attempt to extract the cNFT asset ID for a TComp transaction.
 *
 * ⚠️ STUB — NOT IMPLEMENTED.
 *    cNFT asset IDs are derived from a Merkle tree + leaf index; they do not
 *    appear as SPL token balances. The encoding in TComp instruction data or
 *    accounts is not yet confirmed from live transactions.
 *
 *    Once a ground-truth TComp cNFT sale signature is provided, inspect:
 *      - instruction accounts: which index holds the Merkle tree address?
 *      - instruction data: is the leaf index encoded in the data payload?
 *      - Bubblegum inner instruction accounts: the asset ID may be derivable from
 *        the Bubblegum `transfer` inner instruction.
 *
 * Returns null until implemented — the parser will emit ok:false for cNFT sales
 * until this is filled in.
 */
export function extractCnftAssetId(
  _accounts: string[],
  _ixData: Buffer
): string | null {
  // TODO: implement after verifying account layout from live TComp cNFT sale tx
  return null;
}
