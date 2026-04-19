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

export interface RawTransactionMeta {
  err: unknown | null;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: RawTokenBalance[];
  postTokenBalances: RawTokenBalance[];
  innerInstructions: RawInnerInstructionGroup[];
  logMessages?: string[];
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
