'use client';

// VictoryLabs — native Multi-tab layout (shared).
// Single source of truth for the two-column native composition (no iframes),
// mirroring /mints' [table] | [live feed] structure: LEFT
// DashboardCollectionsPanel (trending-collections table, the /dashboard data
// model) · RIGHT SalesFeedPanel (the /feed sales stream, already native).
// Rendered by BOTH /multi (default/production) and /multi-native (kept as a
// fallback/reference) so there is one implementation of the layout.
//
// Rare Feed (RareFeedCompactPanel) and the mint-events-only MintFeedPanel
// have been REMOVED from this layout (confirmed with the user — Rare Feed is
// being dropped from /multi altogether, not relocated). RareHighlightProvider
// only existed to bridge Rare-row hover/click to the Sales panel, so it goes
// with it; <SalesFeedPanel>'s own `useRareHighlight()` call returns null
// outside a provider (its documented fallback), so it needs no edit here.
//
// data-embedded="1" applies the embed performance CSS (zero feed-root
// horizontal gutter + the card paint band-aid). Gate hides the BottomStatusBar
// for /multi* paths and shows TopNav + the PC/Laptop/Phone switcher; layout-mode
// zoom resolves to 1 in multi/embedded contexts.

import { DashboardCollectionsPanel } from './DashboardCollectionsPanel';
import { SalesFeedPanel } from '@/app/feed/SalesFeedPanel';
import { SaleStreamProvider } from './lib/sale-event-stream';
import { MultiSalesProvider } from './lib/multi-sales';

// Frameless grid cell — flex column so each panel's `flex: 1` fills the cell
// height cross-browser. NO border/background/shadow (panels carry their own
// native frame → no frame-inside-frame).
const CELL: React.CSSProperties = {
  minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
};

export function MultiNativeView() {
  return (
    // One shared EventSource for the whole page: the sales + mint panels
    // register their handlers on it instead of opening a connection each.
    <SaleStreamProvider>
     <MultiSalesProvider>
      <div className="feed-root page-transition" data-embedded="1">
        <div style={{
          flex: 1,
          display: 'grid',
          // 2-way split mirroring /mints ([table] | [live feed]): the
          // collections table gets slightly less width than the sales feed,
          // whose cards need more horizontal room.
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)',
          gridTemplateRows: '1fr',
          gap: 12,
          // Outer horizontal gutter = the responsive page gutter (--page-x),
          // matching the iframe /multi spacing; vertical 16px.
          padding: '16px var(--page-x, 16px)',
          minHeight: 0,
        }}>
          <div style={CELL}><DashboardCollectionsPanel /></div>
          <div style={CELL}><SalesFeedPanel /></div>
        </div>
      </div>
     </MultiSalesProvider>
    </SaleStreamProvider>
  );
}
