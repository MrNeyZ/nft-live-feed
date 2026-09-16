/**
 * Candy Mint tool — resolve an asset's mint (creation) signature from its
 * mint address alone.
 *
 * Exists so the `/mints` feed's Candy Machine badge can link straight into
 * `/tools/candy-mint` using the wire's existing `firstMintAddress` (an
 * asset pubkey) — decode.ts only understands a transaction SIGNATURE, and
 * threading a signature through the accumulator/snapshot/wire just to avoid
 * this one extra RPC was rejected in favor of resolving it here, on demand,
 * only when the tool is actually opened.
 *
 * `getSignaturesForAddress` returns newest-first; a freshly-minted NFT
 * (the common case: badge clicked soon after mint) has few enough
 * transactions that its whole history fits on one page, so the LAST entry
 * of that page is already the earliest — the mint. For an older/heavily-
 * traded asset, walk backward with `before` until a short page confirms
 * we've reached the start of history, capped so one lookup can't run away.
 */
const MAX_PAGES = 5;
const PAGE_LIMIT = 1000;

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo {
  signature: string;
  err: unknown;
}

async function getSignaturesPage(address: string, before?: string): Promise<SigInfo[]> {
  const params: [string, Record<string, unknown>] = [
    address,
    before ? { limit: PAGE_LIMIT, before } : { limit: PAGE_LIMIT },
  ];
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cm-asset-sigs', method: 'getSignaturesForAddress', params }),
  });
  if (!res.ok) throw new Error(`getSignaturesForAddress RPC HTTP ${res.status}`);
  const body = await res.json() as { result?: SigInfo[]; error?: { message?: string } };
  if (body.error) throw new Error(`getSignaturesForAddress RPC error: ${body.error.message ?? 'unknown'}`);
  return body.result ?? [];
}

/** Earliest known signature touching `asset`, or null if it has no history
 *  at all. Prefers a signature with `err == null` at the oldest page —
 *  the mint itself always lands successfully (a failed create wouldn't
 *  have produced this asset address), so the last entry of the oldest
 *  page is the mint even if later (unrelated) entries on that page
 *  happen to include a failed tx. */
export async function resolveEarliestSignatureForAsset(asset: string): Promise<string | null> {
  let before: string | undefined;
  let lastPage: SigInfo[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await getSignaturesPage(asset, before);
    if (rows.length === 0) break;
    lastPage = rows;
    if (rows.length < PAGE_LIMIT) break;
    before = rows[rows.length - 1].signature;
  }
  if (lastPage.length === 0) return null;
  return lastPage[lastPage.length - 1].signature;
}
