// Minimal Phantom wallet binding for the Collection page Buy button.
// Phantom (and most other wallets) inject a provider on `window.solana` that
// implements the Solana Wallet Adapter standard's connect / signTransaction /
// signAndSendTransaction methods. We type just what we use — no adapter SDK.

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAndSendTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<{ signature: string }>;
}

declare global {
  interface Window { solana?: PhantomProvider }
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const sol = window.solana;
  return sol?.isPhantom ? sol : null;
}

/** Connect to Phantom; resolves with the public key as a base58 string. */
export async function connectPhantom(): Promise<string> {
  const sol = getPhantom();
  if (!sol) throw new Error('Phantom wallet not found. Install the Phantom extension.');
  const { publicKey } = await sol.connect();
  return publicKey.toBase58();
}

/** Already-connected pubkey if Phantom remembers a trusted session. Null otherwise. */
export async function eagerConnectPhantom(): Promise<string | null> {
  const sol = getPhantom();
  if (!sol) return null;
  try {
    const { publicKey } = await sol.connect({ onlyIfTrusted: true });
    return publicKey.toBase58();
  } catch {
    return null;
  }
}

export interface SignSendResult {
  signature: string;
  txType:    'versioned' | 'legacy';
}

/**
 * Submit a base64-encoded transaction (legacy or versioned). Phantom signs
 * and submits via its own RPC; we then poll our chosen `Connection` for
 * confirmation so the result reflects the cluster the rest of the app reads.
 *
 * Throws on user rejection, send failure, or confirmation timeout.
 * Returns `{ signature, txType }` so callers can include the deserialized
 * shape in their post-buy logs.
 */
export async function signSendAndConfirm(
  txBase64: string,
  connection: Connection,
): Promise<SignSendResult> {
  const sol = getPhantom();
  if (!sol) throw new Error('Phantom wallet not connected.');

  const raw = Buffer.from(txBase64, 'base64');
  // Try versioned first (current ME format); fall back to legacy.
  let tx: Transaction | VersionedTransaction;
  let txType: 'versioned' | 'legacy';
  try {
    tx = VersionedTransaction.deserialize(raw);
    txType = 'versioned';
  } catch {
    tx = Transaction.from(raw);
    txType = 'legacy';
  }

  const { signature } = await sol.signAndSendTransaction(tx);

  // Confirm against the same RPC the rest of the app uses (so balance/UI
  // reads agree). 60 s should comfortably cover one or two block-time retries.
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed');

  return { signature, txType };
}
