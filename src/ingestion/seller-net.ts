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

/** Sampled debug for cross-checking against the Magic Eden UI.
 *
 * Two log streams, both sampled (1st event + every 25th):
 *   [seller-net]          status=net      → seller-net was extracted
 *   [seller-net/fallback] status=fallback → couldn't compute seller-net,
 *                                           UI will display gross
 *
 * Each line carries enough context to open ME side-by-side and verify:
 *   - signature → click through on /feed → ME item page
 *   - mint     → direct ME item URL
 *   - seller   → ME wallet activities page
 *   - gross    → expected when ME's "Inclusive of all fees" is ON
 *   - net      → expected when ME's "Inclusive of all fees" is OFF
 *
 * The `feePct` is computed live from the actual SOL deltas — no fixed
 * royalty / marketplace-fee percentages anywhere in this code. */
let _sellerNetUsedCount     = 0;
let _sellerNetFallbackCount = 0;
export function logSellerNetDiff(opts: {
  signature:          string;
  marketplace:        string;
  priceLamports:      bigint;
  sellerNetLamports?: bigint | null;
  mint?:              string | null;
  seller?:            string | null;
}): void {
  const net = opts.sellerNetLamports ?? null;
  const sigShort    = opts.signature.slice(0, 12) + '…';
  const mintShort   = opts.mint   ? opts.mint.slice(0, 8)   + '…' : '—';
  const sellerShort = opts.seller ? opts.seller.slice(0, 8) + '…' : '—';

  if (net == null) {
    _sellerNetFallbackCount++;
    if (_sellerNetFallbackCount === 1 || _sellerNetFallbackCount % 25 === 0) {
      console.log(
        `[seller-net/fallback] status=fallback  mp=${opts.marketplace}  ` +
        `gross=${(Number(opts.priceLamports) / 1e9).toFixed(4)}  ` +
        `mint=${mintShort}  seller=${sellerShort}  sig=${sigShort}  ` +
        `n=${_sellerNetFallbackCount}`,
      );
    }
    return;
  }
  if (net === opts.priceLamports) return;        // no diff to report

  _sellerNetUsedCount++;
  if (_sellerNetUsedCount === 1 || _sellerNetUsedCount % 25 === 0) {
    const grossSol = Number(opts.priceLamports) / 1e9;
    const netSol   = Number(net) / 1e9;
    const feePct   = grossSol > 0 ? ((1 - netSol / grossSol) * 100).toFixed(2) : '—';
    console.log(
      `[seller-net] status=net  mp=${opts.marketplace}  ` +
      `gross=${grossSol.toFixed(4)} net=${netSol.toFixed(4)} feePct=${feePct}%  ` +
      `mint=${mintShort}  seller=${sellerShort}  sig=${sigShort}  ` +
      `n=${_sellerNetUsedCount}`,
    );
  }
}

/** Sampled log for AMM_SELL (`pool_sale`) only — mirror of what the
 *  frontend's `displayPrice()` will surface depending on the per-user
 *  "Inclusive fees" toggle. The server doesn't see the toggle, so we
 *  log both numbers + the *default-OFF* displayedMode (`sellerNet`
 *  when present, otherwise `gross`). Lets the operator eyeball
 *  whether AMM pool sales are surfacing realistic seller-net values
 *  vs. gross / pool prices. Sampled (1st + every 25th). */
let _ammSellLogCount = 0;
export function logAmmSellPriceMode(opts: {
  signature:          string;
  priceLamports:      bigint;
  sellerNetLamports?: bigint | null;
  mint?:              string | null;
  seller?:            string | null;
}): void {
  _ammSellLogCount++;
  if (_ammSellLogCount !== 1 && _ammSellLogCount % 25 !== 0) return;
  const net          = opts.sellerNetLamports ?? null;
  const grossSol     = Number(opts.priceLamports) / 1e9;
  const netSol       = net != null ? Number(net) / 1e9 : null;
  const displayedOff = net != null ? 'sellerNet' : 'gross'; // default-OFF UI
  const sigShort     = opts.signature.slice(0, 12) + '…';
  const mintShort    = opts.mint   ? opts.mint.slice(0, 8)   + '…' : '—';
  const sellerShort  = opts.seller ? opts.seller.slice(0, 8) + '…' : '—';
  console.log(
    `[price-mode/amm-sell] gross=${grossSol.toFixed(4)} ` +
    `net=${netSol != null ? netSol.toFixed(4) : '—'} ` +
    `displayedMode=${displayedOff}  ` +
    `seller=${sellerShort}  mint=${mintShort}  sig=${sigShort}  ` +
    `n=${_ammSellLogCount}`,
  );
}

/** Per-saleType audit. Lets the operator see, for each canonical
 *  saleType (`normal_sale` = LIST_BUY, `bid_sell` = BID_SELL,
 *  `pool_buy` = AMM_BUY, `pool_sale` = AMM_SELL), whether seller-net
 *  was recovered or fell back to gross — and whether net actually
 *  differs from gross. Sampled per-saleType (1st + every 25th) so a
 *  burst on one path doesn't mask the others. */
const _auditCounts = new Map<string, number>();
export function logSellerNetAudit(opts: {
  signature:          string;
  saleType:           string;
  marketplace:        string;
  priceLamports:      bigint;
  sellerNetLamports?: bigint | null;
  mint?:              string | null;
  seller?:            string | null;
}): void {
  const n = (_auditCounts.get(opts.saleType) ?? 0) + 1;
  _auditCounts.set(opts.saleType, n);
  if (n !== 1 && n % 25 !== 0) return;

  const fallback   = opts.sellerNetLamports == null;
  const grossSol   = Number(opts.priceLamports) / 1e9;
  const netSol     = !fallback ? Number(opts.sellerNetLamports!) / 1e9 : null;
  const sigShort   = opts.signature.slice(0, 12) + '…';
  const mintShort  = opts.mint   ? opts.mint.slice(0, 8)   + '…' : '—';
  const sellerShort = opts.seller ? opts.seller.slice(0, 8) + '…' : '—';
  console.log(
    `[seller-net/audit] saleType=${opts.saleType}  ` +
    `gross=${grossSol.toFixed(4)} net=${netSol != null ? netSol.toFixed(4) : '—'}  ` +
    `fallback=${fallback}  ` +
    `seller=${sellerShort}  mint=${mintShort}  sig=${sigShort}  n=${n}`,
  );
}
