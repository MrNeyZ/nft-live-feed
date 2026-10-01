'use client';

/**
 * iOS-Photos-style drag selection for the sweep.
 *
 * Mouse: press on a selectable card and drag — every card in the range
 * between the first and the current card gets the same state.
 * Touch: long-press (LONG_PRESS_MS, no movement) arms it, then slide the
 * finger; page scroll is blocked while armed.
 *
 * Mode comes from the first card: unselected → select, selected → deselect.
 * The range is recomputed from a snapshot each move, so dragging back
 * shrinks it (same as Photos). Cards opt in via `data-sweep-mint`.
 */
import { useEffect, useRef, type RefObject } from 'react';

const LONG_PRESS_MS = 350;
const MOVE_SLOP_PX = 8;
const EDGE_PX = 48;
const EDGE_SCROLL_PX = 14;

export function useDragSelect(
  containerRef: RefObject<HTMLElement | null>,
  getSelection: () => Set<string>,
  setSelection: (next: Set<string>) => void,
  enabled: boolean,
): void {
  const getRef = useRef(getSelection);
  const setRef = useRef(setSelection);
  getRef.current = getSelection;
  setRef.current = setSelection;

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) return;

    type Drag = {
      pointerId: number; touch: boolean; armed: boolean;
      startMint: string; mode: boolean; base: Set<string>;
      x0: number; y0: number; x: number; y: number; lastMint: string | null;
      timer: ReturnType<typeof setTimeout> | null; raf: number | null;
    };
    let drag: Drag | null = null;
    let suppressClick = false;

    const cardAt = (x: number, y: number): HTMLElement | null =>
      (document.elementFromPoint(x, y)?.closest('[data-sweep-mint]') as HTMLElement | null) ?? null;
    const mintsInOrder = (): string[] =>
      Array.from(root.querySelectorAll<HTMLElement>('[data-sweep-mint]')).map(el => el.dataset.sweepMint!);

    const applyRange = (endMint: string) => {
      if (!drag) return;
      const order = mintsInOrder();
      const a = order.indexOf(drag.startMint), b = order.indexOf(endMint);
      if (a < 0 || b < 0) return;
      const next = new Set(drag.base);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (drag.mode) next.add(order[i]); else next.delete(order[i]);
      }
      drag.lastMint = endMint;
      setRef.current(next);
    };

    const arm = () => {
      if (!drag) return;
      drag.armed = true;
      suppressClick = true;
      if (drag.touch && 'vibrate' in navigator) { try { navigator.vibrate(10); } catch { /* ignore */ } }
      applyRange(drag.startMint);
      const tick = () => {
        if (!drag?.armed) return;
        const r = root.getBoundingClientRect();
        let dy = 0;
        if (drag.y < r.top + EDGE_PX) dy = -EDGE_SCROLL_PX;
        else if (drag.y > r.bottom - EDGE_PX) dy = EDGE_SCROLL_PX;
        if (dy) {
          root.scrollTop += dy;
          const c = cardAt(drag.x, Math.min(Math.max(drag.y, r.top + 1), r.bottom - 1));
          const m = c?.dataset.sweepMint;
          if (m && m !== drag.lastMint) applyRange(m);
        }
        drag.raf = requestAnimationFrame(tick);
      };
      drag.raf = requestAnimationFrame(tick);
    };

    const end = () => {
      if (!drag) return;
      if (drag.timer) clearTimeout(drag.timer);
      if (drag.raf != null) cancelAnimationFrame(drag.raf);
      drag = null;
      // Let the trailing click (same task) be swallowed, then reset.
      setTimeout(() => { suppressClick = false; }, 0);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const t = e.target as HTMLElement;
      if (t.closest('a,button,input')) return;
      const card = t.closest('[data-sweep-mint]') as HTMLElement | null;
      if (!card || !root.contains(card)) return;
      const mint = card.dataset.sweepMint!;
      const base = new Set(getRef.current());
      const touch = e.pointerType !== 'mouse';
      drag = {
        pointerId: e.pointerId, touch, armed: false,
        startMint: mint, mode: !base.has(mint), base,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lastMint: null,
        timer: null, raf: null,
      };
      if (touch) drag.timer = setTimeout(arm, LONG_PRESS_MS);
      else e.preventDefault();  // no text selection while dragging
    };

    const onMove = (x: number, y: number) => {
      if (!drag) return;
      drag.x = x; drag.y = y;
      const moved = Math.hypot(x - drag.x0, y - drag.y0) > MOVE_SLOP_PX;
      if (!drag.armed) {
        if (!moved) return;
        if (drag.touch) { end(); return; }  // finger moved before long-press → it's a scroll
        arm();                               // mouse: arm on first real movement
      }
      const m = cardAt(x, y)?.dataset.sweepMint;
      if (m && m !== drag.lastMint) applyRange(m);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId || drag.touch) return;
      onMove(e.clientX, e.clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!drag?.touch) return;
      const t = e.touches[0];
      if (!t) return;
      if (drag.armed) e.preventDefault();  // block page scroll while selecting
      onMove(t.clientX, t.clientY);
    };
    const onUp = () => end();
    // Armed touch: we own the gesture (touchmove is preventDefault'ed), so a
    // late pointercancel from the browser must not drop the selection drag.
    const onCancel = () => { if (!drag?.armed || !drag.touch) end(); };
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const onContextMenu = (e: Event) => { if (drag) e.preventDefault(); };

    root.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', onUp);
    root.addEventListener('touchcancel', onUp);
    root.addEventListener('click', onClickCapture, true);
    root.addEventListener('contextmenu', onContextMenu);
    return () => {
      end();
      root.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onUp);
      root.removeEventListener('touchcancel', onUp);
      root.removeEventListener('click', onClickCapture, true);
      root.removeEventListener('contextmenu', onContextMenu);
    };
  }, [containerRef, enabled]);
}
