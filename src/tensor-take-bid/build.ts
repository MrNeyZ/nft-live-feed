/**
 * Tensor "take collection bid" — unsigned transaction builder.
 *
 * Accepts ANY live Tensor collection bid on ANY mpl-core asset. Nothing is
 * hardcoded to one collection/bid/asset. No private key ever touches this
 * process — it only reads public on-chain state and returns an UNSIGNED
 * transaction; the connecting wallet (Phantom, client-side) signs it.
 *
 * Ported from the standalone `tensor-takebid-tool/server.js` prototype —
 * see that repo's HANDOFF.md for the full reverse-engineering notes behind
 * every non-obvious choice below (targetId-is-a-whitelist, the SystemProgram
 * cosigner sentinel, the margin default, etc). Don't re-derive any of that;
 * this file mirrors it directly.
 */

import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TCompSDK } from '@tensor-oss/tcomp-sdk';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

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

    // bid.targetId for a collection-wide bid is the WHITELIST pda, not the
    // mpl-core Collection account. Resolve the real Collection generically
    // from the asset's own updateAuthority field (works for any asset, no
    // hardcoding) — see HANDOFF.md point 1.
    const assetInfo = await connection.getAccountInfo(ASSET);
    if (!assetInfo) return { ok: false, error: 'asset_account_not_found' };
    const uaTag = assetInfo.data.readUInt8(33); // 1 (key byte) + 32 (owner pubkey)
    const collection = uaTag === 2 ? new PublicKey(assetInfo.data.subarray(34, 66)) : null;

    const { tx } = await sdk.takeBidCore({
      bidId: bid.bidId,
      asset: ASSET,
      owner: bid.owner,
      rentDest: seller,
      seller,
      minAmount: bid.amount,            // exact live on-chain price -> zero slippage tolerance
      collection,
      currency: bid.currency,
      makerBroker: bid.makerBroker,
      takerBroker: null,
      margin: bid.margin ?? bid.owner,  // bids w/o shared-escrow margin PDA are funded from owner's wallet — HANDOFF.md point 3
      whitelist: bid.targetId,
      cosigner: bid.cosigner,
      compute: opts.computeUnits ?? 400_000,
      priorityMicroLamports: opts.priorityMicroLamports ?? 250_000,
    });

    // bidState.cosigner == SystemProgram is Tensor's "no cosigner required"
    // sentinel. The bundled IDL marks that account isSigner:true
    // unconditionally, but nobody holds that keypair and the deployed
    // program doesn't actually check it in this case (confirmed against
    // real historical txs — HANDOFF.md point 2). Strip the impossible
    // signer requirement client-side.
    if (bid.cosigner.toBase58() === SYSTEM_PROGRAM) {
      for (const ix of tx.ixs) {
        for (const meta of ix.keys) {
          if (meta.pubkey.toBase58() === SYSTEM_PROGRAM && meta.isSigner) meta.isSigner = false;
        }
      }
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: seller, blockhash, lastValidBlockHeight }).add(...tx.ixs);
    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

    return {
      ok: true,
      txBase64: serialized.toString('base64'),
      bidInfo: {
        owner: bid.owner.toBase58(),
        amountLamports: bid.amount.toString(),
        amountSOL: bid.amount.toNumber() / 1e9,
        quantity: bid.quantity,
        filledQuantity: bid.filledQuantity,
        currency: bid.currency ? bid.currency.toBase58() : 'SOL',
        expiry: bid.expiry.toString(),
        collection: collection ? collection.toBase58() : null,
      },
      blockhash,
      lastValidBlockHeight,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
