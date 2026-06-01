'use client';

// VictoryLabs — /multi cross-column highlight bridge.
// The compact Rare strip is a discovery layer over the Live Feed Sales column:
//   • hovering a rare row transiently highlights the matching sale card;
//   • clicking selects it persistently AND scrolls it into view.
// `activeMint = hoveredMint ?? selectedMint` is what the Sales panel highlights;
// scrolling is driven only by `selectNonce` (click), never by hover. /multi-only
// — outside the provider the hook returns null, so /feed is unaffected.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface RareHighlight {
  selectedMint: string | null;
  hoveredMint:  string | null;
  /** What the Sales feed should highlight right now. */
  activeMint:   string | null;
  /** Bumps on each click so re-selecting the same mint re-triggers scroll. */
  selectNonce:  number;
  /** Click: toggle persistent selection (re-click clears). */
  selectMint:   (mint: string | null) => void;
  /** Hover: transient highlight (null on mouse-leave). */
  hoverMint:    (mint: string | null) => void;
}

const RareHighlightContext = createContext<RareHighlight | null>(null);

/** Null outside <RareHighlightProvider> (e.g. on /feed) → no-op. */
export function useRareHighlight(): RareHighlight | null {
  return useContext(RareHighlightContext);
}

export function RareHighlightProvider({ children }: { children: React.ReactNode }) {
  const [selectedMint, setSelected] = useState<string | null>(null);
  const [hoveredMint, setHovered] = useState<string | null>(null);
  const [selectNonce, setNonce] = useState(0);

  const selectMint = useCallback((mint: string | null) => {
    setSelected((prev) => (prev === mint ? null : mint));   // re-click clears
    setNonce((n) => n + 1);
  }, []);
  const hoverMint = useCallback((mint: string | null) => setHovered(mint), []);

  const value = useMemo<RareHighlight>(() => ({
    selectedMint,
    hoveredMint,
    activeMint: hoveredMint ?? selectedMint,
    selectNonce,
    selectMint,
    hoverMint,
  }), [selectedMint, hoveredMint, selectNonce, selectMint, hoverMint]);

  return <RareHighlightContext.Provider value={value}>{children}</RareHighlightContext.Provider>;
}
