/**
 * Raw Magic Eden transaction parser.
 *
 * Converts a raw Solana `getTransaction` response into a `SaleEvent`
 * using instruction discriminator matching and balance delta analysis —
 * no dependency on Helius enhanced parsing.
 *
 * Plugs into the same pipeline as the Helius parser:
 *   parseRawMeTransaction(tx) → ParseResult → insertSaleEvent()
 *
 * Coverage (ME family only):
 *   ME AMM: legacy (solFulfillBuy ✅), pNFT (solMip1FulfillSell ✅),
 *           Core (coreFulfillBuy ✅, coreFulfillSell ✅)
 *   ME v2:  pNFT/mip1 (mip1ExecuteSaleV2 ✅)
 *           legacy direct sale — executeSale / executeSaleV2 discriminators UNVERIFIED;
 *           parser attempts extraction via token-flow but events are marked for review.
 *
 * Verification date: 2026-04-14
 * DO NOT wire into live ingestion until replay-tested (see replay-test.ts).
 */

import { RawSolanaTx } from './types';
import { SaleEvent, NftType } from '../../models/sale-event';
import { computeSellerNetLamports } from '../seller-net';
import {
  isMeTransaction,
  findMeV2SaleIx,
  findMmmSaleIx,
  extractCoreAssetFromInnerIx,
} from './decoder';
import {
  extractPaymentInfo,
  extractNftMint,
  extractPartiesFromTokenFlow,
  balanceDeltas,
} from './price';
import { LUCKY_BUY_PROGRAM } from './programs';

/** Deterministic Lucky Buy detector. Scans the tx's account-keys list
 *  (static + loaded-address tables) for the dedicated lucky-buy raffle
 *  program. Combined with a matched ME v2 sale instruction at the call
 *  site, the signal is unambiguous: the lucky-buy program is single-
 *  purpose and only ever appears in raffle-fulfilment transactions. */
/** Extract the `lp_fee` integer from MMM's post-fulfill program log
 *  line, e.g. `Program log: {"lp_fee":0,"royalty_paid":0,"total_price":5500000}`.
 *  Returns the parsed lamport amount, or null if the log line isn't
 *  present (different ix family, log shape change, or wrapper hiding
 *  it). Tolerates whitespace + optional quoting around the field. */
function readLpFeeFromLogs(logs: unknown): number | null {
  if (!Array.isArray(logs)) return null;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    const m = line.match(/["']?lp_fee["']?\s*:\s*(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function isLuckyBuyTx(tx: RawSolanaTx): boolean {
  const msg = tx.transaction?.message;
  if (!msg) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (msg as any).accountKeys as Array<string | { pubkey: string }> | undefined;
  if (Array.isArray(rawKeys)) {
    for (const k of rawKeys) {
      const pk = typeof k === 'string' ? k : k?.pubkey;
      if (pk === LUCKY_BUY_PROGRAM) return true;
    }
  }
  // loadedAddresses (v0 tx address-lookup-table expansions) — also checked
  // because the lucky-buy program could in principle appear via ALT,
  // although in practice it lands in the static keys.
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    for (const list of [loaded.writable, loaded.readonly]) {
      if (!Array.isArray(list)) continue;
      for (const k of list) if (k === LUCKY_BUY_PROGRAM) return true;
    }
  }
  return false;
}

/** Derive NFT type from the matched instruction name — more precise than program-presence heuristic. */
function nftTypeFromInstruction(name: string): NftType {
  if (name === 'coreFulfillBuy' || name === 'coreFulfillSell' ||
      name === 'coreFulfillBuyV2' ||
      name === 'coreExecuteSaleV2') return 'core';
  if (name === 'solMip1FulfillBuy' || name === 'solMip1FulfillSell' || name === 'mip1ExecuteSaleV2') return 'pnft';
  return 'legacy';
}

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseRawMeTransaction(tx: RawSolanaTx): ParseResult {
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }
  if (!tx.blockTime) {
    return { ok: false, reason: 'missing blockTime' };
  }
  if (!isMeTransaction(tx)) {
    return { ok: false, reason: 'no ME program involved' };
  }

  // Try ME AMM first — instruction names unambiguous from open-source program.
  const mmmMatch = findMmmSaleIx(tx);
  if (mmmMatch) return parseMmmSale(tx, mmmMatch);

  // Try ME v2 fixed-price.
  const meV2Match = findMeV2SaleIx(tx);
  if (meV2Match) return parseMeV2Sale(tx, meV2Match);

  return { ok: false, reason: 'no recognised ME sale instruction' };
}

// ─── ME v2 fixed-price ────────────────────────────────────────────────────────

function parseMeV2Sale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findMeV2SaleIx>>
): ParseResult {
  // Unverified discriminators (executeSale / executeSaleV2) are kept in the
  // instruction list as candidates, but we still attempt parsing — token-flow
  // extraction is reliable regardless of which discriminator matched.
  // The `verified` flag is surfaced in rawData so callers can filter if needed.

  const nftType = nftTypeFromInstruction(match.instructionName);

  // Mint extraction — three paths depending on instruction type:
  //   1. coreAssetIdx set   → fixed accounts index (buyV2, confirmed layout)
  //   2. Core + null idx    → MPL Core inner CPI accounts[0] (coreExecuteSaleV2,
  //                           coreFulfillSell where outer position varies)
  //   3. Legacy / pNFT      → SPL token-balance delta (no Core accounts involved)
  let mint: string | null;
  if (match.coreAssetIdx !== null) {
    mint = match.accounts[match.coreAssetIdx] ?? null;
  } else if (nftType === 'core') {
    mint = extractCoreAssetFromInnerIx(tx);
  } else {
    mint = extractNftMint(tx);
  }
  if (!mint) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine NFT mint` };
  }

  // Parties for ME v2:
  //   SOL-flow (payment.seller) is the primary seller source — the real seller wallet always
  //   receives the largest net SOL increase in the transaction (buyer pays minus ME fee/royalties).
  //   Token-flow (tkSeller = preTokenBalance.owner) is unreliable here: for pNFT/mip1 listings
  //   ME V2 holds the NFT in a program-controlled escrow whose token-account owner is a fixed
  //   program address (not the seller's wallet), causing consistent misattribution.
  //   Token-flow is kept only as a fallback for Core instructions (no SPL balances → tkSeller=null).
  //
  //   For buyer: token-flow (postHolder.owner = buyer's ATA owner) is reliable and preferred.
  const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
  const payment = extractPaymentInfo(tx);
  if (!payment) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine price` };
  }

  const seller = payment.seller ?? tkSeller;
  const buyer  = tkBuyer  ?? payment.buyer;

  if (!seller || !buyer || seller === buyer) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine seller/buyer` };
  }
  if (payment.priceLamports <= 0n) {
    return { ok: false, reason: `me_v2(${match.instructionName}): zero price` };
  }

  const sellerNet = computeSellerNetLamports(tx, seller);

  // Lucky Buy override. The default price extraction picks the largest
  // SOL decrease as the buyer's spend, but on a lucky-buy raffle the
  // largest decrease is the raffle escrow (~entry-fee + reshuffles),
  // not the listing settlement. The seller's positive delta — the same
  // signal computeSellerNetLamports already returns — captures the
  // actual NFT purchase value (listing price + small rent reclaim from
  // the closed NFT-token account). When available we use it as both
  // gross and net for lucky-buy rows. Falls back to the original
  // payment.priceLamports when sellerNet is null (defensive — would
  // require seller absent from accountKeys, which doesn't happen for
  // the SPL paths Lucky Buy operates on).
  const luckyBuy = isLuckyBuyTx(tx);
  const priceLamports = luckyBuy && sellerNet != null
    ? sellerNet
    : payment.priceLamports;

  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'magic_eden',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData:           {
      _parser:     'me_v2_raw',
      _instruction: match.instructionName,
      _verified:   match.verified,
      ...(luckyBuy ? { _subtype: 'lucky_buy' as const } : {}),
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}

// ─── ME AMM (mmm) ─────────────────────────────────────────────────────────────

function parseMmmSale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findMmmSaleIx>>
): ParseResult {
  const nftType = nftTypeFromInstruction(match.instructionName);
  const accs    = match.accounts;

  // ── Mint / Core asset ID ──────────────────────────────────────────────────

  let mint: string | null;

  if (match.coreAssetIdx !== null) {
    // Core NFT: asset ID at the verified instruction account index.
    mint = accs[match.coreAssetIdx] ?? null;
  } else if (nftType === 'core') {
    // Core NFT with variable account layout (e.g. coreFulfillSell) — read from
    // MPL Core inner CPI accounts[0], which is the canonical stable position.
    mint = extractCoreAssetFromInnerIx(tx);
  } else {
    // Legacy / pNFT: derive mint from SPL token balance changes (confirmed to work).
    mint = extractNftMint(tx);
  }

  if (!mint) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine NFT mint` };
  }

  // ── Seller ────────────────────────────────────────────────────────────────

  let seller: string | null;

  if (match.sellerAcctIdx !== null) {
    seller = accs[match.sellerAcctIdx] ?? null;
  } else if (match.coreAssetIdx === null) {
    // Unverified SOL/pNFT instruction — fall back to token-flow ownership.
    seller = extractPartiesFromTokenFlow(tx, mint).seller;
  } else {
    seller = null; // Core, no verified position — use SOL-flow below
  }

  // ── Buyer ─────────────────────────────────────────────────────────────────

  let buyer: string | null;

  if (match.buyerAcctIdx !== null) {
    buyer = accs[match.buyerAcctIdx] ?? null;
  } else if (match.coreAssetIdx === null) {
    // Unverified SOL/pNFT instruction — fall back to token-flow ownership.
    buyer = extractPartiesFromTokenFlow(tx, mint).buyer;
  } else {
    buyer = null; // Core, no verified position — use SOL-flow below
  }

  // ── Price + SOL-flow fallback ─────────────────────────────────────────────

  const payment = extractPaymentInfo(tx);
  if (!payment || payment.priceLamports <= 0n) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine price` };
  }

  seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine parties` };
  }

  // ── Individual bid detection (non-Core fulfillBuy only) ───────────────────
  //
  // ME AMM (mmm program) handles two distinct cases under the same fulfillBuy
  // instruction family:
  //   1. True pool sale  — NFT swapped into an AMM pool. The MMM program
  //                        always charges an LP curve fee (`lp_fee > 0`).
  //   2. Individual bid  — NFT delivered directly to the bidder's wallet.
  //                        No LP curve fee (`lp_fee === 0`).
  //
  // MMM emits a JSON line in the program logs at the end of every fulfill
  // call:  `{"lp_fee":N,"royalty_paid":M,"total_price":P}`. Reading
  // `lp_fee` is the most reliable disambiguation — the previous address-
  // comparison heuristic (tokenFlowBuyer vs accs[1]) misclassified
  // trait-bid acceptances because for SolFulfillBuy `accs[1]` IS the
  // bidder wallet (per programs.ts), so `tokenFlowBuyer === accs[1]`
  // for every individual bid → fell through to `pool_sale`.
  //
  // Confirmed against fixture
  //   57uuQJLbQRZfXoSnueSKEQtR4G4nWTHBN3PCtNajm1PdVjzWQCHa8yn33xQD4ieow3AL996tVoigyYokkNx3kB3s
  // (trait-filtered SolFulfillBuy, lp_fee=0, total_price=5_500_000) which
  // previously surfaced as AMM/pool_sale and now correctly classifies
  // as bid_sell. Core NFTs reuse the same log shape via the
  // post_sol_mpl_core_fulfill_buy log, so the signal is portable to
  // them too if needed later — for now the gate stays non-Core to
  // avoid touching the existing Core path's behavior.
  let effectiveDirection: string = match.direction;
  if (match.direction === 'fulfillBuy' && nftType !== 'core') {
    const lpFee = readLpFeeFromLogs(tx.meta?.logMessages);
    let promote: boolean;
    if (lpFee != null) {
      promote = lpFee === 0;
    } else {
      // No log signal — fall back to the legacy address heuristic so
      // pre-launch / pre-log MMM ixs still behave identically. This
      // path is reached only when the MMM program log line is missing
      // or shape-changes; safe to leave the original logic in place.
      const tokenFlowBuyer = extractPartiesFromTokenFlow(tx, mint).buyer;
      const poolPda        = accs[match.buyerAcctIdx ?? 1] ?? null;
      promote = !!tokenFlowBuyer && !!poolPda && tokenFlowBuyer !== poolPda;
    }
    if (promote) {
      const tokenFlowBuyer = extractPartiesFromTokenFlow(tx, mint).buyer;
      if (tokenFlowBuyer) buyer = tokenFlowBuyer;
      effectiveDirection = 'takeBid'; // maps to bid_sell in both sse.ts and queries.ts
    }
  }

  // TEMPORARY hard diagnostic for the trait-bid investigation. Logged
  // unsampled for the specific fixture so the operator can verify the
  // parser output without enabling the noisier general parse logs.
  if (tx.signature === '57uuQJLbQRZfXoSnueSKEQtR4G4nWTHBN3PCtNajm1PdVjzWQCHa8yn33xQD4ieow3AL996tVoigyYokkNx3kB3s') {
    const lpFee = readLpFeeFromLogs(tx.meta?.logMessages);
    console.log(
      `[debug-sale-fixture] sig=${tx.signature} ` +
      `priceLamports=${payment.priceLamports.toString()} ` +
      `direction=${match.direction} effectiveDirection=${effectiveDirection} ` +
      `rawKind=${match.instructionName} lpFee=${lpFee ?? 'unknown'} ` +
      `buyer=${buyer} seller=${seller}`,
    );
  }

  // ── Price selection ───────────────────────────────────────────────────────
  //
  // For MMM AMM buys (`fulfillSell`: user pulls NFT from a sell-side pool)
  // the buyer's gross SOL outflow ≠ the listing price. Outflow includes
  // LP fee (~1%) + a fresh ATA's rent (~0.002 SOL) + tx fee, so naively
  // using `abs(buyer.delta)` overstates the displayed price by ~2.4
  // milli-SOL on a small purchase, which is visible to the user and
  // doesn't match the on-chain `total_price` shown on ME's listing page.
  //
  // The MMM `post_sol_fulfill_sell` event log emits the canonical
  //   `total_price` (= curve price the buyer agreed to). Empirically this
  // equals the largest positive SOL delta in the tx — the pool wallet
  // / pool state PDA receiving the curve proceeds. Royalty + LP fee
  // are always smaller fractions of the price, so the largest gainer
  // is the correct disambiguation without parsing the program log.
  //
  // Scope: ONLY `fulfillSell` (= pool_buy). All other MMM directions
  // (`fulfillBuy` = pool_sale, `takeBid` = bid_sell) keep the existing
  // buyer-outflow path — for those the buyer is the pool and the
  // distinction doesn't apply the same way.
  let priceLamports = payment.priceLamports;
  if (effectiveDirection === 'fulfillSell') {
    const deltas = balanceDeltas(tx);
    if (deltas.length > 0) {
      const topGain = deltas.reduce((a, b) => (a.delta > b.delta ? a : b));
      if (topGain.delta > 0) priceLamports = BigInt(topGain.delta);
    }
  }

  // ── Build event ───────────────────────────────────────────────────────────

  const sellerNet = computeSellerNetLamports(tx, seller);
  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'magic_eden_amm',
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports:     priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency:          'SOL',
    rawData:           {
      _parser:      'mmm_raw',
      _instruction: match.instructionName,
      _direction:   effectiveDirection,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
