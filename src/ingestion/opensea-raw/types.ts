/**
 * OpenSea (OS2) raw parser types.
 *
 * Reuses the shared RawSolanaTx shape (same RPC encoding / versioned-tx
 * loadedAddresses expansion as ME / Tensor / Orbis) — no OpenSea-specific tx
 * fields.
 */
export type { RawSolanaTx } from '../me-raw/types';
