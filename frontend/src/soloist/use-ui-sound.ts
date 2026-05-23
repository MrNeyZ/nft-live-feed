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

const HOVER_THROTTLE_MS = 50;
const CLICK_THROTTLE_MS = 20;

// ── Sound packs ──────────────────────────────────────────────────────────────
// Three selectable packs, each mapping the three UI channels (hover tick,
// click tick, notification = deep-discount alert) to asset URLs. `legacy` is
// the default so existing behaviour is unchanged unless the operator switches.
//   legacy — the original recorded AAC assets already shipping on the site.
//   clean  — uploaded /sounds/{hover,click,notification}.mp3
//   alt    — uploaded /sounds/{hover,click,notification}_alt.mp3
// All resolution flows through `pack()`; pools/alert are rebuilt on switch.
export type SoundPackName = 'legacy' | 'clean' | 'alt' | 'candy';
export const SOUND_PACK_NAMES: readonly SoundPackName[] = ['legacy', 'clean', 'alt', 'candy'];
// Per-channel `gain` multiplies the base HOVER_GAIN/CLICK_GAIN (and the alert's
// 1.0) so a pack can be balanced without touching the trigger/pool logic.
// Optional semantic channels — only `candy` ships dedicated assets. For other
// packs they fall back to playUiClick (see playNamed below).
type NamedChannel = 'select' | 'undo' | 'error' | 'login' | 'logout' | 'confirm';
interface SoundPack {
  hover: string; click: string; notification: string;
  select?: string; undo?: string; error?: string;
  login?: string; logout?: string; confirm?: string;
  gain: { hover: number; click: number; notification: number;
    select?: number; undo?: number; error?: number;
    login?: number; logout?: number; confirm?: number };
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
    gain: { hover: 0.12, click: 0.30, notification: 0.50 },  // vs legacy
  },
  alt: {
    hover:        '/sounds/hover_alt.mp3?v=1',
    click:        '/sounds/click_alt.mp3?v=1',
    notification: '/sounds/notification_alt.mp3?v=1',
    gain: { hover: 0.12, click: 0.30, notification: 0.50 },  // vs legacy
  },
  // CandyLabs assets — properly mastered already, so they bypass the Web Audio
  // softening (lowpass + attack ramp) and play directly like legacy. Dedicated
  // files for several semantic channels; other packs fall back to a click tick
  // for those (no notification spam, no per-event allocations).
  candy: {
    hover:        '/sounds/candylabs/hover.wav?v=1',
    click:        '/sounds/candylabs/button-click.wav?v=1',
    notification: '/sounds/candylabs/confirm.wav?v=1',
    select:       '/sounds/candylabs/builder-trait-select.wav?v=1',
    undo:         '/sounds/candylabs/builder-undo.wav?v=1',
    error:        '/sounds/candylabs/ui-unable.wav?v=1',
    login:        '/sounds/candylabs/log-in.wav?v=1',
    logout:       '/sounds/candylabs/log-out.wav?v=1',
    confirm:      '/sounds/candylabs/confirm.wav?v=1',
    // Real Candylabs runtime volumes (discovered from their production bundle).
    gain: {
      hover: 0.35, click: 0.60, notification: 0.70,
      select: 0.60, undo: 0.60, error: 0.80,
      login: 0.35, logout: 0.35, confirm: 0.70,
    },
  },
};

function readPack(): SoundPackName {
  if (typeof window === 'undefined') return 'candy';
  try {
    const v = window.localStorage.getItem(PACK_KEY);
    // Default pack is `candy` for first-time visitors; any explicitly-saved
    // choice (incl. 'legacy') is honored so returning users keep their pref.
    if (v === 'legacy' || v === 'clean' || v === 'alt' || v === 'candy') return v;
    return 'candy';
  } catch { return 'candy'; }
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
  if (next) {
    // Going ON — flip + prime first so the login tick has assets ready.
    enabled = true;
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(STORAGE_KEY, 'on'); }
      catch { /* quota / private mode — fail silent */ }
    }
    primeAudio();
    for (const fn of listeners) fn();
    playUiLogin();
  } else {
    // Going OFF — force-fire logout *first* so it bypasses the enabled
    // gate that's about to flip. Then defer the actual disable by a
    // short delay so the audio element has a window of "enabled === true"
    // state in case anything downstream (Web Audio resume, etc.) reads it
    // during the play() startup. localStorage is written immediately so
    // the OFF state survives a reload that races the delay.
    playNamed('logout', { force: true });
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(STORAGE_KEY, 'off'); }
      catch { /* quota / private mode — fail silent */ }
    }
    setTimeout(() => {
      enabled = false;
      for (const fn of listeners) fn();
    }, 100);
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

// ── Optional softening (clean/alt only) ─────────────────────────────────────
// Routes each pooled element through a single shared AudioContext:
//   MediaElementSource → lowpass (trim harsh highs) → gain (per-play attack).
// The gain ramps 0→1 over a few ms each play to round off the sharp click
// transient. Legacy is NEVER routed (bit-identical playback). Falls back to
// plain HTMLAudio playback when Web Audio is unavailable or routing throws.
const SOFTEN: Record<'hover' | 'click', { lowpass: number; attackMs: number }> = {
  hover: { lowpass: 6500, attackMs: 6 },
  click: { lowpass: 5800, attackMs: 6 },
};
let audioCtx: AudioContext | null = null;
function ensureCtx(): AudioContext | null {
  if (audioCtx) return audioCtx;
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try { audioCtx = new AC(); } catch { audioCtx = null; }
  return audioCtx;
}
function resumeCtx(): void {
  if (audioCtx && audioCtx.state === 'suspended') { void audioCtx.resume().catch(() => undefined); }
}

interface PoolItem { el: HTMLAudioElement; envGain?: GainNode; attackMs?: number; }
let hoverPool: PoolItem[] = [];
let clickPool: PoolItem[] = [];
let hoverIdx = 0;
let clickIdx = 0;
let lastHoverAt = 0;
let lastClickAt = 0;
let primed = false;

function buildPool(url: string, gain: number, channel?: 'hover' | 'click'): PoolItem[] {
  const out: PoolItem[] = [];
  // Only clean/alt are softened; legacy AND candy stay on the plain element
  // path (candy's WAVs already have proper tonal balance).
  const soften = channel && activePack !== 'legacy' && activePack !== 'candy'
    ? SOFTEN[channel] : null;
  const ctx = soften ? ensureCtx() : null;
  for (let i = 0; i < POOL_SIZE; i++) {
    try {
      const a = new Audio(url);
      a.preload = 'auto';
      a.volume  = gain;
      if (soften && ctx) {
        try {
          const src = ctx.createMediaElementSource(a);
          const lp  = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = soften.lowpass;
          const env = ctx.createGain();
          env.gain.value = 1;
          src.connect(lp); lp.connect(env); env.connect(ctx.destination);
          out.push({ el: a, envGain: env, attackMs: soften.attackMs });
          continue;
        } catch { /* routing failed — fall back to plain element below */ }
      }
      out.push({ el: a });
    } catch { /* skip — partially filled pool still works */ }
  }
  return out;
}

function primeAudio(): void {
  if (primed || typeof window === 'undefined') return;
  primed = true;
  try {
    hoverPool = buildPool(pack().hover, HOVER_GAIN * pack().gain.hover, 'hover');
    clickPool = buildPool(pack().click, CLICK_GAIN * pack().gain.click, 'click');
    resumeCtx();
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
  // Disconnect any Web Audio graph from the old pack before dropping refs
  // (the shared AudioContext is reused — never recreated).
  for (const it of [...hoverPool, ...clickPool]) {
    try { it.envGain?.disconnect(); } catch { /* already gone */ }
  }
  hoverPool = [];
  clickPool = [];
  deepDiscountAudio = null;
  // Drop the lazy pools for the prior pack; next playNamed() rebuilds.
  namedPoolCache.clear();
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
function getPackServerSnapshot(): SoundPackName { return 'candy'; }
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
    resumeCtx();  // unlock the AudioContext on the first gesture (clean/alt)
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
    if (target.closest('[data-uisnd="skip"]')) return; // owner plays its own
    const from = findClickableAncestor(e.relatedTarget);
    if (from === target) return;                 // moved within same clickable
    playUiHover();
  }, { passive: true });

  document.addEventListener('click', (e) => {
    if (!enabled) return;
    const target = findClickableAncestor(e.target);
    if (!target) return;
    if (target.closest('[data-uisnd="skip"]')) return; // owner plays its own
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
  pool: PoolItem[],
  state: PoolState,
  throttleMs: number,
  lastAt: number,
): number {
  if (!enabled) return lastAt;
  if (reducedMotion()) return lastAt;
  if (pool.length === 0) return lastAt;
  const now = performance.now();
  if (now - lastAt < throttleMs) return lastAt;
  const item = pool[state.idx];
  state.idx = (state.idx + 1) % pool.length;
  // currentTime = 0 still cheap; on a fresh pool instance it's usually
  // already 0 anyway. play() returns a Promise — swallow rejections
  // (browsers reject when invoked before the first user gesture).
  try {
    // Softened (clean/alt) items ramp their envelope gain 0→1 over attackMs to
    // round off the transient; the lowpass is static. No-op for legacy.
    if (item.envGain && audioCtx) {
      resumeCtx();
      const t = audioCtx.currentTime;
      const a = (item.attackMs ?? 8) / 1000;
      item.envGain.gain.cancelScheduledValues(t);
      item.envGain.gain.setValueAtTime(0, t);
      item.envGain.gain.linearRampToValueAtTime(1, t + a);
    }
    item.el.currentTime = 0;
    void item.el.play().catch(() => undefined);
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

// ── Semantic channels (low-frequency events) ─────────────────────────────────
// select / undo / error / login / logout. Only `candy` ships dedicated assets;
// other packs fall back to a normal click tick so they never get louder/longer
// than their existing UI feedback. Lazy singleton HTMLAudio per (pack,channel)
// — no pools (these events are infrequent) and no allocations per event. A
// 250 ms per-channel throttle guards against accidental spam.
const NAMED_THROTTLE_MS = 80;
const NAMED_POOL_SIZE   = 2;
interface NamedPoolEntry { pool: HTMLAudioElement[]; idx: number }
const namedPoolCache = new Map<string, NamedPoolEntry>(); // key = `${pack}:${ch}`
const namedLastAt: Record<NamedChannel, number> = {
  select: 0, undo: 0, error: 0, login: 0, logout: 0, confirm: 0,
};

function playNamed(ch: NamedChannel, opts?: { force?: boolean }): void {
  // `force` lets the logout transition fire *while* enabled is being
  // flipped to false — every other path keeps the normal enabled gate.
  if (!opts?.force && !enabled) return;
  if (reducedMotion()) return;
  const now = performance.now();
  if (now - namedLastAt[ch] < NAMED_THROTTLE_MS) return;
  const url  = pack()[ch];
  const gain = pack().gain[ch];
  if (!url) {                       // pack has no dedicated asset → click fallback
    playUiClick();
    namedLastAt[ch] = now;
    return;
  }
  const key = `${activePack}:${ch}`;
  let entry = namedPoolCache.get(key);
  if (!entry) {
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < NAMED_POOL_SIZE; i++) {
      try {
        const a = new Audio(url);
        a.preload = 'auto';
        a.volume  = typeof gain === 'number' ? gain : 1.0;
        pool.push(a);
      } catch { /* skip — partial pool still works */ }
    }
    if (pool.length === 0) return;
    entry = { pool, idx: 0 };
    namedPoolCache.set(key, entry);
  }
  const a = entry.pool[entry.idx];
  entry.idx = (entry.idx + 1) % entry.pool.length;
  try {
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch { /* invalid state — skip */ }
  namedLastAt[ch] = now;
}

export function playUiSelect():  void { playNamed('select');  }
export function playUiUndo():    void { playNamed('undo');    }
export function playUiError():   void { playNamed('error');   }
export function playUiLogin():   void { playNamed('login');   }
export function playUiLogout():  void { playNamed('logout');  }
export function playUiConfirm(): void { playNamed('confirm'); }

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
