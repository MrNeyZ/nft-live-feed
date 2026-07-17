'use client';

// Global command palette (⌘K / Ctrl+K) — Phase 1: navigation to the 6 main
// surfaces + delegating to actions/search that already exist on the current
// page. No new backend calls, no per-collection commands, no fuzzy search —
// static list, plain substring-free arrow-key navigation.
//
// Pause/Settings state lives locally inside each page component (feed,
// dashboard, mints each own their own `useState`), and this palette is
// mounted once, globally, in Gate.tsx — outside any single page's tree. It
// has no direct handle on those setters, so it dispatches a plain
// CustomEvent that only the page(s) which actually have that action listen
// for (see the `useEffect` in feed/page.tsx, dashboard/page.tsx,
// mints/page.tsx). Visibility of each command is decided here, statically,
// from the route — the event is only ever dispatched to a page that is
// already known (by pathname) to handle it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export const PALETTE_TOGGLE_PAUSE_EVENT = 'vl:palette:toggle-pause';
export const PALETTE_TOGGLE_SETTINGS_EVENT = 'vl:palette:toggle-settings';

type CommandGroup = 'page' | 'go to';

interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  hint?: string;
  run: () => void;
}

// Order mirrors TopNav's own tab order (BOARD, MULTI, MINTS, TOOLS, FEED).
const NAV_ITEMS: { key: string; label: string; href: string; match: (p: string) => boolean }[] = [
  { key: 'dashboard', label: 'Open Dashboard', href: '/dashboard',      match: p => p.startsWith('/dashboard') },
  { key: 'multi',     label: 'Open Multi',     href: '/multi',          match: p => p.startsWith('/multi') },
  { key: 'mints',     label: 'Open Mints',     href: '/mints',          match: p => p.startsWith('/mints') },
  { key: 'tools',     label: 'Open Tools',     href: '/tools',          match: p => p.startsWith('/tools') },
  { key: 'feed',      label: 'Open Feed',      href: '/feed',           match: p => p.startsWith('/feed') },
];

const HINTS: readonly [string, string][] = [
  ['↑↓', 'Navigate'],
  ['↵', 'Select'],
  ['esc', 'Close'],
];

export function CommandPalette() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (pathname.startsWith('/feed')) {
      list.push({
        id: 'toggle-pause', label: 'Toggle Pause', group: 'page',
        run: () => window.dispatchEvent(new Event(PALETTE_TOGGLE_PAUSE_EVENT)),
      });
    }
    if (pathname.startsWith('/feed') || pathname.startsWith('/dashboard') || pathname.startsWith('/mints')) {
      list.push({
        id: 'toggle-settings', label: 'Toggle Settings', group: 'page',
        run: () => window.dispatchEvent(new Event(PALETTE_TOGGLE_SETTINGS_EVENT)),
      });
    }
    list.push({
      id: 'focus-search', label: 'Focus Search', group: 'page',
      run: () => { (document.querySelector('.topnav-search input') as HTMLInputElement | null)?.focus(); },
    });
    for (const item of NAV_ITEMS) {
      if (item.match(pathname)) continue; // hide the current route
      list.push({ id: `go-${item.key}`, label: item.label, group: 'go to', hint: item.href, run: () => router.push(item.href) });
    }
    return list;
  }, [pathname, router]);

  // Refs mirror the reactive values the keydown handler needs, so the
  // listener is attached exactly once at mount (same pattern as feed/
  // page.tsx's `pausedRef` — avoids add/remove-listener churn on every
  // arrow-key press or route change).
  const commandsRef = useRef(commands);
  useEffect(() => { commandsRef.current = commands; }, [commands]);
  const hiRef = useRef(hi);
  useEffect(() => { hiRef.current = hi; }, [hi]);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
        setHi(0);
        return;
      }
      if (!openRef.current) return;
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, commandsRef.current.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => Math.max(0, h - 1)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = commandsRef.current[hiRef.current];
        if (cmd) { setOpen(false); cmd.run(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;

  const execute = (cmd: Command) => { setOpen(false); cmd.run(); };

  let lastGroup: CommandGroup | null = null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '14vh',
        background: 'rgba(8,6,18,0.62)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(480px, 92vw)',
          background: 'linear-gradient(180deg, #1a1430 0%, #14102a 100%)',
          border: '1px solid rgba(168,144,232,0.28)',
          borderRadius: 10,
          boxShadow: '0 16px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.3)',
          padding: 6,
        }}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {commands.map((cmd, i) => {
            const showHeader = cmd.group !== lastGroup;
            lastGroup = cmd.group;
            return (
              <div key={cmd.id}>
                {showHeader && (
                  <div style={{ fontSize: 9, fontWeight: 600, color: '#9a9ab4', letterSpacing: '0.8px', padding: '6px 8px 3px', textTransform: 'uppercase' }}>
                    {cmd.group}
                  </div>
                )}
                <div
                  onMouseEnter={() => setHi(i)}
                  onClick={() => execute(cmd)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9,
                    padding: '7px 8px', borderRadius: 4, cursor: 'pointer',
                    background: hi === i ? 'rgba(128,104,216,0.12)' : 'transparent',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#f0eef8' }}>{cmd.label}</span>
                  {cmd.hint && (
                    <span style={{ fontSize: 9, color: '#9a9ab4', fontFamily: "'SF Mono','Fira Code',monospace" }}>{cmd.hint}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px 2px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 4 }}>
          {HINTS.map(([key, label]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: '#63637a' }}>
              <kbd style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 14, height: 15, padding: '0 4px', fontSize: 9,
                fontFamily: "'SF Mono','Fira Code',monospace", color: '#9a9ab4',
                border: 'none', borderRadius: 3, background: 'rgba(255,255,255,0.06)', lineHeight: 1,
              }}>{key}</kbd>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
