// Small fixed-position dev-only badge that shows the current viewport
// width and breakpoint range. Mounts only when:
//   - NODE_ENV !== 'production', OR
//   - NEXT_PUBLIC_VIEWPORT_DEBUG === '1'
// Toggle visible at runtime with `?vp=0` / `?vp=1` (persists in
// localStorage under 'vl.viewportDebug').
//
// Render position is bottom-left so it doesn't collide with Next's
// dev-overlay error pill (bottom-right) — even though that pill is
// disabled in next.config.mjs, leaving room for it is cheap.

'use client';

import { useEffect, useState } from 'react';
import { useViewport } from '@/lib/use-viewport';

const STORAGE_KEY = 'vl.viewportDebug';

function initialVisible(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('vp');
    if (q === '1') {
      window.localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    if (q === '0') {
      window.localStorage.setItem(STORAGE_KEY, '0');
      return false;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch { /* ignore */ }
  // Default: shown in dev, hidden in prod unless the public flag is set.
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.NEXT_PUBLIC_VIEWPORT_DEBUG === '1';
}

const LABELS: Record<string, string> = {
  mobile:        'mobile ≤480',
  tablet:        'tablet 481–768',
  small_laptop:  'small_laptop 769–1024',
  laptop:        'laptop 1025–1600',
  desktop_large: 'desktop_large >1600',
};

export function ViewportDebugBadge() {
  const vp = useViewport();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(initialVisible());
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+V toggles the badge — cheap escape hatch when it overlaps
      // something you're inspecting.
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        setVisible(v => {
          const next = !v;
          try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!vp.mounted || !visible) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: 'clamp(6px, 1vw, 12px)',
        bottom: 'clamp(6px, 1vh, 12px)',
        zIndex: 2147483646,
        padding: '4px 8px',
        font: '500 11px/1.2 ui-monospace, "Fira Code", Menlo, monospace',
        color: '#e7e7ea',
        background: 'rgba(20, 20, 28, 0.78)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 6,
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        maxWidth: 'min(90vw, 320px)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {vp.width}px · {LABELS[vp.range] ?? vp.range}
    </div>
  );
}
