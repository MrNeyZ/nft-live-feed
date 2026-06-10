/**
 * Orbis raw parser.
 *
 *   parseRawOrbisTransaction(tx) → ParseResult → insertSaleEvent()
 *
 * Log-driven by design: Orbis's `BuyCoreV2` / `BuyNft` instructions emit a
 * single deterministic settlement log line that carries mint, gross price,
 * seller and buyer inline — a far more robust signal than account-index
 * extraction (the buy account layout differs between the Core and legacy
 * paths). We require the Orbis program to be present, match the "sold for"
 * line, and read the four fields straight out of it. SOL-flow is used only
 * for the best-effort `sellerNetLamports` display value.
 *
 * Only completed sales are returned `ok`. List / delist / offer / update txs
 * never emit "sold for", so they fall through to `{ ok: false }` and the
 * ingest layer treats them as non-sale (no row written).
 */
import { RawSolanaTx } from './types';
import { SaleEvent, NftType } from '../../models/sale-event';
import { ORBIS_PROGRAM } from './programs';

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

/** Full account-key list in balance-index order. `fetchRawTx` already merges
 *  ALT-loaded (writable then readonly) keys into `accountKeys` in
 *  balance-index order, so this is the complete, correctly-ordered list —
 *  same as every ME/Tensor parser reads. */
function accountPubkeys(tx: RawSolanaTx): string[] {
  return tx.transaction.message.accountKeys.map((k) => k.pubkey);
}

function isOrbisTransaction(tx: RawSolanaTx): boolean {
  return accountPubkeys(tx).includes(ORBIS_PROGRAM);
}

// Base58 pubkey (32–44 chars, no 0 O I l). Two log shapes, one regex:
//   Core:   "Core NFT <mint> sold for <n> lamports (delegate mode). Seller: <s>, Buyer: <b>"
//   Legacy: "NFT <mint> sold for <n> lamports. Seller: <s>, Buyer: <b>"
const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const SOLD_RE = new RegExp(
  `(Core )?NFT (${B58}) sold for (\\d+) lamports` +
  `[^]*?Seller: (${B58}), Buyer: (${B58})`,
);

/** Best-effort net proceeds: the seller wallet's positive SOL delta. Null when
 *  the seller isn't in the tx's accounts or the delta is non-positive. */
function computeSellerNet(tx: RawSolanaTx, seller: string): bigint | null {
  const keys = accountPubkeys(tx);
  const pre = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (!pre || !post) return null;
  const i = keys.indexOf(seller);
  if (i < 0 || i >= pre.length || i >= post.length) return null;
  const delta = BigInt(post[i]) - BigInt(pre[i]);
  return delta > 0n ? delta : null;
}

export function parseRawOrbisTransaction(tx: RawSolanaTx): ParseResult {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }
  if (!tx.blockTime) {
    return { ok: false, reason: 'missing blockTime' };
  }
  if (!isOrbisTransaction(tx)) {
    return { ok: false, reason: 'no Orbis program involved' };
  }

  const logs = tx.meta?.logMessages ?? [];
  let match: RegExpMatchArray | null = null;
  for (const line of logs) {
    const m = line.match(SOLD_RE);
    if (m) { match = m; break; }
  }
  if (!match) {
    // List / delist / offer / update / cancel — not a sale.
    return { ok: false, reason: 'no Orbis sold-for settlement log' };
  }

  const isCore = !!match[1];
  const mint = match[2];
  const priceLamports = BigInt(match[3]);
  const seller = match[4];
  const buyer = match[5];

  if (priceLamports <= 0n) {
    return { ok: false, reason: 'orbis: zero price' };
  }
  if (!seller || !buyer || seller === buyer) {
    return { ok: false, reason: 'orbis: could not determine seller/buyer' };
  }

  const nftType: NftType = isCore ? 'core' : 'legacy';
  const sellerNet = computeSellerNet(tx, seller);

  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime * 1000),
    marketplace:       'orbis',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,    // resolved later by background enrichment
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData: {
      _parser:      'orbis_raw',
      _instruction: isCore ? 'BuyCoreV2' : 'BuyNft',
      _direction:   'buy',
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
