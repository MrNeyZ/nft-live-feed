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
// being dropped from /multi altogether, not relocated). The old
// RareHighlightProvider bridge went with it.
//
// DashboardHighlightProvider is its replacement bridge, LEFT -> RIGHT this
// time: hovering a collection row in DashboardCollectionsPanel highlights
// matching cards in SalesFeedPanel. Deliberately conservative vs. the old
// Rare bridge — hover-only, no click/select, no scroll, and no dimming of
// the rest of the feed (see dashboard-highlight.tsx doc).
//
// data-embedded="1" applies the embed performance CSS (zero feed-root
// horizontal gutter + the card paint band-aid). Gate hides the BottomStatusBar
// for /multi* paths and shows TopNav + the PC/Laptop/Phone switcher; layout-mode
// zoom resolves to 1 in multi/embedded contexts.

import { DashboardCollectionsPanel } from './DashboardCollectionsPanel';
import { SalesFeedPanel } from '@/app/feed/SalesFeedPanel';
import { SaleStreamProvider, useSaleStreamConnected } from './lib/sale-event-stream';
import { MultiSalesProvider } from './lib/multi-sales';
import { DashboardHighlightProvider } from './lib/dashboard-highlight';
import { LiveDot } from '@/soloist/shared';
import { VL, VLText, rgb } from '@/lib/palette';

// Frameless grid cell — flex column so each panel's `flex: 1` fills the cell
// height cross-browser. NO border/background/shadow (panels carry their own
// native frame → no frame-inside-frame).
const CELL: React.CSSProperties = {
  minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
};

// Page-level title, matching /mints' "Live mint tracker" header (H1 +
// LiveDot status line) above its two-panel grid — /multi had no such
// header at all, which (combined with the panels' own inner headers) read
// as a wall of table with nothing framing it. Needs to render inside
// SaleStreamProvider for the connection dot, hence a separate component
// rather than inlining in MultiNativeView.
function MultiHeader() {
  const connected = useSaleStreamConnected();
  // Horizontal padding uses --page-x (NOT /mints' 4px) — /mints' header
  // relies on its non-embedded .feed-root ALSO contributing its own page
  // gutter underneath; here .feed-root is data-embedded="1" (its gutter is
  // zeroed via !important), so this padding is the only gutter the header
  // gets. At 4px the title sat almost flush against the window edge
  // whenever the viewport was narrower than --mints-max (so the
  // maxWidth/margin:auto centering had no spare width to work with).
  return (
    <div style={{ padding: '16px var(--page-x, 16px) 8px', flexShrink: 0, width: '100%', maxWidth: 'var(--mints-max, 1400px)', margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.5px' }}>Multi View</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <LiveDot color={connected ? rgb(VL.green) : rgb(VL.gold)} />
        <span style={{ fontSize: 11, color: connected ? rgb(VL.green) : rgb(VL.gold) }}>
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>
    </div>
  );
}

export function MultiNativeView() {
  return (
    // One shared EventSource for the whole page: the sales + mint panels
    // register their handlers on it instead of opening a connection each.
    <SaleStreamProvider>
     <MultiSalesProvider>
     <DashboardHighlightProvider>
      <div className="feed-root page-transition" data-embedded="1">
        <MultiHeader />
        <div style={{
          flex: 1,
          display: 'grid',
          // FeedCard's content (thumb + seller/buyer block + price/badge
          // cluster) has a fairly fixed natural width — stretching its
          // column to an even ~50/50 split just opened a dead gap between
          // the seller/buyer text and the price, since flex:1 fills the
          // column but the card's actual content doesn't grow with it.
          // Capping the feed column near that natural width (~520px)
          // removes the gap, and the table column (flexible remainder)
          // absorbs the freed space instead.
          // Feed column cap widens/narrows via --multi-feed-col-max
          // (laptop 560px default, PC 480px) so PC mode nets a WIDER
          // table than laptop, same convention as --mints-table-max.
          gridTemplateColumns: 'minmax(0, 1fr) minmax(460px, var(--multi-feed-col-max, 560px))',
          gridTemplateRows: '1fr',
          gap: 12,
          // Outer horizontal gutter = the responsive page gutter (--page-x).
          // No top padding — MultiHeader already contributes 16px above
          // (its own padding-top), so a matching top value here just
          // doubled the gap and made the header read as a separate block
          // floating over the panels instead of a caption sitting on them
          // (/mints' `.mints-grid` has no top padding for the same reason).
          padding: '0 var(--page-x, 16px) 16px',
          // Caps + centers on wide monitors, same as /mints' `.mints-grid`
          // (reuses --mints-max — same two-panel-dashboard visual language,
          // not a new token). Without this the grid stretched full-bleed
          // edge-to-edge on any viewport, unlike every other page.
          maxWidth: 'var(--mints-max, 1400px)',
          margin: '0 auto',
          boxSizing: 'border-box',
          minHeight: 0,
        }}>
          <div style={CELL}><DashboardCollectionsPanel /></div>
          <div style={CELL}><SalesFeedPanel /></div>
        </div>
      </div>
     </DashboardHighlightProvider>
     </MultiSalesProvider>
    </SaleStreamProvider>
  );
}
