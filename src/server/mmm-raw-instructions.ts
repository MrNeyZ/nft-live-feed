/**
 * Raw, on-chain MMM (Magic Eden's open-source AMM pool program) instruction
 * builders + pool-account decoder. Used because
 * `GET /instructions/mmm/create-pool` is Cloudflare-blocked (confirmed live
 * 2026-07-17 — a fully correct, fully-parameterised request still returns
 * HTTP 403 "Attention Required", while a diagnostic call to a *different*
 * mmm instruction-generation endpoint, `sol-deposit-buy`, with the exact
 * same headers/key/UA reached Magic Eden's own backend cleanly (400
 * "invalid pool", not a WAF page) — the block is specific to `create-pool`,
 * not the whole `/instructions/mmm/*` path).
 *
 * Every discriminator, argument layout, account list/order, and PDA seed
 * below is evidence-backed, not guessed:
 *
 *   1. The open-source program source (github.com/magicoss/mmm,
 *      `programs/mmm/src/{constants,state}.rs` and
 *      `instructions/{admin/create_pool,admin/update_pool,
 *      admin/sol_close_pool,vanilla/sol_deposit_buy,vanilla/sol_withdraw_buy}.rs`),
 *      fetched verbatim.
 *   2. A real, independently-selected historical `create_pool` transaction
 *      (pool `9FJCWoGf8hZKRrbq3pwKcPrcs5kZuN5gjqBYn1YiYrpe`, signature
 *      `3zZzjVEZiNMWH8mfsDFYL9woP2VhM9BKHqbmta8iHai26iGsXngWGSqsrw2jBVzaECTR5aBVtPgVM2vNJ7FTDmxa`,
 *      fetched via `getTransaction`) — the instruction's account list and
 *      Borsh-decoded args were checked byte-for-byte against the source's
 *      declared field order; the decode consumed EXACTLY the 365 bytes of
 *      instruction data with zero slack, proving the field order/types are
 *      correct, not approximate. The SAME transaction also contained a
 *      bundled `sol_deposit_buy` instruction, confirming pool creation and
 *      initial funding are commonly submitted together in one transaction.
 *   3. The already-verified, live-account-tested pool decoder in
 *      `tools-mmm-pools.ts` (`POOL_SIZE = 849`, `spot_price@8`,
 *      `expiry@27`, `owner@121`, `cosigner@153`,
 *      `buyside_payment_amount@447`) — independently re-derived here from
 *      the source's field declaration order and matches exactly for every
 *      field that file also reads. One correction found in the process:
 *      that file's comment labels the Pubkey at offset 185 "referral" —
 *      per the real `Pool` struct, offset 185 is actually `uuid`; the
 *      real `referral` field is at offset 37. Not fixed here (out of
 *      scope, `tools-mmm-pools.ts` is untouched by this module), but this
 *      file uses the source-verified offsets, not the possibly-mislabeled
 *      comment.
 *
 * ── Cosigner ─────────────────────────────────────────────────────────────
 *
 * `create_pool`, `update_pool`, `sol_deposit_buy`, `sol_withdraw_buy`, and
 * `sol_close_pool` ALL require a second `cosigner: Signer<'info>` account
 * (Anchor `has_one = cosigner` on every instruction except create, which
 * sets `pool.cosigner` for the first time) — the on-chain program's only
 * constraint is `owner.key() != cosigner.key()`; it does not require any
 * specific pubkey. Empirically, Magic Eden's own Instruction API always
 * auto-signs this slot with its own platform authority
 * (`NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd` — the same account seen
 * as a fixed read-only account across the item-level M2 bid tool's
 * transactions too, confirmed via a live, non-mutating
 * `sol-deposit-buy` call against a real existing pool, whose returned
 * `txSigned` had that account's signature slot already filled while the
 * owner's was empty) — meaning pools created through ME's own UI can only
 * be managed through ME's API, and (since we cannot obtain that
 * signature — the one endpoint that would let us set it, `create-pool`,
 * is the one that's blocked) pools created through THIS module use a
 * dedicated, narrowly-scoped, server-held cosigner keypair instead (see
 * `loadCosignerKeypair`), and ALL FIVE admin operations are built raw —
 * never via Magic Eden's Instruction API — for consistency (a pool whose
 * cosigner isn't ME's own key cannot reliably be assumed compatible with
 * ME's black-box tx-building for the other four operations either, and
 * this project already had a "trust but verify" incident with an
 * undocumented ME response field before — see git history).
 *
 * The cosigner is a pure co-authorization key: every instruction above
 * ALSO requires `owner` as a signer via Anchor's `has_one = owner` (or, for
 * create_pool, `payer = owner` for the newly-init'd pool account), and the
 * Solana runtime rejects any transaction missing a required signer BEFORE
 * program logic ever runs — so the cosigner alone, even if compromised,
 * cannot authorize any of these five instructions without the owner's own
 * signature too. No instruction here ever sends funds TO the cosigner —
 * `sol_deposit_buy` moves owner→escrow, `sol_withdraw_buy` moves
 * escrow→owner, `sol_close_pool` closes rent to owner. The cosigner has
 * zero economic role.
 */

import {
  PublicKey, Keypair, TransactionInstruction, SystemProgram, AccountMeta,
} from '@solana/web3.js';

export const MMM_PROGRAM_ID = new PublicKey('mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc');

const POOL_PREFIX = Buffer.from('mmm_pool');
const BUYSIDE_SOL_ESCROW_ACCOUNT_PREFIX = Buffer.from('mmm_buyside_sol_escrow_account');

/** Verified live 2026-07-16/17 against real, historically-observed
 *  transactions (see `src/ingestion/me-raw/ingest.ts`'s own
 *  `ME_V2_LIST_DISCS`/`MMM_REPRICE_DISCS` sets, and the real create_pool
 *  tx decoded for this module) — not computed/guessed. */
export const MMM_DISCRIMINATORS = {
  createPool: Buffer.from('e992d18ecf6840bc', 'hex'),
  updatePool: Buffer.from('efd6aa4e24231e22', 'hex'),
  solDepositBuy: Buffer.from('42e50b366da455ee', 'hex'),
  solWithdrawBuy: Buffer.from('9a2950e8ae30f623', 'hex'),
  solClosePool: Buffer.from('f87de814754eeaea', 'hex'),
};

export const CURVE_KIND_LINEAR = 0;
export const CURVE_KIND_EXP = 1;

export const ALLOWLIST_KIND = {
  EMPTY: 0, FVCA: 1, MINT: 2, MCC: 3, METADATA: 4, GROUP: 5, MPL_CORE_COLLECTION: 6, ANY: 255,
} as const;

export const ALLOWLIST_MAX_LEN = 6;
export const MAX_LP_FEE_BP = 2_000;
/** Verified live: real 849-byte pool accounts (`tools-mmm-pools.ts`'s
 *  `POOL_SIZE`), matches the source's `Pool::LEN` (real fields + 352-ish
 *  bytes of reserved padding). */
export const POOL_ACCOUNT_SIZE = 849;

export function derivePoolPda(owner: PublicKey, uuid: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POOL_PREFIX, owner.toBuffer(), uuid.toBuffer()],
    MMM_PROGRAM_ID,
  )[0];
}

export function deriveEscrowPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BUYSIDE_SOL_ESCROW_ACCOUNT_PREFIX, pool.toBuffer()],
    MMM_PROGRAM_ID,
  )[0];
}

export interface Allowlist {
  kind: number;
  value: PublicKey;
}

function emptyAllowlist(): Allowlist {
  return { kind: ALLOWLIST_KIND.EMPTY, value: PublicKey.default };
}

/** Exactly `ALLOWLIST_MAX_LEN` (6) entries — pads with empty ones, never
 *  fewer/more (the on-chain array is fixed-size, no length prefix). */
export function normalizeAllowlists(entries: Allowlist[]): Allowlist[] {
  if (entries.length > ALLOWLIST_MAX_LEN) throw new Error(`too_many_allowlist_entries: max ${ALLOWLIST_MAX_LEN}`);
  const out = [...entries];
  while (out.length < ALLOWLIST_MAX_LEN) out.push(emptyAllowlist());
  return out;
}

function writeAllowlists(buf: Buffer, offset: number, allowlists: Allowlist[]): number {
  let o = offset;
  for (const a of allowlists) {
    buf.writeUInt8(a.kind, o); o += 1;
    a.value.toBuffer().copy(buf, o); o += 32;
  }
  return o;
}

// ── create_pool ──────────────────────────────────────────────────────────

export interface CreatePoolArgs {
  spotPriceLamports: bigint;
  curveType: number;
  curveDelta: bigint;
  reinvestFulfillBuy: boolean;
  reinvestFulfillSell: boolean;
  expiry: bigint;
  lpFeeBp: number;
  referral: PublicKey;
  cosignerAnnotation: Buffer; // 32 bytes
  buysideCreatorRoyaltyBp: number;
  uuid: PublicKey;
  allowlists: Allowlist[];
}

function serializeCreatePoolArgs(args: CreatePoolArgs): Buffer {
  const allowlists = normalizeAllowlists(args.allowlists);
  const buf = Buffer.alloc(
    8 + 1 + 8 + 1 + 1 + 8 + 2 + 32 + 32 + 2 + 32 + 32 + ALLOWLIST_MAX_LEN * 33,
  );
  let o = 0;
  buf.writeBigUInt64LE(args.spotPriceLamports, o); o += 8;
  buf.writeUInt8(args.curveType, o); o += 1;
  buf.writeBigUInt64LE(args.curveDelta, o); o += 8;
  buf.writeUInt8(args.reinvestFulfillBuy ? 1 : 0, o); o += 1;
  buf.writeUInt8(args.reinvestFulfillSell ? 1 : 0, o); o += 1;
  buf.writeBigInt64LE(args.expiry, o); o += 8;
  buf.writeUInt16LE(args.lpFeeBp, o); o += 2;
  args.referral.toBuffer().copy(buf, o); o += 32;
  if (args.cosignerAnnotation.length !== 32) throw new Error('cosigner_annotation_must_be_32_bytes');
  args.cosignerAnnotation.copy(buf, o); o += 32;
  buf.writeUInt16LE(args.buysideCreatorRoyaltyBp, o); o += 2;
  args.uuid.toBuffer().copy(buf, o); o += 32;
  PublicKey.default.toBuffer().copy(buf, o); o += 32; // payment_mint — SOL pools use Pubkey::default(), confirmed live
  o = writeAllowlists(buf, o, allowlists);
  if (o !== buf.length) throw new Error(`create_pool_args_serialize_length_mismatch: wrote ${o}, expected ${buf.length}`);
  return buf;
}

export interface CreatePoolAccounts {
  owner: PublicKey;
  cosigner: PublicKey;
  pool: PublicKey;
}

export function buildCreatePoolIx(accounts: CreatePoolAccounts, args: CreatePoolArgs): TransactionInstruction {
  const data = Buffer.concat([MMM_DISCRIMINATORS.createPool, serializeCreatePoolArgs(args)]);
  const keys: AccountMeta[] = [
    { pubkey: accounts.owner, isSigner: true, isWritable: true },
    { pubkey: accounts.cosigner, isSigner: true, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MMM_PROGRAM_ID, keys, data });
}

// ── update_pool ──────────────────────────────────────────────────────────

export interface UpdatePoolArgs {
  spotPriceLamports: bigint;
  curveType: number;
  curveDelta: bigint;
  reinvestFulfillBuy: boolean;
  reinvestFulfillSell: boolean;
  expiry: bigint;
  lpFeeBp: number;
  referral: PublicKey;
  cosignerAnnotation: Buffer;
  buysideCreatorRoyaltyBp: number;
}

function serializeUpdatePoolArgs(args: UpdatePoolArgs): Buffer {
  const buf = Buffer.alloc(8 + 1 + 8 + 1 + 1 + 8 + 2 + 32 + 32 + 2);
  let o = 0;
  buf.writeBigUInt64LE(args.spotPriceLamports, o); o += 8;
  buf.writeUInt8(args.curveType, o); o += 1;
  buf.writeBigUInt64LE(args.curveDelta, o); o += 8;
  buf.writeUInt8(args.reinvestFulfillBuy ? 1 : 0, o); o += 1;
  buf.writeUInt8(args.reinvestFulfillSell ? 1 : 0, o); o += 1;
  buf.writeBigInt64LE(args.expiry, o); o += 8;
  buf.writeUInt16LE(args.lpFeeBp, o); o += 2;
  args.referral.toBuffer().copy(buf, o); o += 32;
  if (args.cosignerAnnotation.length !== 32) throw new Error('cosigner_annotation_must_be_32_bytes');
  args.cosignerAnnotation.copy(buf, o); o += 32;
  buf.writeUInt16LE(args.buysideCreatorRoyaltyBp, o); o += 2;
  if (o !== buf.length) throw new Error(`update_pool_args_serialize_length_mismatch: wrote ${o}, expected ${buf.length}`);
  return buf;
}

export interface PoolOwnerCosignerAccounts {
  owner: PublicKey;
  cosigner: PublicKey;
  pool: PublicKey;
}

export function buildUpdatePoolIx(accounts: PoolOwnerCosignerAccounts, args: UpdatePoolArgs): TransactionInstruction {
  const data = Buffer.concat([MMM_DISCRIMINATORS.updatePool, serializeUpdatePoolArgs(args)]);
  const keys: AccountMeta[] = [
    { pubkey: accounts.owner, isSigner: true, isWritable: true },
    { pubkey: accounts.cosigner, isSigner: true, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: MMM_PROGRAM_ID, keys, data });
}

// ── sol_deposit_buy / sol_withdraw_buy ──────────────────────────────────

export interface PoolEscrowAccounts extends PoolOwnerCosignerAccounts {
  escrow: PublicKey;
}

function serializeAmountArgs(disc: Buffer, paymentAmountLamports: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(paymentAmountLamports, 0);
  return Buffer.concat([disc, buf]);
}

export function buildSolDepositBuyIx(accounts: PoolEscrowAccounts, paymentAmountLamports: bigint): TransactionInstruction {
  const data = serializeAmountArgs(MMM_DISCRIMINATORS.solDepositBuy, paymentAmountLamports);
  const keys: AccountMeta[] = [
    { pubkey: accounts.owner, isSigner: true, isWritable: true },
    { pubkey: accounts.cosigner, isSigner: true, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
    { pubkey: accounts.escrow, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MMM_PROGRAM_ID, keys, data });
}

export function buildSolWithdrawBuyIx(accounts: PoolEscrowAccounts, paymentAmountLamports: bigint): TransactionInstruction {
  const data = serializeAmountArgs(MMM_DISCRIMINATORS.solWithdrawBuy, paymentAmountLamports);
  const keys: AccountMeta[] = [
    { pubkey: accounts.owner, isSigner: true, isWritable: true },
    { pubkey: accounts.cosigner, isSigner: true, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
    { pubkey: accounts.escrow, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MMM_PROGRAM_ID, keys, data });
}

// ── sol_close_pool ───────────────────────────────────────────────────────

export function buildSolClosePoolIx(accounts: PoolEscrowAccounts): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: accounts.owner, isSigner: true, isWritable: true },
    { pubkey: accounts.cosigner, isSigner: true, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: true },
    { pubkey: accounts.escrow, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MMM_PROGRAM_ID, keys, data: MMM_DISCRIMINATORS.solClosePool });
}

// ── Pool account decode — offsets independently re-derived from the
//    source's field declaration order (Borsh: fixed-size fields serialize
//    back-to-back, in-order, no padding) and cross-checked against
//    `tools-mmm-pools.ts`'s already-live-verified offsets for every field
//    both files read (spot_price, expiry, owner, cosigner,
//    buyside_payment_amount all match exactly). ────────────────────────────

export interface DecodedPool {
  spotPriceLamports: bigint;
  curveType: number;
  curveDelta: bigint;
  reinvestFulfillBuy: boolean;
  reinvestFulfillSell: boolean;
  expiry: bigint;
  lpFeeBp: number;
  referral: string;
  buysideCreatorRoyaltyBp: number;
  sellsideAssetAmount: bigint;
  lpFeeEarned: bigint;
  owner: string;
  cosigner: string;
  uuid: string;
  paymentMint: string;
  allowlists: Allowlist[];
  buysidePaymentAmount: bigint;
  sharedEscrowAccount: string;
  sharedEscrowCount: bigint;
}

const OFF = {
  spotPrice: 8, curveType: 16, curveDelta: 17, reinvestBuy: 25, reinvestSell: 26,
  expiry: 27, lpFeeBp: 35, referral: 37, referralBpDeprecated: 69, royaltyBp: 71,
  cosignerAnnotation: 73, sellsideAssetAmount: 105, lpFeeEarned: 113,
  owner: 121, cosigner: 153, uuid: 185, paymentMint: 217, allowlists: 249,
  buysidePaymentAmount: 447, sharedEscrowAccount: 455, sharedEscrowCount: 487,
};

export function decodePool(data: Buffer): DecodedPool | null {
  if (data.length !== POOL_ACCOUNT_SIZE) return null;
  const allowlists: Allowlist[] = [];
  for (let i = 0; i < ALLOWLIST_MAX_LEN; i++) {
    const o = OFF.allowlists + i * 33;
    allowlists.push({ kind: data.readUInt8(o), value: new PublicKey(data.subarray(o + 1, o + 33)) });
  }
  return {
    spotPriceLamports: data.readBigUInt64LE(OFF.spotPrice),
    curveType: data.readUInt8(OFF.curveType),
    curveDelta: data.readBigUInt64LE(OFF.curveDelta),
    reinvestFulfillBuy: data.readUInt8(OFF.reinvestBuy) !== 0,
    reinvestFulfillSell: data.readUInt8(OFF.reinvestSell) !== 0,
    expiry: data.readBigInt64LE(OFF.expiry),
    lpFeeBp: data.readUInt16LE(OFF.lpFeeBp),
    referral: new PublicKey(data.subarray(OFF.referral, OFF.referral + 32)).toBase58(),
    buysideCreatorRoyaltyBp: data.readUInt16LE(OFF.royaltyBp),
    sellsideAssetAmount: data.readBigUInt64LE(OFF.sellsideAssetAmount),
    lpFeeEarned: data.readBigUInt64LE(OFF.lpFeeEarned),
    owner: new PublicKey(data.subarray(OFF.owner, OFF.owner + 32)).toBase58(),
    cosigner: new PublicKey(data.subarray(OFF.cosigner, OFF.cosigner + 32)).toBase58(),
    uuid: new PublicKey(data.subarray(OFF.uuid, OFF.uuid + 32)).toBase58(),
    paymentMint: new PublicKey(data.subarray(OFF.paymentMint, OFF.paymentMint + 32)).toBase58(),
    allowlists,
    buysidePaymentAmount: data.readBigUInt64LE(OFF.buysidePaymentAmount),
    sharedEscrowAccount: new PublicKey(data.subarray(OFF.sharedEscrowAccount, OFF.sharedEscrowAccount + 32)).toBase58(),
    sharedEscrowCount: data.readBigUInt64LE(OFF.sharedEscrowCount),
  };
}

/** A fresh, randomly-generated uuid Pubkey — the program only uses this as
 *  a PDA-derivation salt (never signs, never needs a real keypair's
 *  private key held anywhere), letting one owner run multiple pools. */
export function generatePoolUuid(): PublicKey {
  return Keypair.generate().publicKey;
}
