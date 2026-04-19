/**
 * Secondary metadata fallback chain for MPL Core assets.
 *
 * Used when Helius DAS does not index a mint (Asset Not Found) or returns
 * a partial result (name/image null).  Sources are tried in priority order;
 * each one only fills in fields that are still missing — it never overwrites
 * what an earlier source already provided.
 *
 *   1. Solscan  — public NFT detail endpoint, no key required
 *   2. SolanaFM — public token registry, no key required
 *
 * Never throws.  Always returns a complete NftMetadata object; name/image
 * may still be null if both sources fail (caller applies synthetic name).
 */

import { NftMetadata } from './helius-das';

// ─── Solscan ──────────────────────────────────────────────────────────────────

// Solscan public API v1 — NFT detail
// Possible response shapes depending on asset type; we probe the most common paths.
interface SolscanNftDetail {
  data?: {
    // Shape A — standard SPL / pNFT
    name?:  string;
    image?: string;
    // Shape B — wrapped in metadata sub-object
    metadata?: {
      name?:  string;
      image?: string;
    };
    collection?: {
      name?: string;
    };
  };
}

async function getSolscanMetadata(
  mint: string,
): Promise<Partial<Pick<NftMetadata, 'nftName' | 'imageUrl' | 'collectionName'>>> {
  const res = await fetch(
    `https://public-api.solscan.io/nft/detail?address=${mint}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`Solscan HTTP ${res.status}`);

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new Error('Solscan non-JSON');

  const json = (await res.json()) as SolscanNftDetail;
  const d = json.data;
  if (!d) throw new Error('Solscan: empty data');

  return {
    nftName:        d.name       ?? d.metadata?.name  ?? null,
    imageUrl:       d.image      ?? d.metadata?.image ?? null,
    collectionName: d.collection?.name ?? null,
  };
}

// ─── SolanaFM ─────────────────────────────────────────────────────────────────

// SolanaFM public token registry v1
interface SolanaFmTokenRes {
  status?: string;
  result?: {
    tokenList?: {
      name?:     string;
      logoURI?:  string;
    };
  };
}

async function getSolanaFmMetadata(
  mint: string,
): Promise<Partial<Pick<NftMetadata, 'nftName' | 'imageUrl'>>> {
  const res = await fetch(
    `https://api.solana.fm/v1/tokens/${mint}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`SolanaFM HTTP ${res.status}`);

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new Error('SolanaFM non-JSON');

  const json = (await res.json()) as SolanaFmTokenRes;
  const tl = json.result?.tokenList;
  if (!tl?.name && !tl?.logoURI) throw new Error('SolanaFM: no token data');

  return {
    nftName:  tl.name     ?? null,
    imageUrl: tl.logoURI  ?? null,
  };
}

// ─── Public: ordered chain ────────────────────────────────────────────────────

/**
 * Try Solscan then SolanaFM, overlaying each result onto `base`.
 * Only missing fields (null) are filled; existing values are never replaced.
 *
 * @param base  Partial NftMetadata from DAS (may be null if DAS threw entirely).
 * @returns     Merged NftMetadata; nftName/imageUrl may still be null on total failure.
 */
export async function fetchFallbackMetadata(
  mint:  string,
  base:  NftMetadata | null,
): Promise<NftMetadata> {
  let name    = base?.nftName           ?? null;
  let image   = base?.imageUrl          ?? null;
  let colName = base?.collectionName    ?? null;
  const colAddr = base?.collectionAddress ?? null;

  // ── 1. Solscan ──────────────────────────────────────────────────────────────
  if (!name || !image) {
    try {
      const ss = await getSolscanMetadata(mint);
      name    = name    || ss.nftName       || null;
      image   = image   || ss.imageUrl      || null;
      colName = colName || ss.collectionName || null;
      if (name || image) console.log(`[enrich] Solscan fallback ok  ${mint.slice(0, 8)}...`);
    } catch (err) {
      console.warn(`[enrich] Solscan failed  ${mint.slice(0, 8)}...: ${(err as Error).message}`);
    }
  }

  // ── 2. SolanaFM ─────────────────────────────────────────────────────────────
  if (!name || !image) {
    try {
      const fm = await getSolanaFmMetadata(mint);
      name  = name  || fm.nftName  || null;
      image = image || fm.imageUrl || null;
      if (name || image) console.log(`[enrich] SolanaFM fallback ok  ${mint.slice(0, 8)}...`);
    } catch (err) {
      console.warn(`[enrich] SolanaFM failed  ${mint.slice(0, 8)}...: ${(err as Error).message}`);
    }
  }

  return { nftName: name, imageUrl: image, collectionName: colName, collectionAddress: colAddr, meCollectionSlug: null };
}
