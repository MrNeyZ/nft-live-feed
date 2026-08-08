// VictoryLabs — generic localStorage-backed range persistence.
// Extracted from /dashboard's loadSavedRange/saveRange (dashboard/page.tsx)
// so /multi's DashboardCollectionsPanel can persist its own timeframe under
// a different key with identical validate/fallback semantics, instead of
// silently resetting to the default on every reload.

/** Reads `key`, returns it only if it's a member of `validRanges`; falls
 *  back to `fallback` otherwise (missing key, invalid value, private-mode
 *  storage exception, or SSR where `window` doesn't exist yet). */
export function loadStoredRange<R extends string>(
  key: string, validRanges: ReadonlySet<R>, fallback: R,
): R {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v && validRanges.has(v as R)) return v as R;
  } catch { /* private mode */ }
  return fallback;
}

export function saveStoredRange(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}
