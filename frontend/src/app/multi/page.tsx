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
    // Multi-tab outer follows the standard PC scale (1.10) — the user
    // spec says "Multi-tab PC = 1.10 unless otherwise constrained". The
    // iframe content opts itself out via the `embedded` flag handled in
    // /dashboard and /feed (data-embedded="1" sets internal zoom = 1
    // so the panes don't double-scale on top of the outer's 1.10).
    // Right padding 0 so the feed iframe sits flush with the viewport edge.
    <div className="feed-root" style={{ paddingRight: 0 }}>
      <TopNav active="multi" />

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1.55fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        padding: '12px 0',
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
  border: '1px solid rgba(168,144,232,0.18)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
};
