/**
 * Tensor "take collection bid" — unsigned transaction builder.
 *
 * Accepts ANY live Tensor collection bid on ANY mpl-core OR legacy/pNFT
 * (Token Metadata) asset. Nothing is hardcoded to one collection/bid/asset.
 * No private key ever touches this process — it only reads public on-chain
 * state and returns an UNSIGNED transaction; the connecting wallet
 * (Phantom, client-side) signs it.
 *
 * Ported from the standalone `tensor-takebid-tool/server.js` prototype —
 * see that repo's HANDOFF.md for the full reverse-engineering notes behind
 * every non-obvious choice below (targetId-is-a-whitelist, the SystemProgram
 * cosigner sentinel, the margin default, the minAmount dry-run, etc). Don't
 * re-derive any of that; this file mirrors it directly. Those findings are
 * general TCOMP behavior (not Core-specific), so the legacy/pNFT path below
 * applies the exact same fixes.
 *
 * Legacy vs pNFT is NOT a fork here — both go through TCOMP's single
 * takeBidLegacy instruction; the SDK's prepPnftAccounts() auto-detects a
 * ruleSet on the mint's metadata and includes the token-record/auth-rules
 * accounts only when present. Dispatch is only Core vs everything-else,
 * decided by the asset account's owner program (Core assets are owned by
 * MPL_CORE_PROGRAM_ID; legacy/pNFT assets are SPL mints owned by the token
 * program).
 */

import * as anchor from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { TCompSDK } from '@tensor-oss/tcomp-sdk';
import BN from 'bn.js';
import { simulateTakeBidTx } from './simulate';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

// Shared Address Lookup Table holding the program IDs that appear
// identically in every take-bid tx (TCOMP, TensorSwap, Token Metadata,
// Auth Rules, SPL Token(+2022), ATA, System, Instructions sysvar, MPL
// Core) — compresses each from 32 bytes to a 1-byte index so legacy/pNFT
// take-bid txs (which carry ~30 accounts) fit under Solana's 1232-byte
// wire limit. Created once (2026-08-15), read-only from here on; no
// per-request setup cost. See tensor-takebid-tool/infra/create-alt.js.
const TAKE_BID_ALT_ADDRESS = new PublicKey('GEYwX8PAdQghWef4zUD4RWwpGn3zWYx4REDPxuG9SrFU');
let cachedAlt: AddressLookupTableAccount | null = null;
async function getTakeBidAlt(connection: Connection): Promise<AddressLookupTableAccount> {
  if (cachedAlt) return cachedAlt;
  const res = await connection.getAddressLookupTable(TAKE_BID_ALT_ADDRESS);
  if (!res.value) throw new Error('take_bid_alt_not_found');
  cachedAlt = res.value;
  return cachedAlt;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export interface TakeBidInfo {
  owner: string;
  amountLamports: string;
  amountSOL: number;
  quantity: number;
  filledQuantity: number;
  currency: string;
  expiry: string;
  collection: string | null;
  /** Net lamports the seller actually receives, after TCOMP's platform fee
   *  and the collection's creator royalty (both deducted on-chain before
   *  the minAmount check) -- this is what got used as minAmount, NOT
   *  amountLamports. See the dry-run comment below for why. */
  netProceedsLamports: string;
}

export type BuildTakeBidResult =
  | {
      ok: true;
      txBase64: string;
      bidInfo: TakeBidInfo;
      blockhash: string;
      lastValidBlockHeight: number;
    }
  | { ok: false; error: string };

export async function buildTakeBidTx(opts: {
  bidStateAddr: string;
  assetAddr: string;
  sellerAddr: string;
  priorityMicroLamports?: number;
  computeUnits?: number;
}): Promise<BuildTakeBidResult> {
  try {
    const connection = new Connection(rpcUrl(), 'confirmed');
    const seller = new PublicKey(opts.sellerAddr);
    const ASSET = new PublicKey(opts.assetAddr);
    const BID_STATE = new PublicKey(opts.bidStateAddr);

    // Read-only provider — no wallet/keys. takeBidCore() only needs it to
    // build the instruction, never to sign anything. `payer` is required
    // by anchor's Wallet interface but never touched by anything this
    // file calls — a throwaway keypair satisfies the type without ever
    // being used for signing.
    const dummyWallet: anchor.Wallet = {
      publicKey: seller,
      payer: Keypair.generate(),
      signTransaction: async () => { throw new Error('unused'); },
      signAllTransactions: async () => { throw new Error('unused'); },
    };
    const provider = new anchor.AnchorProvider(connection, dummyWallet, { commitment: 'confirmed' });
    const sdk = new TCompSDK({ provider });

    const bid = await sdk.fetchBidState(BID_STATE);
    if (bid.filledQuantity >= bid.quantity) {
      return { ok: false, error: 'bid_already_fully_filled' };
    }

    // Dispatch on the asset account's OWNER program, not an assumed shape —
    // Core assets are owned by MPL_CORE_PROGRAM_ID; legacy/pNFT assets are
    // SPL mints owned by the (2022 or classic) token program. Everything
    // that isn't Core goes through takeBidLegacy (handles pNFT internally,
    // see file header).
    const assetInfo = await connection.getAccountInfo(ASSET);
    if (!assetInfo) return { ok: false, error: 'asset_account_not_found' };
    const isCore = assetInfo.owner.equals(MPL_CORE_PROGRAM_ID);

    // bid.targetId for a collection-wide bid is the WHITELIST pda, not the
    // mpl-core Collection account. For Core, resolve the real Collection
    // generically from the asset's own updateAuthority field (works for any
    // asset, no hardcoding) — see HANDOFF.md point 1. Legacy/pNFT doesn't
    // need this: takeBidLegacy takes `whitelist` directly (== bid.targetId)
    // and verifies membership off the mint's own metadata/creators, no
    // separate collection-account resolution step.
    const collection = isCore
      ? (assetInfo.data.readUInt8(33) === 2 ? new PublicKey(assetInfo.data.subarray(34, 66)) : null)
      : null;

    async function buildLegacyIxs(minAmount: BN): Promise<TransactionInstruction[]> {
      const tokenProgram = assetInfo!.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const nftSellerAcc = getAssociatedTokenAddressSync(ASSET, seller, false, tokenProgram);
      const { tx } = await sdk.takeBidLegacy({
        bidId: bid.bidId,
        nftMint: ASSET,
        nftSellerAcc,
        owner: bid.owner,
        rentDest: bid.rentPayer,
        seller,
        minAmount,
        tokenProgram,
        currency: bid.currency,
        makerBroker: bid.makerBroker,
        takerBroker: null,
        margin: bid.margin ?? bid.owner,
        whitelist: bid.targetId,
        cosigner: bid.cosigner.toBase58() === SYSTEM_PROGRAM ? seller : bid.cosigner,
        compute: opts.computeUnits ?? 400_000,
        priorityMicroLamports: opts.priorityMicroLamports ?? 250_000,
      });
      return tx.ixs;
    }

    async function buildCoreIxs(minAmount: BN): Promise<TransactionInstruction[]> {
      const { tx } = await sdk.takeBidCore({
        bidId: bid.bidId,
        asset: ASSET,
        owner: bid.owner,
        // The SDK computes the actual rentDest account as
        // getTcompRentPayer({rentPayer: rentDest, owner}) -> rentDest if
        // it's not the zero pubkey, else owner -- mirroring the on-chain
        // program's own state.rs:get_rent_payer() check exactly. Passing
        // bid.rentPayer straight through lets the SDK's own fallback
        // reproduce the program's logic instead of guessing seller (which
        // is never the zero pubkey, so it always "won" and never matched
        // -> AnchorError account: rent_destination, BadRentDest, 6136).
        rentDest: bid.rentPayer,
        seller,
        minAmount,
        collection,
        currency: bid.currency,
        makerBroker: bid.makerBroker,
        takerBroker: null,
        margin: bid.margin ?? bid.owner,  // bids w/o shared-escrow margin PDA are funded from owner's wallet — HANDOFF.md point 3
        whitelist: bid.targetId,
        // bidState.cosigner == SystemProgram is Tensor's "no cosigner
        // required" sentinel. The real fix is substituting the SELLER's
        // own wallet into the cosigner slot (seller already signs the tx
        // as fee payer, so this closes the program's signer check for
        // free) — see HANDOFF.md point 2 for the full forensics; a
        // SystemProgram-with-isSigner-forced-false hack does NOT work
        // (AccountNotSigner, 3010). The SDK's own internal default
        // (`cosigner ?? seller`) only fires on null/undefined, not on a
        // real sentinel PublicKey, so the substitution has to happen here.
        cosigner: bid.cosigner.toBase58() === SYSTEM_PROGRAM ? seller : bid.cosigner,
        compute: opts.computeUnits ?? 400_000,
        priorityMicroLamports: opts.priorityMicroLamports ?? 250_000,
      });
      return tx.ixs;
    }

    const buildIxs = isCore ? buildCoreIxs : buildLegacyIxs;

    // Versioned (v0) tx referencing the shared ALT (see top of file) instead
    // of a legacy Transaction — legacy/pNFT take-bid carries ~30 accounts
    // and blows past Solana's 1232-byte wire limit ("Transaction too large")
    // without the ~250 bytes the ALT saves by compressing the constant
    // program-ID accounts. Frontend's signSendAndConfirm already
    // auto-detects versioned vs legacy, no client change needed.
    async function serialize(ixs: TransactionInstruction[]): Promise<{ txBase64: string; blockhash: string; lastValidBlockHeight: number }> {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const alt = await getTakeBidAlt(connection);
      const message = new TransactionMessage({
        payerKey: seller,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message([alt]);
      const transaction = new VersionedTransaction(message);
      const serialized = Buffer.from(transaction.serialize());
      return { txBase64: serialized.toString('base64'), blockhash, lastValidBlockHeight };
    }

    // TCOMP deducts its own platform fee (TCOMP_FEE_BPS, 150 = 1.5%) AND
    // the collection's creator royalty from the bid's gross `amount`
    // BEFORE checking `minAmount` — passing the raw gross bid.amount as
    // minAmount always fails with AnchorError account: amount,
    // PriceMismatch (6105), even when the bid hasn't been touched since
    // the last read. There's no dependable formula to hand-compute the
    // net figure client-side (creator royalty bps is a per-collection
    // setting the collection authority can change at any time) — dry-run
    // build with minAmount=0 (trivially satisfies any price check) and
    // simulate it to read the TRUE current net payout via the seller's
    // balance delta, then rebuild the real tx using that exact figure as
    // minAmount. This also means minAmount keeps doing its actual job —
    // protecting against the bid amount (or a royalty change) shifting
    // between this dry-run and the real send.
    const dryRunIxs = await buildIxs(new BN(0));
    const dryRun = await serialize(dryRunIxs);
    const sim = await simulateTakeBidTx(dryRun.txBase64, opts.sellerAddr);
    if (!sim.ok) return { ok: false, error: `dry_run_simulate_failed: ${sim.error}` };
    if (sim.solDeltaLamports == null || sim.solDeltaLamports <= 0) {
      return { ok: false, error: 'dry_run_simulate_returned_no_net_proceeds' };
    }
    const netProceedsLamports = new BN(sim.solDeltaLamports);

    const realIxs = await buildIxs(netProceedsLamports);
    const real = await serialize(realIxs);

    return {
      ok: true,
      txBase64: real.txBase64,
      bidInfo: {
        owner: bid.owner.toBase58(),
        amountLamports: bid.amount.toString(),
        amountSOL: bid.amount.toNumber() / 1e9,
        quantity: bid.quantity,
        filledQuantity: bid.filledQuantity,
        currency: bid.currency ? bid.currency.toBase58() : 'SOL',
        expiry: bid.expiry.toString(),
        collection: collection ? collection.toBase58() : null,
        netProceedsLamports: netProceedsLamports.toString(),
      },
      blockhash: real.blockhash,
      lastValidBlockHeight: real.lastValidBlockHeight,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
