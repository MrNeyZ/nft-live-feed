import bs58 from 'bs58';
import { RawSolanaTx, RawInstruction } from './types';
import {
  TCOMP_PROGRAM,
  TAMM_PROGRAM,
  BUBBLEGUM_PROGRAM,
  MPL_CORE_PROGRAM,
  TENSOR_PROGRAMS,
  TCOMP_SALE_INSTRUCTIONS,
  TAMM_SALE_INSTRUCTIONS,
  TcompIxDef,
  TammIxDef,
} from './programs';
import { NftType } from '../../models/sale-event';

// ─── Instruction data ─────────────────────────────────────────────────────────

function decodeIxData(base58Data: string): Buffer {
  return Buffer.from(bs58.decode(base58Data));
}

function matchesDisc(data: Buffer, disc: Buffer): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

// ─── Instruction iteration ────────────────────────────────────────────────────

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
  return tx.transaction.message.accountKeys[ix.programIdIndex]?.pubkey ?? '';
}

function anyProgramInvolved(tx: RawSolanaTx, programId: string): boolean {
  return allInstructions(tx).some((e) => programAt(tx, e.ix) === programId);
}

// ─── Pre-filter ───────────────────────────────────────────────────────────────

/** Fast check: does this transaction involve any Tensor program? */
export function isTensorTransaction(tx: RawSolanaTx): boolean {
  return tx.transaction.message.accountKeys.some((k) => TENSOR_PROGRAMS.has(k.pubkey));
}

// ─── TComp detection ─────────────────────────────────────────────────────────

export interface TcompMatch {
  kind: 'tcomp';
  instructionName: string;
  verified: boolean;
  direction: TcompIxDef['direction'];
  buyerAcctIdx:  number | null;
  sellerAcctIdx: number | null;
  /** Index into accounts[] for the Core NFT asset address, or null. */
  coreAssetIdx: number | null;
  ix: RawInstruction;
  /** Resolved account pubkeys for this instruction (in order). */
  accounts: string[];
}

export function findTcompSaleIx(tx: RawSolanaTx): TcompMatch | null {
  const accountKeys = tx.transaction.message.accountKeys;

  for (const { ix } of allInstructions(tx)) {
    if (programAt(tx, ix) !== TCOMP_PROGRAM) continue;

    const data = decodeIxData(ix.data);
    for (const def of TCOMP_SALE_INSTRUCTIONS) {
      if (matchesDisc(data, def.disc)) {
        return {
          kind:            'tcomp',
          instructionName: def.name,
          verified:        def.verified,
          direction:       def.direction,
          buyerAcctIdx:    def.buyerAcctIdx,
          sellerAcctIdx:   def.sellerAcctIdx,
          coreAssetIdx:    def.coreAssetIdx,
          ix,
          accounts: ix.accounts.map((i) => accountKeys[i]?.pubkey ?? ''),
        };
      }
    }
  }
  return null;
}

// ─── TAMM detection ──────────────────────────────────────────────────────────

export interface TammMatch {
  kind: 'tamm';
  instructionName: string;
  verified: boolean;
  direction: TammIxDef['direction'];
  buyerAcctIdx:  number | null;
  sellerAcctIdx: number | null;
  /** Index into accounts[] for the Core NFT asset address, or null. */
  coreAssetIdx: number | null;
  ix: RawInstruction;
  accounts: string[];
}

export function findTammSaleIx(tx: RawSolanaTx): TammMatch | null {
  const accountKeys = tx.transaction.message.accountKeys;

  for (const { ix } of allInstructions(tx)) {
    if (programAt(tx, ix) !== TAMM_PROGRAM) continue;

    const data = decodeIxData(ix.data);
    for (const def of TAMM_SALE_INSTRUCTIONS) {
      if (matchesDisc(data, def.disc)) {
        return {
          kind:            'tamm',
          instructionName: def.name,
          verified:        def.verified,
          direction:       def.direction,
          buyerAcctIdx:    def.buyerAcctIdx,
          sellerAcctIdx:   def.sellerAcctIdx,
          coreAssetIdx:    def.coreAssetIdx,
          ix,
          accounts: ix.accounts.map((i) => accountKeys[i]?.pubkey ?? ''),
        };
      }
    }
  }
  return null;
}

// ─── NFT type classification ──────────────────────────────────────────────────

/**
 * Classify the NFT asset type for a Tensor transaction.
 *
 * Verification status (2026-04-14):
 *   ✅ 'cnft'   — Bubblegum involvement is the reliable cNFT signal.
 *   ✅ 'core'   — MPL Core program involvement confirms Core NFT.
 *   ⚠️ 'legacy' / 'pnft' distinction — not yet verified from live Tensor txs.
 *                 For now all non-cNFT, non-Core trades default to 'legacy'.
 */
export function classifyNftType(tx: RawSolanaTx, _instructionName: string): NftType {
  // cNFT: Bubblegum is invoked by TComp for the actual NFT transfer.
  if (anyProgramInvolved(tx, BUBBLEGUM_PROGRAM)) return 'cnft';

  // Core NFT: MPL Core program handles the asset transfer.
  if (anyProgramInvolved(tx, MPL_CORE_PROGRAM)) return 'core';

  // Standard SPL NFT (legacy or pNFT). pNFT detection via TOKEN_AUTH_RULES
  // is not yet implemented — default to 'legacy' until a live pNFT Tensor tx
  // is observed and the heuristic is confirmed.
  return 'legacy';
}
