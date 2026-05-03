/**
 * LaunchMyNFT featured-collections lookup.
 *
 * The user-facing collection page at
 *   https://www.launchmynft.io/collections/{owner}/{id}
 * is a Next.js SSR page; the page's __NEXT_DATA__ payload exposes the
 * full collection record, including:
 *   id              — the URL `collectionId` segment
 *   owner           — the URL `owner` segment
 *   collectionMint  — the on-chain MPL Core collection asset (our JOIN KEY)
 *   collectionName, maxSupply, totalMints, cost, customOverride,
 *   collectionBannerUrl, collectionCoverUrl, …
 *
 * The homepage embeds an array `pageProps.featuredCollections[]` with
 * the same shape for every featured/trending collection. We scrape the
 * homepage HTML once every TTL window, parse `__NEXT_DATA__`, and build
 * a `collectionMint → LmntfInfo` map. Cache TTL is 10 min; on any
 * failure the previous cache is kept and the next refresh tries again.
 *
 * Limitation: only collections featured on the LMNFT homepage end up
 * in this map. Non-featured fresh launches will be invisible until LMNFT
 * promotes them. There's no public per-mint search API today (only the
 * Next.js page route, which itself requires owner+id), so this is the
 * best stable signal without scraping per-collection HTML.
 */

const LMNFT_HOMEPAGE = 'https://www.launchmynft.io/';
const REFRESH_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface LmntfInfo {
  owner:           string;
  collectionId:    string;          // URL segment
  collectionMint:  string;          // on-chain MPL Core collection asset
  collectionName:  string | null;
  maxSupply:       number | null;
  totalMints:      number | null;
  customOverride:  string | null;
  bannerUrl:       string | null;
  coverUrl:        string | null;
  /** Convenience: pre-built marketing URL. Always safe to render. */
  url:             string;
}

let cache: Map<string, LmntfInfo> = new Map();
let lastRefreshAt = 0;
let inflight: Promise<void> | null = null;

interface RawCollection {
  id?:                  unknown;
  owner?:               unknown;
  collectionMint?:      unknown;
  collectionName?:      unknown;
  maxSupply?:           unknown;
  totalMints?:          unknown;
  customOverride?:      unknown;
  collectionBannerUrl?: unknown;
  collectionCoverUrl?:  unknown;
}
function asString(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInfo(raw: RawCollection): LmntfInfo | null {
  const id    = asString(raw.id);
  const owner = asString(raw.owner);
  const mint  = asString(raw.collectionMint);
  if (!id || !owner || !mint) return null;
  return {
    owner,
    collectionId:   id,
    collectionMint: mint,
    collectionName: asString(raw.collectionName),
    maxSupply:      asNumber(raw.maxSupply),
    totalMints:     asNumber(raw.totalMints),
    customOverride: asString(raw.customOverride),
    bannerUrl:      asString(raw.collectionBannerUrl),
    coverUrl:       asString(raw.collectionCoverUrl),
    url:            `https://www.launchmynft.io/collections/${owner}/${id}`,
  };
}

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(LMNFT_HOMEPAGE, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; nft-live-feed/1.0)' },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.log(`[mints/lmnft-refresh] reason=http_${res.status}`);
        return;
      }
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
      if (!m) {
        console.log('[mints/lmnft-refresh] reason=no_next_data');
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try { parsed = JSON.parse(m[1]); }
      catch { console.log('[mints/lmnft-refresh] reason=parse_error'); return; }
      const arr = parsed?.props?.pageProps?.featuredCollections;
      if (!Array.isArray(arr)) {
        console.log('[mints/lmnft-refresh] reason=no_featured_collections');
        return;
      }
      const next = new Map<string, LmntfInfo>();
      for (const raw of arr) {
        const info = toInfo(raw as RawCollection);
        if (info) next.set(info.collectionMint, info);
      }
      cache = next;
      lastRefreshAt = Date.now();
      console.log(`[mints/lmnft-refresh] ok size=${cache.size}`);
    } catch (e) {
      console.log(`[mints/lmnft-refresh] reason=fetch_error msg=${(e as Error).message}`);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Synchronous lookup for a known LMNFT collection by on-chain mint
 *  address. Returns null when the collection isn't in the cached
 *  featured set, OR when the cache is stale and a refresh is already
 *  in flight. Triggers a background refresh if the TTL has expired —
 *  caller never blocks. */
export function getLmnftInfoByMint(collectionMint: string): LmntfInfo | null {
  if (Date.now() - lastRefreshAt > REFRESH_TTL_MS) {
    void refresh();
  }
  return cache.get(collectionMint) ?? null;
}
