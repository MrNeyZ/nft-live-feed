/**
 * TCOMP Anchor error code → human-readable message.
 *
 * `simulateTransaction`'s `err` field comes back as a raw
 * `{"InstructionError":[ixIndex,{"Custom":6008}]}` blob — no message, no
 * program name. Diagnosing a real failure meant hand-decoding this every
 * time (see the tensor-take-bid investigation history). Table pulled
 * directly from `@tensor-oss/tcomp-sdk`'s bundled IDL (`errors` array).
 *
 * `whitelist_v2.rs`-specific codes worth calling out explicitly:
 *   6008  FailedMerkleProofVerification — the seller's asset has no
 *         registered `MintProofV2` account for this collection's
 *         whitelist. NOT a dead bid (confirmed live third-party fills
 *         going through on the same bidState while this specific mint
 *         fails) — Tensor's own merkle whitelist simply never indexed a
 *         proof for this particular mint. `WhitelistV2` / `MintProofV2`
 *         are undocumented in the public SDK (discriminators confirmed
 *         by brute-forcing `sha256("account:<Name>")` against the raw
 *         on-chain bytes) — self-serve proof generation isn't supported
 *         here yet.
 *   6132  BadCosigner — the bid's `cosigner` field is a REAL (non-
 *         SystemProgram-sentinel) pubkey the seller doesn't control.
 *         Distinct from the SystemProgram-sentinel case this tool already
 *         substitutes the seller for — some bids (observed: repeated
 *         across many collections from the same bidder/cosigner pair)
 *         are placed through a bidding bot that must co-sign every fill.
 *         Those fills are genuinely unfillable without that bot.
 */
export const TCOMP_ERRORS: Readonly<Record<number, string>> = {
  6100: 'arithmetic error',
  6101: 'expiry too large',
  6102: 'bad owner',
  6103: 'bad list state',
  6104: 'royalties pct must be between 0 and 100',
  6105: 'price mismatch — bid amount or royalty shifted since read',
  6106: 'creator mismatch',
  6107: 'insufficient balance in bid escrow',
  6108: 'bid has expired',
  6109: 'taker not allowed (private bid targets a different wallet)',
  6110: 'cannot pass bid field',
  6111: 'bid not yet expired',
  6112: 'bad margin account',
  6113: 'wrong instruction for this bid target type',
  6114: 'wrong target id',
  6115: 'creator array missing first verified creator',
  6116: 'metadata missing collection',
  6117: 'cannot modify bid target — bid would need to be re-created',
  6118: 'target id and bid id must be the same for single-asset bids',
  6119: 'currency not yet enabled',
  6120: 'maker broker not yet enabled',
  6121: 'optional royalties not yet enabled',
  6122: 'wrong state version',
  6123: 'wrong bid field id',
  6124: 'broker mismatch',
  6125: 'asset id mismatch',
  6126: 'listing has expired',
  6127: 'listing not yet expired',
  6128: 'bad quantity passed in',
  6129: 'bid is fully filled',
  6130: 'bad whitelist',
  6131: 'forbidden collection',
  6132: 'bad cosigner — bid requires a signature this wallet cannot produce',
  6133: 'bad mint proof',
  6134: 'currency mismatch',
  6135: 'bid balance was not emptied',
  6136: 'bad rent destination',
  6137: 'currency not yet whitelisted',
  6138: 'maker broker not yet whitelisted',
  6139: 'token record derivation is wrong',
  // whitelist_v2.rs — undocumented in the public tcomp IDL error table;
  // observed directly via simulation logs (`AnchorError ... Error Code:
  // FailedMerkleProofVerification. Error Number: 6008.`).
  6008: 'failed merkle proof verification — this mint has no registered proof for the collection\'s whitelist (Tensor indexing gap, not a dead bid)',
};

/** Extract the Anchor `Custom` error code from a simulate `err` value —
 *  either the raw object (`{InstructionError:[ix,{Custom:code}]}`) or its
 *  JSON-stringified form (what `simulateTakeBidTx` / `buildTakeBidTx`
 *  currently pass around). Returns null for any other shape (real
 *  RPC/network error, non-Custom instruction error, etc). */
export function extractCustomErrorCode(err: unknown): number | null {
  let obj: unknown = err;
  if (typeof err === 'string') {
    try { obj = JSON.parse(err); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const ie = (obj as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return null;
  const custom = (ie[1] as { Custom?: unknown } | undefined)?.Custom;
  return typeof custom === 'number' ? custom : null;
}

/** Human-readable diagnosis for a simulate `err` value — the TCOMP error
 *  message when recognized, else null (caller falls back to the raw
 *  error string). */
export function describeTcompError(err: unknown): string | null {
  const code = extractCustomErrorCode(err);
  if (code == null) return null;
  const msg = TCOMP_ERRORS[code];
  return msg ? `TCOMP error ${code}: ${msg}` : `TCOMP error ${code} (unrecognized)`;
}
