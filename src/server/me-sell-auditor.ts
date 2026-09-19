/**
 * ME Sell (ME Offer Accept) — canonical structural + exact-price authorization
 * auditor for the M2 `Sell` + `ExecuteSaleV2` accept-offer bundle.
 *
 * Replaces the old `validateSellStructure`'s presence-anywhere checks
 * (`.some(k => pubkey === expected)`, no price check at all — see
 * docs/me-sell-audit-2026-09-12.md findings MS-1/MS-2). This module is used
 * on EVERY path that ever hands bytes to Phantom or broadcasts them:
 * backend build-accept, the Tampermonkey-bridge pre-sign path, and both
 * submit/submit-bridge revalidation — there is exactly ONE auditor, not
 * subtly different rules per path.
 *
 * ── EVIDENCE — real, historical, mainnet, read-only (2026-09-12) ──────────
 *
 * Two REAL, settled, successful (err:null) M2 accept-offer bundles were
 * decoded this session via Helius `getTransaction` (read-only; nothing was
 * signed or broadcast) — found by scanning ~9,000 recent M2-program
 * signatures for the 2-signer / exactly-2-M2-instruction shape this feature
 * builds, since (per the original 2026-08-24 audit note) this exact event
 * type is rare relative to list/buy/cancel/bid activity:
 *
 *   pNFT:     sig 4cc5RPFdP4CuR9a4AunviUfP2JndzTTdQzpTpci2sEuGSpP1Z2FCBNn7uavhjw9WueR9kAngzMC9dogYUY9uhvNH
 *             price 9,065,000,000 lamports (9.065 SOL) — confirmed EXACTLY
 *             via lamport-for-lamport balance-delta reconciliation:
 *             sellerGain(8,883,638,817) + txFee(61,183) = price*0.98 exactly;
 *             royalty(453,250,000) = price*0.05 exactly; buyer's escrow lost
 *             exactly price+royalty. Metadata is a real Token-Metadata PDA
 *             (607 bytes — the shrunk/resized size, matching this repo's own
 *             Resize Claim findings), `metaqbxx…`/`auth9SigN…` (Token
 *             Metadata / Token Auth Rules programs) are both present — this
 *             is the PROGRAMMABLE NFT (pNFT) variant.
 *   MPL Core: sig 4DCPfNX4Hq9bsT9t6kLyfTa3E6vfop5DXPeqWStPt8mDaCQpcme3To62XUYiQiFFvp2cNVfEJkLwFwnodX7dcPuq
 *             price 4,980,000,000 lamports (4.98 SOL), same exact-reconciliation
 *             method (royalty=price*0.05, seller proceeds=price*0.98-fee).
 *             `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` (the MPL Core
 *             program) is present — this is the MPL CORE variant.
 *
 * IMPORTANT CORRECTION to the 2026-09-12 audit's own standard-support
 * assumption: the audit (reasonably, given it did not independently decode
 * a fresh accept-offer tx) treated MPL Core as "no explicit support, no
 * explicit rejection, most likely fails via ME's own downstream validation."
 * This session's real evidence PROVES the opposite — a real, live, ME-built
 * MPL Core accept-offer bundle exists, landed successfully, and correctly
 * enforced a 5% royalty. Core is therefore an EXPLICITLY SUPPORTED standard
 * here, not merely "probably rejected." Conversely, NO real evidence of a
 * legacy (pre-pNFT, non-Core) SPL accept-offer bundle was found despite
 * scanning ~9,000 signatures — legacy is therefore NOT included in the
 * standard allowlist below (MS-6) until real evidence exists. This is a
 * deliberate, evidence-driven behavior change from the tool's prior
 * (untested) assumption that legacy "just works" — see the hardening
 * report for the full reasoning.
 *
 * Both instructions' data layout is: `discriminator(8) ‖ priceLamports
 * u64LE(8) ‖ <fixed tail>` — price sits at a fixed byte offset in BOTH the
 * Sell and the ExecuteSaleV2 instruction, confirmed identical between the
 * two (both instructions must reference the same price for the trade-state
 * match to succeed on-chain). The tail bytes are pinned exactly for the
 * one case this tool ever sends (`sellerExpiry: 0`, implicit tokenSize=1,
 * no referral) — a different tail would mean the request shape changed and
 * this auditor intentionally fails closed rather than guessing what changed.
 *
 * Compared against the vanilla open-source `@metaplex-foundation/
 * mpl-auction-house` package (already present in this repo's own dependency
 * tree, program `hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk`) purely for
 * conceptual cross-reference: its `Sell` discriminator/layout
 * (`[51,230,133,164,1,127,131,173]`, 27-byte data) does NOT match either
 * real M2 variant found here — confirming M2 (Magic Eden's own fork,
 * `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K`) uses its own distinct
 * instruction set, not the vanilla program's. The reference package is not
 * imported or relied on for any check below — every constant here comes
 * from the real M2 evidence.
 *
 * Per-position account IDENTITY is NOT pinned beyond what is either (a) a
 * frozen-intent value (seller/buyer/mint/auctionHouse), (b) a program ID
 * known independently of this trade, or (c) an address independently
 * DERIVABLE with no guessing — the buyer's M2 escrow PDA (this repo's own
 * already-audited `deriveBuyerEscrowPda`, re-verified live in the GhostBid
 * audit), the NFT's Metadata PDA, and the seller's own ATA (both confirmed
 * to match the real pNFT transaction's actual accounts, byte for byte, in
 * this session). Everything else (trade-state PDAs, escrow, program-as-
 * signer, token records, the creator-royalty tail) is validated by COUNT
 * (exact, per variant/instruction — locks out extra/missing accounts) and
 * SET MEMBERSHIP of the required-present addresses above, not by fixed
 * position — a positional model built from only 2 real samples risked
 * silently breaking on a legitimate account-count variation (e.g. a
 * different number of royalty-split creators) that this audit's own spec
 * explicitly warns is a real, dynamic part of this instruction shape.
 */

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveBuyerEscrowPda } from './me-bid-escrow';

export const M2_PROGRAM_ID = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SYSVAR_INSTRUCTIONS_ID = 'Sysvar1nstructions1111111111111111111111111';
const SYSVAR_RENT_ID = 'SysvarRent111111111111111111111111111111111';
const AUTH_RULES_PROGRAM_ID = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
const MPL_CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

export type MeSellStandard = 'pnft' | 'mplCore';
/** The full allowlist — legacy/Token-2022/cNFT/SFT are intentionally absent
 *  (MS-6): no real evidence of this tool successfully accepting an offer
 *  on those standards exists yet. Extend only after capturing real
 *  evidence, the same way pnft/mplCore were established above. */
export const SUPPORTED_STANDARDS: readonly MeSellStandard[] = ['pnft', 'mplCore'];

interface M2IxTemplate {
  /** lowercase hex, 16 chars (8 bytes) */
  discriminatorHex: string;
  /** total instruction data length in bytes, including discriminator+price+tail */
  dataLength: number;
  /** hex of the bytes AFTER discriminator(8)+price(8) — must match exactly
   *  for the one request shape this tool ever sends. */
  tailHex: string;
}
interface M2VariantTemplate {
  standard: MeSellStandard;
  sell: M2IxTemplate;
  executeSale: M2IxTemplate;
  sellAccountCount: number;
  executeSaleAccountCount: number;
  /** the one standard-specific program that must appear in BOTH
   *  instructions' account sets for this variant. */
  standardProgramId: string;
}

const VARIANTS: readonly M2VariantTemplate[] = [
  {
    standard: 'pnft',
    sell: { discriminatorHex: '3a32ac6fa697165e', dataLength: 24, tailHex: 'ffffffffffffffff' },
    executeSale: { discriminatorHex: 'eca3ccad4790eb76', dataLength: 20, tailHex: '0000c800' },
    sellAccountCount: 22,
    executeSaleAccountCount: 29,
    standardProgramId: AUTH_RULES_PROGRAM_ID,
  },
  {
    standard: 'mplCore',
    sell: { discriminatorHex: '1ff3f73b8653a5da', dataLength: 25, tailHex: 'ffffffffffffffff00' },
    executeSale: { discriminatorHex: 'd562c518f2359a23', dataLength: 21, tailHex: '0000c80000' },
    sellAccountCount: 12,
    executeSaleAccountCount: 22,
    standardProgramId: MPL_CORE_PROGRAM_ID,
  },
];

export type AuditResult = { ok: true } | { ok: false; reason: string };
function fail(reason: string): AuditResult { return { ok: false, reason }; }

export interface FrozenMeSellIntent {
  seller: string;
  /** NFT mint (pnft) or Core asset address (mplCore) — same field, the
   *  identity of the thing being sold either way. */
  mint: string;
  buyer: string;
  auctionHouse: string;
  /** exact integer lamports, as a decimal string — never a float. */
  priceLamports: string;
  standard: MeSellStandard;
}

function u64leHex(decimalLamports: string): string {
  const n = BigInt(decimalLamports);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf.toString('hex');
}

function keySet(ix: TransactionInstruction): Set<string> {
  return new Set(ix.keys.map((k) => k.pubkey.toBase58()));
}

function checkInstructionData(ix: TransactionInstruction, tmpl: M2IxTemplate, priceLamports: string, label: string): AuditResult {
  const data = ix.data;
  if (data.length !== tmpl.dataLength) {
    return fail(`${label}_data_length: expected ${tmpl.dataLength}, got ${data.length}`);
  }
  const discHex = data.subarray(0, 8).toString('hex');
  if (discHex !== tmpl.discriminatorHex) {
    return fail(`${label}_discriminator: expected ${tmpl.discriminatorHex}, got ${discHex}`);
  }
  const priceHex = data.subarray(8, 16).toString('hex');
  const expectedPriceHex = u64leHex(priceLamports);
  if (priceHex !== expectedPriceHex) {
    return fail(`${label}_price_mismatch: expected ${priceLamports} lamports (${expectedPriceHex}), instruction encodes ${priceHex}`);
  }
  const tailHex = data.subarray(16).toString('hex');
  if (tailHex !== tmpl.tailHex) {
    return fail(`${label}_unexpected_tail_bytes: expected ${tmpl.tailHex}, got ${tailHex} (request shape changed — refusing rather than guessing what changed)`);
  }
  return { ok: true };
}

/**
 * Canonical ME Sell auditor. Operates on FINAL legacy `Transaction` bytes —
 * the exact object that will be (or was) handed to Phantom. Used identically
 * by build-accept (pre-cache), the bridge pre-sign path, and submit/
 * submit-bridge revalidation — one set of rules, everywhere.
 */
export function auditMeSellTransaction(
  tx: Transaction,
  intent: FrozenMeSellIntent,
  expectSellerSignature: 'absent' | 'present',
): AuditResult {
  if (!SUPPORTED_STANDARDS.includes(intent.standard)) {
    return fail(`unsupported_standard: ${intent.standard}`);
  }
  if (tx.signatures.length !== 2) {
    return fail(`unexpected_signer_count: expected 2, got ${tx.signatures.length}`);
  }
  const sellerEntry = tx.signatures.find((s) => s.publicKey.toBase58() === intent.seller);
  if (!sellerEntry) return fail('seller_not_in_signer_set');
  const otherEntry = tx.signatures.find((s) => s.publicKey.toBase58() !== intent.seller);
  if (!otherEntry) return fail('cosigner_slot_missing');

  const sellerSigned = sellerEntry.signature != null;
  if (expectSellerSignature === 'absent' && sellerSigned) return fail('unexpected_pre_filled_seller_signature');
  if (expectSellerSignature === 'present' && !sellerSigned) return fail('missing_seller_signature');

  if (!tx.feePayer || tx.feePayer.toBase58() !== intent.seller) return fail('fee_payer_mismatch');
  if (!tx.recentBlockhash) return fail('missing_recent_blockhash');

  // ── top-level envelope: only ComputeBudget + M2, ComputeBudget bounded
  //    and positioned before both M2 instructions (MS: ComputeBudget
  //    containment). Real evidence (both historical examples) shows ME's
  //    bundle DOES include 1-2 ComputeBudget instructions with real,
  //    varying CU price — the prior code comment claiming "zero
  //    ComputeBudget instructions" was wrong; this is corrected here using
  //    what was actually observed, not the stale comment.
  let sawM2 = false;
  let cuLimit = 200_000; // Solana's own default when no SetComputeUnitLimit is present
  let cuPriceMicroLamports = 0n;
  const seenCbOpcodes = new Set<number>();
  const m2Instructions: TransactionInstruction[] = [];
  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
      if (sawM2) return fail('compute_budget_instruction_after_m2');
      if (ix.data.length < 1) return fail('malformed_compute_budget_instruction');
      const opcode = ix.data[0];
      if (opcode !== 2 && opcode !== 3) return fail(`unexpected_compute_budget_opcode: ${opcode}`);
      if (seenCbOpcodes.has(opcode)) return fail(`duplicate_compute_budget_opcode: ${opcode}`);
      seenCbOpcodes.add(opcode);
      if (opcode === 2) {
        if (ix.data.length < 5) return fail('malformed_set_compute_unit_limit');
        cuLimit = ix.data.readUInt32LE(1);
      } else {
        if (ix.data.length < 9) return fail('malformed_set_compute_unit_price');
        cuPriceMicroLamports = ix.data.readBigUInt64LE(1);
      }
      continue;
    }
    if (pid === M2_PROGRAM_ID) {
      sawM2 = true;
      m2Instructions.push(ix);
      continue;
    }
    return fail(`unexpected_top_level_program: ${pid}`);
  }
  const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n; // 0.01 SOL ceiling on CU_limit*CU_price — generous vs the ~50,000/~11,000-lamport real fees observed, still bounded against a runaway/absurd value
  const worstCaseFeeLamports = (BigInt(cuLimit) * cuPriceMicroLamports) / 1_000_000n;
  if (worstCaseFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) {
    return fail(`compute_budget_priority_fee_exceeds_bound: ${worstCaseFeeLamports} lamports > ${MAX_PRIORITY_FEE_LAMPORTS}`);
  }
  if (m2Instructions.length !== 2) return fail(`unexpected_m2_instruction_count: expected 2, got ${m2Instructions.length}`);

  // ── identify which variant this bundle claims to be, from the Sell
  //    instruction's discriminator; both instructions must belong to the
  //    SAME real, known variant pairing, and it must match frozen intent.
  const [sellIx, executeIx0] = m2Instructions;
  const sellDisc = sellIx.data.length >= 8 ? sellIx.data.subarray(0, 8).toString('hex') : '';
  const variant = VARIANTS.find((v) => v.sell.discriminatorHex === sellDisc);
  if (!variant) return fail(`unknown_sell_discriminator: ${sellDisc}`);
  if (variant.standard !== intent.standard) {
    return fail(`standard_mismatch: bundle is ${variant.standard}, reviewed intent is ${intent.standard}`);
  }
  const executeDisc = executeIx0.data.length >= 8 ? executeIx0.data.subarray(0, 8).toString('hex') : '';
  if (executeDisc !== variant.executeSale.discriminatorHex) {
    return fail(`execute_sale_discriminator_does_not_match_sell_variant: sell claims ${variant.standard}, execute disc is ${executeDisc}`);
  }
  const executeIx = executeIx0;

  const sellCheck = checkInstructionData(sellIx, variant.sell, intent.priceLamports, 'sell');
  if (!sellCheck.ok) return sellCheck;
  const executeCheck = checkInstructionData(executeIx, variant.executeSale, intent.priceLamports, 'execute_sale');
  if (!executeCheck.ok) return executeCheck;

  if (sellIx.keys.length !== variant.sellAccountCount) {
    return fail(`sell_account_count: expected ${variant.sellAccountCount}, got ${sellIx.keys.length}`);
  }
  if (executeIx.keys.length !== variant.executeSaleAccountCount) {
    return fail(`execute_sale_account_count: expected ${variant.executeSaleAccountCount}, got ${executeIx.keys.length}`);
  }

  const sellKeys = keySet(sellIx);
  const executeKeys = keySet(executeIx);

  for (const [label, keys] of [['sell', sellKeys], ['execute_sale', executeKeys]] as const) {
    if (!keys.has(intent.mint)) return fail(`${label}_mint_missing`);
    if (!keys.has(intent.auctionHouse)) return fail(`${label}_auction_house_missing`);
    if (!keys.has(TOKEN_PROGRAM_ID)) return fail(`${label}_token_program_missing`);
    if (!keys.has(SYSTEM_PROGRAM_ID)) return fail(`${label}_system_program_missing`);
    if (variant.standard === 'pnft') {
      if (!keys.has(TOKEN_METADATA_PROGRAM_ID)) return fail(`${label}_token_metadata_program_missing`);
      if (!keys.has(ATA_PROGRAM_ID)) return fail(`${label}_ata_program_missing`);
      if (!keys.has(SYSVAR_INSTRUCTIONS_ID)) return fail(`${label}_sysvar_instructions_missing`);
      if (!keys.has(SYSVAR_RENT_ID)) return fail(`${label}_sysvar_rent_missing`);
    }
    if (!keys.has(variant.standardProgramId)) return fail(`${label}_standard_program_missing: ${variant.standardProgramId}`);
  }

  if (!sellKeys.has(intent.seller)) return fail('sell_seller_missing');
  if (!executeKeys.has(intent.seller)) return fail('execute_sale_seller_missing');

  // Buyer identity is NOT independently derivable (no known M2 trade-state
  // seed formula — same limitation this repo's own tools-me-bids.ts already
  // documents for its own create-offer path) — kept as presence-in-either-
  // instruction, same invariant as before, not weakened.
  if (!sellKeys.has(intent.buyer) && !executeKeys.has(intent.buyer)) {
    return fail('buyer_missing_from_instructions');
  }

  // Buyer's M2 escrow PDA IS independently derivable (shared, already-
  // audited primitive — see GhostBid's own live-mainnet re-verification of
  // this exact function) and must be present: this is the account the
  // buyer's SOL actually moves out of, for either standard.
  const buyerEscrowPda = deriveBuyerEscrowPda(intent.auctionHouse, intent.buyer);
  if (buyerEscrowPda && !executeKeys.has(buyerEscrowPda)) {
    return fail('buyer_escrow_pda_missing_from_execute_sale');
  }

  if (variant.standard === 'pnft') {
    const mintPk = new PublicKey(intent.mint);
    const sellerPk = new PublicKey(intent.seller);
    const metadataPda = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), new PublicKey(TOKEN_METADATA_PROGRAM_ID).toBuffer(), mintPk.toBuffer()],
      new PublicKey(TOKEN_METADATA_PROGRAM_ID),
    )[0].toBase58();
    if (!sellKeys.has(metadataPda)) return fail('sell_metadata_pda_missing');
    if (!executeKeys.has(metadataPda)) return fail('execute_sale_metadata_pda_missing');

    const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false).toBase58();
    if (!sellKeys.has(sellerAta)) return fail('sell_seller_ata_missing');
  }

  return { ok: true };
}
