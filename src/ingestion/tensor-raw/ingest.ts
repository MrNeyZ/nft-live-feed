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
import { parseRawMeTransaction } from '../me-raw/parser';
import { fetchRawTx, markSigFetched } from '../me-raw/ingest';
import { Priority } from '../concurrency';
import { extractNftMintsInvolved } from '../me-raw/price';
import { saleEventBus } from '../../events/emitter';
import { insertSaleEvent, patchSaleEventRaw } from '../../db/insert';
import { HeliusEnhancedTransaction } from '../helius/types';
import { SaleEvent, Marketplace, NftType } from '../../models/sale-event';
import { trace } from '../../trace';
import { extractPaymentInfo, extractNftMint, extractPartiesFromTokenFlow } from './price';
import { extractCoreAssetFromInnerIx } from './decoder';
import { TCOMP_PROGRAM, TAMM_PROGRAM } from './programs';
import bs58 from 'bs58';

// ─── Instruction scanner (debug) ─────────────────────────────────────────────

const TENSOR_PROGRAM_LABELS: Record<string, string> = {
  [TCOMP_PROGRAM]: 'tcomp',
  [TAMM_PROGRAM]:  'tamm',
};

interface IxScan { program: string; disc: string; }

function scanTensorInstructions(tx: import('./types').RawSolanaTx): IxScan[] {
  const keys = tx.transaction.message.accountKeys;
  const allIxs = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const out: IxScan[] = [];
  for (const ix of allIxs) {
    const prog = keys[ix.programIdIndex]?.pubkey ?? '';
    const label = TENSOR_PROGRAM_LABELS[prog];
    if (!label) continue;
    let disc = 'short';
    try {
      const buf = Buffer.from(bs58.decode(ix.data));
      if (buf.length >= 8) disc = buf.subarray(0, 8).toString('hex');
    } catch { /* skip */ }
    out.push({ program: label, disc });
  }
  return out;
}

const CANDIDATE_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL floor for unknown candidates

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
export async function ingestTensorRaw(
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
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
      } catch (err) {
        console.log(`DEDUPE_DEBUG_SKIP ${fast.signature} insert_condition_failed(fast_path): ${(err as Error)?.message ?? 'unknown'}`);
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
    tx = await fetchRawTx(sig, fastPathInserted, priority);
  } catch (err) {
    console.error(`[tensor_raw] fetch error  sig=${sig.slice(0, 12)}...`, err);
    return;
  }

  if (!tx) return;  // deduped or not found — already processed elsewhere

  // ── Per-tx debug: log every Tensor instruction discriminator seen ────────────
  const ixScan = scanTensorInstructions(tx);
  const discStr = ixScan.map((s) => `${s.program}:${s.disc}`).join(' ');
  const programsStr = [...new Set(ixScan.map((s) => s.program))].join(',') || 'none';

  const result = parseRawTensorTransaction(tx);

  if (!result.ok) {
    // Log EVERY failed parse — primary signal for diagnosing missing sales.
    console.log(
      `[tensor_raw] DROP  sig=${sig.slice(0, 12)}` +
      `  programs=${programsStr}` +
      `  reason="${result.reason}"` +
      (ixScan.length ? `  discs=[${discStr}]` : ''),
    );

    // Non-sale Tensor tx: list / delist / pool deposit / pool withdraw / etc.
    // Flag the listings store so any cached slug touching one of these mints
    // is scheduled for reconciliation. Emitted before the TAMM→ME fallback
    // so even the fallback-success case reconciles (precise remove via the
    // sale hook runs first; debounced refresh 10s later is a cheap recheck).
    const touchedMints = extractNftMintsInvolved(tx);
    if (touchedMints.length > 0) saleEventBus.emitTxMintsTouched({ mints: touchedMints });

    // ── Precise live deltas: classify the TCOMP outer ix ──────────────────────
    // Verified anchor discriminators — semantics proven either via live log
    // observation or by matching anchorDisc(name) against the non-sale set we
    // already guard in TCOMP_NON_SALE_DISCS.
    //   delist_core / delist_compressed / delist_legacy / delist  → precise remove
    //   list_core / list_compressed / list_spl / list_legacy / edit → immediate refresh
    // For any OTHER non-sale disc the existing tx_mints_touched path (dirty +
    // 10 s debounce) handles reconciliation — unchanged.
    const TCOMP_DELIST_DISCS = new Set<string>([
      '3818e702e3130e44', // delist_core
      '6d6997016aa5d0ce', // delist_compressed
      '5823e7b86eda9517', // delist_legacy
      '3788cd6b6bad041f', // delist (generic)
    ]);
    const TCOMP_LIST_OR_EDIT_DISCS = new Set<string>([
      'ad4ca77d76470199', // list_core
      '41b3da1996736fab', // list_compressed
      '37f7740f60908842', // list_spl
      '066eff121024081e', // list_legacy
      '0fb72156571c9791', // edit  (reprice of existing listing)
      '36aec14311298426', // list  (generic — observed live, 20 occurrences/3 min)
    ]);
    const hasTcompDelist = ixScan.some(s => s.program === 'tcomp' && TCOMP_DELIST_DISCS.has(s.disc));
    const hasTcompListOrEdit = ixScan.some(s => s.program === 'tcomp' && TCOMP_LIST_OR_EDIT_DISCS.has(s.disc));
    if (hasTcompDelist) {
      for (const m of touchedMints) saleEventBus.emitListingConfirmedDelist({ mint: m });
      console.log(`[tensor_raw] DELIST  sig=${sig.slice(0, 12)}  mints=${touchedMints.length}`);
    } else if (hasTcompListOrEdit) {
      for (const m of touchedMints) saleEventBus.emitListingRefreshHint({ mint: m });
      console.log(`[tensor_raw] LIST/EDIT  sig=${sig.slice(0, 12)}  mints=${touchedMints.length}`);
    }

    // ── TAMM → ME fallback ───────────────────────────────────────────────────
    // Some TAMM (V2) transactions CPI into ME V2, so when the Tensor parser
    // doesn't recognise the outer ix, parseRawMeTransaction may still extract
    // a valid SaleEvent from the inner ME V2 instruction. Gated on TAMM only
    // so tcomp txs (tcomp+mmm composite flows) aren't re-routed.
    if (programsStr.includes('tamm')) {
      const meResult = parseRawMeTransaction(tx);
      if (meResult.ok) {
        const meIx = (meResult.event.rawData as Record<string, unknown>)._instruction;
        trace(sig, 'parse:ok', `parser=tamm→me_raw  ix=${meIx}`);
        console.log(
          `[tensor_raw→me_raw] OK    sig=${sig.slice(0, 12)}` +
          `  ix=${meIx}` +
          `  ${meResult.event.marketplace}/${meResult.event.nftType}` +
          `  ${meResult.event.priceSol.toFixed(4)} SOL` +
          `  mint=${meResult.event.mintAddress.slice(0, 8)}...`,
        );
        console.log(`INSERT_DEBUG_PARSED ${meResult.event.signature} tamm_to_me_raw ${meResult.event.marketplace} ${meResult.event.mintAddress}`);
        try {
          const id = await insertSaleEvent(meResult.event);
          if (id) {
            console.log(
              `[tensor_raw→me_raw] sale  ${meResult.event.marketplace}/${meResult.event.nftType}` +
              `  ${meResult.event.priceSol.toFixed(4)} SOL  sig=${sig.slice(0, 12)}`
            );
          } else if (fastPathInserted) {
            await patchSaleEventRaw(meResult.event);
          } else {
            console.log(`[tensor_raw→me_raw] dup   sig=${sig.slice(0, 12)}...`);
          }
        } catch (err) {
          console.log(`DEDUPE_DEBUG_SKIP ${meResult.event.signature} insert_condition_failed(tamm→me): ${(err as Error)?.message ?? 'unknown'}`);
          console.error(`[tensor_raw→me_raw] insert error  sig=${sig.slice(0, 12)}...`, err);
        }
        return;
      }
    }

    // ── Unknown-candidate path ────────────────────────────────────────────────
    //
    // Guard: skip the candidate path when the outer TCOMP instruction is a
    // KNOWN non-sale op. Delists (and some list flows) include rent-refund
    // SOL transfers that exceed CANDIDATE_MIN_LAMPORTS, plus an escrow→owner
    // NFT move that looks like a seller→buyer pair to the generic extractor —
    // i.e. they pass every candidate check, producing ghost-sale rows that
    // render with the wrong side in the feed. Confirmed live on gorbagio:
    // disc 3818e702e3130e44 (delist_core) was producing bogus "buy" rows.
    //
    // These 8 discriminators are known non-sale TCOMP instructions. Any tx
    // whose TCOMP outer or inner ix matches one of them is skipped for
    // candidate extraction. Real sale instructions (take_bid_*, buy_*, etc.)
    // are unaffected — those already match TCOMP_SALE_INSTRUCTIONS or fall
    // through to the next heuristic as before.
    const TCOMP_NON_SALE_DISCS = new Set<string>([
      '3818e702e3130e44', // delist_core
      'ad4ca77d76470199', // list_core
      '41b3da1996736fab', // list_compressed
      '6d6997016aa5d0ce', // delist_compressed
      '066eff121024081e', // list_legacy
      '5823e7b86eda9517', // delist_legacy
      '37f7740f60908842', // list_spl
      '3788cd6b6bad041f', // delist
    ]);
    const hasNonSaleTcomp = ixScan.some(s => s.program === 'tcomp' && TCOMP_NON_SALE_DISCS.has(s.disc));
    if (hasNonSaleTcomp) {
      console.log(`[tensor_raw] SKIP_CAND sig=${sig.slice(0, 12)} non_sale_ix  discs=[${discStr}]`);
      return;
    }
    if (!fastPathInserted && result.reason.includes('no recognised')) {
      const payment  = extractPaymentInfo(tx);
      // Mint fallback chain: SPL token movement → MPL Core inner CPI.
      const splMint  = extractNftMint(tx);
      const coreMint = splMint ? null : extractCoreAssetFromInnerIx(tx);
      const mint     = splMint ?? coreMint;
      if (!payment || payment.priceLamports < CANDIDATE_MIN_LAMPORTS) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_price(candidate:${payment?.priceLamports ?? 'none'})`);
      } else if (!mint) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} empty_mint(candidate)`);
      }
      if (payment && payment.priceLamports >= CANDIDATE_MIN_LAMPORTS && mint) {
        const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
        const seller = payment.seller ?? tkSeller;
        const buyer  = tkBuyer ?? payment.buyer;
        if (!(seller && buyer && seller !== buyer)) {
          console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_seller(candidate:seller=${seller ?? 'none'} buyer=${buyer ?? 'none'})`);
        }
        if (seller && buyer && seller !== buyer) {
          console.log(
            `[tensor_raw] CAND  sig=${sig.slice(0, 12)}` +
            `  discs=[${discStr}]` +
            `  src=${splMint ? 'spl' : 'core'}` +
            `  price=${(Number(payment.priceLamports) / 1e9).toFixed(4)} SOL` +
            `  mint=${mint.slice(0, 8)}...`,
          );
          const event: SaleEvent = {
            signature:         tx.signature,
            blockTime:         new Date(tx.blockTime! * 1000),
            marketplace:       'tensor',
            nftType:           coreMint ? 'core' : 'legacy',
            mintAddress:       mint,
            collectionAddress: null,
            seller,
            buyer,
            priceLamports:     payment.priceLamports,
            priceSol:          Number(payment.priceLamports) / 1e9,
            currency:          'SOL',
            rawData: {
              _parser:   'unknown_sale_candidate',
              _program:  programsStr,
              _discs:    discStr,
              _mintFrom: splMint ? 'spl_token_balance' : 'mpl_core_inner_cpi',
              saleType:  'unknown',
            },
            nftName:           null,
            imageUrl:          null,
            collectionName:    null,
            magicEdenUrl:      null,
          };
          try {
            const id = await insertSaleEvent(event);
            if (id) console.log(`[tensor_raw] CAND_INSERTED  sig=${sig.slice(0, 12)}`);
          } catch (err) {
            console.log(`DEDUPE_DEBUG_SKIP ${event.signature} insert_condition_failed(candidate): ${(err as Error)?.message ?? 'unknown'}`);
            console.error(`[tensor_raw] CAND insert error  sig=${sig.slice(0, 12)}`, err);
          }
        }
      }
    }
    return;
  }

  const tag = (result.event.rawData as Record<string, unknown>)._parser ?? 'tensor_raw';

  // Step 4 — raw parser recognised this as a sale.
  trace(sig, 'parse:ok', `parser=${tag}  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`);

  console.log(
    `[${tag}] OK    sig=${sig.slice(0, 12)}` +
    `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}` +
    `  ${result.event.marketplace}/${result.event.nftType}` +
    `  ${result.event.priceSol.toFixed(4)} SOL` +
    `  mint=${result.event.mintAddress.slice(0, 8)}...`,
  );

  console.log(`INSERT_DEBUG_PARSED ${result.event.signature} ${tag} ${result.event.marketplace} ${result.event.mintAddress}`);

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
    console.log(`DEDUPE_DEBUG_SKIP ${result.event.signature} insert_condition_failed: ${(err as Error)?.message ?? 'unknown'}`);
    console.error(`[${tag}] insert error  sig=${sig.slice(0, 12)}...`, err);
  }
}
