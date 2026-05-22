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
const PACK_KEY    = 'vl.uiSoundPack';

const HOVER_THROTTLE_MS = 80;
const CLICK_THROTTLE_MS = 40;

// ── Sound packs ──────────────────────────────────────────────────────────────
// Three selectable packs, each mapping the three UI channels (hover tick,
// click tick, notification = deep-discount alert) to asset URLs. `legacy` is
// the default so existing behaviour is unchanged unless the operator switches.
//   legacy — the original recorded AAC assets already shipping on the site.
//   clean  — uploaded /sounds/{hover,click,notification}.mp3
//   alt    — uploaded /sounds/{hover,click,notification}_alt.mp3
// All resolution flows through `pack()`; pools/alert are rebuilt on switch.
export type SoundPackName = 'legacy' | 'clean' | 'alt';
export const SOUND_PACK_NAMES: readonly SoundPackName[] = ['legacy', 'clean', 'alt'];
// Per-channel `gain` multiplies the base HOVER_GAIN/CLICK_GAIN (and the alert's
// 1.0) so a pack can be balanced without touching the trigger/pool logic.
interface SoundPack {
  hover: string; click: string; notification: string;
  gain: { hover: number; click: number; notification: number };
}
const SOUND_PACKS: Record<SoundPackName, SoundPack> = {
  legacy: {
    hover:        '/sounds/ui-hover.m4a?v=8',
    click:        '/sounds/ui-click.m4a?v=8',
    // Deep-discount alert — hot-loud AAC so the operator won't miss it.
    notification: '/sounds/deep-discount-alert.m4a?v=2',
    gain: { hover: 1.0, click: 1.0, notification: 1.0 },  // legacy unchanged
  },
  clean: {
    hover:        '/sounds/hover.mp3?v=1',
    click:        '/sounds/click.mp3?v=1',
    notification: '/sounds/notification.mp3?v=1',
    gain: { hover: 0.15, click: 0.25, notification: 0.50 },  // vs legacy
  },
  alt: {
    hover:        '/sounds/hover_alt.mp3?v=1',
    click:        '/sounds/click_alt.mp3?v=1',
    notification: '/sounds/notification_alt.mp3?v=1',
    gain: { hover: 0.15, click: 0.25, notification: 0.50 },  // vs legacy
  },
};

function readPack(): SoundPackName {
  if (typeof window === 'undefined') return 'legacy';
  try {
    const v = window.localStorage.getItem(PACK_KEY);
    return (v === 'clean' || v === 'alt') ? v : 'legacy';
  } catch { return 'legacy'; }
}
let activePack: SoundPackName = readPack();
function pack(): SoundPack { return SOUND_PACKS[activePack]; }
const packListeners = new Set<() => void>();

// Played at most once per signature and rate-limited globally so a flurry of
// cheap dumps can't turn the page into a slot machine. File missing → fail
// silent (HTMLAudio play() rejects, swallowed below).
const DEEP_DISCOUNT_COOLDOWN_MS = 8_000;
const DEEP_DISCOUNT_SEEN_MAX    = 500;
/** Per-sound pool size — multiple preloaded HTMLAudioElement
 *  instances rotated round-robin so a rapid retrigger doesn't wait
 *  for the previous play() to finish or for a `currentTime = 0`
 *  reset round-trip. Three is enough for typical hover sweeps. */
const POOL_SIZE = 3;
// HTMLMediaElement.volume kept at 1.0 — the assets themselves now
// carry full perceived loudness (3x amplified in-place: hover post-peak
// ~0.099, click post-peak ~0.324, both well below the 0.99 ceiling so
// no clipping). Hover stays quieter than click via the asset amplitude
// difference, so volume scaling here would only attenuate.
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

// ── Audio pools (lazy, primed after first user gesture) ───────────────────
//
// Per-sound pool of POOL_SIZE preloaded HTMLAudioElement instances.
// Rotated round-robin per play() so a rapid retrigger uses a fresh
// instance instead of waiting for the previous play to settle (the
// `currentTime = 0; play()` round-trip can introduce a few-ms gap on
// some browsers; rotating eliminates it entirely).

let hoverPool: HTMLAudioElement[] = [];
let clickPool: HTMLAudioElement[] = [];
let hoverIdx = 0;
let clickIdx = 0;
let lastHoverAt = 0;
let lastClickAt = 0;
let primed = false;

function buildPool(url: string, gain: number): HTMLAudioElement[] {
  const out: HTMLAudioElement[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    try {
      const a = new Audio(url);
      a.preload = 'auto';
      a.volume  = gain;
      out.push(a);
    } catch { /* skip — partially filled pool still works */ }
  }
  return out;
}

function primeAudio(): void {
  if (primed || typeof window === 'undefined') return;
  primed = true;
  try {
    hoverPool = buildPool(pack().hover, HOVER_GAIN * pack().gain.hover);
    clickPool = buildPool(pack().click, CLICK_GAIN * pack().gain.click);
  } catch {
    hoverPool = [];
    clickPool = [];
  }
}

// ── Pack switching ───────────────────────────────────────────────────────────
// Tear down cached pools + the lazy alert element so the next play() builds
// them from the newly-active pack's URLs. Re-prime immediately when sound is on
// so the switch has zero perceived latency. No new event listeners are added.
function rebuildForPack(): void {
  primed = false;
  hoverPool = [];
  clickPool = [];
  deepDiscountAudio = null;
  if (enabled) primeAudio();
}

export function setUiSoundPack(next: SoundPackName): void {
  if (next === activePack) return;
  activePack = next;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(PACK_KEY, next); }
    catch { /* quota / private mode — fail silent */ }
  }
  rebuildForPack();
  for (const fn of packListeners) fn();
  // Confirmation tick (only if sound is enabled) so the operator hears the pack.
  if (enabled) playUiClick();
}

function getPackSnapshot():       SoundPackName { return activePack; }
function getPackServerSnapshot(): SoundPackName { return 'legacy'; }
function subscribePack(cb: () => void): () => void {
  packListeners.add(cb);
  return () => { packListeners.delete(cb); };
}
/** Cross-component reactive read of the active sound pack. */
export function useUiSoundPack(): SoundPackName {
  return useSyncExternalStore(subscribePack, getPackSnapshot, getPackServerSnapshot);
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

// ── Global delegation: every clickable surface gets sounds ────────────────
//
// Walks up the DOM from the event target to find the nearest interactive
// element (button, anchor with href, or role=button). Hover sound fires
// only when the pointer ENTERS a new clickable ancestor (i.e. the
// relatedTarget's clickable ancestor differs) — moving within the same
// button doesn't re-tick. Click fires on every click of a clickable.
//
// This is what enables the spec rule "all clickable objects tick;
// non-clickable bubbles in tables don't" — table badges / value cells
// are spans without role=button, so they're naturally excluded.
//
// Disabled buttons (HTMLButtonElement.disabled or aria-disabled="true"
// on a role=button surface) are silenced too. play* functions still
// gate on `enabled` / reduced-motion / throttle internally, so the
// listeners are cheap to leave installed even when sound is OFF.
function findClickableAncestor(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el && el !== document.body) {
    if (el instanceof HTMLButtonElement) {
      return el.disabled ? null : el;
    }
    if (el instanceof HTMLAnchorElement && el.href) {
      return el;
    }
    if (el.getAttribute && el.getAttribute('role') === 'button') {
      return el.getAttribute('aria-disabled') === 'true' ? null : el;
    }
    el = el.parentElement;
  }
  return null;
}

let globalListenersInstalled = false;
function installGlobalUiSoundListeners(): void {
  if (globalListenersInstalled || typeof document === 'undefined') return;
  globalListenersInstalled = true;

  document.addEventListener('pointerover', (e) => {
    if (!enabled) return;                        // cheap pre-gate
    const target = findClickableAncestor(e.target);
    if (!target) return;
    const from = findClickableAncestor(e.relatedTarget);
    if (from === target) return;                 // moved within same clickable
    playUiHover();
  }, { passive: true });

  document.addEventListener('click', (e) => {
    if (!enabled) return;
    if (!findClickableAncestor(e.target)) return;
    playUiClick();
  }, { passive: true });
}
if (typeof document !== 'undefined') installGlobalUiSoundListeners();

// ── Reduced-motion respect ─────────────────────────────────────────────────

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Internal play helper ───────────────────────────────────────────────────

interface PoolState { idx: number; }

function playFromPool(
  pool: HTMLAudioElement[],
  state: PoolState,
  throttleMs: number,
  lastAt: number,
): number {
  if (!enabled) return lastAt;
  if (reducedMotion()) return lastAt;
  if (pool.length === 0) return lastAt;
  const now = performance.now();
  if (now - lastAt < throttleMs) return lastAt;
  const el = pool[state.idx];
  state.idx = (state.idx + 1) % pool.length;
  // currentTime = 0 still cheap; on a fresh pool instance it's usually
  // already 0 anyway. play() returns a Promise — swallow rejections
  // (browsers reject when invoked before the first user gesture).
  try {
    el.currentTime = 0;
    void el.play().catch(() => undefined);
  } catch { /* element in invalid state — ignore one tick */ }
  return now;
}

// ── Public play surface ────────────────────────────────────────────────────

const _hoverState: PoolState = { get idx() { return hoverIdx; }, set idx(v) { hoverIdx = v; } };
const _clickState: PoolState = { get idx() { return clickIdx; }, set idx(v) { clickIdx = v; } };

/** Soft pointer-enter tick. Independent throttle from click. */
export function playUiHover(): void {
  lastHoverAt = playFromPool(hoverPool, _hoverState, HOVER_THROTTLE_MS, lastHoverAt);
}

/** Click / activation tick — slightly louder + longer than hover. */
export function playUiClick(): void {
  lastClickAt = playFromPool(clickPool, _clickState, CLICK_THROTTLE_MS, lastClickAt);
}

// ── Deep-discount alert (rare, signature-deduped, throttled) ──────────────
//
// Single HTMLAudioElement is enough — the alert fires at most once per
// ~8 s. Lazy-instantiated so no network request is made until the first
// trigger. Respects the same `enabled` toggle and reduced-motion check as
// the hover/click ticks; the per-signature `seen` Set + global cooldown
// stop the alert from spamming when several deep-discount sales arrive
// in a single SSE burst.
let deepDiscountAudio: HTMLAudioElement | null = null;
let lastDeepDiscountAt = 0;
const deepDiscountSeen = new Set<string>();
function rememberDeepDiscount(sig: string): void {
  if (deepDiscountSeen.has(sig)) return;
  deepDiscountSeen.add(sig);
  if (deepDiscountSeen.size <= DEEP_DISCOUNT_SEEN_MAX) return;
  // Drop the oldest insertion (Set preserves insertion order).
  const overflow = deepDiscountSeen.size - DEEP_DISCOUNT_SEEN_MAX;
  const it = deepDiscountSeen.values();
  for (let i = 0; i < overflow; i++) {
    const r = it.next();
    if (r.done) break;
    deepDiscountSeen.delete(r.value);
  }
}

/** Play the deep-discount alert once per `signature`, gated by the
 *  `enabled` toggle, reduced-motion, and a global ~8 s cooldown. Safe
 *  to call from SSE listeners — no-ops on the server (no `window`),
 *  on duplicate signatures, or before the first user gesture has
 *  unlocked autoplay (HTMLAudio play() rejects, swallowed below). */
export function playDeepDiscountAlert(signature: string): void {
  if (!enabled) return;
  if (typeof window === 'undefined') return;
  if (reducedMotion()) return;
  if (!signature || deepDiscountSeen.has(signature)) return;
  const now = performance.now();
  if (now - lastDeepDiscountAt < DEEP_DISCOUNT_COOLDOWN_MS) return;
  rememberDeepDiscount(signature);
  lastDeepDiscountAt = now;
  try {
    if (!deepDiscountAudio) {
      deepDiscountAudio = new Audio(pack().notification);
      deepDiscountAudio.preload = 'auto';
      deepDiscountAudio.volume  = 1.0 * pack().gain.notification;
    }
    deepDiscountAudio.currentTime = 0;
    void deepDiscountAudio.play().catch(() => undefined);
  } catch { /* asset missing or invalid state — silent */ }
}
