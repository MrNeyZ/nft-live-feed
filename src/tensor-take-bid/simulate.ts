/**
 * Tensor take-bid tool — pre-sign proceeds simulation.
 *
 * `bidInfo.amountSOL` (build.ts) is the bid's gross price, before whatever
 * marketplace fee / royalty the instruction routes to other accounts —
 * not necessarily what actually lands in the seller's wallet. Phantom also
 * won't show a balance-change preview for an unverified dApp. Simulate the
 * exact built transaction server-side (sigVerify off — we don't have the
 * wallet's real signature yet) and diff the seller's lamports before/after
 * so the UI can show the true net SOL received before asking for a
 * signature. Same technique as candy-mint/simulate.ts.
 */

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export type SimulateTakeBidResult =
  | { ok: true; solDeltaLamports: number | null; unitsConsumed: number | null; logs: string[] }
  | { ok: false; error: string; logs?: string[] };

export async function simulateTakeBidTx(
  transactionBase64: string,
  seller: string,
): Promise<SimulateTakeBidResult> {
  const rpc = rpcUrl();

  const balanceRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getBalance', params: [seller, { commitment: 'confirmed' }],
    }),
  });
  const balanceJson = await balanceRes.json() as { result?: { value?: number } };
  const beforeLamports = balanceJson.result?.value ?? null;

  const simRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [
        transactionBase64,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'processed',
          maxSupportedTransactionVersion: 0,
          accounts: { encoding: 'base64', addresses: [seller] },
        },
      ],
    }),
  });
  const simJson = await simRes.json() as {
    result?: {
      value?: {
        err?: unknown;
        logs?: string[];
        unitsConsumed?: number;
        accounts?: Array<{ lamports: number } | null>;
      };
    };
    error?: { message?: string };
  };

  const value = simJson.result?.value;
  if (!value) return { ok: false, error: simJson.error?.message ?? 'simulate_rpc_failed' };

  const logs = value.logs ?? [];
  if (value.err) return { ok: false, error: JSON.stringify(value.err), logs };

  const afterLamports = value.accounts?.[0]?.lamports ?? null;
  const solDeltaLamports = afterLamports != null && beforeLamports != null
    ? afterLamports - beforeLamports
    : null;

  return { ok: true, solDeltaLamports, unitsConsumed: value.unitsConsumed ?? null, logs };
}
