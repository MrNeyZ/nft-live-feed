/**
 * Types for the Tensor raw parser.
 *
 * The raw Solana `getTransaction` format is identical across all programs —
 * re-export from me-raw rather than duplicating.
 */
export type {
  RawSolanaTx,
  RawInstruction,
  RawInnerInstructionGroup,
  RawTokenBalance,
  RawTransactionMeta,
  RawAccountKey,
} from '../me-raw/types';
