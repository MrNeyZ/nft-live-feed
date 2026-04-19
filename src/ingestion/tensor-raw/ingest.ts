/**
 * Tensor raw ingestion helper.
 *
 * Fetches a raw Solana transaction from the RPC, runs it through the Tensor
 * raw parser, and inserts the result. Runs alongside (not replacing) the
 * Helius enhanced parser — ON CONFLICT (signature) DO NOTHING handles dedup.
 *
 * Uses fetchRawTx from me-raw/ingest to avoid duplicating the versioned-tx
 * loadedAddresses expansion logic (same RawSolanaTx type, same RPC encoding).
 *
 * Fast path: see me-raw/ingest.ts for the general pattern. Same behaviour —
 * an SSE card is emitted immediately from Helius webhook data, then patched
 * once the raw parse completes.
 */
import { parseRawTensorTransaction } from './parser';
import { fetchRawTx, markSigFetched } from '../me-raw/ingest';
import { insertSaleEvent, patchSaleEventRaw } from '../../db/insert';
import { HeliusEnhancedTransaction } from '../helius/types';
import { SaleEvent, Marketplace, NftType } from '../../models/sale-event';

// ─── Fast-path event builder ──────────────────────────────────────────────────

interface HTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
  tokenStandard?: string;
}
interface HNativeTransfer { amount?: number; }

function tryBuildFastFromTransfers(
  tx: HeliusEnhancedTransaction,
  parser: string,
  defaultMarketplace: Marketplace,
): SaleEvent | null {
  if (!tx.timestamp) return null;
  const tokenTransfers = tx.tokenTransfers as HTokenTransfer[] | undefined;
  const nativeTransfers = tx.nativeTransfers as HNativeTransfer[] | undefined;
  if (!tokenTransfers?.length || !nativeTransfers?.length) return null;

  const nftTxs = tokenTransfers.filter((t) => t.tokenAmount === 1 && t.mint);
  if (!nftTxs.length) return null;
  const mint = nftTxs[0].mint!;
  const sameMint = nftTxs.filter((t) => t.mint === mint);

  const buyer  = sameMint[sameMint.length - 1].toUserAccount;
  const seller = sameMint[0].fromUserAccount;
  if (!buyer || !seller || buyer === seller) return null;

  const priceLamports = BigInt(Math.max(...nativeTransfers.map((t) => t.amount ?? 0)));
  if (priceLamports <= 0n) return null;

  const std = (nftTxs[0].tokenStandard ?? '').toLowerCase();
  const nftType: NftType =
    std.includes('programmable') ? 'pnft' :
    std === 'compressed'         ? 'cnft' :
    'legacy';

  return {
    signature:         tx.signature,
    blockTime:         new Date(tx.timestamp * 1000),
    marketplace:       defaultMarketplace,
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    currency:          'SOL',
    rawData: { _parser: parser, events: { nft: { saleType: '' } } },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };
}

function tryBuildFastTensorEvent(tx: HeliusEnhancedTransaction): SaleEvent | null {
  const nft = tx.events?.nft;
  if (nft?.buyer && nft?.seller && nft?.amount && nft?.nfts?.[0]?.mint && nft?.timestamp) {
    const priceLamports = BigInt(nft.amount);
    if (priceLamports > 0n) {
      const st = (nft.saleType ?? '').toUpperCase();
      return {
        signature:         tx.signature,
        blockTime:         new Date(nft.timestamp * 1000),
        marketplace:       st.includes('AMM') ? 'tensor_amm' : 'tensor',
        nftType:           'legacy',
        mintAddress:       nft.nfts[0].mint,
        collectionAddress: null,
        seller:            nft.seller,
        buyer:             nft.buyer,
        priceLamports,
        priceSol:          Number(priceLamports) / 1e9,
        currency:          'SOL',
        rawData: { _parser: 'tensor_helius_fast', events: { nft: { saleType: nft.saleType ?? '' } } },
        nftName:           null,
        imageUrl:          null,
        collectionName:    null,
        magicEdenUrl:      null,
      };
    }
  }
  return tryBuildFastFromTransfers(tx, 'tensor_xfer_fast', 'tensor');
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

/**
 * Fetch + parse + insert one Tensor transaction via the raw parser.
 * When heliusTx is supplied the fast path fires immediately.
 * Raw RPC fetch is skipped for events.nft-based fast paths — same rationale
 * as ingestMeRaw; only tensor_xfer_fast (transfer-based approximation) needs
 * raw correction. Never throws.
 */
export async function ingestTensorRaw(sig: string, heliusTx?: HeliusEnhancedTransaction): Promise<void> {
  // ── Fast path ───────────────────────────────────────────────────────────────
  let fastPathInserted = false;
  let fastParser: string | undefined;

  if (heliusTx) {
    const fast = tryBuildFastTensorEvent(heliusTx);
    if (fast) {
      fastParser = fast.rawData._parser as string;
      try {
        const id = await insertSaleEvent(fast);
        fastPathInserted = id !== null;
      } catch {
        // Non-fatal — raw path will insert normally.
      }
    }
  }

  // ── Skip raw fetch when not needed (same logic as ingestMeRaw) ─────────────
  const needsRawFetch = fastParser === 'tensor_xfer_fast' || (!fastParser && !fastPathInserted);
  if (!needsRawFetch) {
    if (fastPathInserted) {
      // Accurate fast path inserted the event — mark so listener/poller won't
      // redundantly raw-fetch this sig from a different ingestion path.
      markSigFetched(sig);
    } else if (fastParser) {
      console.log(`[tensor_raw] dup   sig=${sig.slice(0, 12)}...`);
    }
    return;
  }

  // ── Slow path: RPC fetch + raw parse ───────────────────────────────────────
  let tx;
  try {
    // bestEffort=true only when fast-path already emitted a sale card.
    tx = await fetchRawTx(sig, fastPathInserted);
  } catch (err) {
    console.error(`[tensor_raw] fetch error  sig=${sig.slice(0, 12)}...`, err);
    return;
  }

  if (!tx) return;  // deduped or not found — already processed elsewhere

  const result = parseRawTensorTransaction(tx);
  if (!result.ok) return;  // not a Tensor sale instruction we recognise

  const tag = (result.event.rawData as Record<string, unknown>)._parser ?? 'tensor_raw';

  try {
    const id = await insertSaleEvent(result.event);
    if (id) {
      console.log(
        `[${tag}] sale  ${result.event.marketplace}/${result.event.nftType}` +
        `  ${result.event.priceSol.toFixed(4)} SOL` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else if (fastPathInserted) {
      await patchSaleEventRaw(result.event);
      console.log(
        `[${tag}] patch ${result.event.marketplace}/${result.event.nftType}` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else {
      console.log(`[${tag}] dup   sig=${sig.slice(0, 12)}...`);
    }
  } catch (err) {
    console.error(`[${tag}] insert error  sig=${sig.slice(0, 12)}...`, err);
  }
}
