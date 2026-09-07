/**
 * Candy Mint tool — current on-chain block height.
 *
 * Feeds the frontend batch-mint post-sign blockhash-headroom guard (see
 * handleMintBatch in page.tsx): after the single signAllTransactions
 * approval, one call here tells the send loop whether each rebuilt tx's
 * own lastValidBlockHeight (already returned by /build-tx) still has
 * enough margin before broadcasting it. One cheap RPC call, no caching —
 * the entire point is a fresh number at the moment it's asked for.
 */
function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export async function getCurrentBlockHeight(): Promise<number> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'cm-height', method: 'getBlockHeight', params: [{ commitment: 'confirmed' }],
    }),
  });
  const body = await res.json() as { result?: number; error?: { message?: string } };
  if (typeof body.result !== 'number') throw new Error(body.error?.message ?? 'getBlockHeight failed');
  return body.result;
}
