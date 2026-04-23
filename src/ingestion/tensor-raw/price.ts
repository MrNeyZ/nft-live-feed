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
import { RawSolanaTx } from './types';
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
 * Derive the cNFT asset ID from the Bubblegum `transfer` inner CPI that TComp
 * emits when settling a compressed-NFT sale. The raw `getTransaction` response
 * we already paid for carries every field we need, so we derive locally rather
 * than issuing a paid Helius `v0/transactions` parsed-tx call.
 *
 *     asset_id = PDA(["asset", merkle_tree, u64_le(nonce)], Bubblegum)
 *
 * Bubblegum `transfer` layout:
 *   discriminator = sha256("global:transfer")[0..8]
 *   data: 8 disc | 32 root | 32 data_hash | 32 creator_hash | 8 nonce_le | 4 index
 *   accounts[4] = merkle_tree
 *
 * Returns null when no matching Bubblegum `transfer` inner instruction exists
 * (e.g. an unsupported ix variant). Callers must treat null as "asset id
 * unknown" and decide whether to drop the sale or insert with an empty mint.
 */
const BUBBLEGUM_TRANSFER_DISC = createHash('sha256')
  .update('global:transfer')
  .digest()
  .subarray(0, 8);
const BUBBLEGUM_PROGRAM_PK = new PublicKey(BUBBLEGUM_PROGRAM);
const ASSET_SEED = Buffer.from('asset');
/** Minimum byte length for a Bubblegum `transfer` ix data: 8+32+32+32+8+4. */
const BUBBLEGUM_TRANSFER_MIN_DATA_LEN = 116;

// Resolve an account index to its pubkey. `fetchRawTx` merges loadedAddresses
// into `accountKeys` before the parser runs, so entries are typically
// `{ pubkey }` objects; tests/bypass callers may pass raw strings.
function pubkeyAt(tx: RawSolanaTx, idx: number): string | null {
  const keys = tx.transaction.message.accountKeys as unknown as Array<string | { pubkey?: string } | undefined>;
  const k = keys[idx];
  if (typeof k === 'string') return k;
  if (k && typeof k === 'object' && typeof k.pubkey === 'string') return k.pubkey;
  return null;
}

export function extractCnftAssetId(tx: RawSolanaTx): string | null {
  const groups = tx.meta?.innerInstructions ?? [];
  for (const g of groups) {
    for (const ix of g.instructions) {
      const program = pubkeyAt(tx, ix.programIdIndex);
      if (program !== BUBBLEGUM_PROGRAM) continue;
      let data: Buffer;
      try { data = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
      if (data.length < BUBBLEGUM_TRANSFER_MIN_DATA_LEN) continue;
      if (!data.subarray(0, 8).equals(BUBBLEGUM_TRANSFER_DISC)) continue;
      const merkleIdx = ix.accounts[4];
      if (merkleIdx === undefined) continue;
      const merkle = pubkeyAt(tx, merkleIdx);
      if (!merkle) continue;
      const nonceBuf = Buffer.alloc(8);
      data.copy(nonceBuf, 0, 104, 112);
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [ASSET_SEED, new PublicKey(merkle).toBuffer(), nonceBuf],
          BUBBLEGUM_PROGRAM_PK,
        );
        return pda.toBase58();
      } catch { /* malformed merkle key — skip */ }
    }
  }
  return null;
}
