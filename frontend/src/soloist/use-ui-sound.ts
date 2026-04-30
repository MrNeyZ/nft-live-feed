'use client';

/**
 * UI sound — hover + click ticks played from real recorded audio
 * assets (extracted from the operator's reference recording, not
 * synthesised). HTMLAudioElement-backed; no library dependencies.
 *
 * Two channels share gating, toggle, and the first-gesture init
 * but each carries its own asset, gain, and throttle timestamp:
 *
 *   playUiHover() — soft, quiet (gain 0.55), 80 ms throttle.
 *     /sounds/ui-hover.m4a (~80 ms, AAC ~5 KB)
 *   playUiClick() — sharper / slightly louder (gain 0.85), 40 ms throttle.
 *     /sounds/ui-click.m4a (~107 ms, AAC ~5 KB)
 *
 * Defaults to OFF; toggleable from BottomStatusBar (persisted to
 * `localStorage` as `vl.uiSound: 'on' | 'off'`). Respects
 * `prefers-reduced-motion` as a proxy for "user dislikes UI flair".
 *
 * Note: assets ship as `.m4a` (AAC) rather than `.mp3` because the
 * build host's `afconvert` only decodes MP3, doesn't encode. AAC is
 * smaller per-byte at the same perceived quality and supported by
 * all modern browsers via HTMLAudioElement.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'vl.uiSound';

const HOVER_THROTTLE_MS = 80;
const CLICK_THROTTLE_MS = 40;

const HOVER_URL  = '/sounds/ui-hover.m4a';
const CLICK_URL  = '/sounds/ui-click.m4a';
// Gain 1.0 — the underlying clips were extracted at the original
// recording's natural amplitude (peak ~0.008 hover, ~0.028 click) with
// NO normalization, so playing at full element volume reproduces what
// the operator heard in sample.mp3. Don't raise these casually — going
// above 1.0 isn't allowed by HTMLMediaElement.volume anyway, and
// boosting via Web Audio would re-introduce the harshness the previous
// (over-normalized) version had.
const HOVER_GAIN = 1.0;
const CLICK_GAIN = 1.0;

// ── Persisted preference ────────────────────────────────────────────────────

function readPref(): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === 'on'; }
  catch { return false; }
}

let enabled: boolean = readPref();
const listeners = new Set<() => void>();

export function setUiSoundEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off'); }
    catch { /* quota / private mode — fail silent */ }
  }
  for (const fn of listeners) fn();
  if (next) {
    // Eagerly pre-load assets the moment the operator opts in so the
    // very first hover/click after toggling has zero perceived latency.
    primeAudio();
    // Confirmation tick so the operator hears that the toggle worked.
    playUiClick();
  }
}

// ── React subscription ─────────────────────────────────────────────────────

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot():       boolean { return enabled; }
function getServerSnapshot(): boolean { return false; }

/** Cross-component reactive read of the current UI-sound preference. */
export function useUiSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ── Audio elements (lazy, primed after first user gesture) ─────────────────

let hoverEl: HTMLAudioElement | null = null;
let clickEl: HTMLAudioElement | null = null;
let lastHoverAt = 0;
let lastClickAt = 0;
let primed = false;

function primeAudio(): void {
  if (primed || typeof window === 'undefined') return;
  primed = true;
  try {
    hoverEl = new Audio(HOVER_URL);
    hoverEl.preload = 'auto';
    hoverEl.volume  = HOVER_GAIN;
    clickEl = new Audio(CLICK_URL);
    clickEl.preload = 'auto';
    clickEl.volume  = CLICK_GAIN;
  } catch {
    hoverEl = null;
    clickEl = null;
  }
}

let gestureInstalled = false;
function installFirstGestureInit(): void {
  if (gestureInstalled || typeof window === 'undefined') return;
  gestureInstalled = true;
  const init = () => {
    primeAudio();
    window.removeEventListener('pointerdown', init);
    window.removeEventListener('keydown',     init);
  };
  window.addEventListener('pointerdown', init, { once: true });
  window.addEventListener('keydown',     init, { once: true });
}
if (typeof window !== 'undefined') installFirstGestureInit();

// ── Reduced-motion respect ─────────────────────────────────────────────────

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Internal play helper ───────────────────────────────────────────────────

function play(el: HTMLAudioElement | null, throttleMs: number, lastAt: number): number {
  if (!enabled) return lastAt;
  if (reducedMotion()) return lastAt;
  if (!el) return lastAt;
  const now = performance.now();
  if (now - lastAt < throttleMs) return lastAt;
  // Rewind to start so rapid retriggers (within throttle) play cleanly
  // without drift. `play()` returns a Promise — swallow any rejection
  // (browsers reject when invoked before the first user gesture).
  try {
    el.currentTime = 0;
    void el.play().catch(() => undefined);
  } catch { /* element in invalid state — ignore one tick */ }
  return now;
}

// ── Public play surface ────────────────────────────────────────────────────

/** Soft pointer-enter tick. Independent throttle from click. */
export function playUiHover(): void {
  lastHoverAt = play(hoverEl, HOVER_THROTTLE_MS, lastHoverAt);
}

/** Click / activation tick — slightly louder + longer than hover. */
export function playUiClick(): void {
  lastClickAt = play(clickEl, CLICK_THROTTLE_MS, lastClickAt);
}
