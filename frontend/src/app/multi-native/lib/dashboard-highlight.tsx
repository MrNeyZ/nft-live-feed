'use client';

// VictoryLabs — /multi cross-panel highlight bridge (dashboard -> feed).
// Hovering a collection row in the LEFT DashboardCollectionsPanel highlights
// matching cards in the RIGHT SalesFeedPanel. Deliberately conservative
// (first pass) vs. the retired Rare-strip <-> Sales bridge (rare-highlight.tsx):
// hover-only, no click/select, no scroll, and NO dimming of the rest of the
// feed — matching cards just get the same ring/glow a mouse-hovered card
// already gets. /multi-only — outside the provider the hook returns null.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface DashboardHighlight {
  hoveredSlug: string | null;
  /** Hover: transient highlight (null on mouse-leave). */
  hoverSlug: (slug: string | null) => void;
}

const DashboardHighlightContext = createContext<DashboardHighlight | null>(null);

/** Null outside <DashboardHighlightProvider> (e.g. on /feed) -> no-op. */
export function useDashboardHighlight(): DashboardHighlight | null {
  return useContext(DashboardHighlightContext);
}

export function DashboardHighlightProvider({ children }: { children: React.ReactNode }) {
  const [hoveredSlug, setHovered] = useState<string | null>(null);
  const hoverSlug = useCallback((slug: string | null) => setHovered(slug), []);
  const value = useMemo<DashboardHighlight>(() => ({ hoveredSlug, hoverSlug }), [hoveredSlug, hoverSlug]);
  return <DashboardHighlightContext.Provider value={value}>{children}</DashboardHighlightContext.Provider>;
}
