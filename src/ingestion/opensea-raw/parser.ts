/**
 * OpenSea (OS2) raw parser.
 *
 * No published IDL exists for OS2 yet — buyer/seller/price are resolved via
 * the same instruction-layout-agnostic SOL-flow heuristic already used for
 * ME v2/MMM (`extractPaymentInfo`), and the Core asset mint via the same
 * MPL Core inner-CPI scan every other MPL-Core-aware parser in this repo
 * uses (`extractCoreAssetFromInnerIx`) — see programs.ts for how the program
 * ID and sale-instruction set were reverse-engineered and verified.
 *
 * Instruction identification is log-driven, same technique as the Tensor/
 * Orbis prefilters: OS2's own Anchor dispatch always logs
 * `Program log: Instruction: <name>` as the FIRST such line in the tx
 * (nested CPIs — Metaplex Transfer, TcompNoop, Validate — log their own
 * "Instruction:" lines afterward), so taking the first match reliably
 * identifies the outer OS2 instruction without needing invoke-depth tracking.
 *
 * Only the four confirmed buy/accept paths in OPENSEA_SALE_INSTRUCTIONS are
 * treated as sales. Everything else (list/delist/edit/bid/cancel/…) falls
 * through to `{ ok: false }` and the ingest layer treats it as non-sale.
 */
import { RawSolanaTx } from './types';
import { SaleEvent, NftType } from '../../models/sale-event';
import { OPENSEA_PROGRAM, OPENSEA_SALE_INSTRUCTIONS } from './programs';
import { extractPaymentInfo, extractNftMint, balanceDeltas } from '../me-raw/price';
import { extractCoreAssetFromInnerIx } from '../me-raw/decoder';

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

function accountPubkeys(tx: RawSolanaTx): string[] {
  return tx.transaction.message.accountKeys.map((k) => k.pubkey);
}

function isOpenseaTransaction(tx: RawSolanaTx): boolean {
  return accountPubkeys(tx).includes(OPENSEA_PROGRAM);
}

const LOG_IX_PREFIX = 'program log: instruction: ';

function firstInstructionName(tx: RawSolanaTx): string | null {
  for (const line of tx.meta?.logMessages ?? []) {
    const lower = (line ?? '').toLowerCase();
    if (!lower.startsWith(LOG_IX_PREFIX)) continue;
    return lower.slice(LOG_IX_PREFIX.length);
  }
  return null;
}

/** Best-effort net proceeds: the seller wallet's positive SOL delta. Null
 *  when the seller isn't in the tx's accounts or the delta is non-positive. */
function computeSellerNet(tx: RawSolanaTx, seller: string): bigint | null {
  const d = balanceDeltas(tx).find((x) => x.pubkey === seller);
  if (!d || d.delta <= 0) return null;
  return BigInt(d.delta);
}

export function parseRawOpenseaTransaction(tx: RawSolanaTx): ParseResult {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }
  if (!tx.blockTime) {
    return { ok: false, reason: 'missing blockTime' };
  }
  if (!isOpenseaTransaction(tx)) {
    return { ok: false, reason: 'no OpenSea (OS2) program involved' };
  }

  const ix = firstInstructionName(tx);
  if (!ix || !OPENSEA_SALE_INSTRUCTIONS.has(ix)) {
    return { ok: false, reason: `opensea: non-sale instruction (${ix ?? 'none'})` };
  }

  // buyCore / buyCoreSpl → MPL Core asset (no SPL token account exists).
  // buyLegacy / takeBidLegacy → legacy/pNFT SPL token, mint via balance diff.
  const isCore = ix === 'buycore' || ix === 'buycorespl';
  const direction = ix === 'takebidlegacy' ? 'takeBid' : 'buy';

  const mint = isCore ? extractCoreAssetFromInnerIx(tx) : extractNftMint(tx);
  if (!mint) {
    return { ok: false, reason: 'opensea: could not resolve NFT mint' };
  }

  // NOTE: priced off the SOL balance delta for every instruction, including
  // buyCoreSpl. That's wrong for a real SPL/USDC-denominated buyCoreSpl sale
  // (the price would live in a token-balance delta instead) — acceptable for
  // now since only near-zero/test examples of that path have been observed;
  // revisit once a real-value example appears (see programs.ts).
  const payment = extractPaymentInfo(tx);
  if (!payment) {
    return { ok: false, reason: 'opensea: could not resolve SOL payment flow' };
  }
  if (payment.buyer === payment.seller) {
    return { ok: false, reason: 'opensea: buyer === seller' };
  }

  const nftType: NftType = isCore ? 'core' : 'legacy';
  const sellerNet = computeSellerNet(tx, payment.seller);

  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime * 1000),
    marketplace:       'opensea',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,    // resolved later by background enrichment
    seller:            payment.seller,
    buyer:             payment.buyer,
    priceLamports:     payment.priceLamports,
    priceSol:          Number(payment.priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData: {
      _parser:      'opensea_raw',
      _instruction: ix,
      _direction:   direction,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
