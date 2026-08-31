/**
 * Magic Eden NFT re-index — force ME to re-read a wallet's NFTs off-chain
 * (owner, listing, metadata) straight from Solana, optionally scoped to one
 * collection. Deliberately wallet-scoped, not collection-wide: the actual
 * use case is a handful of NFTs (typically <20) whose ME-cached state has
 * drifted from chain — not blanket-refreshing an entire collection's supply.
 *
 * Mechanism reverse-engineered from magiceden.io's own bundle (2026-08-16):
 * every item-details page mounts a `useEffect` that fires
 *   POST {apiHost}/rpc/refreshNFTsByMintAddresses/<comma-joined mints>
 * on load — this is ME's own client re-sync call, not a private/internal
 * endpoint. It accepts a batch of mints in one call (tested up to 100 mints,
 * ~4.5KB URL, still 200 OK).
 *
 * Confirmed scope (2026-08-16, see chat log / memory): this endpoint
 * refreshes per-NFT metadata (owner, name, image, attributes) ONLY. It does
 * NOT touch MMM pool / bid `updatedAt` — tested directly, no change. Do not
 * present this as a bid/pool refresher; that mechanism is still unknown.
 */

const ME_API_HOST = 'https://api-mainnet.magiceden.io';
const REFRESH_BATCH_SIZE = 100;
const BATCH_DELAY_MS = 300;

// ── Collection-kind lookup (Core vs pNFT/Legacy) ────────────────────────────
// Used by the frontend's search dropdown to badge/filter results by asset
// standard, per user request — helps pick the right collection when several
// share a name. Reuses the same slug→sampleMint resolver as the address
// resolution path, then classifies via the existing DAS verdict logic
// (verifyAndFetchAsset) rather than re-deriving asset-standard detection.
const kindCache = new Map<string, { kind: string | null; at: number }>();
const KIND_CACHE_TTL_MS = 10 * 60_000;

export async function getCollectionKind(slug: string): Promise<string | null> {
  const hit = kindCache.get(slug);
  if (hit && Date.now() - hit.at < KIND_CACHE_TTL_MS) return hit.kind;

  const { resolveSlugToCollection } = await import('../tools-holders/resolve-slug');
  const { verifyAndFetchAsset } = await import('../enrichment/helius-das');

  let kind: string | null = null;
  try {
    const resolution = await resolveSlugToCollection(slug);
    if (resolution.sampleMint) {
      const { verdict } = await verifyAndFetchAsset(resolution.sampleMint);
      kind = verdict.ok ? (verdict.kind ?? null) : null;
    }
  } catch (err) {
    console.warn(`[me-collection-refresh] collection-kind lookup failed for ${slug}`, err);
  }
  kindCache.set(slug, { kind, at: Date.now() });
  return kind;
}

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('helius_api_key_missing');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export interface WalletMintsResult {
  mints: string[];
  cnftSkipped: number;
}

/** Every mint currently owned by this wallet, optionally filtered to one
 *  on-chain collection group. Paginated via Helius DAS getAssetsByOwner.
 *  Compressed NFTs (cNFTs) are skipped instantly — ME's
 *  refreshNFTsByMintAddresses is only meaningful for pNFT/legacy/MPL Core
 *  assets, which is all this tool is meant to cover. */
export async function fetchWalletMints(owner: string, collectionAddress?: string): Promise<WalletMintsResult> {
  const mints: string[] = [];
  let cnftSkipped = 0;
  let page = 1;
  const limit = 1000;
  for (;;) {
    const res = await fetch(heliusRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAssetsByOwner',
        params: { ownerAddress: owner, page, limit },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`das_http_${res.status}`);
    const json = await res.json() as {
      result?: {
        items?: Array<{
          id: string;
          compression?: { compressed?: boolean };
          grouping?: Array<{ group_key: string; group_value: string }>;
        }>;
      };
      error?: { message?: string };
    };
    if (json.error) throw new Error(`das_error_${json.error.message ?? 'unknown'}`);
    const items = json.result?.items ?? [];
    for (const it of items) {
      if (it.compression?.compressed) { cnftSkipped += 1; continue; }
      if (collectionAddress) {
        const inColl = it.grouping?.some((g) => g.group_key === 'collection' && g.group_value === collectionAddress);
        if (!inColl) continue;
      }
      mints.push(it.id);
    }
    if (items.length < limit) break;
    page += 1;
    if (page > 20) break; // 20k-item safety cap — a wallet, not a whole collection
  }
  return { mints, cnftSkipped };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface WalletRefreshResult {
  totalMints: number;
  batches: number;
  refreshed: number;
  failedBatches: number;
  cnftSkipped: number;
  /** True when the scan stopped early because ME actually 429'd us — the
   *  rest of `batches` past what ran were never attempted (see
   *  `skippedMints`), not silently counted as failures. */
  rateLimited: boolean;
  skippedMints: number;
  mints: string[];
}

type BatchOutcome = 'ok' | 'fail' | 'rate_limited';

/** Calls ME's own `refreshNFTsByMintAddresses` in batches for every mint
 *  currently owned by the given wallet (optionally scoped to one
 *  collection). cNFTs are skipped instantly — pNFT/legacy/MPL Core only. */
export async function refreshWalletNfts(owner: string, collectionAddress?: string): Promise<WalletRefreshResult> {
  const { mints, cnftSkipped } = await fetchWalletMints(owner, collectionAddress);
  const batches = chunk(mints, REFRESH_BATCH_SIZE);

  const { meCooldownActive, setMeCooldown } = await import('../me-api-cooldown');

  // ME's own endpoint is genuinely flaky, not slow-under-load — confirmed
  // 2026-08-16 by re-sending the EXACT SAME 86-mint batch that had just
  // timed out twice (at a 25s cap) through our own backend: the identical
  // request succeeded in 0.5s moments later. Batch size isn't the driver
  // (10/30/50/86-mint batches all resolved in well under 1s on their own),
  // it's random per-request blips on ME's side. Short per-attempt timeout +
  // more retries recovers from that faster than one long wait would.
  // A real 429 is a DIFFERENT signal from a flaky timeout, though — that's
  // ME telling us to stop, not a transient blip — so it's excluded from the
  // retry loop and instead trips the shared project-wide ME cooldown
  // (me-api-cooldown.ts) and ends the whole scan immediately, same as every
  // other ME-calling tool in this codebase already does.
  const MAX_ATTEMPTS = 3;
  async function refreshBatch(batch: string[], attempt: number): Promise<BatchOutcome> {
    try {
      const res = await fetch(`${ME_API_HOST}/rpc/refreshNFTsByMintAddresses/${batch.join(',')}`, {
        method: 'POST',
        headers: { 'User-Agent': 'VictoryLabs/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return 'ok';
      if (res.status === 429) {
        setMeCooldown();
        console.warn('[me-collection-refresh] ME 429 — stopping scan early, shared cooldown set');
        return 'rate_limited';
      }
      console.warn(`[me-collection-refresh] batch http ${res.status} (attempt ${attempt})`);
    } catch (err) {
      console.warn(`[me-collection-refresh] batch error (attempt ${attempt})`, err);
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 1_000));
      return refreshBatch(batch, attempt + 1);
    }
    return 'fail';
  }

  let refreshed = 0;
  let failedBatches = 0;
  let rateLimited = false;
  let stoppedAt = batches.length;
  for (let i = 0; i < batches.length; i++) {
    if (meCooldownActive()) {
      console.warn('[me-collection-refresh] shared ME cooldown already active — stopping scan early');
      rateLimited = true;
      stoppedAt = i;
      break;
    }
    const batch = batches[i];
    const outcome = await refreshBatch(batch, 0);
    if (outcome === 'ok') {
      refreshed += batch.length;
    } else if (outcome === 'rate_limited') {
      rateLimited = true;
      stoppedAt = i;
      break;
    } else {
      failedBatches += 1;
    }
    if (i < batches.length - 1) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  const skippedMints = batches.slice(stoppedAt).reduce((n, b) => n + b.length, 0);
  return { totalMints: mints.length, batches: batches.length, refreshed, failedBatches, cnftSkipped, rateLimited, skippedMints, mints };
}
