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

export function useCollectionIcons(slugs: readonly string[]): Record<string, string | null> {
  const [icons, setIcons] = useState<Record<string, string | null>>(() => pickFromCache(slugs));

  const key = slugs.slice().sort().join('\u0001');
  useEffect(() => {
    const missing = slugs.filter(s => s && !iconCache.has(s) && !inflight.has(s));
    if (missing.length === 0) {
      setIcons(pickFromCache(slugs));
      return;
    }
    for (const s of missing) inflight.add(s);
    let cancelled = false;
    fetch(`${API_BASE}/api/collections/icon?slugs=${encodeURIComponent(missing.join(','))}`)
      .then(r => r.ok ? r.json() : { icons: {} })
      .then((data: { icons?: Record<string, string | null> }) => {
        if (cancelled) return;
        const received = data.icons ?? {};
        for (const s of missing) {
          iconCache.set(s, received[s] ?? null);
          inflight.delete(s);
        }
        setIcons(pickFromCache(slugs));
      })
      .catch(() => {
        for (const s of missing) inflight.delete(s);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return icons;
}
