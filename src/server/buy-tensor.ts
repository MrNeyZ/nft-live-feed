/**
 * Tensor (TComp) buy-listing transaction builder — our own, no Tensor API.
 *
 * TComp has no mandatory marketplace co-signature, so we build `buy_core`
 * directly from on-chain state (list_state + asset) and return an UNSIGNED
 * v0 tx for the buyer to sign. No simulation / preflight: `maxAmount` makes
 * the program reject a raised price on-chain, and anything else stale fails
 * for the base fee.
 *
 * Scope: MPL Core, SOL-priced, no listing cosigner. Legacy / pNFT / T22 /
 * SPL-currency / cosigned listings return 501 for now.
 *
 * Account layout = tensor-foundation/marketplace program/idl.json v0.7.1
 * `buyCore` (the old @tensor-oss/tcomp-sdk v6 predates `feeVault` and the
 * optional trailing `cosigner`, so its builder would misalign the creator
 * remaining-accounts). Omitted optional accounts = the TComp program id,
 * same as Tensor's generated client ('programId' strategy).
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { fetchAssetV1, fetchCollectionV1 } from '@metaplex-foundation/mpl-core';
import { createUmi } from '@metaplex-foundation/umi';
import { web3JsRpc } from '@metaplex-foundation/umi-rpc-web3js';
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { rpcPost, rpcUrl } from './tools-mmm-pools';
import { TCOMP_PROGRAM } from '../ingestion/tensor-raw/programs';

const TCOMP_PK   = new PublicKey(TCOMP_PROGRAM);
const FEE_PROGRAM = new PublicKey('TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A');
const MPL_CORE   = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const DEFAULT_PK = PublicKey.default.toBase58();
const BUY_CORE_DISC = crypto.createHash('sha256').update('global:buy_core').digest().subarray(0, 8);

// Same small fixed priority fee as the ME path. CU limit is generous for
// buy_core (+ royalty transfers) — at 100k µL/CU the fee stays ~0.000008 SOL.
const PRIO_FEE_MICROLAMPORTS = Number(process.env.BUY_PRIO_FEE_MICROLAMPORTS) || 100_000;
const CU_LIMIT = 80_000;   // buy_core measured ~45k CU in simulation

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(rpcUrl(), 'confirmed'));

interface ListState {
  owner:        PublicKey;
  assetId:      PublicKey;
  amount:       bigint;
  currency:     PublicKey | null;
  expiry:       bigint;
  privateTaker: PublicKey | null;
  makerBroker:  PublicKey | null;
  rentPayer:    PublicKey;
  cosigner:     PublicKey;
}

/** ListState: disc 8 | version u8 | bump [u8;1] | owner | assetId | amount u64
 *  | currency Option<Pubkey> | expiry i64 | privateTaker Option<Pubkey>
 *  | makerBroker Option<Pubkey> | rentPayer | cosigner | reserved. */
function decodeListState(d: Buffer): ListState {
  let o = 8 + 1 + 1;
  const pk = () => { const p = new PublicKey(d.subarray(o, o + 32)); o += 32; return p; };
  const opt = () => (d[o++] === 1 ? pk() : null);
  const owner = pk();
  const assetId = pk();
  const amount = d.readBigUInt64LE(o); o += 8;
  const currency = opt();
  const expiry = d.readBigInt64LE(o); o += 8;
  const privateTaker = opt();
  const makerBroker = opt();
  const rentPayer = pk();
  const cosigner = pk();
  return { owner, assetId, amount, currency, expiry, privateTaker, makerBroker, rentPayer, cosigner };
}

/** Royalty creators for a Core asset — asset's Royalties plugin, else its
 *  collection's (same rule as @tensor-oss/tcomp-sdk getCreators). */
async function getRoyalties(asset: PublicKey, collection: PublicKey | null): Promise<{ creators: PublicKey[]; bps: number }> {
  const umi = createUmi().use(web3JsRpc(connection()));
  const a = await fetchAssetV1(umi, fromWeb3JsPublicKey(asset));
  let r = a.royalties;
  if (!r && collection && a.updateAuthority.type === 'Collection' && a.updateAuthority.address === fromWeb3JsPublicKey(collection)) {
    r = (await fetchCollectionV1(umi, a.updateAuthority.address)).royalties;
  }
  return r ? { creators: r.creators.map(c => toWeb3JsPublicKey(c.address)), bps: r.basisPoints } : { creators: [], bps: 0 };
}

function rejectLog(fields: Record<string, unknown>): void {
  console.warn('[buy/tensor] REJECTED', JSON.stringify(fields));
}

/** Build the unsigned buy tx. Exported for offline checks (simulation). */
export async function buildTensorBuy(asset: PublicKey, buyer: PublicKey, maxAmount: bigint): Promise<{ status: number; body: Record<string, unknown> }> {
  const mint = asset.toBase58();
  const buyerStr = buyer.toBase58();
  const [listStatePk] = PublicKey.findProgramAddressSync([Buffer.from('list_state'), asset.toBuffer()], TCOMP_PK);
  try {
    const [accs, bh] = await Promise.all([
      rpcPost('getMultipleAccounts', [[listStatePk.toBase58(), mint], { encoding: 'base64' }]) as Promise<{ value: ({ data: [string, string]; owner: string } | null)[] }>,
      connection().getLatestBlockhash('confirmed'),
    ]);
    const [lsAcc, assetAcc] = accs.value;
    if (!lsAcc || lsAcc.owner !== TCOMP_PROGRAM) {
      rejectLog({ reason: 'not_listed', mint });
      return { status: 404, body: { error: 'not_listed', message: 'No active Tensor listing for this NFT.' } };
    }
    if (!assetAcc || assetAcc.owner !== MPL_CORE.toBase58()) {
      return { status: 501, body: { error: 'unsupported_standard', message: 'Only MPL Core Tensor listings are supported so far.' } };
    }
    const ls = decodeListState(Buffer.from(lsAcc.data[0], 'base64'));
    const assetData = Buffer.from(assetAcc.data[0], 'base64');
    if (!ls.assetId.equals(asset)) { return { status: 409, body: { error: 'list_state_mismatch' } }; }
    if (ls.currency) { return { status: 501, body: { error: 'unsupported_currency', message: 'Only SOL-priced listings are supported.' } }; }
    if (ls.cosigner.toBase58() !== DEFAULT_PK) { return { status: 501, body: { error: 'cosigned_listing', message: 'This listing requires a Tensor cosigner.' } }; }
    if (ls.privateTaker && !ls.privateTaker.equals(buyer)) { return { status: 403, body: { error: 'private_listing' } }; }
    if (ls.expiry > 0n && ls.expiry < BigInt(Math.floor(Date.now() / 1000))) { return { status: 404, body: { error: 'listing_expired' } }; }
    if (ls.amount > maxAmount) {
      rejectLog({ reason: 'price_above_slippage', mint, currentLamports: String(ls.amount), maxAmount: String(maxAmount) });
      return { status: 409, body: { error: 'price_above_slippage', currentPriceSol: Number(ls.amount) / 1e9 } };
    }

    // Core asset: key u8 | owner | updateAuthority { tag u8 (2 = Collection) | pubkey }.
    const collection = assetData.readUInt8(33) === 2 ? new PublicKey(assetData.subarray(34, 66)) : null;
    const { creators, bps } = await getRoyalties(asset, collection);

    const [feeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_vault'), Buffer.from([listStatePk.toBytes()[31]])], FEE_PROGRAM,
    );
    const rentDest = ls.rentPayer.toBase58() === DEFAULT_PK ? ls.owner : ls.rentPayer;
    const opt = (p: PublicKey | null, writable: boolean) =>
      p ? { pubkey: p, isSigner: false, isWritable: writable } : { pubkey: TCOMP_PK, isSigner: false, isWritable: false };

    const data = Buffer.alloc(16);
    BUY_CORE_DISC.copy(data, 0);
    // buy_core checks `amount + creator_fee <= max_amount` (royalties are
    // enforced at 100%; taker fee is paid on top, outside the check). Cap =
    // the price the buyer accepted plus its royalty, so a raised price fails.
    const maxWithRoyalty = maxAmount + (maxAmount * BigInt(bps) + 9_999n) / 10_000n;
    data.writeBigUInt64LE(maxWithRoyalty, 8);
    const ix = new TransactionInstruction({
      programId: TCOMP_PK,
      data,
      keys: [
        { pubkey: feeVault,    isSigner: false, isWritable: true },
        { pubkey: listStatePk, isSigner: false, isWritable: true },
        { pubkey: asset,       isSigner: false, isWritable: true },
        opt(collection, false),
        { pubkey: buyer,       isSigner: false, isWritable: false },
        { pubkey: buyer,       isSigner: true,  isWritable: true },   // payer
        { pubkey: ls.owner,    isSigner: false, isWritable: true },
        opt(null, true),                                             // takerBroker
        opt(ls.makerBroker, true),
        { pubkey: rentDest,    isSigner: false, isWritable: true },
        { pubkey: MPL_CORE,    isSigner: false, isWritable: false },
        { pubkey: TCOMP_PK,    isSigner: false, isWritable: false }, // marketplaceProgram
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        opt(null, false),                                            // cosigner
        ...creators.map(c => ({ pubkey: c, isSigner: false, isWritable: true })),
      ],
    });

    const message = new TransactionMessage({
      payerKey: buyer,
      recentBlockhash: bh.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIO_FEE_MICROLAMPORTS }),
        ix,
      ],
    }).compileToV0Message();
    const txBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
    const priceSol = Number(ls.amount) / 1e9;
    console.log(`[buy/tensor] tx_built buyer=${buyerStr.slice(0, 8)}… asset=${mint.slice(0, 8)}… price=${priceSol}SOL creators=${creators.length}`);
    return { status: 200, body: { txBase64, listing: { priceSol, seller: ls.owner.toBase58() } } };
  } catch (err) {
    console.warn('[buy/tensor] build failed', (err as Error).message);
    return { status: 502, body: { error: 'build_failed', message: (err as Error).message } };
  }
}

export function createBuyTensorRouter(): Router {
  const router = Router();
  const buyLimit = rateLimit({ limit: 10, windowMs: 60_000, label: 'buy/tensor' });

  router.get('/tensor', buyLimit, requireAuth, async (req: Request, res: Response) => {
    const mint          = String(req.query.mint ?? '').trim();
    const buyerStr      = String(req.query.buyer ?? '').trim();
    const expectedPrice = Number(req.query.expectedPriceSol);
    const slippagePct   = Number(req.query.maxSlippagePct ?? 0);
    let asset: PublicKey, buyer: PublicKey;
    try { asset = new PublicKey(mint); buyer = new PublicKey(buyerStr); }
    catch { res.status(400).json({ error: 'bad_request', message: 'mint and buyer must be pubkeys' }); return; }
    if (!Number.isFinite(expectedPrice) || expectedPrice <= 0 || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) {
      res.status(400).json({ error: 'bad_request', message: 'expectedPriceSol / maxSlippagePct invalid' });
      return;
    }
    const maxAmount = BigInt(Math.floor(expectedPrice * (1 + slippagePct / 100) * 1e9));

    const r = await buildTensorBuy(asset, buyer, maxAmount);
    res.status(r.status).json(r.body);
  });

  return router;
}
