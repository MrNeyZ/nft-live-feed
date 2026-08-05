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
import { computeSellerNetLamports, cleanSellerNet } from '../seller-net';
import {
  isMeTransaction,
  findMeV2SaleIx,
  findMmmSaleIx,
  findMeCnftSaleIx,
  extractCoreAssetFromInnerIx,
} from './decoder';
import {
  extractPaymentInfo,
  extractNftMint,
  extractPartiesFromTokenFlow,
  balanceDeltas,
  detectSaleCurrency,
  currencyDecimals,
} from './price';
import { LUCKY_BUY_PROGRAM, ME_PACKS_PROGRAM } from './programs';
import { noteMmmV2Disc } from './v2-disc-watch';

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

/** Extract the explicit settlement price (lamports) from a Magic Eden v2
 *  fixed-price sale's program logs. ME v2 emits a JSON log line carrying the
 *  true list/sale price on both the intermediate `BuyV2`
 *    Program log: {"price":14000000,"buyer_expiry":...}
 *  and the terminal settlement instruction (executeSaleV2 / mip1ExecuteSaleV2 /
 *  coreExecuteSaleV2), which additionally carries the fee/royalty breakdown:
 *    Program log: {"maker_fee":0,"taker_fee":280000,"price":14000000,
 *                  "seller_expiry":-1,"buyer_expiry":...,"royalty":966000}
 *  This `price` is the canonical sale price — it EXCLUDES royalty, marketplace
 *  fee and network fee, unlike the buyer's gross SOL outflow
 *  (extractPaymentInfo) which bundles all three and so overstates the price
 *  (e.g. sig 21V7qF…: log price 14_000_000 vs gross 15_279_685). The
 *  settlement breakdown line (the one carrying fee/royalty fields) is the
 *  authoritative value, so it is preferred; a bare price line is the fallback.
 *  Returns null if no price line is present (wrapper hiding logs / log shape
 *  change). Tolerates whitespace and optional quoting around the field. */
function readMeV2PriceFromLogs(logs: unknown): bigint | null {
  if (!Array.isArray(logs)) return null;
  let bare: bigint | null = null;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    const m = line.match(/["']?price["']?\s*:\s*(\d+)/);
    if (!m) continue;
    let n: bigint;
    try { n = BigInt(m[1]); } catch { continue; }
    if (n <= 0n) continue;
    // Settlement breakdown line — fee/royalty fields present → canonical.
    if (/maker_fee|taker_fee|royalty/.test(line)) return n;
    if (bare === null) bare = n; // bare BuyV2 line → fallback
  }
  return bare;
}

function txHasProgram(tx: RawSolanaTx, programId: string): boolean {
  const msg = tx.transaction?.message;
  if (!msg) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (msg as any).accountKeys as Array<string | { pubkey: string }> | undefined;
  if (Array.isArray(rawKeys)) {
    for (const k of rawKeys) {
      const pk = typeof k === 'string' ? k : k?.pubkey;
      if (pk === programId) return true;
    }
  }
  // loadedAddresses (v0 tx address-lookup-table expansions) — also
  // checked because either program could appear via ALT, although in
  // practice both land in the static keys.
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    for (const list of [loaded.writable, loaded.readonly]) {
      if (!Array.isArray(list)) continue;
      for (const k of list) if (k === programId) return true;
    }
  }
  return false;
}
function isLuckyBuyTx(tx: RawSolanaTx): boolean { return txHasProgram(tx, LUCKY_BUY_PROGRAM); }
function isPackOpenTx(tx: RawSolanaTx): boolean { return txHasProgram(tx, ME_PACKS_PROGRAM); }

/** True iff `pubkey` is a genuine signer of this transaction (per the raw
 *  `getTransaction` response's per-key `signer` flag — present even under
 *  `encoding: 'json'`, see RawAccountKey). The one fact a program-owned
 *  escrow PDA can never have, no matter how large its SOL outflow. */
function isConfirmedSigner(tx: RawSolanaTx, pubkey: string): boolean {
  const keys = tx.transaction.message.accountKeys as unknown as Array<string | { pubkey: string; signer: boolean }>;
  for (const k of keys) {
    if (typeof k === 'string') continue; // un-merged raw response — no signer info available
    if (k.pubkey === pubkey) return k.signer === true;
  }
  return false;
}

/**
 * Instruction-aware buyer resolution for MPL Core ME v2 sales — the
 * fallback path (extractPaymentInfo's SOL-flow "largest decrease")
 * misattributes the buyer to a program-owned escrow PDA whenever that
 * escrow's single-instruction outflow exceeds the real buyer's own fresh
 * top-up in the same transaction (2026-08-05 bug, see MeV2IxDef.buyerAcctIdx
 * doc in programs.ts for the full mechanism + confirmed live examples).
 *
 * Returns null (falls through to the existing tkBuyer / payment.buyer
 * chain — i.e. current behaviour, unchanged) unless ALL of:
 *   1. This exact instruction variant has a verified buyerAcctIdx
 *      (currently: coreExecuteSaleV2 only — every other ME v2 variant
 *      either has reliable token-flow data or hasn't been independently
 *      confirmed, so this deliberately does nothing for them).
 *   2. The candidate account at that index is a REAL signer of the
 *      transaction. A relayed/sponsored wrapper (confirmed live: Lucky
 *      Buy, where accounts[0] is ME's own treasury acting as fee-payer)
 *      would place a non-buyer account there. Lucky Buy is ALSO excluded
 *      by name (`isLuckyBuyTx`) since its relayed accounts[0] genuinely
 *      IS a signer with a genuinely negative delta (network fee) — the
 *      other two checks alone would NOT catch it.
 *   3. The candidate has a net NON-POSITIVE SOL delta in this transaction
 *      — i.e. they actually paid something. `coreExecuteSaleV2` is the
 *      TERMINAL instruction for BOTH the buyer-initiated
 *      `Deposit → BuyV2 → CoreExecuteSaleV2` flow (accounts[0] = buyer,
 *      the case this fix targets) AND a seller-initiated
 *      `CoreSell → CoreExecuteSaleV2` flow that fills an existing bid
 *      (accounts[0] = the LISTING SELLER — confirmed live on sig
 *      t9WL1dm2juFBecShy7ZbeReZYHz7PQRjofq743eUyA43bzHLTUdWvSNA7jpVjovMWy6hAkYhNcCrPVhasY75EbY,
 *      where accounts[0] received +0.1995 SOL). Both produce the same
 *      discriminator match; only the delta sign distinguishes them
 *      without also needing to detect the preceding CoreSell/BuyV2
 *      instruction. A receiving signer fails this check and falls
 *      through — never asserted as the payer.
 */
function resolveCoreBuyer(
  tx: RawSolanaTx,
  match: { buyerAcctIdx: number | null; accounts: string[] },
): string | null {
  if (match.buyerAcctIdx === null) return null;
  if (isLuckyBuyTx(tx)) return null;
  const candidate = match.accounts[match.buyerAcctIdx] ?? null;
  if (!candidate) return null;
  if (!isConfirmedSigner(tx, candidate)) return null;
  const delta = balanceDeltas(tx).find((d) => d.pubkey === candidate)?.delta;
  if (delta === undefined || delta > 0) return null;
  return candidate;
}

/** Derive NFT type from the matched instruction name — more precise than program-presence heuristic. */
function nftTypeFromInstruction(name: string): NftType {
  if (name === 'coreFulfillBuy' || name === 'coreFulfillSell' ||
      name === 'coreFulfillBuyV2' ||
      name === 'coreExecuteSaleV2') return 'core';
  if (name === 'solMip1FulfillBuy' || name === 'solMip1FulfillSell' || name === 'mip1ExecuteSaleV2') return 'pnft';
  if (name === 'cnftFulfillBuy') return 'cnft';
  return 'legacy';
}

export type ParseResult =
  | { ok: true;  event: SaleEvent }
  | { ok: false; reason: string  };

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseRawMeTransaction(tx: RawSolanaTx): ParseResult {
  // Captured once, up front, before any instruction matching/parsing work —
  // this is `SaleEvent.parserReceivedAt`: "when did the parser receive this
  // raw tx." Single `Date.now()` call, no I/O, applies uniformly to every
  // sale family below (ME v2 / MMM / cNFT) via the shared `stamp()` helper.
  const parserReceivedAt = new Date();
  const stamp = (result: ParseResult): ParseResult => {
    if (result.ok) result.event.parserReceivedAt = parserReceivedAt;
    return result;
  };

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
  if (mmmMatch) {
    const mmmResult = parseMmmSale(tx, mmmMatch);
    // Observability-only: capture dormant coreFulfillBuyV2 occurrences. No-op
    // for every other instruction; never alters the returned result.
    noteMmmV2Disc(tx.signature, mmmMatch.instructionName, mmmResult);
    return stamp(mmmResult);
  }

  // Try ME v2 fixed-price.
  const meV2Match = findMeV2SaleIx(tx);
  if (meV2Match) return stamp(parseMeV2Sale(tx, meV2Match));

  // ME cNFT marketplace (`M3mxk5W2…`). Distinct program from ME v2,
  // single confirmed sale instruction (`buy_now`). Closes the coverage
  // gap surfaced by the `wegens` audit (7/8 missing sales).
  const meCnftMatch = findMeCnftSaleIx(tx);
  if (meCnftMatch) return stamp(parseMeCnftSale(tx, meCnftMatch));

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
  //   SOL-flow (payment.seller) is the primary seller source here — the real seller wallet
  //   receives the largest net SOL increase (buyer pays minus ME fee/royalties). This is safe
  //   for ME v2 specifically because every ME v2 sale is a direct single-listing settlement:
  //   there is exactly one seller and the payment always lands directly in their wallet, with
  //   no intermediate pool. Do NOT assume this generalizes to MMM (see parseMmmSale below) —
  //   in a shared AMM pool the largest SOL recipient is the pool's payout wallet, which is a
  //   DIFFERENT account from whoever deposited the specific NFT that sold (confirmed 2026-07-15,
  //   see programs.ts's coreFulfillSell/solFulfillSell/solMip1FulfillSell/solExtFulfillSell docs).
  //   Token-flow (tkSeller = preTokenBalance.owner) is unreliable here: for pNFT/mip1 listings
  //   ME V2 holds the NFT in a program-controlled escrow whose token-account owner is a fixed
  //   program address (not the seller's wallet), causing consistent misattribution.
  //   Token-flow is kept only as a fallback for Core instructions (no SPL balances → tkSeller=null).
  //
  //   For buyer: token-flow (postHolder.owner = buyer's ATA owner) is reliable and preferred.
  //   MPL Core has no SPL token balances at all, so tkBuyer is always null there — the
  //   remaining fallback (payment.buyer, SOL-flow "largest decrease") is where the
  //   2026-08-05 escrow-PDA bug lives; resolveCoreBuyer (instruction-aware, signer-
  //   validated) takes priority over it when available. See its doc for the fix.
  const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
  const payment = extractPaymentInfo(tx);
  if (!payment) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine price` };
  }

  const seller = payment.seller ?? tkSeller;
  const buyer  = resolveCoreBuyer(tx, match) ?? tkBuyer ?? payment.buyer;

  if (!seller || !buyer || seller === buyer) {
    return { ok: false, reason: `me_v2(${match.instructionName}): could not determine seller/buyer` };
  }
  if (payment.priceLamports <= 0n) {
    return { ok: false, reason: `me_v2(${match.instructionName}): zero price` };
  }

  const sellerNet = computeSellerNetLamports(tx, seller);

  // USDC-priced ME v2 sale (Deposit → BuyV2 → ExecuteSaleV2 SPL path) —
  // see detectSaleCurrency's doc for how this differs from the SOL default.
  const currency = detectSaleCurrency(tx);

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

  // Canonical ME v2 price comes from the program's own settlement log
  // (`"price":N`), the true list/sale price — it excludes royalty, marketplace
  // fee and network fee. The buyer's gross SOL outflow (payment.priceLamports)
  // bundles all three and overstates the sale price, so it is used only as a
  // fallback when the log line is absent. Lucky-buy is unchanged: its `price`
  // log is the raffle entry, not the NFT value, so we ignore the log there and
  // keep the sellerNet-as-gross override.
  const logPrice = luckyBuy ? null : readMeV2PriceFromLogs(tx.meta?.logMessages);
  const priceLamports = luckyBuy && sellerNet != null
    ? sellerNet
    : logPrice ?? payment.priceLamports;

  // Listing-escrow / rent-refund guard (ME v2 fixed-price path only).
  // When a fixed-price listing is filled, Magic Eden closes the seller's
  // listing PDA in the SAME transaction and refunds its rent/deposit to the
  // seller's wallet. `computeSellerNetLamports` reads the seller wallet's raw
  // pre/post lamport delta, so that refund (≈0.0035 SOL of reclaimed rent)
  // is added on top of the real NFT proceeds — inflating seller-net above the
  // actual sale price. Observed on coreExecuteSaleV2
  //   3WkwA8QBgnqKwhfpnUBCrSjFXYY7LS2dQh1LNJsSG6wogv1nFDqJLJK245sgnVQVe4Stc2a3YvK7sXrEqD4ia3mm
  // → seller-net 0.013465 vs true price 0.010112 (refunded escrow 0.003564).
  // A legitimate seller-net can never exceed the canonical sale price, so
  // when it does the value is contaminated and we drop it; the UI then falls
  // back to priceLamports — now the explicit ME log price (above), the correct
  // economic sale price, rather than the fee-inflated buyer gross. Skipped for
  // lucky-buy, where gross IS the raffle-escrow spend (unreliable) and
  // sellerNet is the intended price source.
  // sellerNet is computed purely from the seller's NATIVE SOL balance delta
  // (computeSellerNetLamports) — meaningless for a USDC-priced sale, where
  // the real proceeds land in a USDC token account and the SOL delta is just
  // rent/fee dust. Drop it for non-SOL currencies rather than surface a
  // misleading micro-SOL "net" figure; the UI falls back to priceSol, which
  // IS correct (see detectSaleCurrency/currencyDecimals above).
  const sellerNetClean = currency === 'SOL' && !luckyBuy && sellerNet != null && sellerNet > priceLamports
    ? null
    : currency === 'SOL' ? sellerNet : null;

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
    priceSol:          Number(priceLamports) / 10 ** currencyDecimals(currency),
    sellerNetLamports: sellerNetClean,
    sellerNetPriceSol: sellerNetClean != null ? Number(sellerNetClean) / 1e9 : null,
    currency,
    rawData:           {
      _parser:     'me_v2_raw',
      _instruction: match.instructionName,
      _verified:   match.verified,
      // Lucky-buy and pack-open are mutually exclusive program-presence
      // signals; checking pack first preserves intent if both ever
      // co-occur in a future ME product (currently they don't).
      ...(isPackOpenTx(tx) ? { _subtype: 'pack_open' as const } : luckyBuy ? { _subtype: 'lucky_buy' as const } : {}),
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
  } else if (nftType === 'cnft') {
    // Compressed NFT: no on-chain mint account. Place the collection
    // address (verified at outer ix `accounts[7]` for `cnftFulfillBuy`
    // — confirmed against fixture
    //   3UwKaN58uyh2PBZ7atv1ACmDHpSG1n1xyNWjQvdAxKqcLZ3vubggv6BYweSb7yEPtPddNsFGxoR1R5p3ERWVso6w
    // accs[7] = axkvaYVWWopHZJzPBsfLJcHQNecHy8L4vvMTYPjaY9N) into
    // `mintAddress` as a stable placeholder. The signature is the
    // real per-sale key downstream; mintAddress is just used for
    // log truncation, dedup heuristics, and a Solscan link target
    // (which for cNFT instead points at the collection page —
    // acceptable trade-off versus a derived asset_id that requires
    // a Bubblegum CPI decode + PDA derivation on every sale).
    mint = accs[7] ?? null;
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
  } else if (match.coreAssetIdx === null && match.direction !== 'fulfillSell') {
    // Token-flow fallback only when direction is fulfillBuy (user IS the
    // seller, sends NFT to pool). For fulfillSell (user buys FROM pool)
    // the token-flow source is the pool vault PDA — wrong wallet. Leave
    // seller null so the parser rejects rather than surfacing the pool
    // PDA. Affects unverified ixs only (verified pool-sells like
    // solMip1FulfillSell carry sellerAcctIdx=5 = pool owner).
    seller = extractPartiesFromTokenFlow(tx, mint).seller;
  } else {
    seller = null; // Core / pool-sell w/ no verified pos — use SOL-flow below
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

  // Same guard as the token-flow block above: don't let payment-flow
  // backfill a pool-vault PDA as the human seller on unverified
  // fulfillSell ixs. Verified pool-sells already set seller from
  // sellerAcctIdx so this guard is a no-op for them.
  const poolSellAmbiguous = match.direction === 'fulfillSell' && match.sellerAcctIdx === null;
  if (!poolSellAmbiguous) seller = seller ?? payment.seller;
  buyer  = buyer  ?? payment.buyer;

  if (!seller || !buyer) {
    return { ok: false, reason: `mmm(${match.instructionName}): could not determine parties` };
  }

  // MMM sale currency — see detectSaleCurrency's doc. MMM pools are
  // overwhelmingly SOL-denominated; this stays SOL unless a USDC leg is
  // actually present in the tx.
  const currency = detectSaleCurrency(tx);

  // ── Pool state PDA (AMM badge classification) ─────────────────────────────
  // Only extracted for instruction variants with an independently-verified
  // poolAcctIdx (see programs.ts) — every other variant leaves this null,
  // failing closed (no AMM badge) rather than guessing an account index.
  const poolAddress = match.poolAcctIdx !== null ? (accs[match.poolAcctIdx] ?? null) : null;

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
  // ── Synchronous AMM-fill classification (transaction-time, persisted) ────
  //
  // Independent of the takeBid reclassification below and of the (async,
  // non-persisted) mmm-pool-type-resolver: `lp_fee > 0` on a fulfillBuy is
  // itself the authoritative on-chain evidence that the fill retained the
  // NFT as sell-side pool inventory (a genuine two-sided/AMM fill) — the
  // MMM program only charges its LP curve fee when the trade reprices the
  // pool's bonding curve, which happens exclusively on that path. Audited
  // live 2026-07-15 against 13 real fulfillBuy transactions spanning
  // solFulfillBuy / coreFulfillBuy / solMip1FulfillBuy / solOcpFulfillBuy /
  // solExtFulfillBuy (7 lp_fee=0 bid-acceptance examples, 6 lp_fee>0 pool
  // fills, no contradictions) — including both regression signatures
  // reported for this fix (3VYqF8s6…, a pool ME's own API had classified
  // `two_sided`, and 5G5YJiVf…, a pool ME's API could NOT classify at all)
  // — both carry lp_fee > 0 on-chain regardless of what (or whether) ME's
  // poolType lookup resolves, which is exactly why this signal must be the
  // authoritative one and ME poolType only ever corroboration/fallback.
  //
  // Gated on `match.poolAcctIdx !== null` (the same independently-verified
  // pool-account-position requirement `poolAddress` above uses) so an
  // instruction variant whose account layout isn't independently confirmed
  // (e.g. the still-dormant `coreFulfillBuyV2`) can never emit this flag —
  // fails closed exactly like `poolAddress` does for the same reason.
  // cNFT fulfillBuy never emits an `lp_fee` log line at all (confirmed live
  // 2026-07-15 on 2 cnftFulfillBuy fixtures) so `ammFill` is never set for
  // cNFT sales — also a correct fail-closed outcome, not a gap.
  //
  // Tri-state, NOT a plain boolean: `true` (lp_fee>0, confirmed AMM fill),
  // `false` (lp_fee===0, confirmed ordinary bid acceptance — this is
  // authoritative and must NEVER be second-guessed by a later ME poolType
  // lookup), or omitted entirely (lp_fee missing/unverified — no evidence
  // either way, poolType fallback is allowed). Collapsing `false` and
  // "omitted" into one value would let a stale/wrong ME `two_sided` lookup
  // override a transaction we've already confirmed is NOT a pool fill —
  // exactly the class of bug this fix closes (see the frontend saleKind()
  // precedence rule in sale-kind.ts).
  let ammFill: { lpFeeLamports: number; isAmmFill: boolean } | null = null;

  let effectiveDirection: string = match.direction;
  if (match.direction === 'fulfillBuy') {
    const lpFee = readLpFeeFromLogs(tx.meta?.logMessages);
    if (lpFee != null && match.poolAcctIdx !== null) {
      ammFill = { lpFeeLamports: lpFee, isAmmFill: lpFee > 0 };
    }
    let promote: boolean;
    if (lpFee != null) {
      promote = lpFee === 0;
    } else if (nftType !== 'core') {
      // No log signal — fall back to the legacy address heuristic so
      // pre-launch / pre-log MMM ixs still behave identically. This
      // path is reached only when the MMM program log line is missing
      // or shape-changes; safe to leave the original logic in place.
      // Core NFTs don't have SPL token-flow so we can't run this
      // heuristic for them; if the lp_fee log isn't present we leave
      // the direction as-is (`fulfillBuy` → pool_sale) — better to
      // miss a takeBid reclassification than to call the heuristic
      // with bad inputs.
      const tokenFlowBuyer = extractPartiesFromTokenFlow(tx, mint).buyer;
      const poolPda        = accs[match.buyerAcctIdx ?? 1] ?? null;
      promote = !!tokenFlowBuyer && !!poolPda && tokenFlowBuyer !== poolPda;
    } else {
      promote = false;
    }
    if (promote) {
      // Direction reclassification is correct for any fulfillBuy with
      // lp_fee=0 — that's the bid acceptance signal regardless of NFT
      // standard. Buyer override however is ONLY valid for legacy SPL,
      // where the NFT lands directly in the bidder's wallet so
      // `tokenFlowBuyer === bidder`. For pNFT (this `mmm` branch's
      // pnft path) the pNFT escrow forces the destination ATA to be
      // owned by an escrow PDA (e.g. `G6RG…QmmA`), NOT the bidder's
      // human wallet — overriding here would surface that escrow PDA
      // as the "buyer" on the wire (confirmed against
      //   66RH19t3tZUaMc3A6WdfYG6tE8wMdeHNg2wn89Vhp6HVwGxHtSx7PaMM5iJEcoZVHhNz5nLJC3ijwtHLPsXBSc2Y
      // — Magic Eden's UI shows `PER2zk…` (the MMM `owner` arg =
      // accs[1] = bidder), our parser was showing `G6RG…QmmA`
      // (escrow). Keeping `accs[1]` is correct for pNFT.
      // Core path: lp_fee=0 ALSO triggers takeBid reclassification —
      // confirmed against
      //   2cdam8rLjxCCAmW53ZTcFU4E9orPstjyP4oJtVhydT3z6anszEwripjf1mf5zUCqPz5HMeViNoEDLfvcow5ULdi5
      // (SolMplCoreFulfillBuy, lp_fee=0, royalty_paid=1.4M lamports,
      // total_price=20M lamports). For Core MMM the outer ix `accs[1]`
      // is already the human bidder (pool owner), and there's no SPL
      // token-flow to override against — so we DO NOT apply the
      // tokenFlowBuyer override below.
      effectiveDirection = 'takeBid'; // maps to bid_sell in both sse.ts and queries.ts
      // NOTE: no buyer override here. The previous legacy-only override
      // (`buyer = extractPartiesFromTokenFlow(tx, mint).buyer`) was both
      // redundant and harmful:
      //   • redundant — for a genuine individual bid the NFT lands directly
      //     in the bidder's wallet, so tokenFlowBuyer === accs[1] anyway.
      //   • harmful — for a zero-LP-fee MMM pool (lp_fee=0 + reinvest), the
      //     NFT recipient is the pool STATE PDA, not the bidder. The override
      //     surfaced that pool PDA as the "buyer" (e.g. BJT7KT1q… instead of
      //     the pool owner PER7nVm9… on sig 5xPi1Pvt…rifEn).
      // accs[1] (= buyerAcctIdx) is the pool owner / bidder wallet for
      // solFulfillBuy in BOTH cases, so we keep the value already assigned
      // from match.buyerAcctIdx above and do not touch it on takeBid.
    }
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
  // equals the largest positive SOL delta in the tx — the pool's payout
  // wallet receiving the curve proceeds. Royalty + LP fee are always
  // smaller fractions of the price, so the largest gainer is the correct
  // disambiguation for the PRICE without parsing the program log.
  //
  // NB: this is a PRICE heuristic only — do not read anything about seller
  // IDENTITY into it. The account that happens to be the largest gainer
  // (the pool's payout wallet) is confirmed NOT to be the human depositor
  // in general (see programs.ts's per-instruction sellerAcctIdx docs,
  // corrected 2026-07-15); `seller` above is assigned from the verified
  // `sellerAcctIdx` account, entirely independently of this price calc.
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

  // Rent-refund guard: MMM sales can be bundled in the same tx as an
  // unrelated ME `CancelSell` (delisting a stale ME v2 listing on the
  // same NFT) that closes a PDA and refunds its rent to the seller's
  // wallet. computeSellerNetLamports reads the seller's whole-tx
  // balance delta, so that refund is added on top of the real MMM sale
  // proceeds. Confirmed on
  //   4XtV5LU5zfRkmKavGvrLGfXF9J19P7ZytUfguSovf8XDv2yahefqte9kQ6VmeV6hq3gcir9jy6cnzfjNwE4iEPn3
  // → seller-net 0.011642646 vs MMM log total_price 0.00826 (bundled
  // CancelSell refunded ≈0.0056 SOL of closed-PDA rent). Same invariant
  // as the ME v2 guard above: seller-net can never exceed the canonical
  // sale price, so a value above priceLamports is contaminated and dropped.
  //
  // `fulfillSell` is excluded entirely: the `seller` account there is the
  // pool depositor (sellerAcctIdx), a verified IDENTITY only — per the price
  // heuristic comment above, the actual sale proceeds land on the pool's
  // payout wallet, NOT the depositor's own wallet. Reading the depositor's
  // balance delta as "net price" massively UNDERSTATES it (e.g. 0.0105 SOL
  // of rent-refund + lp_fee dust vs a real 0.18 SOL sale — confirmed on
  //   4URg4bwcJrJQ6SgVkVEChd5eCchq8mVnDCvrjcTzmc6iqxsWa6wraf1rtXwLYCNbR1TodE8GNXFmVGG3aUgMEMdf
  // ), and the >priceLamports guard only catches overstatement, not this.
  // sellerNet reads the seller's native SOL balance delta — meaningless for
  // a USDC-priced fill (see the ME v2 path's identical guard above).
  const sellerNet = currency !== 'SOL' || effectiveDirection === 'fulfillSell'
    ? null
    : cleanSellerNet(computeSellerNetLamports(tx, seller), priceLamports);
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
    priceSol:          Number(priceLamports) / 10 ** currencyDecimals(currency),
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency,
    poolAddress,
    rawData:           {
      _parser:      'mmm_raw',
      _instruction: match.instructionName,
      _direction:   effectiveDirection,
      // Same subtype tag as the ME V2 path, applied here because Pack
      // opens deliver the NFT via an MMM `SolFulfillSell` CPI nested
      // inside the PCKj `FulfillMmm` outer ix — the decoder matches
      // the inner MMM instruction and routes through THIS parser
      // path. Detection is by program presence in the tx account
      // universe (mirrors the lucky-buy approach).
      ...(isPackOpenTx(tx) ? { _subtype: 'pack_open' as const } : {}),
      // Synchronous, persisted AMM-fill evidence — see the block above.
      // `_ammFill` key is entirely ABSENT (not `false`) when lp_fee is
      // missing/unverified — that's the "no evidence either way" state the
      // frontend fallback checks for. When present it's always an exact
      // boolean derived from an integer lamport comparison — never a
      // floating-point value. This is the authoritative signal the
      // frontend badge reads; mmm-pool-type-resolver's poolType is
      // fallback/corroboration only (see its module doc).
      ...(ammFill != null ? {
        _ammFill:        ammFill.isAmmFill,
        _ammEvidence:    'lp_fee' as const,
        _lpFeeLamports:  String(ammFill.lpFeeLamports),
      } : {}),
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}

// ─── ME cNFT marketplace (M3mxk5W2…) ──────────────────────────────────────────
//
// Magic Eden's standalone Bubblegum / cNFT marketplace program. Single
// confirmed sale instruction (`buy_now`) — a direct buyer-side fulfilment
// of a listed cNFT. Account / data layout reverse-engineered against the
// `wegens` coverage-gap audit fixtures (3RggSHw8…, 2S8tP67Y…, 3iTTPC5B…,
// 3knsHxac…, 4AzFBi9A…, 4tkQBb4S…). All six match the layout encoded in
// `ME_CNFT_SALE_INSTRUCTIONS`.
//
// cNFT specifics:
//   - No on-chain mint account. Following the existing MMM
//     `cnftFulfillBuy` convention, we place the merkle tree at
//     `accounts[10]` into `mintAddress` as a stable, dedup-friendly
//     placeholder. The signature remains the per-sale unique key.
//   - Buyer / seller / price are read deterministically from the outer
//     instruction — no SOL-flow / token-flow heuristic needed for this
//     path (data layout is fixed by the Anchor program).

function parseMeCnftSale(
  tx: RawSolanaTx,
  match: NonNullable<ReturnType<typeof findMeCnftSaleIx>>,
): ParseResult {
  const accs = match.accounts;

  const buyer       = accs[match.buyerAcctIdx]  ?? null;
  const seller      = accs[match.sellerAcctIdx] ?? null;
  const merkleTree  = accs[match.merkleTreeIdx] ?? null;

  if (!buyer || !seller || buyer === seller) {
    return { ok: false, reason: `me_cnft(${match.instructionName}): could not determine buyer/seller` };
  }
  if (!merkleTree) {
    return { ok: false, reason: `me_cnft(${match.instructionName}): missing merkle tree at accs[${match.merkleTreeIdx}]` };
  }
  if (match.data.length < match.priceOffset + 8) {
    return { ok: false, reason: `me_cnft(${match.instructionName}): instruction data too short for price (${match.data.length} B)` };
  }
  const priceLamports = match.data.readBigUInt64LE(match.priceOffset);
  if (priceLamports <= 0n) {
    return { ok: false, reason: `me_cnft(${match.instructionName}): zero price` };
  }

  // sellerNet for cNFTs falls through to `computeSellerNetLamports`
  // which reads the seller's lamport delta from balanceDeltas — that's
  // the same authoritative source the ME V2 / MMM paths use.
  // Currency + sellerNet: same USDC-vs-SOL split as the ME v2 / MMM paths.
  const currency   = detectSaleCurrency(tx);
  const sellerNet  = currency === 'SOL' ? computeSellerNetLamports(tx, seller) : null;

  const event: SaleEvent = {
    signature:         tx.signature,
    blockTime:         new Date(tx.blockTime! * 1000),
    marketplace:       'magic_eden',
    nftType:           'cnft',
    // Merkle tree placeholder — same shape MMM cnftFulfillBuy uses for
    // its accs[7]. Downstream consumers (sale_events, /feed) treat
    // mintAddress as a stable identifier; the merkle tree is the
    // collection-equivalent group anchor for compressed assets.
    mintAddress:       merkleTree,
    collectionAddress: merkleTree,
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 10 ** currencyDecimals(currency),
    sellerNetLamports: sellerNet,
    sellerNetPriceSol: sellerNet != null ? Number(sellerNet) / 1e9 : null,
    currency,
    rawData:           {
      _parser:      'me_cnft_raw',
      _instruction: match.instructionName,
      _verified:    match.verified,
    },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };

  return { ok: true, event };
}
