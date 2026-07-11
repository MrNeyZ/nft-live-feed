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
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import { RawSolanaTx, RawInstruction, resolveAccountKey } from './types';
import { TENSOR_FEE_ACCOUNT, BUBBLEGUM_PROGRAM } from './programs';

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

  // An NFT mint is identified by ANY accountIndex with a 1→0 or 0→1 transition
  // for that mint, under decimals=0. The previous scalar diff collapsed
  // per-mint instead of per-account — which fails on pool-style transfers
  // where the NFT moves between two ATAs: both snapshots carry amount=1 for
  // the mint (just on different accountIndexes), so the diff is 0 and the
  // true NFT was discarded. Symmetric to `extractPartiesFromTokenFlow` below.
  const allMints = new Set([...pre.map((b) => b.mint), ...post.map((b) => b.mint)]);

  for (const mint of allMints) {
    const sample = pre.find((b) => b.mint === mint) ?? post.find((b) => b.mint === mint);
    if (sample?.uiTokenAmount.decimals !== 0) continue; // fungible → skip

    const accountIndexes = new Set<number>([
      ...pre .filter((b) => b.mint === mint).map((b) => b.accountIndex),
      ...post.filter((b) => b.mint === mint).map((b) => b.accountIndex),
    ]);
    for (const idx of accountIndexes) {
      const preEntry  = pre .find((b) => b.mint === mint && b.accountIndex === idx);
      const postEntry = post.find((b) => b.mint === mint && b.accountIndex === idx);
      const preAmt  = parseInt(preEntry?.uiTokenAmount.amount  ?? '0', 10);
      const postAmt = parseInt(postEntry?.uiTokenAmount.amount ?? '0', 10);
      if ((preAmt === 1 && postAmt === 0) || (preAmt === 0 && postAmt === 1)) return mint;
    }
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

// ─── cNFT price extraction ───────────────────────────────────────────────────

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** System program Transfer instruction type (u32 LE = 2). */
const SYSTEM_TRANSFER_TYPE = 2;
/**
 * Byte offset of `maxAmount` (u64 LE) within a TComp `buy` instruction for
 * compressed NFTs (discriminator `66063d1201daebea`, data_len=107).
 *
 * Layout confirmed from on-chain tx
 * 3xZAvr4oW2TAZ6VCMYK8k7So9Pw6tjoXkJprabdUKUkDSwN4A4QLMEkzuVCbdGK1iV3bFMffTYiStnQpz3eG31WF:
 *   0   disc     (8)
 *   8   nonce    (u64, 8)
 *   16  index    (u32, 4)
 *   20  root     ([u8;32], 32)
 *   52  dataHash ([u8;32], 32)
 *   84  [12 bytes: version / optional fields]
 *   96  maxAmount (u64, 8)  ← this constant
 */
const TCOMP_BUY_MAX_AMOUNT_OFFSET = 96;

/**
 * For a TComp compressed-NFT (cNFT) buy, the transaction often contains
 * unrelated SOL transfers (listing-escrow closures, rent, etc.) that make
 * the standard "largest negative SOL delta" heuristic return the wrong price.
 *
 * Strategy:
 *   1. Decode maxAmount from the TComp `buy` instruction — it is the hard
 *      ceiling on what the buyer can pay for the sale (principal + fees).
 *   2. Walk all inner System Program Transfer instructions.
 *   3. Discard any transfer to the Tensor fee account (protocol fee).
 *   4. Discard any transfer whose amount exceeds maxAmount.
 *   5. The largest remaining transfer is the seller principal.
 *
 * Returns null when the instruction data is too short, no valid transfers
 * exist, or the derived price is zero.
 */
export function extractCnftPaymentInfo(
  tx: RawSolanaTx,
  tcompIx: RawInstruction,
): PaymentInfo | null {
  // 1. Read maxAmount from instruction data.
  let ixData: Buffer;
  try { ixData = Buffer.from(bs58.decode(tcompIx.data)); } catch { return null; }
  if (ixData.length < TCOMP_BUY_MAX_AMOUNT_OFFSET + 8) return null;
  const maxAmount = ixData.readBigUInt64LE(TCOMP_BUY_MAX_AMOUNT_OFFSET);
  if (maxAmount <= 0n) return null;

  // 2. Scan inner System Program Transfers.
  let bestAmount = 0n;
  let seller: string | null = null;
  // Buyer = fee payer = first account in the transaction.
  const buyer = resolveAccountKey(tx, 0);

  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (resolveAccountKey(tx, ix.programIdIndex) !== SYSTEM_PROGRAM) continue;
      let data: Buffer;
      try { data = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
      if (data.length < 12) continue;
      if (data.readUInt32LE(0) !== SYSTEM_TRANSFER_TYPE) continue;

      const amount = data.readBigUInt64LE(4);
      // 3. Reject Tensor protocol fee transfers.
      const recipient = resolveAccountKey(tx, ix.accounts[1]);
      if (recipient === TENSOR_FEE_ACCOUNT) continue;
      // 4. Reject amounts that exceed the sale ceiling.
      if (amount > maxAmount) continue;

      // 5. Track the largest qualifying transfer (= seller principal).
      if (amount > bestAmount) {
        bestAmount = amount;
        seller = recipient ?? null;
      }
    }
  }

  if (bestAmount <= 0n) return null;
  return { priceLamports: bestAmount, buyer, seller };
}

// ─── cNFT asset ID extraction ─────────────────────────────────────────────────

/**
 * Derive the cNFT asset ID from the Bubblegum `transfer` inner CPI that TComp
 * emits when settling a compressed-NFT sale.
 *
 * Previously this was a stub returning null, and `src/db/insert.ts` fell back
 * to a Helius `v0/transactions` parsed-tx call (1 credit per cNFT sale) to
 * recover the mint. The raw `getTransaction` response we already paid for
 * carries every field we need, so we derive locally:
 *
 *     asset_id = PDA(["asset", merkle_tree, u64_le(nonce)], Bubblegum)
 *
 * Bubblegum `transfer` layout:
 *   discriminator = sha256("global:transfer")[0..8]
 *   data: 8 disc | 32 root | 32 data_hash | 32 creator_hash | 8 nonce_le | 4 index
 *   accounts[4] = merkle_tree
 *
 * Returns null when no matching Bubblegum `transfer` inner instruction exists
 * (e.g. a future variant, or a layout change). Callers must treat null as
 * "asset id unknown" — the sale is still inserted with an empty mint, matching
 * the prior fallback-failure semantics.
 */
const BUBBLEGUM_TRANSFER_DISC = createHash('sha256')
  .update('global:transfer')
  .digest()
  .subarray(0, 8);
const BUBBLEGUM_PROGRAM_PK = new PublicKey(BUBBLEGUM_PROGRAM);
const ASSET_SEED = Buffer.from('asset');
/** Minimum byte length for a Bubblegum `transfer` ix data: 8+32+32+32+8+4. */
const BUBBLEGUM_TRANSFER_MIN_DATA_LEN = 116;

interface BubblegumTransferIx {
  /** Resolved pubkey strings for the instruction's accounts, in canonical
   *  order: [0]=tree_authority [1]=leaf_owner [2]=leaf_delegate
   *  [3]=new_leaf_owner [4]=merkle_tree [5]=log_wrapper
   *  [6]=compression_program [7]=system_program, then proof accounts. */
  accounts: string[];
  data: Buffer;
}

/**
 * Finds the Bubblegum `transfer` inner CPI that TComp emits when settling a
 * compressed-NFT sale — shared by asset-id derivation (extractCnftAssetId)
 * and party resolution (extractCnftLeafTransferParties) so both read the
 * exact same instruction. Fails closed (null) on any decode/shape mismatch
 * rather than guessing.
 */
function findBubblegumTransferIx(tx: RawSolanaTx): BubblegumTransferIx | null {
  const groups = tx.meta?.innerInstructions ?? [];
  for (const g of groups) {
    for (const ix of g.instructions) {
      const program = resolveAccountKey(tx, ix.programIdIndex);
      if (program !== BUBBLEGUM_PROGRAM) continue;
      let data: Buffer;
      try { data = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
      if (data.length < BUBBLEGUM_TRANSFER_MIN_DATA_LEN) continue;
      if (!data.subarray(0, 8).equals(BUBBLEGUM_TRANSFER_DISC)) continue;
      const accounts = ix.accounts.map((idx: number) => resolveAccountKey(tx, idx));
      if (accounts.some((a: string) => !a)) continue; // unresolved key — fail closed
      return { accounts, data };
    }
  }
  return null;
}

export function extractCnftAssetId(tx: RawSolanaTx): string | null {
  const found = findBubblegumTransferIx(tx);
  if (!found) return null;
  const merkle = found.accounts[4];
  if (!merkle) return null;
  const nonceBuf = Buffer.alloc(8);
  found.data.copy(nonceBuf, 0, 104, 112);
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [ASSET_SEED, new PublicKey(merkle).toBuffer(), nonceBuf],
      BUBBLEGUM_PROGRAM_PK,
    );
    return pda.toBase58();
  } catch {
    return null; // malformed merkle key
  }
}

export interface CnftLeafTransferParties {
  seller: string;
  buyer: string;
}

/**
 * Resolves cNFT buyer/seller from the SAME Bubblegum `transfer` inner CPI
 * `extractCnftAssetId` reads:
 *   accounts[1] = leaf_owner (old owner) = seller
 *   accounts[3] = new_leaf_owner (new owner) = buyer
 *
 * ⚠️ SCOPE: this is authoritative ONLY for cNFT `takeBid*` (bid-acceptance)
 * instructions, where the seller holds the cNFT directly in their own
 * wallet until accepting — confirmed bug (2026-07-11, asset CaixMh97…): the
 * bidder's own wallet moves 0 lamports in a takeBid fulfillment (funds were
 * locked in an earlier place-bid transaction), so a balance-delta heuristic
 * locks onto Tensor's TCMP-owned bid-state PDA instead and reports it as
 * "buyer"; the tree_authority PDA (accounts[0]) is likewise not the seller,
 * despite `sellerAcctIdx` guessing it is for some takeBid* variants.
 *
 * Do NOT use this for cNFT `buy` (fixed-price listing): there the cNFT
 * sits in an escrow/delegate structure from listing time, so accounts[1]
 * at transfer time is that ESCROW, not the human seller (verified: it
 * moves only a small rent-sized amount; the real sale proceeds land on a
 * different account via a separate System Transfer). The caller
 * (parseTcompSale) gates this correctly on `isBidAcceptance` — do not widen
 * that gate without re-verifying the listing-purchase flow on-chain first.
 *
 * Fails closed (null) when no valid Bubblegum transfer CPI is found or
 * accounts[1]/[3] can't be resolved — callers must NOT fall back to
 * account-index or balance-delta heuristics for cNFT takeBid party identity
 * in that case; treat it the same as "seller/buyer unknown".
 */
export function extractCnftLeafTransferParties(tx: RawSolanaTx): CnftLeafTransferParties | null {
  const found = findBubblegumTransferIx(tx);
  if (!found) return null;
  const seller = found.accounts[1];
  const buyer  = found.accounts[3];
  if (!seller || !buyer) return null;
  return { seller, buyer };
}
