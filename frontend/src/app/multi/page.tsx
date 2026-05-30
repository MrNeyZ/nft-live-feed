'use client';

// VictoryLabs — Multi-tab.
// Composite layout that hosts the REAL existing /mints, /tools/rare-feed
// and /feed pages (not custom approximations) via iframes with `?embed=1`.
// Same origin → localStorage / cookies / runtime-mode are all shared.
// Each iframe's Gate auth, layout-mode dataset, and SSE connection run
// inside its own document; the outer page just owns the chrome.
//
// Layout — three equal-width live-feed panels, full viewport height:
//   ┌───────────┬───────────────┬───────────┐
//   │   MINTS    │  RARE SALES   │   SALES   │
//   │  (left)    │   (center)    │  (right)  │
//   └───────────┴───────────────┴───────────┘

import { useEffect } from 'react';
// TopNav rendered persistently by Gate (anti-flash); no per-page import needed.

const IFRAME_STYLE: React.CSSProperties = {
  // `flex: 1 1 auto` + `min-height: 0` (on the parent paneStyle) lets the
  // iframe stretch to the full grid-cell height across browsers without
  // depending on the height-percentage chain. Width still 100 % via flex.
  flex: '1 1 auto',
  width: '100%',
  height: '100%',
  minHeight: 0,
  border: 'none',
  background: 'transparent',
  display: 'block',
};

export default function MultiTabPage() {
  useEffect(() => { document.title = 'VictoryLabs — Multi-tab'; }, []);

  return (
    // Multi-tab outer follows the standard PC scale (1.10). The iframe
    // content opts itself out via the `embedded` flag (data-embedded="1"
    // sets internal zoom = 1 so panes don't double-scale).
    // No paddingRight override — the .feed-root's `var(--feed-root-padding-x)`
    // supplies the same gutter on both sides (16 px laptop / 24 px PC /
    // 8 px phone) so the right pane no longer anchors to the viewport
    // edge.
    <div className="feed-root page-transition">
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      <div style={{
        flex: 1,
        display: 'grid',
        // Three equal-width columns. `minmax(0, 1fr)` (not bare `1fr`)
        // lets each track shrink below its content's intrinsic width so
        // the panels stay exactly equal and never overflow the viewport.
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gridTemplateRows: '1fr',
        gap: 12,
        // Vertical breathing room mirrors the horizontal gutter on the
        // outer .feed-root so the grid is framed evenly on all four
        // sides — no panel border touches a viewport edge. The 12 px
        // inter-panel gap stays the same as before.
        padding: '16px 0',
        minHeight: 0,
      }}>
        {/* Left: actual Live Mint Feed interface, embedded */}
        <div style={paneStyle}>
          <iframe src="/mints?embed=1" title="Live Feed Mints" style={IFRAME_STYLE} />
        </div>

        {/* Center: actual Rare Feed (rare sales) interface, embedded */}
        <div style={paneStyle}>
          <iframe src="/tools/rare-feed?embed=1" title="Live Feed Rare Sales" style={IFRAME_STYLE} />
        </div>

        {/* Right: actual Live Feed (sales) interface, embedded */}
        <div style={paneStyle}>
          <iframe src="/feed?embed=1" title="Live Feed Sales" style={IFRAME_STYLE} />
        </div>
      </div>
    </div>
  );
}

const paneStyle: React.CSSProperties = {
  minWidth: 0, minHeight: 0,
  // Flex column so the iframe child stretches to fill the cell. Without
  // this the iframe's `height: 100%` was inconsistent across browsers
  // when the parent was a CSS-grid track — the feed pane visually
  // ended above the grid-cell bottom.
  display: 'flex',
  flexDirection: 'column',
  // No border / shadow / background here. The embedded page already
  // supplies its own native frame (the feed/mint panels' borders, the
  // cards themselves). A wrapper border + glow stacked on top of that
  // produced a frame-inside-frame and ate horizontal space with empty
  // gutters — so the iframe now sits directly in the grid column.
};
