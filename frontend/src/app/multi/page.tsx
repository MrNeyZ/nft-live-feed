'use client';

// VictoryLabs — Multi-tab.
// Composite layout that hosts the REAL existing /dashboard, /feed and
// /mints pages (not custom approximations) via iframes with `?embed=1`.
// Same origin → localStorage / cookies / runtime-mode are all shared.
// Each iframe's Gate auth, layout-mode dataset, and SSE connection run
// inside its own document; the outer page just owns the chrome.
//
// Layout:
//   ┌─────────────┬──────────────┐
//   │ DASHBOARD   │              │
//   │ (top-left)  │   LIVE FEED  │
//   ├─────────────┤  (full right)│
//   │   MINTS     │              │
//   │ (bottom-left)              │
//   └─────────────┴──────────────┘

import { useEffect } from 'react';
import { TopNav } from '@/soloist/shared';

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
    <div className="feed-root">
      <TopNav active="multi" />

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1.55fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        // Vertical breathing room mirrors the horizontal gutter on the
        // outer .feed-root so the grid is framed evenly on all four
        // sides — no panel border touches a viewport edge. The 12 px
        // inter-panel gap stays the same as before.
        padding: '16px 0',
        minHeight: 0,
      }}>
        {/* Top-left: actual Dashboard interface, embedded */}
        <div style={paneStyle}>
          <iframe src="/dashboard?embed=1" title="Dashboard" style={IFRAME_STYLE} />
        </div>

        {/* Right column: actual Live Feed interface, embedded; spans both rows */}
        <div style={{ ...paneStyle, gridRow: '1 / 3' }}>
          <iframe src="/feed?embed=1" title="Live Feed" style={IFRAME_STYLE} />
        </div>

        {/* Bottom-left: actual Mints interface, embedded */}
        <div style={{ ...paneStyle, gridColumn: '1 / 2', gridRow: '2 / 3' }}>
          <iframe src="/mints?embed=1" title="Mints" style={IFRAME_STYLE} />
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
  border: '1px solid rgba(168,144,232,0.18)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
};
