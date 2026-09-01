/**
 * OpenSea (OS2) raw ingestion helper.
 *
 * Fetch a raw Solana tx, run it through the OS2 parser, insert the sale.
 * Mirrors the Orbis/Tensor raw slow-path (fetch → parse → insertSaleEvent).
 * No Helius fast-path — OS2 isn't covered by the Helius enhanced webhook, so
 * there's no enriched event to build a preliminary card from. Reuses
 * me-raw/ingest's fetchRawTx so the versioned-tx loadedAddresses expansion
 * and the shared rpcLimiter/dedup are identical to ME/Tensor/Orbis.
 *
 * Dedup: insertSaleEvent uses ON CONFLICT (signature) DO NOTHING, so a sig
 * dispatched by both the WS listener and the amm-poller is written once.
 */
import { parseRawOpenseaTransaction } from './parser';
import { fetchRawTx, markSigFetched } from '../me-raw/ingest';
import { extractNftMintsInvolved } from '../me-raw/price';
import { Priority } from '../concurrency';
import { insertSaleEvent } from '../../db/insert';
import { HeliusEnhancedTransaction } from '../helius/types';
import { saleEventBus } from '../../events/emitter';
import { recordOutcome as auditRecordOutcome } from '../sales-prefilter-audit';

/**
 * Fetch + parse + insert one OpenSea (OS2) transaction.
 * `heliusTx` is accepted for signature parity with ingestMeRaw/ingestTensorRaw
 * but unused (no OS2 Helius fast-path). Never throws.
 */
export async function ingestOpenseaRaw(
  sig: string,
  _heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
  let tx;
  try {
    tx = await fetchRawTx(sig, false, priority);
  } catch (err) {
    auditRecordOutcome(sig, 'error');
    console.error(`[opensea_raw] fetch error  sig=${sig.slice(0, 12)}...`, err);
    return;
  }
  if (!tx) { auditRecordOutcome(sig, 'null_tx'); return; } // deduped / not found

  const result = parseRawOpenseaTransaction(tx);
  if (!result.ok) {
    // Non-sale OS2 tx (list / delist / edit / bid / cancel / …). Flag touched
    // mints so any cached listing for them is reconciled — same hint the
    // Tensor/Orbis drop paths emit. No row written.
    const touched = extractNftMintsInvolved(tx);
    if (touched.length > 0) saleEventBus.emitTxMintsTouched({ mints: touched });
    auditRecordOutcome(sig, 'parser_drop');
    console.log(`[opensea_raw] DROP  sig=${sig.slice(0, 12)}  reason="${result.reason}"`);
    return;
  }

  const ev = result.event;
  try {
    const id = await insertSaleEvent(ev);
    if (id) {
      auditRecordOutcome(sig, 'accepted_sale');
      // Accurate path inserted — block redundant raw-fetch from the other
      // ingestion path (WS vs poller), same as the Tensor/Orbis accurate path.
      markSigFetched(sig);
      console.log(
        `[opensea_raw] sale  opensea/${ev.nftType}  ${ev.priceSol.toFixed(4)} SOL` +
        `  mint=${ev.mintAddress.slice(0, 8)}...  sig=${sig.slice(0, 12)}`,
      );
    } else {
      console.log(`[opensea_raw] dup   sig=${sig.slice(0, 12)}...`);
    }
  } catch (err) {
    console.error(`[opensea_raw] insert error  sig=${sig.slice(0, 12)}...`, err);
  }
}
