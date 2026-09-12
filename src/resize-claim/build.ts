/**
 * Resize / Claim tool — unsigned transaction packer.
 *
 * No private key ever touches this process. Every function returns an
 * array of base64 `VersionedTransaction`s with the connecting wallet as
 * fee payer and only-signer; the client `signAllTransactions` + submits,
 * exactly like resize.metaplex.com's own flow.
 *
 * Packing:
 *   • claims — one `DistributeToLegacyNft` per transaction, and NO
 *     ComputeBudget instructions. The 25-node merkle proof is ~800 bytes
 *     of instruction data; with the shared ALT the tx is ~1206 bytes —
 *     adding even a single setComputeUnitPrice ix pushes it over the
 *     1232-byte wire limit (this mirrors resize.metaplex.com's own claim
 *     tx, which also carries no priority fee). Land them via a fast RPC /
 *     Jito or by spacing submissions; the program only burns ~55–75k CU.
 *   • resizes — `Resize` is 7 accounts + 1 data byte, so many pack into
 *     one transaction (default 8) with a normal priority fee.
 *
 * The claim pays wSOL into ATA(wSOL, wallet), created idempotently by the
 * program via CPI. This tool does not unwrap it — a caller running at
 * scale should batch-close the wSOL account afterwards (closing unwraps
 * and returns native SOL + the ATA rent).
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
// ComputeBudgetProgram is used for the resize path only — the claim path
// omits it deliberately (see the packing note in the file header).
import {
  buildDistributeToLegacyNftIx,
  buildResizeIx,
  CLAIM_ALT_ADDRESS,
} from './program';

const RESIZES_PER_TX = 8;
const DEFAULT_PRIORITY_MICROLAMPORTS = 20_000;
const RESIZE_COMPUTE_UNITS_EACH = 40_000;

export interface ClaimInput {
  mint: string;
  amountLamports: string;
  proof: string[];
}
export interface ResizeInput {
  mint: string;
}

export interface PackedTx {
  kind: 'claim' | 'resize';
  /** base64 serialized unsigned VersionedTransaction */
  txBase64: string;
  /** mints covered by this transaction */
  mints: string[];
}
export interface BuildResult {
  txs: PackedTx[];
  blockhash: string;
  lastValidBlockHeight: number;
}

let cachedAlt: AddressLookupTableAccount | null = null;
async function getClaimAlt(conn: Connection): Promise<AddressLookupTableAccount | null> {
  if (cachedAlt) return cachedAlt;
  const res = await conn.getAddressLookupTable(CLAIM_ALT_ADDRESS);
  if (res.value) cachedAlt = res.value;
  return cachedAlt;
}

function compile(
  payer: PublicKey,
  ixs: TransactionInstruction[],
  blockhash: string,
  alts: AddressLookupTableAccount[],
): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString('base64');
}

export async function buildTransactions(opts: {
  conn: Connection;
  wallet: string;
  claims?: ClaimInput[];
  resizes?: ResizeInput[];
  priorityMicroLamports?: number;
}): Promise<BuildResult> {
  const payer = new PublicKey(opts.wallet);
  const priority = opts.priorityMicroLamports ?? DEFAULT_PRIORITY_MICROLAMPORTS;
  const claims = opts.claims ?? [];
  const resizes = opts.resizes ?? [];

  const { blockhash, lastValidBlockHeight } =
    await opts.conn.getLatestBlockhash('confirmed');

  const alt = await getClaimAlt(opts.conn);
  const claimAlts = alt ? [alt] : [];

  const txs: PackedTx[] = [];

  // ── claims: one per tx, no ComputeBudget (size budget — see header) ──
  for (const c of claims) {
    const mint = new PublicKey(c.mint);
    const proof = c.proof.map((p) => new PublicKey(p));
    const ix = buildDistributeToLegacyNftIx({
      nftMint: mint,
      nftOwner: payer,
      amount: BigInt(c.amountLamports),
      proof,
      payer,
    });
    txs.push({
      kind: 'claim',
      txBase64: compile(payer, [ix], blockhash, claimAlts),
      mints: [c.mint],
    });
  }

  // ── resizes: packed ──
  for (let i = 0; i < resizes.length; i += RESIZES_PER_TX) {
    const group = resizes.slice(i, i + RESIZES_PER_TX);
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: RESIZE_COMPUTE_UNITS_EACH * group.length,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
    ];
    for (const r of group) {
      ixs.push(buildResizeIx({ nftMint: new PublicKey(r.mint), holder: payer, payer }));
    }
    txs.push({
      kind: 'resize',
      txBase64: compile(payer, ixs, blockhash, []),
      mints: group.map((g) => g.mint),
    });
  }

  return { txs, blockhash, lastValidBlockHeight };
}
