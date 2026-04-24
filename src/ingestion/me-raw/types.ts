/**
 * Minimal types matching the Solana JSON RPC `getTransaction` response.
 * Encoding: "json" (not "jsonParsed") — instruction data arrives as base58.
 *
 * Only fields used by the ME raw parser are included.
 * Reference: https://docs.solana.com/api/http#gettransaction
 */

export interface RawAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

/** A single instruction as returned by the raw (non-jsonParsed) RPC format. */
export interface RawInstruction {
  /** Index into transaction.message.accountKeys */
  programIdIndex: number;
  /** Indices into transaction.message.accountKeys */
  accounts: number[];
  /** Base58-encoded instruction data. First 8 bytes = Anchor discriminator. */
  data: string;
}

export interface RawInnerInstructionGroup {
  /** Index of the outer instruction this group belongs to */
  index: number;
  instructions: RawInstruction[];
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: {
    amount: string;       // e.g. "1" or "0" for NFTs
    decimals: number;
    uiAmount: number | null;
  };
  owner?: string;         // token account owner (present when fetchedWith commitment)
}

/**
 * Address Lookup Table (ALT) resolution for versioned (v0) transactions.
 * When `encoding: json` is used, the RPC returns only static keys in
 * `transaction.message.accountKeys` and appends ALT-loaded keys here.
 * Combined index order is `[...accountKeys, ...writable, ...readonly]`.
 */
export interface LoadedAddresses {
  writable: string[];
  readonly: string[];
}

export interface RawTransactionMeta {
  err: unknown | null;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: RawTokenBalance[];
  postTokenBalances: RawTokenBalance[];
  innerInstructions: RawInnerInstructionGroup[];
  logMessages?: string[];
  /** Present on versioned transactions; absent on legacy txs. */
  loadedAddresses?: LoadedAddresses;
}

export interface RawSolanaTx {
  /** The primary transaction signature */
  signature: string;
  /** Unix timestamp (seconds). null if not yet confirmed. */
  blockTime: number | null;
  slot: number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: RawAccountKey[];
      instructions: RawInstruction[];
    };
  };
  meta: RawTransactionMeta | null;
}

/**
 * Resolve an account index to its pubkey, transparently falling back to
 * `meta.loadedAddresses` for ALT-loaded accounts on versioned transactions.
 *
 * The primary ingestion path (`fetchRawTx`) already merges loadedAddresses
 * into `accountKeys` before the parser runs — in that case this helper just
 * reads from the array directly. The fallback only kicks in for callers that
 * pass an un-merged RPC response (e.g. tests, or any future code path that
 * bypasses `fetchRawTx`).
 *
 * Returns '' when the index cannot be resolved.
 */
export function resolveAccountKey(tx: RawSolanaTx, idx: number): string {
  // NB: after fetchRawTx's merge, entries are objects with .pubkey.
  // Before merge (raw `encoding: json` response), entries are plain strings.
  const keys = tx.transaction.message.accountKeys as unknown as Array<string | RawAccountKey | undefined>;
  const k = keys[idx];
  if (typeof k === 'string') return k;
  if (k && typeof k === 'object' && k.pubkey) return k.pubkey;

  // Fallback: un-merged versioned tx — compute into loadedAddresses.
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return '';
  const staticLen = keys.length;
  const w = loaded.writable ?? [];
  const r = loaded.readonly ?? [];
  const wOff = idx - staticLen;
  if (wOff >= 0 && wOff < w.length) return w[wOff];
  const rOff = wOff - w.length;
  if (rOff >= 0 && rOff < r.length) return r[rOff];
  return '';
}
