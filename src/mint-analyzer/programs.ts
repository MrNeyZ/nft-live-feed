/**
 * Mint Analyzer — program registry + instruction-name catalog.
 *
 * Single source of truth for the program IDs and platform signers is the
 * ingestion-side detector (`src/ingestion/mint-raw/launchpad-detector.ts`).
 * We IMPORT those constants here rather than re-hardcoding them so the
 * analyzer never drifts from the detector that classifies the same mints on
 * the live path. This module is pure data + pure helpers: no network, no DB,
 * no side effects at import — safe to pull into a request handler or a test.
 */
import { createHash } from 'crypto';
import {
  LAUNCHMYNFT_PROGRAM,
  MPL_CORE_PROGRAM,
  BUBBLEGUM_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  GRAVEMINT_PROGRAM,
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_V3_PROGRAM,
  VVVSO_PLATFORM_SIGNER,
  VVVSO_PLATFORM_TREASURY,
  GRAVEMINT_PLATFORM_SIGNER,
} from '../ingestion/mint-raw/launchpad-detector';

// Re-export the imported primitive program IDs so the rest of the analyzer
// imports every program constant from this single module.
export {
  LAUNCHMYNFT_PROGRAM,
  MPL_CORE_PROGRAM,
  BUBBLEGUM_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  GRAVEMINT_PROGRAM,
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_V3_PROGRAM,
};

// MPL Core Candy Machine + Candy Guard. Defined privately inside the
// core-v2 detector (not exported there); restated here as the analyzer's
// own knowledge. Distinct from the legacy Token-Metadata candy machine.
export const CORE_CANDY_MACHINE_PROGRAM = 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J';
export const CORE_CANDY_GUARD_PROGRAM   = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';

// Common system-level programs — named so the analyzer can label them and
// exclude ComputeBudget when picking the transaction's entry instruction.
export const SYSTEM_PROGRAM         = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SPL_TOKEN_PROGRAM      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM     = 'TokenzQdBNbLqP5VEUNnHNEoA1YtbRuVvYr7fXMxHEy';
export const ASSOC_TOKEN_PROGRAM    = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export type ProgramKind =
  | 'candy_guard'
  | 'candy_machine'
  | 'core_candy_guard'
  | 'core_candy_machine'
  | 'mpl_core'
  | 'token_metadata'
  | 'bubblegum'
  | 'launchpad_wrapper'
  | 'system'
  | 'token'
  | 'unknown';

interface ProgramInfo { name: string; kind: ProgramKind; }

/** Curated registry of programs the analyzer can name. Anything absent is
 *  reported with `name: null` and treated as a potential custom wrapper. */
export const PROGRAM_REGISTRY: Readonly<Record<string, ProgramInfo>> = {
  [CANDY_GUARD_PROGRAM]:        { name: 'Candy Guard',        kind: 'candy_guard'        },
  [CANDY_MACHINE_V3_PROGRAM]:   { name: 'Candy Machine v3',   kind: 'candy_machine'      },
  [CORE_CANDY_GUARD_PROGRAM]:   { name: 'Core Candy Guard',   kind: 'core_candy_guard'   },
  [CORE_CANDY_MACHINE_PROGRAM]: { name: 'Core Candy Machine', kind: 'core_candy_machine' },
  [MPL_CORE_PROGRAM]:           { name: 'MPL Core',           kind: 'mpl_core'           },
  [TOKEN_METADATA_PROGRAM]:     { name: 'Token Metadata',     kind: 'token_metadata'     },
  [BUBBLEGUM_PROGRAM]:          { name: 'Bubblegum',          kind: 'bubblegum'          },
  [LAUNCHMYNFT_PROGRAM]:        { name: 'LaunchMyNFT',        kind: 'launchpad_wrapper'  },
  [GRAVEMINT_PROGRAM]:          { name: 'Gravemint',          kind: 'launchpad_wrapper'  },
  [SYSTEM_PROGRAM]:             { name: 'System',             kind: 'system'             },
  [COMPUTE_BUDGET_PROGRAM]:     { name: 'ComputeBudget',      kind: 'system'             },
  [SPL_TOKEN_PROGRAM]:          { name: 'SPL Token',          kind: 'token'              },
  [TOKEN_2022_PROGRAM]:         { name: 'SPL Token-2022',     kind: 'token'              },
  [ASSOC_TOKEN_PROGRAM]:        { name: 'Associated Token',   kind: 'token'              },
};

/** Programs that ARE the mint primitive / a recognised Metaplex standard.
 *  When the transaction's entry instruction is one of these, the mint is a
 *  direct standard mint — there is no opaque wrapper in front of it. */
export const PRIMITIVE_PROGRAM_IDS: ReadonlySet<string> = new Set([
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_V3_PROGRAM,
  CORE_CANDY_GUARD_PROGRAM,
  CORE_CANDY_MACHINE_PROGRAM,
  MPL_CORE_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  BUBBLEGUM_PROGRAM,
]);

/** Known launchpad wrapper programs: not a raw primitive, but a documented
 *  launchpad whose inner mint we can in principle reconstruct given the
 *  launchpad's config inputs. */
export const KNOWN_LAUNCHPAD_IDS: ReadonlySet<string> = new Set([
  LAUNCHMYNFT_PROGRAM,
  GRAVEMINT_PROGRAM,
]);

/** Platform / backend co-signers observed on launchpad mints. A transaction
 *  signed by one of these is server-gated — reconstructing the mint requires
 *  an off-chain signature we cannot produce. */
export const KNOWN_PLATFORM_SIGNERS: Readonly<Record<string, string>> = {
  [VVVSO_PLATFORM_SIGNER]:     'vvv.so platform signer',
  [GRAVEMINT_PLATFORM_SIGNER]: 'gravemint.io platform signer',
};

/** Diagnostic-only platform treasuries (writable non-signers). Surfaced as a
 *  label hint when present, never as a signer classification. */
export const KNOWN_PLATFORM_ACCOUNTS: Readonly<Record<string, string>> = {
  [VVVSO_PLATFORM_TREASURY]: 'vvv.so treasury',
};

/** 8-byte Anchor instruction discriminator: sha256("global:<name>")[0..8].
 *  Mirrors `anchorDisc` in `src/ingestion/me-raw/programs.ts`. */
export function anchorDisc(instructionName: string): string {
  return createHash('sha256').update(`global:${instructionName}`).digest().subarray(0, 8).toString('hex');
}

// Anchor discriminators for the mint instructions we recognise. Candy Guard
// and Candy Machine v3 both dispatch `mintV2` (confirmed against fixture tx1:
// disc 78791792ad6ec7cd on both the Guard outer ix and the CM v3 inner CPI).
const CANDY_MINT_V2_DISC = anchorDisc('mint_v2'); // 78791792ad6ec7cd

const ANCHOR_IX_BY_PROGRAM: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [CANDY_GUARD_PROGRAM]:      { [CANDY_MINT_V2_DISC]: 'mintV2' },
  [CANDY_MACHINE_V3_PROGRAM]: { [CANDY_MINT_V2_DISC]: 'mintV2' },
};

// MPL Core dispatches by a single leading byte (see mpl-core IDL): the
// analyzer only needs the asset-creating variants.
const MPL_CORE_IX_BY_BYTE0: Readonly<Record<number, string>> = {
  0:  'Create',
  20: 'CreateV2',
};

export function programName(programId: string): string | null {
  return PROGRAM_REGISTRY[programId]?.name ?? null;
}

export function programKind(programId: string): ProgramKind {
  return PROGRAM_REGISTRY[programId]?.kind ?? 'unknown';
}

/**
 * Best-effort human instruction name from the program + decoded data bytes.
 * Returns null when the instruction layout is unknown (e.g. custom wrapper
 * programs) — the discriminator is still reported alongside.
 */
export function instructionName(programId: string, data: Buffer): string | null {
  if (data.length === 0) return null;
  if (programId === MPL_CORE_PROGRAM) {
    return MPL_CORE_IX_BY_BYTE0[data[0]] ?? null;
  }
  const disc8 = data.subarray(0, 8).toString('hex');
  return ANCHOR_IX_BY_PROGRAM[programId]?.[disc8] ?? null;
}
