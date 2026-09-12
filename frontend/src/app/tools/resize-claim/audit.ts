// Resize Claim — structural audit of the FINAL transaction bytes handed to
// Phantom. Pure (no network calls of its own — ALT contents are supplied by
// the caller, already read-only-resolved via POST /resize-claim/verify).
// Runs on the exact base64 that will be signed, for every tracked tx, and
// fails CLOSED before any signature is requested.
//
// The account layouts below are not guessed — they mirror
// src/resize-claim/program.ts's real, live-simulation-verified builders
// exactly (see docs/resize-claim-audit-2026-09-12.md §8/§27). Frontend and
// backend are separate TS projects in this repo (no shared import path),
// so the constants are duplicated here as literals — the same convention
// ../candy-mint/audit.ts already uses for ITS program IDs.
//
// If program.ts's account order ever changes, this file's regression
// fixtures (audit.test.ts, built from the REAL production builder) force a
// deliberate review — do not loosen a check just to make a fixture pass.

import { PublicKey, VersionedTransaction, AddressLookupTableAccount, MessageV0, type MessageCompiledInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { TxKind } from './logic';

// ── program ids / constants (mirrors src/resize-claim/program.ts) ────────
export const PROGRAMS = {
  mplDistro: 'RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4',
  tokenMetadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  system: '11111111111111111111111111111111',
  associatedToken: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  splToken: TOKEN_PROGRAM_ID.toBase58(),
  sysvarInstructions: 'Sysvar1nstructions1111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
} as const;

export const TM_RESIZE_DISTRIBUTION = '7mRLZe6KxNcS27ABv3nxyr4TWTTEt4eY6svhXF25Sj6B';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const CLAIM_ALT_ADDRESS = '73spkUGYUH5B1oPYQh7GxbfosDiLEEdqNnMHbL2mXhio';

const DISTRIBUTE_TO_LEGACY_NFT_DISC = 5;
const RESIZE_DISC = 56;
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

// Mirrors build.ts's own constants exactly — these are OUR builder's
// deterministic choices, not guesses.
export const RESIZE_COMPUTE_UNITS_EACH = 40_000;
export const MAX_RESIZE_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000; // matches tools-resize-claim.ts's own /build validation bound — the auditor independently re-checks it against the compiled bytes rather than trusting that validation was actually applied upstream.
const RESIZES_PER_TX_MAX = 8;

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), new PublicKey(PROGRAMS.tokenMetadata).toBuffer(), mint.toBuffer()],
    new PublicKey(PROGRAMS.tokenMetadata),
  )[0];
}
function masterEditionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), new PublicKey(PROGRAMS.tokenMetadata).toBuffer(), mint.toBuffer(), Buffer.from('edition')],
    new PublicKey(PROGRAMS.tokenMetadata),
  )[0];
}
function claimReceiptPda(nftMint: PublicKey, amount: bigint, nonce: bigint = BigInt(0)): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim_receipt'), new PublicKey(TM_RESIZE_DISTRIBUTION).toBuffer(), nftMint.toBuffer(), u64le(amount), u64le(nonce)],
    new PublicKey(PROGRAMS.mplDistro),
  )[0];
}
function distributionVault(): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(TM_RESIZE_DISTRIBUTION), true);
}

// ── frozen intent ──────────────────────────────────────────────────────────

export interface FrozenClaim { mint: string; amountLamports: string; proof: string[] }
export interface FrozenResize { mint: string }

export interface FrozenResizeClaimIntent {
  wallet: string;
  claims: Map<string, FrozenClaim>; // keyed by mint
  resizes: Set<string>;             // mints
}

export function freezeIntent(wallet: string, claims: FrozenClaim[], resizes: FrozenResize[]): FrozenResizeClaimIntent {
  return {
    wallet,
    claims: new Map(claims.map((c) => [c.mint, c])),
    resizes: new Set(resizes.map((r) => r.mint)),
  };
}

export type AuditResult = { ok: true } | { ok: false; reason: string };
function fail(reason: string): AuditResult { return { ok: false, reason }; }

/** Build the real AddressLookupTableAccount objects the message's own
 *  lookups reference, from the raw address lists POST /verify returned
 *  (a real on-chain read, done server-side since the frontend has no RPC
 *  access anywhere in this app). Only the `.addresses` field is used by
 *  web3.js's own `resolveAddressTableLookups`, so the rest of
 *  AddressLookupTableState is filled with inert placeholder values. */
function buildAltAccounts(alts: Record<string, string[]>): AddressLookupTableAccount[] {
  return Object.entries(alts).map(([key, addresses]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: addresses.map((a) => new PublicKey(a)),
    },
  }));
}

/**
 * Audits the EXACT final bytes about to be handed to Phantom for one
 * tracked transaction. `alts` must be the result of a `/verify` call made
 * against these SAME bytes (not an earlier synthetic representation) —
 * callers must not audit stale/different bytes than what gets signed.
 */
export function auditResizeClaimTx(
  txBase64: string,
  tracked: { kind: TxKind; mints: string[] },
  intent: FrozenResizeClaimIntent,
  alts: Record<string, string[]>,
): AuditResult {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  } catch (e) {
    return fail(`transaction did not parse: ${(e as Error).message}`);
  }
  if (tx.message.version !== 0) return fail(`expected a v0 VersionedTransaction, got version ${tx.message.version}`);
  const msg: MessageV0 = tx.message;
  if (!msg.recentBlockhash) return fail('transaction has no recent blockhash');

  let altAccounts: AddressLookupTableAccount[];
  try {
    altAccounts = buildAltAccounts(alts);
  } catch (e) {
    return fail(`could not reconstruct address lookup table(s): ${(e as Error).message}`);
  }
  let accountKeys;
  try {
    const resolved = msg.resolveAddressTableLookups(altAccounts);
    accountKeys = msg.getAccountKeys({ accountKeysFromLookups: resolved });
  } catch (e) {
    return fail(`could not resolve address table lookups: ${(e as Error).message}`);
  }
  const at = (i: number): string | undefined => accountKeys.get(i)?.toBase58();

  // fee payer / required signer — always index 0 in a message compiled by
  // TransactionMessage.compileToV0Message (web3.js guarantee) — must be the
  // reviewed wallet, no one else's.
  if (at(0) !== intent.wallet) {
    return fail(`fee payer #0 is ${at(0)?.slice(0, 8) ?? '<missing>'}…, expected the reviewed wallet ${intent.wallet.slice(0, 8)}…`);
  }
  if (!msg.isAccountSigner(0) || !msg.isAccountWritable(0)) {
    return fail('fee payer #0 must be a writable signer');
  }

  // no unexpected additional unsigned/unknown required-signer slots beyond
  // the fee payer itself — this feature never has a second signer.
  if (msg.header.numRequiredSignatures !== 1) {
    return fail(`expected exactly 1 required signer, got ${msg.header.numRequiredSignatures}`);
  }

  const ixs = msg.compiledInstructions;

  if (tracked.kind === 'claim') return auditClaim(ixs, at, intent, tracked.mints, msg);
  return auditResize(ixs, at, intent, tracked.mints, msg);
}

function auditClaim(
  ixs: MessageCompiledInstruction[],
  at: (i: number) => string | undefined,
  intent: FrozenResizeClaimIntent,
  mints: string[],
  msg: MessageV0,
): AuditResult {
  if (mints.length !== 1) return fail(`claim transaction must cover exactly 1 mint, got ${mints.length}`);
  const mint = mints[0];
  const frozen = intent.claims.get(mint);
  if (!frozen) return fail(`claim for mint ${mint.slice(0, 8)}… is not part of the reviewed/frozen intent`);

  if (msg.addressTableLookups.length > 1) return fail(`expected at most 1 address lookup table, got ${msg.addressTableLookups.length}`);
  if (msg.addressTableLookups.length === 1 && msg.addressTableLookups[0].accountKey.toBase58() !== CLAIM_ALT_ADDRESS) {
    return fail(`unexpected address lookup table ${msg.addressTableLookups[0].accountKey.toBase58().slice(0, 8)}…`);
  }

  if (ixs.length !== 1) return fail(`expected exactly 1 top-level instruction for a claim, got ${ixs.length} (no ComputeBudget on this path — see build.ts's packing note)`);
  const ix = ixs[0];
  const programId = at(ix.programIdIndex);
  if (programId !== PROGRAMS.mplDistro) return fail(`claim instruction program is ${programId?.slice(0, 8) ?? '<missing>'}…, expected the mplDistro program`);

  if (ix.data.length < 1 || ix.data[0] !== DISTRIBUTE_TO_LEGACY_NFT_DISC) {
    return fail(`claim instruction discriminator is ${ix.data[0]}, expected ${DISTRIBUTE_TO_LEGACY_NFT_DISC} (DistributeToLegacyNft)`);
  }

  // ── data field: amount + proof must match the frozen intent exactly.
  //    Proof is NOT part of the ClaimReceipt PDA seeds (only mint+amount
  //    are), so a substituted proof would NOT be caught by account pinning
  //    alone — this is the one place that check has to live.
  const data = Buffer.from(ix.data);
  if (data.length < 13) return fail('claim instruction data is too short');
  const amount = data.readBigUInt64LE(1);
  const expectedAmount = BigInt(frozen.amountLamports);
  if (amount !== expectedAmount) return fail(`claim amount ${amount} != reviewed amount ${expectedAmount}`);
  const proofLen = data.readUInt32LE(9);
  if (proofLen !== frozen.proof.length) return fail(`claim proof length ${proofLen} != reviewed proof length ${frozen.proof.length}`);
  const expectedDataLen = 13 + proofLen * 32 + 8;
  if (data.length !== expectedDataLen) return fail(`claim instruction data length ${data.length} != expected ${expectedDataLen}`);
  for (let i = 0; i < proofLen; i++) {
    const node = new PublicKey(data.subarray(13 + i * 32, 13 + i * 32 + 32)).toBase58();
    if (node !== frozen.proof[i]) return fail(`claim proof node #${i} does not match the reviewed proof`);
  }
  const nonce = data.readBigUInt64LE(13 + proofLen * 32);
  if (nonce !== BigInt(0)) return fail(`claim nonce ${nonce} != 0`);

  // ── account pins (13 accounts, order per program.ts's builder) ─────────
  const claimReceipt = claimReceiptPda(new PublicKey(mint), expectedAmount).toBase58();
  const recipientWsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(intent.wallet), true).toBase58();
  const nftAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(intent.wallet), true).toBase58();
  const vault = distributionVault().toBase58();

  const acc = ix.accountKeyIndexes.map(at);
  const pins: Array<[number, string, string]> = [
    [0, TM_RESIZE_DISTRIBUTION, 'distribution'],
    [1, WSOL_MINT, 'wSOL mint'],
    [2, claimReceipt, 'claimReceipt PDA'],
    [3, recipientWsolAta, 'recipient wSOL ATA'],
    [4, vault, 'distribution vault'],
    [5, mint, 'nftMint'],
    [6, nftAta, 'nftAta'],
    [7, intent.wallet, 'nftOwner slot (inert on-chain — see program.ts RC-6 note; pinned for build-drift detection)'],
    [8, intent.wallet, 'payer'],
    [9, PROGRAMS.associatedToken, 'associatedTokenProgram'],
    [10, PROGRAMS.splToken, 'tokenProgram'],
    [11, PROGRAMS.system, 'systemProgram'],
    [12, PROGRAMS.sysvarInstructions, 'sysvarInstructions'],
  ];
  if (acc.length !== pins.length) return fail(`claim instruction has ${acc.length} accounts, expected ${pins.length}`);
  for (const [i, want, label] of pins) {
    if (acc[i] !== want) return fail(`claim account #${i} (${label}) is ${acc[i]?.slice(0, 8) ?? '<missing>'}…, expected ${want.slice(0, 8)}…`);
  }
  const payerIdx = ix.accountKeyIndexes[8];
  if (!msg.isAccountSigner(payerIdx)) return fail('claim account #8 (payer) must be a signer');
  if (!msg.isAccountWritable(payerIdx)) return fail('claim account #8 (payer) must be writable');
  // No separate "no other account is unexpectedly a signer" loop is needed
  // (or correct) here: signer-ness is a property of the GLOBAL account
  // position, not something a single instruction's own key list can assert
  // independently for a pubkey that's already the tx's fee payer elsewhere
  // (e.g. account #7, which is this same wallet — see program.ts's RC-6
  // note — reads as a signer too, correctly, since it's the same global
  // key as #8/#0). The `numRequiredSignatures !== 1` check above already
  // proves, globally, that the wallet is the ONLY signer in this entire
  // transaction — that's the real invariant, and per-instruction-local
  // re-derivation of it here would be both redundant and wrong.

  return { ok: true };
}

function auditResize(
  ixs: MessageCompiledInstruction[],
  at: (i: number) => string | undefined,
  intent: FrozenResizeClaimIntent,
  mints: string[],
  msg: MessageV0,
): AuditResult {
  if (mints.length === 0) return fail('resize transaction covers 0 mints');
  if (mints.length > RESIZES_PER_TX_MAX) return fail(`resize transaction covers ${mints.length} mints, more than the ${RESIZES_PER_TX_MAX}/tx batch limit`);
  if (new Set(mints).size !== mints.length) return fail('resize transaction lists a duplicate target mint');
  for (const m of mints) {
    if (!intent.resizes.has(m)) return fail(`resize target ${m.slice(0, 8)}… is not part of the reviewed/frozen intent`);
  }
  if (msg.addressTableLookups.length !== 0) return fail('resize transaction unexpectedly references an address lookup table');

  const expected = 2 + mints.length;
  if (ixs.length !== expected) {
    return fail(`expected exactly ${expected} top-level instructions (2 ComputeBudget + ${mints.length} Resize), got ${ixs.length}`);
  }

  // ── ComputeBudget[0]/[1] ─────────────────────────────────────────────
  const cb0 = ixs[0]; const cb1 = ixs[1];
  if (at(cb0.programIdIndex) !== PROGRAMS.computeBudget || at(cb1.programIdIndex) !== PROGRAMS.computeBudget) {
    return fail('first 2 instructions must both be ComputeBudget');
  }
  if (cb0.data[0] !== CB_SET_UNIT_LIMIT) return fail(`instruction 0 opcode ${cb0.data[0]} != SetComputeUnitLimit`);
  if (cb1.data[0] !== CB_SET_UNIT_PRICE) return fail(`instruction 1 opcode ${cb1.data[0]} != SetComputeUnitPrice`);
  const units = Buffer.from(cb0.data).readUInt32LE(1);
  const expectedUnits = RESIZE_COMPUTE_UNITS_EACH * mints.length;
  if (units !== expectedUnits) return fail(`compute unit limit ${units} != expected ${expectedUnits} (${RESIZE_COMPUTE_UNITS_EACH} × ${mints.length})`);
  const price = Buffer.from(cb1.data).readBigUInt64LE(1);
  if (price > BigInt(MAX_RESIZE_COMPUTE_UNIT_PRICE_MICROLAMPORTS)) {
    return fail(`compute unit price ${price} µL exceeds the ${MAX_RESIZE_COMPUTE_UNIT_PRICE_MICROLAMPORTS} µL ceiling`);
  }

  // ── one Resize instruction per mint, in order ────────────────────────
  for (let g = 0; g < mints.length; g++) {
    const ix = ixs[2 + g];
    const mint = mints[g];
    const programId = at(ix.programIdIndex);
    if (programId !== PROGRAMS.tokenMetadata) return fail(`resize instruction ${g} program is ${programId?.slice(0, 8) ?? '<missing>'}…, expected token-metadata`);
    if (ix.data.length !== 1 || ix.data[0] !== RESIZE_DISC) {
      return fail(`resize instruction ${g} discriminator ${ix.data[0]} != ${RESIZE_DISC}`);
    }
    const acc = ix.accountKeyIndexes.map(at);
    const metadata = metadataPda(new PublicKey(mint)).toBase58();
    const edition = masterEditionPda(new PublicKey(mint)).toBase58();
    const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(intent.wallet), true).toBase58();
    const pins: Array<[number, string, string]> = [
      [0, metadata, 'metadata'],
      [1, edition, 'masterEdition'],
      [2, mint, 'mint'],
      [3, intent.wallet, 'payer'],
      [4, intent.wallet, 'holder/authority'],
      [5, tokenAccount, 'token account'],
      [6, PROGRAMS.system, 'systemProgram'],
    ];
    if (acc.length !== pins.length) return fail(`resize instruction ${g} has ${acc.length} accounts, expected ${pins.length}`);
    for (const [i, want, label] of pins) {
      if (acc[i] !== want) return fail(`resize instruction ${g} account #${i} (${label}) is ${acc[i]?.slice(0, 8) ?? '<missing>'}…, expected ${want.slice(0, 8)}…`);
    }
    const payerIdx = ix.accountKeyIndexes[3];
    const holderIdx = ix.accountKeyIndexes[4];
    if (!msg.isAccountSigner(payerIdx) || !msg.isAccountWritable(payerIdx)) return fail(`resize instruction ${g} account #3 (payer) must be a writable signer`);
    if (!msg.isAccountSigner(holderIdx)) return fail(`resize instruction ${g} account #4 (holder) must be a signer`);
  }

  return { ok: true };
}
