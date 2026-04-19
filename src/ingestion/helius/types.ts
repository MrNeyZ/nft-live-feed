/**
 * Minimal Helius enhanced transaction types we care about.
 * Full spec: https://docs.helius.dev/solana-apis/enhanced-transactions-api
 */

export type HeliusTransactionType =
  | 'NFT_SALE'
  | 'COMPRESSED_NFT_SALE'
  | string;

export type HeliusSource =
  | 'MAGIC_EDEN'
  | 'TENSOR'
  | 'FORM_FUNCTION'
  | 'EXCHANGE_ART'
  | 'HYPERSPACE'
  | 'SOLANART'
  | string;

export interface HeliusNftEvent {
  description: string;
  type: HeliusTransactionType;
  source: HeliusSource;
  amount: number;          // lamports
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;       // unix seconds
  saleType: string;        // 'AUCTION' | 'INSTANT_SALE' | 'AMM' | ...
  buyer: string;
  seller: string;
  staker: string;
  nfts: HeliusNftItem[];
}

export interface HeliusNftItem {
  mint: string;
  tokenStandard: string;   // 'NonFungible' | 'ProgrammableNonFungible' | 'Compressed' | ...
}

export interface HeliusEnhancedTransaction {
  description: string;
  type: HeliusTransactionType;
  source: HeliusSource;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: unknown[];
  tokenTransfers: unknown[];
  accountData: unknown[];
  transactionError: unknown | null;
  instructions: HeliusInstruction[];
  events: {
    nft?: HeliusNftEvent;
    [key: string]: unknown;
  };
}

export interface HeliusInstruction {
  accounts: string[];
  data: string;
  programId: string;
  innerInstructions: HeliusInstruction[];
}
