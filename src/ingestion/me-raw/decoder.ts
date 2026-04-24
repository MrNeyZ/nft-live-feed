import bs58 from 'bs58';
import { RawSolanaTx, RawInstruction, resolveAccountKey } from './types';
import {
  ME_V2_PROGRAM,
  ME_AMM_PROGRAM,
  ME_PROGRAMS,
  TOKEN_AUTH_RULES_PROGRAM,
  MPL_CORE_PROGRAM,
  ME_V2_SALE_INSTRUCTIONS,
  MMM_SALE_INSTRUCTIONS,
} from './programs';
import { NftType } from '../../models/sale-event';

// ─── Instruction data ─────────────────────────────────────────────────────────

/** Decode base58 instruction data to a Buffer. */
export function decodeIxData(base58Data: string): Buffer {
  return Buffer.from(bs58.decode(base58Data));
}

/** Compare the first 8 bytes of decoded instruction data to a known discriminator. */
export function matchesDisc(data: Buffer, disc: Buffer): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

// ─── Instruction finders ──────────────────────────────────────────────────────

function allInstructions(tx: RawSolanaTx): Array<{ ix: RawInstruction; isInner: boolean }> {
  const outer = (tx.transaction.message.instructions ?? []).map((ix) => ({
    ix,
    isInner: false,
  }));
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.map((ix) => ({ ix, isInner: true }))
  );
  return [...outer, ...inner];
}

function programAt(tx: RawSolanaTx, ix: RawInstruction): string {
  return resolveAccountKey(tx, ix.programIdIndex);
}

function anyProgramInvolved(tx: RawSolanaTx, programId: string): boolean {
  return allInstructions(tx).some((e) => programAt(tx, e.ix) === programId);
}

// ─── ME v2 detection ─────────────────────────────────────────────────────────

export interface MeV2Match {
  kind: 'me_v2';
  instructionName: string;
  /**
   * Whether this discriminator was confirmed against a live completed-sale tx.
   * When false the parser will still attempt extraction but logs a warning —
   * don't treat these as trusted production events until verified.
   */
  verified: boolean;
  /**
   * For MPL Core instructions: instruction-accounts index of the Core asset ID.
   * null for legacy / pNFT — derive mint from SPL token-balance changes instead.
   */
  coreAssetIdx: number | null;
  ix: RawInstruction;
  /** Resolved account pubkeys for this instruction (in order). */
  accounts: string[];
}

export function findMeV2SaleIx(tx: RawSolanaTx): MeV2Match | null {
  // Scan def-first so higher-priority instructions (mip1ExecuteSaleV2) win
  // even when a lower-priority instruction (buyV2) exists as an inner CPI
  // within the same transaction.
  const meIxs = allInstructions(tx).filter(({ ix }) => programAt(tx, ix) === ME_V2_PROGRAM);

  for (const def of ME_V2_SALE_INSTRUCTIONS) {
    for (const { ix } of meIxs) {
      const data = decodeIxData(ix.data);
      if (matchesDisc(data, def.disc)) {
        return {
          kind: 'me_v2',
          instructionName: def.name,
          verified: def.verified,
          coreAssetIdx: def.coreAssetIdx,
          ix,
          accounts: ix.accounts.map((i) => resolveAccountKey(tx, i)),
        };
      }
    }
  }
  return null;
}

// ─── MMM (ME AMM) detection ───────────────────────────────────────────────────

export interface MmmMatch {
  kind: 'mmm';
  instructionName: string;
  /** fulfillBuy = user sells into pool; fulfillSell = user buys from pool */
  direction: 'fulfillBuy' | 'fulfillSell';
  /**
   * Verified instruction-accounts index for the human seller.
   * null = not confirmed; parser uses token-flow / SOL-flow fallback.
   */
  sellerAcctIdx: number | null;
  /**
   * Verified instruction-accounts index for the human buyer.
   * null = not confirmed; parser uses token-flow / SOL-flow fallback.
   */
  buyerAcctIdx: number | null;
  /**
   * For MPL Core fills: instruction-accounts index of the Core asset ID.
   * null for legacy / pNFT — derive mint from SPL token-balance changes.
   */
  coreAssetIdx: number | null;
  ix: RawInstruction;
  /** Resolved account pubkeys for this instruction (in order). */
  accounts: string[];
}

export function findMmmSaleIx(tx: RawSolanaTx): MmmMatch | null {
  for (const { ix } of allInstructions(tx)) {
    if (programAt(tx, ix) !== ME_AMM_PROGRAM) continue;

    const data = decodeIxData(ix.data);
    for (const def of MMM_SALE_INSTRUCTIONS) {
      if (matchesDisc(data, def.disc)) {
        return {
          kind: 'mmm',
          instructionName: def.name,
          direction: def.direction,
          sellerAcctIdx: def.sellerAcctIdx,
          buyerAcctIdx:  def.buyerAcctIdx,
          coreAssetIdx:  def.coreAssetIdx,
          ix,
          accounts: ix.accounts.map((i) => resolveAccountKey(tx, i)),
        };
      }
    }
  }
  return null;
}

// ─── Core asset ID from inner instruction ────────────────────────────────────

/**
 * Extract the MPL Core asset ID from the first MPL Core CPI in the transaction.
 * The MPL Core program always places the asset account at accounts[0] of its
 * instruction regardless of the calling program's account layout.
 *
 * Used for MMM coreFulfillSell where the asset position in the outer instruction
 * accounts array varies across transactions (confirmed at idx 4 in some, idx 6
 * in others). The inner CPI is the canonical, stable source.
 */
export function extractCoreAssetFromInnerIx(tx: RawSolanaTx): string | null {
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (resolveAccountKey(tx, ix.programIdIndex) !== MPL_CORE_PROGRAM) continue;
      if (ix.accounts.length === 0) continue;
      const asset = resolveAccountKey(tx, ix.accounts[0]);
      if (asset) return asset;
    }
  }
  return null;
}

// ─── Asset type classification ────────────────────────────────────────────────

/**
 * Determine NFT type by looking at which supporting programs were invoked.
 * Works for both ME v2 and MMM transactions.
 */
export function classifyNftType(tx: RawSolanaTx): NftType {
  if (anyProgramInvolved(tx, MPL_CORE_PROGRAM)) return 'metaplex_core';
  if (anyProgramInvolved(tx, TOKEN_AUTH_RULES_PROGRAM)) return 'legacy'; // pNFT is still "legacy" token standard
  return 'legacy';
}

// ─── Quick pre-filter ─────────────────────────────────────────────────────────

/** Fast check: does this transaction involve any ME program at all? */
export function isMeTransaction(tx: RawSolanaTx): boolean {
  // Pre-merge shape (strings) or post-merge shape (objects) — accept both.
  const keys = tx.transaction.message.accountKeys as unknown as Array<string | { pubkey: string }>;
  for (const k of keys) {
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (pk && ME_PROGRAMS.has(pk)) return true;
  }
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    for (const pk of loaded.writable ?? []) if (ME_PROGRAMS.has(pk)) return true;
    for (const pk of loaded.readonly ?? []) if (ME_PROGRAMS.has(pk)) return true;
  }
  return false;
}
