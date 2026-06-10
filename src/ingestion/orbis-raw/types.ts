/**
 * Orbis raw parser types.
 *
 * Reuses the shared RawSolanaTx shape (same RPC encoding / versioned-tx
 * loadedAddresses expansion as ME / Tensor) — no Orbis-specific tx fields.
 */
export type { RawSolanaTx } from '../me-raw/types';
