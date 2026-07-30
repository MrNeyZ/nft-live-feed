/**
 * Candy Mint tool — pre-sign cost simulation.
 *
 * Phantom won't show a balance-change preview for an unverified dApp, so
 * this replaces it: simulate the exact built transaction server-side
 * (sigVerify off — we don't have the wallet's real signature yet) and diff
 * the wallet's lamports before/after. Also flags Candy Guard's bot-tax
 * fallback in the logs — the failure mode that silently drains SOL with no
 * program error and no minted asset (see build.ts's resolveMintArgs).
 */

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

const BOT_TAX_RE = /bot(ting)?\s*(is\s*)?tax/i;

export type SimulateCandyMintResult =
  | {
      ok: true;
      solDeltaLamports: number | null;
      botTaxDetected: boolean;
      unitsConsumed: number | null;
      logs: string[];
    }
  | { ok: false; error: string; logs?: string[] };

export async function simulateCandyMintTx(
  transactionBase64: string,
  wallet: string,
): Promise<SimulateCandyMintResult> {
  const rpc = rpcUrl();

  const balanceRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getBalance', params: [wallet, { commitment: 'confirmed' }],
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
          accounts: { encoding: 'base64', addresses: [wallet] },
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
  const botTaxDetected = logs.some((l) => BOT_TAX_RE.test(l));

  if (value.err) {
    return { ok: false, error: JSON.stringify(value.err), logs };
  }

  const afterLamports = value.accounts?.[0]?.lamports ?? null;
  const solDeltaLamports = afterLamports != null && beforeLamports != null
    ? afterLamports - beforeLamports
    : null;

  return {
    ok: true,
    solDeltaLamports,
    botTaxDetected,
    unitsConsumed: value.unitsConsumed ?? null,
    logs,
  };
}
