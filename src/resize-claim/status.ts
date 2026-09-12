/**
 * Resize / Claim tool — post-submission reconciliation reads.
 *
 * The frontend has no RPC access anywhere in this codebase; this is the
 * one place it goes for "what actually happened to the signature(s) I
 * already got back from /send-tx" and "how fresh is my blockhash right
 * now" (used both as a pre-broadcast freshness gate and, on the
 * unresolved-after-budget path, to prove a never-landed signature's
 * blockhash has actually expired before it's treated as safe to rebuild).
 *
 * Purely a read proxy — never signs, never sends, never mutates anything.
 */

import { Connection } from '@solana/web3.js';

export interface SignatureStatusEntry {
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  err: unknown;
}

export interface StatusResult {
  blockHeight: number;
  /** same length/order as the requested signatures; null = RPC has no
   *  record of this signature (not necessarily "never broadcast" — see
   *  the frontend's classification logic for how this is combined with
   *  blockheight to decide safe-vs-unknown). */
  statuses: Array<SignatureStatusEntry | null>;
}

export async function checkStatus(conn: Connection, signatures: string[]): Promise<StatusResult> {
  const blockHeight = await conn.getBlockHeight('confirmed');
  if (signatures.length === 0) return { blockHeight, statuses: [] };

  const res = await conn.getSignatureStatuses(signatures, { searchTransactionHistory: true });
  const statuses = res.value.map((v): SignatureStatusEntry | null => {
    if (!v) return null;
    return { confirmationStatus: v.confirmationStatus ?? null, err: v.err ?? null };
  });
  return { blockHeight, statuses };
}
