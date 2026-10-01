/**
 * ME Offer Accept — atomic escrow top-up bundle (2026-09-29).
 *
 * Underfunded M2 bids (escrow < price + royalty) can be filled by anyone who
 * tops the buyer's escrow PDA up first — but a STANDALONE top-up is
 * unrecoverable SOL sitting in someone else's escrow: the accept can fail
 * afterwards (stale blockhash, ME 429, dropped tx), any other holder can
 * sell into one of the buyer's other bids sharing the same escrow, or the
 * buyer can withdraw it. The top-up can't go INSIDE ME's accept tx either —
 * ME's notary signature covers that exact message.
 *
 * So: [top-up tx, ME accept tx (untouched), tip tx] as ONE Jito bundle —
 * all land in order in one slot, or none do. The tip lives in its own LAST
 * tx so a validator that unbundles the txs can only collect it if the sale
 * itself landed.
 */
import {
  PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type TransactionInstruction,
} from '@solana/web3.js';
import { messageHashHex } from './tools-me-bids';

/** Live-verified via getTipAccounts 2026-09-29. */
export const JITO_TIP_ACCOUNTS = [
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];
export const JITO_TIP_LAMPORTS = 2_000_000; // 0.002 SOL
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];
/** Anything the simulated sale leaves behind in the escrow is our SOL lost
 *  to the buyer — the top-up is sized exactly, so allow only dust. */
export const MAX_ESCROW_LEFTOVER_LAMPORTS = 1_000_000;

export interface BundleAux {
  escrowPda: string;
  escrowLamportsAtBuild: number;
  requiredLamports: number;
  topupLamports: number;
  tipLamports: number;
  tipAccount: string;
  topupHash: string;
  tipHash: string;
}

export function buildAuxTxs(p: {
  seller: PublicKey; escrowPda: PublicKey; topupLamports: number; blockhash: string;
}): { topup: Transaction; tip: Transaction; tipAccount: string } {
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const topup = new Transaction({ feePayer: p.seller, recentBlockhash: p.blockhash }).add(
    SystemProgram.transfer({ fromPubkey: p.seller, toPubkey: p.escrowPda, lamports: p.topupLamports }),
  );
  const tip = new Transaction({ feePayer: p.seller, recentBlockhash: p.blockhash }).add(
    SystemProgram.transfer({ fromPubkey: p.seller, toPubkey: new PublicKey(tipAccount), lamports: JITO_TIP_LAMPORTS }),
  );
  return { topup, tip, tipAccount };
}

export function unsignedB64(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** Signed aux tx must be byte-identical (message) to what build handed out,
 *  fully signed, and signed validly. */
export function checkSignedAux(signedB64: string, expectedHash: string): { ok: true; tx: Transaction } | { ok: false; reason: string } {
  let tx: Transaction;
  try { tx = Transaction.from(Buffer.from(signedB64, 'base64')); }
  catch (e) { return { ok: false, reason: `aux_decode_failed: ${(e as Error).message}` }; }
  if (messageHashHex(tx) !== expectedHash) return { ok: false, reason: 'aux_message_does_not_match_build' };
  if (!tx.verifySignatures(true)) return { ok: false, reason: 'aux_invalid_signature' };
  return { ok: true, tx };
}

/** One tx = top-up ixs + sale ixs, for sigVerify:false simulation only
 *  (never signed/sent — the real sale tx is ME's untouched bytes). */
export function combineForSim(p: {
  payer: PublicKey; blockhash: string; topupIx: TransactionInstruction; saleIxs: TransactionInstruction[];
  alts: AddressLookupTableAccount[];
}): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: p.payer, recentBlockhash: p.blockhash, instructions: [p.topupIx, ...p.saleIxs],
  }).compileToV0Message(p.alts);
  return new VersionedTransaction(msg);
}

/** Fire the bundle at several regional block engines (same bundle id —
 *  duplicates are deduped). Succeeds if at least one accepted it. */
export async function sendJitoBundle(txsB64: string[]): Promise<{ bundleId: string; accepted: number; errors: string[] }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [txsB64, { encoding: 'base64' }] });
  const results = await Promise.all(JITO_ENDPOINTS.map(async (base) => {
    try {
      const r = await fetch(`${base}/api/v1/bundles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8_000),
      });
      const j = await r.json() as { result?: string; error?: { message?: string } };
      if (typeof j.result === 'string') return { id: j.result };
      return { err: `${new URL(base).hostname}: ${j.error?.message ?? `HTTP ${r.status}`}` };
    } catch (e) { return { err: `${new URL(base).hostname}: ${(e as Error).message}` }; }
  }));
  const ids = results.filter((x): x is { id: string } => 'id' in x).map((x) => x.id);
  const errors = results.filter((x): x is { err: string } => 'err' in x).map((x) => x.err);
  if (ids.length === 0) throw new Error(`jito_rejected_everywhere: ${errors.join(' | ')}`);
  return { bundleId: ids[0], accepted: ids.length, errors };
}
