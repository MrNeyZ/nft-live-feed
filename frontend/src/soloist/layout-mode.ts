// UI layout mode (PC / Laptop / Phone). Persists in localStorage and
// applies a `data-layout` attribute on <html>. CSS in globals.css reads
// `[data-layout="..."]` to swap a small set of layout tokens (feed column
// width, root padding, top-nav max width). Default = laptop.

import { useEffect, useState } from 'react';

export type LayoutMode = 'pc' | 'laptop' | 'phone';

const STORAGE_KEY = 'vl.layoutMode';
const DEFAULT_MODE: LayoutMode = 'laptop';
const CHANGE_EVENT  = 'vl:layoutModeChange';

export const LAYOUT_MODES: { key: LayoutMode; label: string; title: string }[] = [
  { key: 'pc',     label: 'PC',     title: '2560×1440 — 27–32 in monitor' },
  { key: 'laptop', label: 'Laptop', title: '1920×1080 — 13 in (current default)' },
  { key: 'phone',  label: 'Phone',  title: 'iPhone 14 Pro Max — mobile viewport' },
];

function isLayoutMode(v: unknown): v is LayoutMode {
  return v === 'pc' || v === 'laptop' || v === 'phone';
}

export function readLayoutMode(): LayoutMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isLayoutMode(v) ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function applyLayoutMode(mode: LayoutMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.layout = mode;
}

export function writeLayoutMode(mode: LayoutMode): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore quota / private mode */ }
  applyLayoutMode(mode);
  window.dispatchEvent(new CustomEvent<LayoutMode>(CHANGE_EVENT, { detail: mode }));
}

/**
 * React hook: returns the current mode and a setter. Reads from localStorage
 * on mount (avoids SSR/CSR mismatch — server renders without the attribute,
 * client applies it after hydrate). Listens to the in-app change event so
 * sibling instances stay in sync without prop drilling.
 */
export function useLayoutMode(): [LayoutMode, (m: LayoutMode) => void] {
  const [mode, setMode] = useState<LayoutMode>(DEFAULT_MODE);
  useEffect(() => {
    const initial = readLayoutMode();
    setMode(initial);
    applyLayoutMode(initial);
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<LayoutMode>).detail;
      if (isLayoutMode(next)) setMode(next);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return [mode, writeLayoutMode];
}
