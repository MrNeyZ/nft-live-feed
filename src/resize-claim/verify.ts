/**
 * Resize / Claim tool — read-only pre-signature verification.
 *
 * Two jobs, both purely diagnostic (no signing, no broadcast, no mutation):
 *
 *   1. ALT resolution — the frontend structural auditor (audit.ts) needs to
 *      know which real pubkey sits at every address-table-lookup index of
 *      the EXACT final bytes about to go to Phantom. Resolving a lookup
 *      table is an on-chain read; the frontend has no RPC access anywhere
 *      in this codebase (by design — the Helius key never leaves the
 *      backend), so this proxies exactly that one read, keyed off whatever
 *      lookup table(s) the transaction itself references — nothing hardcoded.
 *   2. Simulation — runs the exact final message (not a synthetic stand-in)
 *      through `simulateTransaction` with `sigVerify:false` (no signature
 *      exists yet). Catches AlreadyClaimed / AccountAlreadyResized / stale
 *      account state before the user is ever asked to approve anything.
 *
 * Both jobs run BEFORE any signature exists — this file never touches a
 * signed transaction and never calls sendTransaction.
 */

import { Connection, VersionedTransaction } from '@solana/web3.js';

export interface VerifyResult {
  /** address-table pubkey (base58) -> its full address list, in index order.
   *  Empty for a transaction that references no lookup table (the resize
   *  path never does). */
  alts: Record<string, string[]>;
  simulation: {
    /** null = simulation succeeded; otherwise the on-chain TransactionError,
     *  e.g. an InstructionError carrying AlreadyClaimed/AccountAlreadyResized. */
    err: unknown;
    unitsConsumed: number | null;
    /** capped — this is for a human/log, not a machine contract */
    logs: string[] | null;
  };
}

const MAX_LOG_LINES = 60;

export async function verifyTransaction(conn: Connection, txBase64: string): Promise<VerifyResult> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const msg = tx.message;

  const alts: Record<string, string[]> = {};
  for (const lookup of msg.addressTableLookups) {
    const key = lookup.accountKey.toBase58();
    if (key in alts) continue;
    const res = await conn.getAddressLookupTable(lookup.accountKey);
    if (!res.value) throw new Error(`address lookup table ${key} not found on chain`);
    alts[key] = res.value.state.addresses.map((a) => a.toBase58());
  }

  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
  });

  return {
    alts,
    simulation: {
      err: sim.value.err ?? null,
      unitsConsumed: typeof sim.value.unitsConsumed === 'number' ? sim.value.unitsConsumed : null,
      logs: sim.value.logs ? sim.value.logs.slice(0, MAX_LOG_LINES) : null,
    },
  };
}
