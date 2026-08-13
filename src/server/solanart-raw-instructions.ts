/**
 * Raw, on-chain Solanart marketplace instruction builder + offer decoder.
 * Solanart (solanart.io) has been offline since ~2022 (Cloudflare 521 /
 * Always-Online serving a 2022 Wayback snapshot; `api.solanart.io` and
 * `rpc.solanart.io` no longer resolve at all) — there is no API to call.
 * The on-chain program, however, is very much alive: real accept-offer
 * transactions are still landing (e.g. `4HSboGE9…` and `5cw1WWcm…`,
 * both 2026-08), and thousands of old bid escrows from 2021-2022 are still
 * funded and untouched — this module lets a seller accept one directly.
 *
 * Every discriminator / account role / PDA seed below is evidence-backed
 * (cross-validated against TWO independent real historical accept-offer
 * transactions for two different collections, mints, buyers and sellers —
 * not guessed):
 *
 *   1. `4HSboGE91GwzQmd2c5XzaVTed5XMHZtLvaqBcFvzphQBwtTt5EmNFXgcn7H2GQWJnPAV5PLFXk7BbtCwxyVS5Ht7`
 *      — Meerkat Millionaires Country Club #9369, sold for 6 SOL.
 *   2. `5cw1WWcmL2x3hGEyDvXkxmzKjaXbGbxPfHHxBq384Bi9ZmQK1sEZK83ESKf5o7h5DVtL1n4dyFGgwPCgDGGt13Le`
 *      — a different collection/mint/buyer/seller entirely.
 *
 * For BOTH transactions, every one of the 23 instruction accounts was
 * independently re-derived from public inputs (mint / seller / buyer / the
 * mint's own on-chain Metaplex creators array) and matched the real
 * transaction's account list byte-for-byte:
 *   - seller ATA / buyer ATA          → standard Associated Token Account
 *   - metadata / master edition       → standard Metaplex PDAs
 *   - seller / buyer token_record     → standard Metaplex pNFT PDAs
 *   - the two "unknown" writable accounts turned out to be `creators[0]`
 *     and `creators[1]` read directly off the mint's ON-CHAIN Metaplex
 *     metadata account (NOT the off-chain JSON's `properties.creators`,
 *     which can differ) — royalty distribution accounts, required by the
 *     Token Metadata `TransferV1` CPI this program makes.
 *   - `FoN96i4k…` (marketplace fee wallet) and `eBJLFYPx…` (the Auth Rules
 *     ruleset account passed to the Token Auth Rules `Validate` CPI) were
 *     IDENTICAL across both — different collections, different mints —
 *     confirming they are fixed, not per-collection.
 *   - position 10 (initially misidentified as a field read off the offer
 *     record — that guess produced `InvalidAccountData` when simulated
 *     against a real live offer) is actually the SELLER's stake-account
 *     PDA under Solanart's staking program `7gDpaG9k…`: seeds
 *     `["nft", seller]`. Formula confirmed via the published
 *     `solanart-global-offer` npm package (a Solita/Anchor-generated
 *     client for Solanart's newer parallel "Global Offer" program,
 *     `Gov2UZUUffrk1CYYSJu943sM6jAMF31zGz8uJywQKziY` — a DIFFERENT program
 *     from the one this module targets, but its `getStakeAccount()` helper
 *     reuses the same staking program/seeds), then cross-validated
 *     byte-exact against BOTH reference transactions' actual position-10
 *     value for their respective (different) sellers, and end-to-end
 *     against a real currently-open live offer via `simulateTransaction`
 *     (`err: null`, "NFT sold for 2 SOL", full success).
 *
 * This module covers BOTH the pNFT and legacy accept-offer paths.
 *
 * The legacy path (`buildAcceptOfferIxLegacy`) is evidence-backed the same
 * way — cross-validated byte-exact against TWO independent real historical
 * legacy accept-offer transactions (different mints/sellers/buyers/creator
 * counts):
 *   1. `ShuzRVZhY7Cs2MJLskCQ8NQxoPTqJ83CDVP1oY5roGsgf8shBGKLEvd4zT5rtXgZEpd3rQnZ9eTsmtMa73uE87c`
 *      — sold for 125 SOL, 5 creators, 25 total accounts.
 *   2. `4uenMRyTsfcSE93JtTVN2dN97vi27Qwp2TVaz7jRnnE59fGJQVnbox2xJSvDHN3Dy3MWPgFEnsn9kZYHUjH1s7wV`
 *      — sold for 25 SOL, 3 creators, 23 total accounts.
 * For BOTH, all five derived accounts (metadata, seller stake account,
 * master edition, seller token_record, buyer token_record) matched the
 * real transaction byte-for-byte — token_record accounts are derived and
 * passed even though they never exist for a legacy mint (`getAccountInfo`
 * confirms `null`); the program layout is uniform across both paths, it
 * just doesn't read/write those slots for a legacy target.
 *
 * The legacy account list is **structurally identical to the pNFT one**
 * (found via `resolveTokenStandard`, same discriminator `2`, same fixed
 * prefix/creators/PDAs) with exactly two differences, both confirmed on
 * both reference transactions:
 *   1. No "buyer again" duplicate entry right after the creators block —
 *      the list goes straight from the last creator to `edition`.
 *   2. The final slot (`SOLANART_DEFAULT_RULESET` in the pNFT path, since
 *      pNFT transfers need an Auth Rules ruleset account) is instead a
 *      SECOND reference to the Token Metadata program itself — i.e. no
 *      real ruleset account, just the metadata program id passed again.
 *      Total account count is therefore `20 + creators.length`, one less
 *      than the pNFT path's `21 + creators.length`.
 *
 * ── Creator count ────────────────────────────────────────────────────────
 * Both reference transactions had exactly 2 on-chain creators, and the
 * creators are inserted as a contiguous block (positions 12..12+N-1) —
 * consistent with Metaplex's own `TransferV1` "creators as remaining
 * accounts" convention for royalty distribution, not a Solanart-specific
 * choice. This module builds the account list for N creators generically,
 * but has only been chain-verified for N=2. `buildAcceptOfferIxPnft`
 * always runs through the caller's own preflight simulation before any
 * signature is ever requested — a wrong creator count fails there, not
 * silently on-chain.
 */

import { PublicKey, TransactionInstruction, AccountMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export const SOLANART_PROGRAM_ID = new PublicKey('CJsLwbP1iu5DuUikHEJnLfANgKy6stB2uFgvBBHoyxwz');
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

/** Fixed constant across both cross-validated reference transactions
 *  (different collections/mints/buyers/sellers) — Solanart's own
 *  marketplace fee wallet. */
export const SOLANART_FEE_WALLET = new PublicKey('FoN96i4kNNA4oyPRk8vsG3Py4VEZXEm6nbk4Tff96Mhy');
/** Solanart's NFT-staking program — confirmed via the published
 *  `solanart-global-offer` npm package (a Solita/Anchor-generated client
 *  for Solanart's newer "Global Offer" program, which reuses this same
 *  staking program and account layout). Position 11 in the pNFT
 *  accept-offer instruction is this program's OWN id (read-only, fixed);
 *  position 10 is the SELLER's stake account PDA under it — see
 *  `deriveStakeAccount`, cross-validated exactly against two independent
 *  real accept-offer transactions for two different sellers. */
export const SOLANART_SECONDARY_PROGRAM = new PublicKey('7gDpaG9kUXHTz1dj4eVfykqtXnKq2efyuGigdMeCy74B');
export const STAKE_PROGRAM_ID = SOLANART_SECONDARY_PROGRAM;
export const TOKEN_AUTH_RULES_PROGRAM_ID = new PublicKey('auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg');
/** Fixed constant across both cross-validated reference transactions
 *  (different collections) — the Auth Rules ruleset account passed to the
 *  `Validate` CPI. Re-verify (via simulation, always run before signing)
 *  before trusting it for a brand-new, previously-unseen collection. */
export const SOLANART_DEFAULT_RULESET = new PublicKey('eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9');

export const OFFER_ACCOUNT_SIZE = 233;
const ACCEPT_OFFER_DISCRIMINATOR = 2;

export interface DecodedOffer {
  state: number;
  buyer: PublicKey;
  /** Unused during Accept Offer — only referenced at CreateOffer time. */
  field1: PublicKey;
  offerPubkeySelf: PublicKey;
  buyerTargetAta: PublicKey;
  escrowAuthority: PublicKey;
  priceLamports: bigint;
}

export function decodeOffer(data: Buffer): DecodedOffer {
  if (data.length !== OFFER_ACCOUNT_SIZE) {
    throw new Error(`unexpected_offer_account_size: expected ${OFFER_ACCOUNT_SIZE}, got ${data.length}`);
  }
  return {
    state: data[0],
    buyer: new PublicKey(data.subarray(1, 33)),
    field1: new PublicKey(data.subarray(33, 65)),
    offerPubkeySelf: new PublicKey(data.subarray(65, 97)),
    buyerTargetAta: new PublicKey(data.subarray(129, 161)),
    escrowAuthority: new PublicKey(data.subarray(193, 225)),
    priceLamports: data.readBigUInt64LE(225),
  };
}

export function deriveMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}
export function deriveEditionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('edition')],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}
export function deriveTokenRecordPda(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('token_record'), tokenAccount.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}
/** seeds = ["nft", staker], STAKE_PROGRAM_ID — confirmed byte-exact against
 *  two independent real sellers' accept-offer transactions. */
export function deriveStakeAccount(staker: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nft'), staker.toBuffer()],
    STAKE_PROGRAM_ID,
  )[0];
}

export interface OnChainCreator { address: PublicKey; verified: boolean; share: number }

/** Parses just enough of the Metaplex Metadata account to reach the
 *  `creators: Option<Vec<Creator>>` field — name/symbol/uri are
 *  variable-length Borsh strings that must be walked, not skipped. */
export function parseMetadataCreators(data: Buffer): OnChainCreator[] {
  let o = 1 + 32 + 32; // key + updateAuthority + mint
  function readStr(off: number): number {
    const len = data.readUInt32LE(off);
    return off + 4 + len;
  }
  o = readStr(o); // name
  o = readStr(o); // symbol
  o = readStr(o); // uri
  o += 2; // sellerFeeBasisPoints: u16
  const hasCreators = data[o]; o += 1;
  if (!hasCreators) return [];
  const n = data.readUInt32LE(o); o += 4;
  const creators: OnChainCreator[] = [];
  for (let i = 0; i < n; i++) {
    const address = new PublicKey(data.subarray(o, o + 32)); o += 32;
    const verified = data[o] !== 0; o += 1;
    const share = data[o]; o += 1;
    creators.push({ address, verified, share });
  }
  return creators;
}

export interface AcceptOfferPnftParams {
  seller: PublicKey;
  offer: PublicKey;
  offerData: DecodedOffer;
  mint: PublicKey;
  creators: OnChainCreator[];
}

/** Builds the pNFT Accept Offer instruction. Caller is responsible for
 *  having confirmed (via `resolveTokenStandard`) that this mint is
 *  actually a pNFT before calling this — a legacy mint will fail structural
 *  validation (missing token_record accounts) rather than silently
 *  building something wrong. */
export function buildAcceptOfferIxPnft(p: AcceptOfferPnftParams): TransactionInstruction {
  const sellerAta = getAssociatedTokenAddressSync(p.mint, p.seller, true);
  const buyerAta = getAssociatedTokenAddressSync(p.mint, p.offerData.buyer, true);
  const metadata = deriveMetadataPda(p.mint);
  const edition = deriveEditionPda(p.mint);
  const sellerTokenRecord = deriveTokenRecordPda(p.mint, sellerAta);
  const buyerTokenRecord = deriveTokenRecordPda(p.mint, buyerAta);
  const sellerStakeAccount = deriveStakeAccount(p.seller);

  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

  const keys: AccountMeta[] = [
    { pubkey: p.seller, isSigner: true, isWritable: true }, // 0
    w(p.offer), // 1
    w(p.offerData.buyer), // 2
    r(p.mint), // 3
    w(sellerAta), // 4
    w(buyerAta), // 5
    w(SOLANART_FEE_WALLET), // 6
    r(SYSTEM_PROGRAM_ID), // 7
    r(TOKEN_PROGRAM_ID), // 8
    w(metadata), // 9
    w(sellerStakeAccount), // 10 — seller's stake-program PDA, NOT the offer's stored field6
    r(SOLANART_SECONDARY_PROGRAM), // 11
    ...p.creators.map((c) => w(c.address)), // 12..12+N-1
    w(p.offerData.buyer), // buyer again (matches both reference txs)
    w(edition),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(TOKEN_METADATA_PROGRAM_ID),
    r(SYSVAR_INSTRUCTIONS_ID),
    w(sellerTokenRecord),
    w(buyerTokenRecord),
    r(TOKEN_AUTH_RULES_PROGRAM_ID),
    r(SOLANART_DEFAULT_RULESET),
  ];

  const data = Buffer.alloc(9);
  data.writeUInt8(ACCEPT_OFFER_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.offerData.priceLamports, 1);

  return new TransactionInstruction({ programId: SOLANART_PROGRAM_ID, keys, data });
}

export interface AcceptOfferLegacyParams {
  seller: PublicKey;
  offer: PublicKey;
  offerData: DecodedOffer;
  mint: PublicKey;
  creators: OnChainCreator[];
}

/** Builds the legacy (non-pNFT) Accept Offer instruction — see module
 *  header for the full evidence trail. Caller is responsible for having
 *  confirmed (via `resolveTokenStandard`) that this mint is actually
 *  legacy before calling this. */
export function buildAcceptOfferIxLegacy(p: AcceptOfferLegacyParams): TransactionInstruction {
  const sellerAta = getAssociatedTokenAddressSync(p.mint, p.seller, true);
  const buyerAta = getAssociatedTokenAddressSync(p.mint, p.offerData.buyer, true);
  const metadata = deriveMetadataPda(p.mint);
  const edition = deriveEditionPda(p.mint);
  const sellerTokenRecord = deriveTokenRecordPda(p.mint, sellerAta);
  const buyerTokenRecord = deriveTokenRecordPda(p.mint, buyerAta);
  const sellerStakeAccount = deriveStakeAccount(p.seller);

  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

  const keys: AccountMeta[] = [
    { pubkey: p.seller, isSigner: true, isWritable: true }, // 0
    w(p.offer), // 1
    w(p.offerData.buyer), // 2
    r(p.mint), // 3
    w(sellerAta), // 4
    w(buyerAta), // 5
    w(SOLANART_FEE_WALLET), // 6
    r(SYSTEM_PROGRAM_ID), // 7
    r(TOKEN_PROGRAM_ID), // 8
    w(metadata), // 9
    w(sellerStakeAccount), // 10
    r(SOLANART_SECONDARY_PROGRAM), // 11
    ...p.creators.map((c) => w(c.address)), // 12..12+N-1
    // No "buyer again" duplicate here — confirmed absent in both
    // reference legacy transactions (present in the pNFT path).
    w(edition),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(TOKEN_METADATA_PROGRAM_ID),
    r(SYSVAR_INSTRUCTIONS_ID),
    w(sellerTokenRecord),
    w(buyerTokenRecord),
    r(TOKEN_AUTH_RULES_PROGRAM_ID),
    // Final slot is a second Metadata program reference, not a ruleset —
    // confirmed identically on both reference transactions.
    r(TOKEN_METADATA_PROGRAM_ID),
  ];

  const data = Buffer.alloc(9);
  data.writeUInt8(ACCEPT_OFFER_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.offerData.priceLamports, 1);

  return new TransactionInstruction({ programId: SOLANART_PROGRAM_ID, keys, data });
}
