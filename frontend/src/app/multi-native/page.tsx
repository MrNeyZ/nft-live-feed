'use client';

// VictoryLabs — Multi-tab (NATIVE, Stage 2 — flagged route).
// Native React composition of the three Stage-1 panels, with NO iframes.
// This route exists alongside the live iframe `/multi` so the native build
// can be proven before any cutover. `/multi` remains the default/production
// version and is NOT modified.
//
//   ┌───────────┬───────────────┬───────────┐
//   │ MintFeed  │   RareFeed    │ SalesFeed │
//   │  (left)   │   (center)    │  (right)  │
//   └───────────┴───────────────┴───────────┘
//
// Efficiency vs. the iframe version: one React root (no 3 app shells / 3
// Gates), and the mint column subscribes to ONLY mint events (the hidden
// collections-table subsystem the iframe ran is gone). Stream dedup (one
// shared EventSource) is a later step — NOT done here.

import { useEffect } from 'react';
import { MintFeedPanel } from '@/app/mints/MintFeedPanel';
import { RareFeedPanel } from '@/app/tools/rare-feed/RareFeedPanel';
import { SalesFeedPanel } from '@/app/feed/SalesFeedPanel';

// Frameless grid cell — flex column so each panel's `flex: 1` fills the
// cell height cross-browser. NO border/background/shadow here: the panels
// carry their own native frame, so there is no frame-inside-frame.
const CELL: React.CSSProperties = {
  minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
};

export default function MultiNativePage() {
  useEffect(() => { document.title = 'VictoryLabs — Multi-tab (native)'; }, []);

  return (
    // data-embedded="1" so the embed performance CSS applies to the panels:
    //   • `.feed-root[data-embedded="1"]` → zero horizontal page gutter
    //   • the paint band-aid → no entrance/flash animations + no per-card
    //     glow blur for the three side-by-side card feeds.
    // Gate already hides the BottomStatusBar for any `/multi*` path and the
    // layout-mode zoom resolves to 1 in multi/embedded contexts.
    <div className="feed-root page-transition" data-embedded="1">
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gridTemplateRows: '1fr',
        gap: 12,
        padding: '16px 0',
        minHeight: 0,
      }}>
        <div style={CELL}><MintFeedPanel /></div>
        <div style={CELL}><RareFeedPanel /></div>
        <div style={CELL}><SalesFeedPanel /></div>
      </div>
    </div>
  );
}
