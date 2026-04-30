'use client';

/**
 * UI sound — subtle hover/click tick synthesised via WebAudio.
 *
 * No external audio asset and no library dependencies. All timing /
 * waveform / gain numbers are tuned to a short, mellow "chip" that
 * blends with the dark trading-terminal aesthetic. Defaults to OFF;
 * toggleable from the BottomStatusBar (persisted to localStorage as
 * `vl.uiSound: 'on' | 'off'`). Respects `prefers-reduced-motion` as
 * a proxy for "user dislikes UI flair".
 *
 * Parameters chosen from analysis of the operator's reference sample
 * (~1100 → 700 Hz pitch glide, <100 ms duration, low peak amplitude):
 *   • triangle oscillator (mellower than square, more present than sine)
 *   • 1100 Hz → 700 Hz exponential frequency glide
 *   • 60 ms duration
 *   • 5 ms linear attack, exponential decay to near-silence
 *   • peak gain 0.05
 *   • 80 ms throttle so a fast mouse sweep can't machine-gun ticks
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'vl.uiSound';
const THROTTLE_MS = 80;

const TICK_DURATION_S      = 0.060;
const TICK_ATTACK_S        = 0.005;
const TICK_PEAK_GAIN       = 0.05;
const TICK_FREQ_START_HZ   = 1100;
const TICK_FREQ_END_HZ     = 700;

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
  // Resume a suspended context the moment the operator opts in — some
  // browsers leave it suspended even after the first-gesture init below.
  if (next) {
    void audioCtx?.resume?.().catch(() => undefined);
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

// ── AudioContext (lazy, gated on first user gesture) ───────────────────────

let audioCtx: AudioContext | null = null;
let lastPlayAt = 0;

interface WindowWithAudio extends Window {
  AudioContext?:       typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function ensureContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  if (typeof window === 'undefined') return null;
  try {
    const w = window as WindowWithAudio;
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

let gestureInstalled = false;
function installFirstGestureInit(): void {
  if (gestureInstalled || typeof window === 'undefined') return;
  gestureInstalled = true;
  const init = () => {
    ensureContext();
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

// ── Public play surface ────────────────────────────────────────────────────

/** Fire one tick. No-op when:
 *   • UI sound is disabled (default),
 *   • prefers-reduced-motion is set,
 *   • AudioContext isn't ready (no first gesture yet),
 *   • the previous tick was within `THROTTLE_MS`. */
export function playUiTick(): void {
  if (!enabled) return;
  if (reducedMotion()) return;
  const ctx = ensureContext();
  if (!ctx) return;

  const now = performance.now();
  if (now - lastPlayAt < THROTTLE_MS) return;
  lastPlayAt = now;

  const t0 = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(TICK_FREQ_START_HZ, t0);
  osc.frequency.exponentialRampToValueAtTime(TICK_FREQ_END_HZ, t0 + TICK_DURATION_S);

  const gain = ctx.createGain();
  // 5 ms linear attack → exponential decay to near-silence by end.
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(TICK_PEAK_GAIN, t0 + TICK_ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + TICK_DURATION_S);

  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + TICK_DURATION_S + 0.02);
}
