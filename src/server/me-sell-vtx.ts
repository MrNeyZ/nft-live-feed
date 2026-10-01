/**
 * ME Sell — versioned (v0 + address lookup table) transaction support.
 *
 * WHY THIS EXISTS. ME's `/instructions/batch` response carries TWO variants
 * of the same accept-offer bundle: the legacy `txSigned` and a `v0.txSigned`
 * (this is also what magiceden.io's own UI receives — see the 2026-08-24
 * HAR). For pNFTs with several creators the legacy variant exceeds Solana's
 * 1232-byte cap (Trippin' Ape Tribe #3881: 1376 bytes, "Transaction too
 * large") while ME's v0 variant is 1040 bytes and already carries ME's
 * cosigner signature over the v0 message. This tool only ever consumed the
 * legacy one. Nothing here re-signs or rebuilds a message: the bytes ME
 * signed are the bytes the seller signs and we send.
 *
 * The auditor (me-sell-auditor.ts) works on resolved instructions, so a v0
 * tx is adapted to `AuditableTx` here after its lookup-table accounts are
 * fetched. The lookup table is pinned to ME's own shared table — the same
 * one tools-mmm-pools.ts already relies on (`MMM_SHARED_ALT_ADDRESS`) and
 * the one observed on the real v0 bundle (60 addresses). Lookup-table
 * accounts can never be signers, so the fee payer and both signer slots are
 * always in the static keys the auditor checks.
 */
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import { PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js';
import type { AuditableTx } from './me-sell-auditor';

/** Solana's max serialized transaction size. */
export const TX_WIRE_LIMIT = 1232;

/** ME's shared address lookup table. Any other table is rejected — a v0 tx
 *  pointing at an unknown table could resolve indexes to arbitrary accounts. */
export const ME_ALLOWED_ALTS: readonly string[] = ['9JqEwvgiSLd5gvMKtKXTYtmKBuhByGRZe7iPzHNQd4s3'];

export type AltFetcher = (key: PublicKey) => Promise<AddressLookupTableAccount | null>;

export function decodeVersionedTxFromBytes(bytes: Buffer): VersionedTransaction {
  let vtx: VersionedTransaction;
  try { vtx = VersionedTransaction.deserialize(bytes); }
  catch (err) { throw new Error(`tx_undecodable_not_v0: ${err instanceof Error ? err.message : String(err)}`); }
  if (vtx.message.version !== 0) throw new Error('tx_not_v0');
  return vtx;
}

export function decodeVersionedTxFromBase64(b64: string): VersionedTransaction {
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, 'base64'); } catch { throw new Error('invalid_tx_encoding'); }
  return decodeVersionedTxFromBytes(bytes);
}

/** Hash of the canonical v0 message only (excludes signatures), the same
 *  role `messageHashHex` plays for legacy transactions. */
export function versionedMessageHashHex(vtx: VersionedTransaction): string {
  return createHash('sha256').update(vtx.message.serialize()).digest('hex');
}

function isAllZero(sig: Uint8Array | undefined): boolean {
  if (!sig) return true;
  for (const b of sig) if (b !== 0) return false;
  return true;
}

/**
 * Adapt a v0 transaction for `auditMeSellTransaction`: resolve its lookup
 * table(s) against the chain, decompile to plain instructions, and expose
 * the signer slots. Throws (fail closed) on a non-allowlisted / missing /
 * surplus lookup table.
 */
export async function toAuditableTx(vtx: VersionedTransaction, fetchAlt: AltFetcher): Promise<AuditableTx> {
  const msg = vtx.message;
  if (msg.version !== 0) throw new Error('tx_not_v0');
  const lookups = msg.addressTableLookups;
  if (lookups.length > 1) throw new Error(`too_many_lookup_tables: ${lookups.length}`);
  const alts: AddressLookupTableAccount[] = [];
  for (const l of lookups) {
    const key = l.accountKey.toBase58();
    if (!ME_ALLOWED_ALTS.includes(key)) throw new Error(`alt_not_allowed: ${key}`);
    const alt = await fetchAlt(l.accountKey);
    if (!alt) throw new Error(`alt_unavailable: ${key}`);
    alts.push(alt);
  }
  const decompiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: alts });
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures);
  return {
    signatures: signers.map((publicKey, i) => ({
      publicKey,
      signature: isAllZero(vtx.signatures[i]) ? null : Buffer.from(vtx.signatures[i]),
    })),
    feePayer: decompiled.payerKey,
    recentBlockhash: msg.recentBlockhash,
    instructions: decompiled.instructions,
  };
}

/** Cryptographically verify EVERY required signature slot against the exact
 *  message bytes — the versioned equivalent of `tx.verifySignatures(true)`. */
export function verifyVersionedSignatures(vtx: VersionedTransaction): boolean {
  const msg = vtx.message;
  const n = msg.header.numRequiredSignatures;
  if (vtx.signatures.length !== n) return false;
  const bytes = msg.serialize();
  for (let i = 0; i < n; i++) {
    const sig = vtx.signatures[i];
    if (isAllZero(sig)) return false;
    if (!nacl.sign.detached.verify(bytes, sig, msg.staticAccountKeys[i].toBytes())) return false;
  }
  return true;
}
