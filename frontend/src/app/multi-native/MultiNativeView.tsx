'use client';

// VictoryLabs — native Multi-tab layout (shared).
// Single source of truth for the three-column native composition (no
// iframes): LEFT MintFeedPanel · CENTER RareFeedPanel · RIGHT SalesFeedPanel.
// Rendered by BOTH /multi (default/production) and /multi-native (kept as a
// fallback/reference) so there is one implementation of the layout.
//
// data-embedded="1" applies the embed performance CSS (zero feed-root
// horizontal gutter + the card paint band-aid). Gate hides the BottomStatusBar
// for /multi* paths and shows TopNav + the PC/Laptop/Phone switcher; layout-mode
// zoom resolves to 1 in multi/embedded contexts.

import { MintFeedPanel } from '@/app/mints/MintFeedPanel';
import { RareFeedPanel } from '@/app/tools/rare-feed/RareFeedPanel';
import { SalesFeedPanel } from '@/app/feed/SalesFeedPanel';

// Frameless grid cell — flex column so each panel's `flex: 1` fills the cell
// height cross-browser. NO border/background/shadow (panels carry their own
// native frame → no frame-inside-frame).
const CELL: React.CSSProperties = {
  minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
};

export function MultiNativeView() {
  return (
    <div className="feed-root page-transition" data-embedded="1">
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gridTemplateRows: '1fr',
        gap: 12,
        // Outer horizontal gutter = the responsive page gutter (--page-x),
        // matching the iframe /multi spacing; vertical 16px.
        padding: '16px var(--page-x, 16px)',
        minHeight: 0,
      }}>
        <div style={CELL}><MintFeedPanel /></div>
        <div style={CELL}><RareFeedPanel /></div>
        <div style={CELL}><SalesFeedPanel /></div>
      </div>
    </div>
  );
}
