/**
 * Mint Analyzer — read-only transaction fetch.
 *
 * Thin wrapper over Helius `getTransaction` (encoding:'json'), mirroring the
 * RPC shape used across ingestion (`amm-poller`, `me-raw/inspect-sigs`). This
 * is the ONLY network call in the analyzer and it is strictly read-only — no
 * signing, no sending, no account writes.
 */
import type { RawRpcTx } from './types';

/** base58 alphabet; Solana signatures are 64-byte → 87–88 base58 chars. */
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function isValidSignature(sig: string): boolean {
  return typeof sig === 'string' && SIG_RE.test(sig.trim());
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/**
 * Fetch a confirmed transaction by signature. Returns null when the RPC has
 * no record of it (unknown / dropped / not-yet-confirmed). Throws on a
 * transport/RPC error so the route can answer 502 vs 404 distinctly.
 */
export async function fetchTransaction(signature: string): Promise<RawRpcTx | null> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!res.ok) throw new Error(`getTransaction RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: RawRpcTx | null; error?: { message?: string } };
  if (body.error) throw new Error(`getTransaction RPC error: ${body.error.message ?? 'unknown'}`);
  return body.result ?? null;
}
