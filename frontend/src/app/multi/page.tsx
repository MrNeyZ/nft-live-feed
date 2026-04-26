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
  width: '100%',
  height: '100%',
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
    // Outer .feed-root padding (var(--feed-root-padding-x), 16 px on
    // laptop) supplies the horizontal gutters; the grid's own padding
    // supplies the matching vertical gutters — same on all four sides
    // so panes are framed uniformly.
    <div className="feed-root">
      <TopNav active="multi" />

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1.55fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        // Vertical padding matches the .feed-root's horizontal padding
        // for a uniform 16 px frame around the panes (left, right, top,
        // bottom). Phone mode (--feed-root-padding-x = 8 px) keeps its
        // tighter horizontal gutter; the 16 px vertical here is small
        // enough that the asymmetry is negligible at narrow viewports.
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
  // Same 1 px thickness as before, but bumped opacity so the frame is
  // visible around every pane without depending on the inner card's
  // stronger 0.65-alpha border. All three panes now share an identical
  // chrome — outer purple frame at 0.55, no per-pane variation.
  border: '1px solid rgba(168,144,232,0.55)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
};
