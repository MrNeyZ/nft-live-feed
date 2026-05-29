/**
 * Shared user blacklist store (client-side UI preference).
 *
 * One source of truth for the render-layer "hide collection / item"
 * blacklist used by BOTH the /mints tracker and the /feed live feed.
 * Previously each page kept its own state: /mints persisted to
 * `vl.mints.blacklist`, /feed never persisted at all — so a /feed mute
 * evaporated on refresh and the two pages never agreed. This unifies them
 * onto a single versioned localStorage key with cross-component (same-tab)
 * and cross-tab sync.
 *
 * The store holds a flat set of lowercased identifier tokens (collection
 * slug / name / groupingKey / address). Each page keeps its OWN matcher
 * against this shared set — /mints checks groupingKey/address/name,
 * /feed checks slug/name — so the storage is shared without forcing one
 * field model on both surfaces.
 *
 * NOTE: this is purely a client-side UI preference. It is unrelated to the
 * backend's hardcoded `src/mints/blacklist.ts` (BLACKLISTED_COLLECTIONS),
 * which is a server-side ingestion valve, not a user setting.
 */

import { useEffect, useState } from 'react';

const KEY        = 'vl.blacklist.v1';
const LEGACY_KEY = 'vl.mints.blacklist';   // pre-unification /mints store
const CHANGE_EVENT = 'vl:blacklist-change';

function parse(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Read the persisted blacklist, migrating the legacy /mints-only key on
 *  first access so existing user blacklists survive the unification. */
export function readBlacklist(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const cur = window.localStorage.getItem(KEY);
    if (cur !== null) return parse(cur);
    // One-time migration from the legacy key (if the user had a /mints list).
    const legacy = parse(window.localStorage.getItem(LEGACY_KEY));
    if (legacy.length) window.localStorage.setItem(KEY, legacy.join(','));
    return legacy;
  } catch { return []; }
}

function writeBlacklist(slugs: string[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, slugs.join(',')); } catch { /* quota / private mode */ }
  // Same-tab sync — the native `storage` event only fires in OTHER tabs.
  try { window.dispatchEvent(new CustomEvent<string[]>(CHANGE_EVENT, { detail: slugs })); } catch { /* noop */ }
}

/**
 * Hook: shared, persisted blacklist. Lazy-initialised from localStorage so
 * the first render already has the saved tokens (no flash of blacklisted
 * rows before a hydration effect runs). Stays in sync across pages within
 * the tab (CustomEvent) and across tabs (native `storage` event).
 */
export function useBlacklist(): {
  slugs: string[];
  add: (raw: string) => void;
  remove: (slug: string) => void;
} {
  const [slugs, setSlugs] = useState<string[]>(readBlacklist);

  useEffect(() => {
    const onLocal = (e: Event) => {
      const next = (e as CustomEvent<string[]>).detail;
      if (Array.isArray(next)) setSlugs(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setSlugs(parse(e.newValue));
    };
    window.addEventListener(CHANGE_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (!v) return;
    setSlugs(prev => {
      if (prev.includes(v)) return prev;
      const next = [...prev, v];
      writeBlacklist(next);
      return next;
    });
  };
  const remove = (slug: string) => {
    setSlugs(prev => {
      const next = prev.filter(s => s !== slug);
      writeBlacklist(next);
      return next;
    });
  };

  return { slugs, add, remove };
}
