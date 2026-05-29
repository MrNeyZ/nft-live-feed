/**
 * Per-page user blacklist store (client-side UI preference).
 *
 * The /mints tracker and the /feed live feed each keep an INDEPENDENT
 * persisted blacklist — adding an entry on one page must never affect the
 * other. Each page passes its own versioned localStorage key:
 *   - /mints → vl.mints.blacklist.v1
 *   - /feed  → vl.feed.blacklist.v1
 *
 * Sync is scoped per key: same-tab via a key-suffixed CustomEvent, cross-tab
 * via the native `storage` event filtered to that key. So two pages open in
 * one tab do not bleed into each other.
 *
 * The store holds a flat set of lowercased identifier tokens (collection
 * slug / name / groupingKey / address). Each page keeps its OWN matcher
 * against this set — filtering/matching logic lives in the pages and is
 * unchanged here.
 *
 * NOTE: purely a client-side UI preference, unrelated to the backend's
 * hardcoded src/mints/blacklist.ts (BLACKLISTED_COLLECTIONS).
 */

import { useEffect, useState } from 'react';

/** Pre-separation shared key. Migrated once into each per-page key, then
 *  no longer read or written by this module. */
const SHARED_LEGACY_KEY = 'vl.blacklist.v1';

export const MINTS_BLACKLIST_KEY = 'vl.mints.blacklist.v1';
export const FEED_BLACKLIST_KEY  = 'vl.feed.blacklist.v1';

const changeEventName = (key: string) => `vl:blacklist-change:${key}`;

function parse(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Read the persisted blacklist for `key`, migrating the pre-separation
 *  shared key (vl.blacklist.v1) into it once on first access so existing
 *  user lists survive the split. Each per-page key migrates independently;
 *  the shared key itself is left untouched and simply stops being used. */
export function readBlacklist(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const cur = window.localStorage.getItem(key);
    if (cur !== null) return parse(cur);
    // One-time seed from the shared legacy key (if present).
    const legacy = parse(window.localStorage.getItem(SHARED_LEGACY_KEY));
    if (legacy.length) window.localStorage.setItem(key, legacy.join(','));
    return legacy;
  } catch { return []; }
}

function writeBlacklist(key: string, slugs: string[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, slugs.join(',')); } catch { /* quota / private mode */ }
  // Same-tab sync — the native `storage` event only fires in OTHER tabs.
  try {
    window.dispatchEvent(new CustomEvent<string[]>(changeEventName(key), { detail: slugs }));
  } catch { /* noop */ }
}

/**
 * Hook: an independent, persisted blacklist for the given storage `key`.
 * Lazy-initialised from localStorage so the saved tokens are present on the
 * first render — no flash of blacklisted rows before a hydration effect.
 * Stays in sync for the same key across components in the tab (CustomEvent)
 * and across tabs (native `storage` event); never syncs across keys.
 */
export function useBlacklist(key: string): {
  slugs: string[];
  add: (raw: string) => void;
  remove: (slug: string) => void;
} {
  const [slugs, setSlugs] = useState<string[]>(() => readBlacklist(key));

  useEffect(() => {
    const evt = changeEventName(key);
    const onLocal = (e: Event) => {
      const next = (e as CustomEvent<string[]>).detail;
      if (Array.isArray(next)) setSlugs(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setSlugs(parse(e.newValue));
    };
    window.addEventListener(evt, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(evt, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (!v) return;
    setSlugs(prev => {
      if (prev.includes(v)) return prev;
      const next = [...prev, v];
      writeBlacklist(key, next);
      return next;
    });
  };
  const remove = (slug: string) => {
    setSlugs(prev => {
      const next = prev.filter(s => s !== slug);
      writeBlacklist(key, next);
      return next;
    });
  };

  return { slugs, add, remove };
}
