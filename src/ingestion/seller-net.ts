/**
 * Best-effort seller-net price extraction.
 *
 * Computes the actual SOL amount the seller account received from the
 * tx's pre/post balance deltas. Captures real proceeds after
 * marketplace fees + royalties without hard-coded percentages — what
 * the seller ended the tx with vs. what they started with.
 *
 * Returns null when:
 *   - the seller isn't in accountKeys (e.g. cNFT, mint authority paths)
 *   - balance delta is non-positive (rare: refund-only flows, or the
 *     seller paid the tx fee and netted out around zero)
 *
 * The caller stores this alongside the existing gross `priceLamports`;
 * neither replaces the other. Frontend prefers seller-net when present.
 */

import type { RawSolanaTx } from './me-raw/types';

export function computeSellerNetLamports(
  tx: RawSolanaTx,
  sellerAddress: string,
): bigint | null {
  if (!sellerAddress) return null;
  const message = tx.transaction?.message;
  if (!message) return null;
  // accountKeys after fetchRawTx's merge are objects with .pubkey.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (message as any).accountKeys as Array<string | { pubkey: string }> | undefined;
  if (!Array.isArray(rawKeys)) return null;

  const idx = rawKeys.findIndex(k =>
    (typeof k === 'string' ? k : k?.pubkey) === sellerAddress,
  );
  if (idx < 0) return null;

  const pre  = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) return null;
  if (idx >= pre.length || idx >= post.length) return null;

  // bigint math: balances are u64 lamports. The pre/post arrays are
  // numbers in the raw RPC response — fine for SOL price ranges (<2^53)
  // but normalised to bigint for parity with the rest of the pipeline.
  const preLam  = BigInt(pre[idx]  as number);
  const postLam = BigInt(post[idx] as number);
  const delta = postLam - preLam;
  return delta > 0n ? delta : null;
}

/** Sampled debug: log when seller-net differs from gross (i.e. fees +
 *  royalties were taken). First event + every 25th event. Same cadence
 *  as the other ingestion sample logs in this codebase. */
let _sellerNetDiffCount = 0;
export function logSellerNetDiff(opts: {
  signature:        string;
  marketplace:      string;
  priceLamports:    bigint;
  sellerNetLamports?: bigint | null;
}): void {
  const net = opts.sellerNetLamports ?? null;
  if (net == null) return;
  if (net === opts.priceLamports) return;
  _sellerNetDiffCount++;
  if (_sellerNetDiffCount === 1 || _sellerNetDiffCount % 25 === 0) {
    const grossSol = Number(opts.priceLamports) / 1e9;
    const netSol   = Number(net) / 1e9;
    const feePct   = grossSol > 0 ? ((1 - netSol / grossSol) * 100).toFixed(2) : '—';
    console.log(
      `[seller-net] mp=${opts.marketplace}  ` +
      `gross=${grossSol.toFixed(4)} net=${netSol.toFixed(4)} feePct=${feePct}%  ` +
      `n=${_sellerNetDiffCount}  sig=${opts.signature.slice(0, 12)}…`,
    );
  }
}
