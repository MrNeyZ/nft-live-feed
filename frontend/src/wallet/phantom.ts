// Minimal Phantom wallet binding for the Collection page Buy button.
// Phantom (and most other wallets) inject a provider on `window.solana` that
// implements the Solana Wallet Adapter standard's connect / signTransaction /
// signAndSendTransaction methods. We type just what we use — no adapter SDK.

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { authHeaders } from '@/runtime/auth';

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAndSendTransaction<T extends Transaction | VersionedTransaction>(tx: T, opts?: { skipPreflight?: boolean; preflightCommitment?: string; maxRetries?: number }): Promise<{ signature: string }>;
}

/** Send a serialized transaction via our backend proxy (avoids browser→public RPC 403). */
async function backendSendRaw(serialized: Uint8Array): Promise<string> {
  const txBase64 = Buffer.from(serialized).toString('base64');
  const r = await fetch('/api/tools/mmm-pools/send-tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ tx: txBase64 }),
  });
  const j = await r.json() as { ok: boolean; signature?: string; message?: string };
  if (!j.ok || !j.signature) throw new Error(j.message ?? `send-tx HTTP ${r.status}`);
  return j.signature;
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

  // For versioned transactions (e.g. SolMip1FulfillBuy with ME cosigner pre-signed),
  // signAndSendTransaction rejects partially-signed txs with "Unexpected error".
  // Use signTransaction + sendRawTransaction(skipPreflight) instead — same flow ME UI uses.
  // Diagnostic: log signer info for versioned txs
  if (txType === 'versioned') {
    const vtx = tx as VersionedTransaction;
    const myKey = sol.publicKey?.toBase58() ?? '(no key)';
    const staticKeys = vtx.message.staticAccountKeys.map(k => k.toBase58());
    const numReqSig = vtx.message.header.numRequiredSignatures;
    const signerKeys = staticKeys.slice(0, numReqSig);
    const sigs = vtx.signatures.map(s => s.every(b => b === 0) ? 'EMPTY' : 'FILLED');
    console.log(TAG, 'versioned tx diagnostics', {
      myWallet: myKey,
      numRequiredSignatures: numReqSig,
      signerKeys,
      mySlot: signerKeys.indexOf(myKey),
      signatureSlots: sigs,
      allFilled: vtx.signatures.every(s => s.some(b => b !== 0)),
    });
  }

  console.log(TAG, txType === 'versioned' ? 'calling signTransaction (versioned)...' : 'calling signAndSendTransaction...');
  let signature: string;
  try {
    if (txType === 'versioned') {
      const vtx = tx as VersionedTransaction;
      const myKey = sol.publicKey?.toBase58() ?? '';
      const numReqSig = vtx.message.header.numRequiredSignatures;
      const signerKeys = vtx.message.staticAccountKeys.slice(0, numReqSig).map(k => k.toBase58());
      const mySlot = signerKeys.indexOf(myKey);
      const allFilled = vtx.signatures.every(s => s.some(b => b !== 0));
      // Only throw if a NON-user slot is empty (ME didn't cosign). Our own slot is expected empty.
      const coSignersMissing = vtx.signatures.some((s, i) => i !== mySlot && s.every(b => b === 0));
      if (allFilled) {
        console.log(TAG, 'tx fully pre-signed — sending raw via backend proxy');
        signature = await backendSendRaw(vtx.serialize());
      } else if (coSignersMissing) {
        console.error(TAG, 'ME cosigner slot empty (mySlot=' + mySlot + ', numReqSig=' + numReqSig + ')');
        throw new Error('ME did not co-sign — pool is likely underfunded. Check escrow balance and try again.');
      } else {
        const signed = await sol.signTransaction(vtx);
        const serialized = (signed as VersionedTransaction).serialize();
        console.log(TAG, 'signTransaction resolved — sending raw tx via backend proxy...');
        signature = await backendSendRaw(serialized);
      }
    } else {
      const result = await sol.signAndSendTransaction(tx, { skipPreflight: true });
      signature = result.signature;
    }
    console.log(TAG, 'send resolved — signature=' + signature);
  } catch (err) {
    console.error(TAG, 'sign/send THREW:', (err as Error).message, err);
    throw err;
  }

  console.log(TAG, 'signSendAndConfirm complete — signature=' + signature);
  return { signature, txType };
}
