/**
 * Resize / Claim tool — on-chain constants, PDA derivation and raw
 * instruction builders for the Metaplex "TM Resize" excess-SOL recovery.
 *
 * Two independent on-chain paths, both reverse-engineered from the
 * resize.metaplex.com frontend bundle (Sep 2026) and cross-checked against
 * live mainnet transactions:
 *
 *   1. mpl-token-metadata `Resize`  (discriminator 56)
 *        Shrinks an over-allocated Metadata (+ Master Edition) account and
 *        sends the freed rent straight to `payer`. Permissionless-ish: the
 *        holder signs as `authority` and passes their token account. Only
 *        works while the account is still oversized (else program error 201
 *        `AccountAlreadyResized`). Used here only as the fallback for the
 *        rare NFT that is NOT a leaf in the distribution merkle tree.
 *
 *   2. mplDistro `DistributeToLegacyNft`  (discriminator 5)
 *        Program RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4. Pays a fixed
 *        per-NFT amount in wSOL from the "TM Resize" distribution vault,
 *        gated by a keccak merkle proof (leaf keyed by NFT mint, NOT by
 *        wallet — any current holder can claim). One-time per mint: a
 *        ClaimReceipt PDA is created and blocks re-claims (error 18
 *        `AlreadyClaimed`). This is the primary path — the vault is
 *        pre-funded for the whole 21.7M-leaf tree, so it works whether or
 *        not the metadata account has physically been resized yet.
 *
 * Distribution "TM Resize" (account 7mRLZe6K…, size 216):
 *   merkleRoot  00925f6e7b70c399186d93fc8cf953e39050324b4fadcedbc34d7030e7ffae299c
 *   treeHeight  25
 *   window      2025-08-13 → 2027-02-13
 *   mint        wSOL (the distribution pays in wSOL)
 *   seed        5UGyPp7c5Vf7KKSVEWZNPdNhRXbshKYN4ZuJjLiCG68s
 *
 * NOTHING here ever touches a private key — every function returns an
 * unsigned `TransactionInstruction`.
 */

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const MPL_DISTRO_PROGRAM_ID = new PublicKey('RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4');
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/** "TM Resize" distribution account (Distribution, size 216). */
export const TM_RESIZE_DISTRIBUTION = new PublicKey('7mRLZe6KxNcS27ABv3nxyr4TWTTEt4eY6svhXF25Sj6B');
/** Distribution mint — the distribution pays out in wrapped SOL. */
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
/** Shared address-lookup table used by resize.metaplex.com claim txs. */
export const CLAIM_ALT_ADDRESS = new PublicKey('73spkUGYUH5B1oPYQh7GxbfosDiLEEdqNnMHbL2mXhio');

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

// ── PDA derivation ─────────────────────────────────────────────────────────

/** Metadata PDA: ["metadata", tm program, mint]. */
export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

/** Master-edition PDA: ["metadata", tm program, mint, "edition"]. */
export function masterEditionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from('edition'),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/**
 * ClaimReceipt PDA — verified against live receipt CZZT47SB… :
 *   seeds = ["claim_receipt", distribution, nftMint, u64le(amount), u64le(nonce)]
 * `recipient` in the on-chain struct is the NFT mint for the legacy-NFT
 * instruction (not the wallet). nonce is always 0 for this distribution.
 */
export function claimReceiptPda(nftMint: PublicKey, amount: bigint, nonce = 0n): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('claim_receipt'),
      TM_RESIZE_DISTRIBUTION.toBuffer(),
      nftMint.toBuffer(),
      u64le(amount),
      u64le(nonce),
    ],
    MPL_DISTRO_PROGRAM_ID,
  )[0];
}

/** The distribution's wSOL vault = ATA(wSOL, distribution PDA) (off-curve owner). */
export function distributionVault(): PublicKey {
  return getAssociatedTokenAddressSync(WSOL_MINT, TM_RESIZE_DISTRIBUTION, true);
}

// ── Instruction builders ───────────────────────────────────────────────────

/**
 * mplDistro `DistributeToLegacyNft` (disc 5).
 *
 * data  = u8(5) ‖ u64le(amount) ‖ u32le(proof.len) ‖ proof[32]… ‖ u64le(nonce=0)
 * keys  = 13 accounts, order per the SDK builder:
 *   0  distribution               (w)
 *   1  mint            = wSOL      (r)
 *   2  claimReceipt PDA           (w)
 *   3  recipientTokenAccount = ATA(wSOL, nftOwner)   (w)
 *   4  distributionTokenAccount = vault              (w)
 *   5  nftMint                    (r)
 *   6  nftTokenAccount = ATA(nftMint, nftOwner)      (r)
 *   7  our builder's own choice: nftOwner (r). CORRECTION (2026-09-12
 *      hardening pass): 3 real historical mainnet transactions decode this
 *      slot as the mplDistro PROGRAM's own address, not the NFT owner's
 *      wallet — the original doc line above was wrong about what this
 *      account represents. A from-scratch read-only `simulateTransaction`
 *      of OUR builder's exact output (nftOwner at #7, unchanged) against a
 *      real live claim executed successfully end-to-end, proving the
 *      on-chain handler does not validate this slot's identity either way.
 *      Left as nftOwner here (harmless, and matches this file's existing
 *      account-derivation code) — see docs/resize-claim-audit-2026-09-12.md
 *      §8/§27 for the full evidence trail. Do not "fix" this slot to match
 *      the historical-tx value without re-verifying via simulation first.
 *   8  payer                      (w, signer)
 *   9  associatedTokenProgram     (r)
 *   10 tokenProgram               (r)
 *   11 systemProgram              (r)
 *   12 sysvarInstructions         (r)
 */
export function buildDistributeToLegacyNftIx(params: {
  nftMint: PublicKey;
  nftOwner: PublicKey;
  amount: bigint;
  proof: PublicKey[];
  payer?: PublicKey;
}): TransactionInstruction {
  const { nftMint, nftOwner, amount, proof } = params;
  const payer = params.payer ?? nftOwner;

  const proofBytes = Buffer.concat(proof.map((p) => p.toBuffer()));
  const data = Buffer.concat([
    Buffer.from([5]),
    u64le(amount),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(proof.length);
      return b;
    })(),
    proofBytes,
    u64le(0n),
  ]);

  const recipientWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, nftOwner, true);
  const nftAta = getAssociatedTokenAddressSync(nftMint, nftOwner, true);
  const claimReceipt = claimReceiptPda(nftMint, amount);

  return new TransactionInstruction({
    programId: MPL_DISTRO_PROGRAM_ID,
    keys: [
      { pubkey: TM_RESIZE_DISTRIBUTION, isSigner: false, isWritable: true },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: claimReceipt, isSigner: false, isWritable: true },
      { pubkey: recipientWsolAta, isSigner: false, isWritable: true },
      { pubkey: distributionVault(), isSigner: false, isWritable: true },
      { pubkey: nftMint, isSigner: false, isWritable: false },
      { pubkey: nftAta, isSigner: false, isWritable: false },
      { pubkey: nftOwner, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * mpl-token-metadata `Resize` (disc 56).  data = u8(56).
 * keys per the SDK builder:
 *   0 metadata       (w)
 *   1 edition        (w)   master edition PDA
 *   2 mint           (r)
 *   3 payer          (w, signer)   ← freed rent lands here
 *   4 authority      (r, signer)   ← NFT holder or update authority
 *   5 token          (r)           holder's NFT token account
 *   6 systemProgram  (r)
 */
export function buildResizeIx(params: {
  nftMint: PublicKey;
  holder: PublicKey;
  payer?: PublicKey;
}): TransactionInstruction {
  const { nftMint, holder } = params;
  const payer = params.payer ?? holder;
  const tokenAccount = getAssociatedTokenAddressSync(nftMint, holder, true);

  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPda(nftMint), isSigner: false, isWritable: true },
      { pubkey: masterEditionPda(nftMint), isSigner: false, isWritable: true },
      { pubkey: nftMint, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: holder, isSigner: true, isWritable: false },
      { pubkey: tokenAccount, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([56]),
  });
}

/**
 * Legacy full-size Metadata is 679 bytes; a resized one is ~607. Anything
 * comfortably above the midpoint is still un-resized. pNFT metadata is
 * larger but the same "shrunk vs not" gap holds, so the threshold is
 * generous.
 */
export const RESIZED_METADATA_MAX_SPACE = 640;
