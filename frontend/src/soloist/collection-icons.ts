/**
 * Shared collection-icon resolver.
 *
 * Pulls official collection logos from the backend's `/api/collections/icon`
 * endpoint and caches the result at module scope so every component that
 * renders a collection avatar (Dashboard rows, Collection header, search
 * dropdown) reads through the same memoization. Missing / failed slugs are
 * cached as `null` so the CollectionIcon placeholder fallback fires
 * immediately on re-render instead of refetching.
 */

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** slug → resolved imageUrl or null (unresolved/failed). */
const iconCache = new Map<string, string | null>();
const inflight  = new Set<string>();

function pickFromCache(slugs: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of slugs) if (s && iconCache.has(s)) out[s] = iconCache.get(s)!;
  return out;
}

// Missing slugs from every hook instance on a render pass are coalesced into
// one /api/collections/icon request (a /feed page mounts dozens of cards).
const FLUSH_MS = 30;
const queued    = new Set<string>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  flushTimer = null;
  const batch = Array.from(queued).slice(0, 100);
  for (const s of batch) queued.delete(s);
  if (queued.size) flushTimer = setTimeout(flush, FLUSH_MS);
  if (!batch.length) return;
  fetch(`${API_BASE}/api/collections/icon?slugs=${encodeURIComponent(batch.join(','))}`)
    .then(r => r.ok ? r.json() : { icons: {} })
    .then((data: { icons?: Record<string, string | null> }) => {
      const received = data.icons ?? {};
      for (const s of batch) iconCache.set(s, received[s] ?? null);
    })
    .catch(() => { /* leave uncached → a later mount retries */ })
    .finally(() => {
      for (const s of batch) inflight.delete(s);
      for (const l of Array.from(listeners)) l();
    });
}

export function useCollectionIcons(slugs: readonly string[]): Record<string, string | null> {
  const [icons, setIcons] = useState<Record<string, string | null>>(() => pickFromCache(slugs));

  const key = slugs.slice().sort().join('\u0001');
  useEffect(() => {
    const refresh = () => setIcons(pickFromCache(slugs));
    listeners.add(refresh);
    const missing = slugs.filter(s => s && !iconCache.has(s) && !inflight.has(s));
    for (const s of missing) { inflight.add(s); queued.add(s); }
    if (missing.length && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    refresh();
    return () => { listeners.delete(refresh); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return icons;
}

/** Collection icon (compressible URL) for one slug, or null — the fallback
 *  thumb when an NFT has no image / its image is dead. */
export function useCollectionIcon(slug: string | null | undefined): string | null {
  const icons = useCollectionIcons(slug ? [slug] : []);
  return slug ? icons[slug] ?? null : null;
}
