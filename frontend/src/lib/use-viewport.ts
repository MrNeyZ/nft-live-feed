// SSR-safe viewport hook. Returns the current physical viewport range
// (see @/lib/breakpoints) and width. Uses matchMedia listeners — no
// resize-event spam.
//
// SSR: on the server and on first client render we return a stable initial
// snapshot (range='laptop', width=0). The real value lands on the next
// effect tick. Consumers that need to avoid a hydration mismatch should
// gate their render on `mounted` (also exposed).

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BREAKPOINTS,
  MEDIA,
  rangeForWidth,
  type BreakpointRange,
} from '@/lib/breakpoints';

export interface ViewportInfo {
  width: number;
  range: BreakpointRange;
  mounted: boolean;
  isMobile: boolean;
  isTablet: boolean;
  isSmallLaptop: boolean;
  isLaptop: boolean;
  isDesktopLarge: boolean;
  // "Range or smaller" / "range or larger" helpers — useful for
  // `mobileDown` / `tabletUp` style conditions in markup.
  isMobileDown: boolean;
  isTabletDown: boolean;
  isSmallLaptopDown: boolean;
  isLaptopDown: boolean;
  isTabletUp: boolean;
  isSmallLaptopUp: boolean;
  isLaptopUp: boolean;
  isDesktopLargeUp: boolean;
}

const SSR_DEFAULT: { width: number; range: BreakpointRange } = {
  width: 0,
  range: 'laptop',
};

export function useViewport(): ViewportInfo {
  const [snap, setSnap] = useState(SSR_DEFAULT);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMounted(true);

    const update = () => {
      const w = window.innerWidth;
      setSnap(prev => {
        const r = rangeForWidth(w);
        if (prev.width === w && prev.range === r) return prev;
        return { width: w, range: r };
      });
    };

    update();

    // One matchMedia listener per range boundary. matchMedia change events
    // only fire when crossing the boundary, which is cheap. We also keep a
    // resize listener (passive) so `width` tracks within a range — without
    // it, layouts using `clamp()` look fine but the badge stops updating.
    const mqls = [
      MEDIA.mobile,
      MEDIA.tabletDown,
      MEDIA.smallLaptopDown,
      MEDIA.laptopDown,
    ].map(q => window.matchMedia(q));

    const onMq = () => update();
    mqls.forEach(mq => mq.addEventListener('change', onMq));
    window.addEventListener('resize', update, { passive: true });

    return () => {
      mqls.forEach(mq => mq.removeEventListener('change', onMq));
      window.removeEventListener('resize', update);
    };
  }, []);

  return useMemo<ViewportInfo>(() => {
    const { width, range } = snap;
    return {
      width,
      range,
      mounted,
      isMobile:        range === 'mobile',
      isTablet:        range === 'tablet',
      isSmallLaptop:   range === 'small_laptop',
      isLaptop:        range === 'laptop',
      isDesktopLarge:  range === 'desktop_large',
      isMobileDown:      width > 0 && width <= BREAKPOINTS.mobileMax,
      isTabletDown:      width > 0 && width <= BREAKPOINTS.tabletMax,
      isSmallLaptopDown: width > 0 && width <= BREAKPOINTS.smallLaptopMax,
      isLaptopDown:      width > 0 && width <= BREAKPOINTS.laptopMax,
      isTabletUp:        width >  BREAKPOINTS.mobileMax,
      isSmallLaptopUp:   width >  BREAKPOINTS.tabletMax,
      isLaptopUp:        width >  BREAKPOINTS.smallLaptopMax,
      isDesktopLargeUp:  width >  BREAKPOINTS.laptopMax,
    };
  }, [snap, mounted]);
}
