'use client';

// VictoryLabs — /multi cross-column highlight bridge.
// Lets the compact Rare Feed act as a discovery layer over the Live Feed
// Sales column: clicking a rare row publishes the target mint here, and the
// Sales panel highlights + scrolls the matching card into view. /multi-only —
// outside the provider the hook returns null, so /feed is unaffected.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface RareHighlight {
  /** Mint to highlight in the Sales feed (null = nothing highlighted). */
  mint: string | null;
  /** Bumps on every click so re-selecting the same mint re-triggers scroll. */
  nonce: number;
  /** Publish a mint to highlight (toggles off if the same mint is re-clicked). */
  select: (mint: string | null) => void;
}

const RareHighlightContext = createContext<RareHighlight | null>(null);

/** Null outside <RareHighlightProvider> (e.g. on /feed) → no-op. */
export function useRareHighlight(): RareHighlight | null {
  return useContext(RareHighlightContext);
}

export function RareHighlightProvider({ children }: { children: React.ReactNode }) {
  const [mint, setMint] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const select = useCallback((m: string | null) => {
    setMint((prev) => (prev === m ? null : m));   // re-click clears
    setNonce((n) => n + 1);
  }, []);
  const value = useMemo(() => ({ mint, nonce, select }), [mint, nonce, select]);
  return <RareHighlightContext.Provider value={value}>{children}</RareHighlightContext.Provider>;
}
