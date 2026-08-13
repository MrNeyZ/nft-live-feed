/**
 * Raw, on-chain SolSea / All.Art marketplace instruction builder + bid
 * decoder. SolSea's own frontend/API (`api.all.art`, cert expired but the
 * FeathersJS backend is still live behind `curl -k`) only lists *currently
 * open* bids from its `bidding` DB collection — no historical/settled data,
 * and importantly the DB is not even complete (a direct on-chain scan found
 * 47 genuinely funded bids the DB never listed at all). The on-chain bid
 * program (`AARTcKUzLYaWmK7D1otgyAoFn5vQqBiTrxjwrvjvsVJa`) is what's
 * authoritative, and it still holds thousands of funded, never-cancelled
 * bid escrows from 2022. This module lets a holder of a mint one of those
 * bids targets accept it directly on-chain, bypassing the dead marketplace
 * entirely.
 *
 * NATIVE SOL BIDS ONLY. SolSea bid records carry a `currency` field —
 * `11111111111111111111111111111111` (System Program sentinel) for native
 * SOL, or an SPL token mint (its own `F3nef…` token, or BONK/USDC/etc) for
 * a "multicurrency" bid. Only native-SOL bids are supported here; the
 * multicurrency accept path uses a structurally different instruction
 * (`Accept unlisted bid multicurrency`, discriminator 16, with a separate
 * SPL-token escrow account this module does not build) and has not been
 * chain-verified. `decodeBid` reports the currency; the caller must refuse
 * anything other than the System Program sentinel.
 *
 * Every discriminator / account role below is evidence-backed:
 *   - The full instruction-discriminator enum (1=Delist, 3=Stake,
 *     4=Unstake, 5=Place bid, 6=Cancel bid, 7=Accept unlisted bid,
 *     8=Accept listed bid, 9=Change price, 10=Sell multicurrency,
 *     11=Delist multicurrency, 12=Buy multicurrency, 13=Change price
 *     multicurrency, 14=Place bid multicurrency, 15=Cancel bid
 *     multicurrency, 16=Accept unlisted bid multicurrency, 17=Accept
 *     listed bid multicurrency) was recovered by brute-force simulating
 *     every discriminator 0-25 against the live program with `sigVerify:
 *     false` (no funds ever at risk) — the program prints its instruction
 *     name to logs before failing on bad accounts, which leaks the name
 *     for every valid discriminator.
 *   - The 11-account structure for "Accept unlisted bid instruction"
 *     (discriminator 7) below was recovered from a REAL historical
 *     transaction found by scanning candidate mints' current-holder ATA
 *     signature histories for the exact log line "Accept unlisted bid":
 *     `CELoGi2c68WPqa2HmbW31bjkGCLgcgNuT1yQ3XVz31EvgATnEcUoBKt51jSzPSttfe5Ltqh6rg9fCo5taexbg9S`
 *     — then independently re-derived from first principles (mint / seller
 *     / bidder / on-chain Metadata PDA / fixed fee wallet) and confirmed
 *     byte-for-byte against a SECOND, completely different, currently-live
 *     15 SOL bid via `simulateTransaction`: `err: null`, NFT moved from
 *     seller's ATA to a freshly-created buyer ATA, seller's SOL balance
 *     increased by ~14.7 SOL. Full evidence trail, including which account
 *     roles were inferred vs proven and the remaining open question
 *     (position 7 is a "currency reference" slot — confirmed via a second
 *     simulation test to accept ANY valid SPL token account, not
 *     specifically an F3nef one), lives in
 *     `research/solanart-solsea-forgotten-bids/solsea-accept-bid-re/FINDINGS.md`.
 *   - The fee wallet (`6T4f5bdrd9ffTtehqAj9BGyxahysRGcaUZeDzA1XN52N`) is
 *     fixed — seen identically across every SolSea instruction examined
 *     (Buy, Delist, Accept listed bid, Accept unlisted bid), for different
 *     collections/mints each time.
 *   - Position 10 duplicates position 2 (the seller) exactly — confirmed
 *     present in the real reference transaction's account list, not a
 *     construction mistake.
 */

import { PublicKey, TransactionInstruction, AccountMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export const SOLSEA_PROGRAM_ID = new PublicKey('AARTcKUzLYaWmK7D1otgyAoFn5vQqBiTrxjwrvjvsVJa');
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Fixed constant across every SolSea instruction examined, for different
 *  collections/mints — the marketplace's own fee wallet. */
export const SOLSEA_FEE_WALLET = new PublicKey('6T4f5bdrd9ffTtehqAj9BGyxahysRGcaUZeDzA1XN52N');

/** Native-SOL currency sentinel used in bid records' `currency` field. */
export const NATIVE_SOL_CURRENCY_SENTINEL = new PublicKey('11111111111111111111111111111111');

export const BIDDING_ACCOUNT_SIZE = 600;
const ACCEPT_UNLISTED_BID_DISCRIMINATOR = 7;

export interface DecodedBid {
  /** 2-byte state header. `0101` = active/open. Anything else observed in
   *  practice means historical/cancelled/settled — never funded. */
  header: string;
  mint: PublicKey;
  bidder: PublicKey;
  currency: PublicKey;
  priceRaw: bigint;
}

/** Byte offsets cross-checked byte-exact against known DB records (price +
 *  mint + bidder) and against two known currency types (native-SOL sentinel
 *  at offset 106 for a SOL bid, the real F3nef mint at offset 106 for a
 *  multicurrency bid) — see FINDINGS.md for the derivation. */
export function decodeBid(data: Buffer): DecodedBid {
  if (data.length !== BIDDING_ACCOUNT_SIZE) {
    throw new Error(`unexpected_bid_account_size: expected ${BIDDING_ACCOUNT_SIZE}, got ${data.length}`);
  }
  return {
    header: data.subarray(0, 2).toString('hex'),
    priceRaw: data.readBigUInt64LE(2),
    mint: new PublicKey(data.subarray(10, 42)),
    bidder: new PublicKey(data.subarray(42, 74)),
    currency: new PublicKey(data.subarray(106, 138)),
  };
}

export function deriveMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

export interface AcceptUnlistedBidParams {
  seller: PublicKey;
  bidAccount: PublicKey;
  bidData: DecodedBid;
  mint: PublicKey;
  /** Any existing, valid SPL token account — confirmed via simulation that
   *  the program does not check its mint or owner, only that it decodes as
   *  a real SPL token account (a Sysvar or other non-token account fails
   *  with a distinct on-chain error). The seller's own NFT ATA (already
   *  passed as `sellerAta` below) is a convenient, always-valid choice. */
  currencyPlaceholderAccount: PublicKey;
}

/** Builds the "Accept unlisted bid instruction" (discriminator 7) —
 *  native-SOL bids only. Caller is responsible for having confirmed
 *  `bidData.currency` equals `NATIVE_SOL_CURRENCY_SENTINEL` before calling
 *  this; a multicurrency bid needs a structurally different instruction
 *  (discriminator 16) that this module does not build. */
export function buildAcceptUnlistedBidIx(p: AcceptUnlistedBidParams): TransactionInstruction {
  const sellerAta = getAssociatedTokenAddressSync(p.mint, p.seller, true);
  const buyerAta = getAssociatedTokenAddressSync(p.mint, p.bidData.bidder, true);
  const metadata = deriveMetadataPda(p.mint);

  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

  const keys: AccountMeta[] = [
    w(p.bidAccount), // 0 — closed, rent refunded to bidder
    r(metadata), // 1
    { pubkey: p.seller, isSigner: true, isWritable: true }, // 2
    w(p.bidData.bidder), // 3 — receives NFT ATA ownership + bid-account rent refund
    w(sellerAta), // 4 — source of the NFT transfer
    w(buyerAta), // 5 — destination; must already exist (create via ATA ix first)
    r(p.mint), // 6
    w(p.currencyPlaceholderAccount), // 7 — unused by the program; must decode as a real SPL token account
    w(SOLSEA_FEE_WALLET), // 8
    r(TOKEN_PROGRAM_ID), // 9
    { pubkey: p.seller, isSigner: true, isWritable: true }, // 10 — duplicate of 2, confirmed present in the real reference tx
  ];

  const data = Buffer.alloc(9);
  data.writeUInt8(ACCEPT_UNLISTED_BID_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.bidData.priceRaw, 1);

  return new TransactionInstruction({ programId: SOLSEA_PROGRAM_ID, keys, data });
}
