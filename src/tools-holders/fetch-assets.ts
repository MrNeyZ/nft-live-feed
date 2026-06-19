/**
 * Holder Count Tool — read-only collection ownership scan.
 *
 * Walks Helius DAS `getAssetsByGroup` (groupKey="collection") page by page and
 * collects every asset's `ownership.owner`. This is the ONLY network path in
 * the tool and it is strictly read-only — no signing, no sending, no writes.
 *
 * Safety: bounded pages + per-page timeout + early-stop on a short page. On the
 * page/asset cap the scan stops and flags `truncated` (the analyze layer turns
 * that into a warning — counts become a lower bound, never a silent cut).
 */
import type { CollectionOwnerScan } from './types';

/** Solana base58 pubkey: 32-byte → 32–44 base58 chars. */
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidCollectionAddress(addr: string): boolean {
  return typeof addr === 'string' && ADDR_RE.test(addr.trim());
}

/** DAS page size. 1000 is the documented max for getAssetsByGroup. */
export const PAGE_LIMIT = 1000;
/** Hard page ceiling → PAGE_LIMIT * MAX_PAGES assets. Bounds worst-case
 *  latency + credit spend; beyond it we stop and flag `truncated`. */
export const MAX_PAGES = 30;
/** Per-page request timeout. */
const PAGE_TIMEOUT_MS = 10_000;

interface DasGroupItem {
  ownership?: { owner?: string | null };
  /** DAS marks closed/burned assets `burnt:true`. Verified against chain: a
   *  `burnt` asset's account is a 1-byte closed stub, and DAS still reports a
   *  STALE pre-burn owner (e.g. the mint/treasury wallet) for it — which
   *  otherwise inflates that wallet into a phantom top holder. Excluded. */
  burnt?: boolean;
}
interface DasGroupResponse {
  result?: { total?: number; items?: DasGroupItem[] };
  error?:  { code?: number; message?: string };
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/**
 * Fetch all owners for a verified collection group. Never throws — transport /
 * RPC errors are captured into `dasError` so the caller still returns whatever
 * was collected so far (with a warning). Page walking stops on:
 *   - an empty / short page (last page reached), OR
 *   - the MAX_PAGES safety cap (sets `truncated`), OR
 *   - a DAS error (sets `dasError`).
 */
export async function fetchCollectionOwners(collection: string): Promise<CollectionOwnerScan> {
  const owners: string[] = [];
  let missingOwnerCount = 0;
  let burntCount         = 0;
  let totalAssets        = 0;
  let truncated          = false;
  let dasError: string | null = null;

  const url = rpcUrl();

  for (let page = 1; page <= MAX_PAGES; page++) {
    let json: DasGroupResponse;
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      'holders-tool',
          method:  'getAssetsByGroup',
          params: {
            groupKey:   'collection',
            groupValue: collection,
            page,
            limit:      PAGE_LIMIT,
            // Keep the payload lean — we only read ownership.owner.
            displayOptions: { showCollectionMetadata: false, showFungible: false },
          },
        }),
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) { dasError = `DAS HTTP ${res.status}`; break; }
      json = (await res.json()) as DasGroupResponse;
    } catch (err) {
      dasError = (err as Error).message || 'fetch_error';
      break;
    }
    if (json.error) { dasError = `DAS ${json.error.code ?? '?'}: ${json.error.message ?? 'error'}`; break; }

    const items = json.result?.items ?? [];
    if (items.length === 0) break;  // no more pages

    for (const it of items) {
      // Burned/closed on-chain — DAS keeps a stale pre-burn owner. Drop it so
      // it neither counts toward supply nor inflates a phantom holder.
      if (it.burnt === true) { burntCount++; continue; }
      totalAssets++;
      const owner = it.ownership?.owner;
      if (typeof owner === 'string' && owner.length > 0) owners.push(owner);
      else missingOwnerCount++;
    }

    // Short page → this was the last page; full page on the final allowed page
    // → there may be more, so flag truncation.
    if (items.length < PAGE_LIMIT) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { owners, missingOwnerCount, burntCount, totalAssets, truncated, dasError };
}
