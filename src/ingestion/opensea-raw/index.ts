/**
 * OpenSea (OS2) raw parser — public API.
 *
 * Verified coverage (2026-09-01): buyCore ✅  buyLegacy ✅
 * buyCoreSpl / takeBidLegacy ⚠️ unverified (only near-zero test examples so far).
 */
export { parseRawOpenseaTransaction } from './parser';
export type { ParseResult } from './parser';
export type { RawSolanaTx } from './types';
export { ingestOpenseaRaw } from './ingest';
export { OPENSEA_PROGRAM, OPENSEA_PROGRAMS, OPENSEA_SALE_INSTRUCTIONS } from './programs';
