/**
 * Candy Mint tool — SPL mint decimals lookup for tokenPayment / token2022Payment
 * guards.
 *
 * The Candy Guard's tokenPayment struct carries only { mint, amount,
 * destinationAta } — the raw on-chain integer amount, no decimals. To show a
 * human price the tool needs the mint's `decimals`, which isn't anywhere in
 * guard state. `getTokenSupply` returns it in one cheap RPC call and works
 * identically for classic SPL Token and Token-2022 mints (the RPC resolves
 * the mint's owner program itself).
 *
 * Process-lifetime cache keyed by mint — decimals are immutable, so a hit is
 * permanent. Failures are NOT cached (transient RPC blips shouldn't poison a
 * mint forever); the caller treats null as "unresolved" and shows the raw
 * integer, which is still truthful.
 */

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

const cache = new Map<string, number>();

export async function getTokenDecimals(mint: string): Promise<number | null> {
  const cached = cache.get(mint);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cm-dec', method: 'getTokenSupply', params: [mint] }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { result?: { value?: { decimals?: number } } };
    const d = body.result?.value?.decimals;
    if (typeof d === 'number' && Number.isFinite(d)) {
      cache.set(mint, d);
      return d;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve decimals for several mints at once; de-dupes and preserves the
 *  null-on-failure contract per mint. */
export async function getTokenDecimalsMany(mints: string[]): Promise<Map<string, number | null>> {
  const distinct = [...new Set(mints)];
  const out = new Map<string, number | null>();
  await Promise.all(distinct.map(async (m) => { out.set(m, await getTokenDecimals(m)); }));
  return out;
}
