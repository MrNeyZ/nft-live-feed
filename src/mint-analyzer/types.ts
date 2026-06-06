/**
 * Mint Analyzer — shared types.
 *
 * `RawRpcTx` matches the Solana JSON-RPC `getTransaction` response with
 * `encoding: 'json'` (NOT jsonParsed): instruction data is base58, account
 * keys are a flat string[] in `transaction.message.accountKeys`, and ALT
 * keys arrive separately in `meta.loadedAddresses`. Only the fields the
 * analyzer reads are typed.
 */

export interface RawRpcInstruction {
  programIdIndex: number;
  accounts: number[];
  /** base58-encoded; first bytes are the instruction discriminator */
  data: string;
}

export interface RawRpcTx {
  blockTime: number | null;
  slot: number;
  transaction: {
    signatures: string[];
    message: {
      /** string[] for encoding:'json'; objects for jsonParsed/merged inputs */
      accountKeys: Array<string | { pubkey: string }>;
      header: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      };
      instructions: RawRpcInstruction[];
    };
  };
  meta: {
    err: unknown | null;
    fee?: number;
    computeUnitsConsumed?: number;
    innerInstructions?: Array<{ index: number; instructions: RawRpcInstruction[] }>;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    logMessages?: string[];
  } | null;
}

export type MintPrimitive =
  | 'candy_machine_v3_mintv2'
  | 'mpl_core_create_v2'
  | 'token_metadata_mint'
  | 'bubblegum_mint'
  | 'unknown';

export type SignerClass =
  | 'fee_payer'
  | 'user'
  | 'known_platform_signer'
  | 'unknown_program_signer';

export type Verdict =
  | 'direct_mint_likely_reconstructable'
  | 'possible_requires_extra_inputs'
  | 'blocked_server_captcha_signature'
  | 'custom_program_manual_re_required';

export interface ProgramCall {
  programId: string;
  /** null when the program is not in the analyzer registry */
  name: string | null;
  /** outer + inner invocations of this program in the tx */
  invocationCount: number;
}

export interface DecodedInstruction {
  /** 'outer[i]' or 'inner[outerIdx][j]' */
  path: string;
  programId: string;
  programName: string | null;
  /** hex of the leading 8 bytes (or fewer if the data is shorter) */
  discriminatorHex: string;
  /** human instruction name when known, else null */
  instructionName: string | null;
}

/** Read-only "Mint Requirements / Flow Clues" — additive, never feeds the
 *  verdict. Surfaces on-chain gate signals (burns/transfers before the mint,
 *  candy-machine / core-create involvement) that the primitive/wrapper/verdict
 *  triad alone doesn't expose. Purely descriptive heuristics. */
export type FlowGateType =
  | 'nft_burn_gate'
  | 'spl_token_burn_gate'
  | 'nft_transfer_gate'
  | 'spl_token_transfer_gate'
  | 'candy_machine_v3'
  | 'mpl_core_create'
  | 'token_metadata_create'
  | 'unknown_custom_gate'
  // Server-gated (MintX-style) Core Candy Guard mints — see analyze.ts:
  //   server_signature_gate        — mint needs a backend/AddressGate co-signature
  //   off_chain_token_transfer_gate — a token transfer the candy guard does NOT
  //                                   enforce on-chain; the backend signer gates it
  //   soft_transfer_not_burn        — the gate token is moved to a treasury, not burned
  | 'server_signature_gate'
  | 'off_chain_token_transfer_gate'
  | 'soft_transfer_not_burn';

export interface FlowGate {
  type: FlowGateType;
  confidence: 'high' | 'medium' | 'low';
  assetName?: string;
  mint?: string;
  amount?: string;
  owner?: string;
  programId?: string;
  /** backend/server co-signers, for server_signature_gate */
  signers?: string[];
  /** false when a token movement is NOT enforced by an on-chain guard */
  enforcedOnChain?: boolean;
  evidence: string[];
}

export interface BurnedAsset      { name?: string; mint?: string; amount?: string; owner?: string; }
export interface TransferredAsset { name?: string; mint?: string; amount?: string; from?: string; to?: string; }

export interface FlowClues {
  detectedGates: FlowGate[];
  burnedAssets: BurnedAsset[];
  transferredAssets: TransferredAsset[];
  /** ordered, human-readable mint flow, e.g. ["Burn SagaPass", "Candy Machine V3", "MPL Core CreateV2"] */
  mintFlow: string[];
  notes: string[];
}

export interface ClassifiedSigner {
  address: string;
  class: SignerClass;
  /** extra context, e.g. "vvv.so platform signer" */
  label?: string;
}

export interface MintAnalysis {
  signature: string;
  status: 'success' | 'failed';
  slot: number;
  /** ISO-8601 string, or null if the RPC omitted blockTime */
  blockTime: string | null;
  fee: number | null;
  computeUnitsConsumed: number | null;

  programs: ProgramCall[];
  instructions: DecodedInstruction[];

  likelyMintPrimitive: MintPrimitive;
  /** set when an opaque (non-registry) program fronts the mint primitive */
  customWrapper: { programId: string; name: string | null } | null;
  /** set when a recognised launchpad program fronts the mint */
  knownLaunchpad: { programId: string; name: string | null } | null;

  signers: ClassifiedSigner[];
  /** true if any required signer is a known platform/backend co-signer */
  backendSignerObserved: boolean;

  guardAuth: {
    candyGuard: boolean;
    notes: string[];
  };

  verdict: Verdict;
  verdictReasons: string[];

  /** Additive, read-only mint-requirement clues. Never influences `verdict`. */
  flowClues: FlowClues;
}
