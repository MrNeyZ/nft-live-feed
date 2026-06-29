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

const TAG = '[VL-phantom]';

/**
 * Submit a base64-encoded transaction (legacy or versioned).
 *
 * signAndSendTransaction signs AND submits via Phantom's own RPC, returning
 * a signature as soon as the node accepts the tx (not awaiting confirmation).
 * We return immediately — the tx is already on its way. Callers surface the
 * Solscan link so the user can verify the result.
 *
 * We intentionally skip getLatestBlockhash + confirmTransaction here:
 *   - The ME tx has its own embedded blockhash; a freshly-fetched one is wrong
 *   - confirmTransaction uses a WebSocket subscription; the public RPC WSS is
 *     unreliable and hangs indefinitely with no error, causing the UI to freeze
 *
 * Throws on user rejection or send failure.
 */
export async function signSendAndConfirm(
  txBase64: string,
  connection?: Connection,
): Promise<SignSendResult> {
  const sol = getPhantom();
  if (!sol) throw new Error('Phantom wallet not connected.');

  const raw = Buffer.from(txBase64, 'base64');
  let tx: Transaction | VersionedTransaction;
  let txType: 'versioned' | 'legacy';
  try {
    tx = VersionedTransaction.deserialize(raw);
    txType = 'versioned';
  } catch {
    tx = Transaction.from(raw);
    txType = 'legacy';
  }
  console.log(TAG, `deserialized tx type=${txType} byteLen=${raw.length}`);

  console.log(TAG, 'calling signAndSendTransaction...');
  let signature: string;
  try {
    const result = await sol.signAndSendTransaction(tx);
    signature = result.signature;
    console.log(TAG, 'signAndSendTransaction resolved — signature=' + signature);
  } catch (err) {
    console.error(TAG, 'signAndSendTransaction THREW:', (err as Error).message, err);
    throw err;
  }

  // Optional confirmation via WebSocket — only when a Connection is supplied.
  // Omit for MMM/bridge flows: signAndSendTransaction already submitted the tx
  // via Phantom's own RPC; the public RPC WSS hangs indefinitely under rate
  // limits and freezes the UI with no error.
  if (connection) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const conf = await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, 'confirmed');
    if (conf.value.err) {
      throw new Error('Transaction failed on-chain: ' + JSON.stringify(conf.value.err));
    }
    console.log(TAG, 'confirmTransaction resolved OK');
  }

  console.log(TAG, 'signSendAndConfirm complete — signature=' + signature);
  return { signature, txType };
}
