/**
 * Tensor raw parser — public API.
 *
 * ⚠️ NOT PRODUCTION READY — do not import from the live ingestion pipeline
 *    until wired through an ingest.ts module.
 *
 * Verified coverage (2026-04-14):
 *   TComp buy (Core) ✅  TComp takeBid (Core) ✅
 *   TAMM sell (Core) ✅  TAMM buy (Core) ✅
 */
export { parseRawTensorTransaction } from './parser';
export type { ParseResult } from './parser';
export type { RawSolanaTx } from './types';
export { TCOMP_PROGRAM, TAMM_PROGRAM, TENSOR_PROGRAMS } from './programs';
